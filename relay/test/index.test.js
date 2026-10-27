import assert from "node:assert/strict";
import test from "node:test";
import worker from "../src/index.js";

const env = { GITHUB_TOKEN: "test-token" };
const endpoint = "https://relay.example/results";
const body = "Uploader 2.1.0, tester build build-22-abc1234, UTC 2026-10-26T20:00:00.0000000Z\n\nrow,one\nrow,two";

function request(payload = { title: "Robot data 2026-10-26", body }, headers = {}) {
  return new Request(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Scourge-Client": "windows-uploader 2.1.0", ...headers },
    body: JSON.stringify(payload),
  });
}

async function withGitHub(stub, action) {
  const original = globalThis.fetch;
  globalThis.fetch = stub;
  try {
    return await action();
  } finally {
    globalThis.fetch = original;
  }
}

test("happy path sends one unchanged issue", async () => {
  const calls = [];
  const response = await withGitHub(async (url, options) => {
    calls.push({ url, options });
    return Response.json({ number: 42 }, { status: 201 });
  }, () => worker.fetch(request(), env));
  assert.equal(response.status, 201);
  assert.deepEqual(await response.json(), { ok: true, issues: [42] });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.github.com/repos/Whyater/40217S-Robot-Data/issues");
  assert.equal(calls[0].options.headers.Authorization, "Bearer test-token");
  assert.deepEqual(JSON.parse(calls[0].options.body), { title: "Robot data 2026-10-26", body });
});

test("splits long data only at line boundaries", async () => {
  const rows = Array.from({ length: 1200 }, (_, i) => `${i},${"x".repeat(55)}\r\n`).join("");
  const longBody = `Uploader 2.1.0, tester build build-22-abc1234, UTC 2026-10-26T20:00:00.0000000Z\r\n\r\n${rows}`;
  const sent = [];
  const response = await withGitHub(async (_url, options) => {
    sent.push(JSON.parse(options.body));
    return Response.json({ number: sent.length }, { status: 201 });
  }, () => worker.fetch(request({ title: "Robot data 2026-10-26", body: longBody }), env));
  assert.equal(response.status, 201);
  const result = await response.json();
  assert.equal(result.issues.length, sent.length);
  assert.ok(sent.length > 1);
  sent.forEach((issue, index) => {
    assert.match(issue.title, new RegExp(`\\(part ${index + 1} of ${sent.length}\\)$`));
    assert.ok(issue.body.length <= 60000);
    assert.ok(issue.body.endsWith("\r\n") || issue.body.includes("\r\n\r\n"));
  });
  assert.equal(sent.map((issue) => issue.body.slice(issue.body.indexOf("\r\n\r\n") + 4)).join(""), rows);
});

const rejectionCases = [
  ["wrong method", new Request(endpoint, { method: "GET", headers: { "X-Scourge-Client": "x" } }), env, 405],
  ["wrong path", new Request("https://relay.example/other", { method: "POST", headers: { "X-Scourge-Client": "x" }, body: "{}" }), env, 404],
  ["missing client header", new Request(endpoint, { method: "POST", body: "{}" }), env, 403],
  ["invalid JSON", new Request(endpoint, { method: "POST", headers: { "X-Scourge-Client": "x" }, body: "{" }), env, 400],
  ["invalid title", request({ title: "bad", body }), env, 400],
  ["non-string body", request({ title: "Robot data 2026-10-26", body: 3 }), env, 400],
  ["bad header", request({ title: "Robot data 2026-10-26", body: "Nope\n\nrow" }), env, 400],
  ["missing blank line", request({ title: "Robot data 2026-10-26", body: "Uploader x\nrow" }), env, 400],
  ["no data", request({ title: "Robot data 2026-10-26", body: "Uploader x\n\n" }), env, 400],
  ["body too large", request({ title: "Robot data 2026-10-26", body: `Uploader x\n\n${"x".repeat(600000)}` }), env, 413],
  ["request too large", new Request(endpoint, { method: "POST", headers: { "X-Scourge-Client": "x", "Content-Length": "1000001" }, body: "{}" }), env, 413],
];

for (const [name, req, testEnv, status] of rejectionCases) {
  test(`rejects ${name}`, async () => {
    const response = await worker.fetch(req, testEnv);
    assert.equal(response.status, status);
    assert.equal((await response.json()).ok, false);
  });
}

test("GitHub failure returns 502 without exposing the token", async () => {
  const response = await withGitHub(async () => Response.json({ message: "secret details" }, { status: 401 }), () => worker.fetch(request(), env));
  assert.equal(response.status, 502);
  const text = await response.text();
  assert.doesNotMatch(text, /test-token|secret details/);
  assert.deepEqual(JSON.parse(text), { ok: false, error: "GitHub answered 401", issues: [] });
});

test("missing token is rejected", async () => {
  const response = await worker.fetch(request(), {});
  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), { ok: false, error: "relay not configured" });
});

test("rate limit answers 429 before touching GitHub", async () => {
  const worker = (await import("../src/index.js")).default;
  let githubCalls = 0;
  globalThis.fetch = async () => { githubCalls += 1; return new Response("{}", { status: 201 }); };
  const req = new Request("https://relay.test/results", {
    method: "POST",
    headers: { "X-Scourge-Client": "test", "Content-Type": "application/json" },
    body: JSON.stringify({ title: "Robot data 2026-10-26", body: "Uploader 2.1.0, x\r\n\r\nSCOURGE,a,b,1,u" }),
  });
  const res = await worker.fetch(req, { GITHUB_TOKEN: "t", LIMITER: { limit: async () => ({ success: false }) } });
  const { strictEqual } = await import("node:assert");
  strictEqual(res.status, 429);
  strictEqual(githubCalls, 0);
});

test("a body at the 600000 limit splits into allowed parts", async () => {
  const worker = (await import("../src/index.js")).default;
  const titles = [];
  globalThis.fetch = async (_u, init) => { titles.push(JSON.parse(init.body).title); return new Response(JSON.stringify({ number: titles.length }), { status: 201 }); };
  const header = "Uploader 2.1.0, tester build build-22-abc1234, UTC 2026-10-26T20:00:00.0000000Z\r\n\r\n";
  let body = header;
  while (body.length < 600000 - 40) body += "SCOURGE,lift,sample,123.456789012,deg\r\n";
  body = body.slice(0, 600000 - 2) + "\r\n";
  const req = new Request("https://relay.test/results", {
    method: "POST",
    headers: { "X-Scourge-Client": "test", "Content-Type": "application/json" },
    body: JSON.stringify({ title: "Robot data 2026-10-26", body }),
  });
  const res = await worker.fetch(req, { GITHUB_TOKEN: "t" });
  const { strictEqual, ok } = await import("node:assert");
  strictEqual(res.status, 201, await res.clone().text());
  ok(titles.length >= 10 && titles.length <= 12, String(titles.length));
});
