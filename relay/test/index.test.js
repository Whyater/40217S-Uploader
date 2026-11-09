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
  assert.deepEqual(await response.json(), { ok: true, issues: [42], on_map: false });
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

const mapUrl = "https://relay.example/map";
const pagesOrigin = "https://whyater.github.io";

function fakeKv(values = {}) {
  const store = new Map(Object.entries(values));
  return { store, get: async (key) => store.get(key) ?? null, put: async (key, value) => { store.set(key, value); } };
}

function mapEnv(values = {}) {
  return { TEAM_CODE: "code-1234", INGEST_TOKEN: "ingest-1234", MAP: fakeKv(values) };
}

function mapGet(query = "", headers = { "X-Team-Code": "code-1234" }) {
  return new Request(mapUrl + query, { headers });
}

function recordedPut(body, headers = { Authorization: "Bearer ingest-1234" }) {
  return new Request("https://relay.example/map/recorded", { method: "PUT", headers, body });
}

test("GET /map?build= returns that build's sim and the recorded data", async () => {
  const env = mapEnv({
    "sim/build-70-abc1234": '{"tag":"build-70-abc1234"}',
    "sim/latest": '{"tag":"build-71-def5678"}',
    recorded: '{"sessions":[]}',
    recorded_updated: "2026-10-30T23:00:00.000Z",
  });
  const response = await worker.fetch(mapGet("?build=build-70-abc1234"), env);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Access-Control-Allow-Origin"), pagesOrigin);
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  assert.deepEqual(await response.json(), {
    ok: true,
    sim: { tag: "build-70-abc1234" },
    recorded: { sessions: [] },
    recorded_updated: "2026-10-30T23:00:00.000Z",
    sim_is_latest: false,
  });
});

test("GET /map?build= for an unknown build gives a null sim, not the latest", async () => {
  const env = mapEnv({ "sim/latest": '{"tag":"build-71-def5678"}' });
  for (const query of ["?build=build-1-none", "?build=latest", "?build=..%2Frecorded"]) {
    const result = await (await worker.fetch(mapGet(query), env)).json();
    assert.deepEqual(result, { ok: true, sim: null, recorded: null, recorded_updated: null, sim_is_latest: false }, query);
  }
});

test("GET /map returns sim/latest and says so", async () => {
  const env = mapEnv({ "sim/latest": '{"tag":"build-71-def5678"}' });
  const result = await (await worker.fetch(mapGet(), env)).json();
  assert.deepEqual(result.sim, { tag: "build-71-def5678" });
  assert.equal(result.sim_is_latest, true);
  assert.equal(result.recorded, null);
});

test("GET /map with a wrong or missing team code is 401 and reads nothing", async () => {
  for (const headers of [{}, { "X-Team-Code": "code-1235" }, { "X-Team-Code": "code-12345" }, { "X-Team-Code": "" }]) {
    const env = mapEnv();
    env.MAP.get = async () => { throw new Error("read without a code"); };
    const response = await worker.fetch(mapGet("", headers), env);
    assert.equal(response.status, 401);
    assert.equal(response.headers.get("Access-Control-Allow-Origin"), pagesOrigin);
    assert.deepEqual(await response.json(), { ok: false, error: "wrong team code" });
  }
});

test("GET /map with no TEAM_CODE secret is 500, never open", async () => {
  const env = mapEnv({ recorded: "{}" });
  delete env.TEAM_CODE;
  for (const headers of [{}, { "X-Team-Code": "" }, { "X-Team-Code": "anything" }]) {
    const response = await worker.fetch(mapGet("", headers), env);
    assert.equal(response.status, 500);
    assert.equal((await response.json()).ok, false);
  }
});

test("GET /map is limited per address before the code is checked", async () => {
  const keys = [];
  const env = mapEnv();
  env.LIMITER_READ = { limit: async ({ key }) => { keys.push(key); return { success: false }; } };
  const response = await worker.fetch(mapGet("", { "X-Team-Code": "code-1234", "CF-Connecting-IP": "203.0.113.9" }), env);
  assert.equal(response.status, 429);
  assert.deepEqual(keys, ["203.0.113.9"]);
});

test("OPTIONS /map allows exactly the Pages origin, GET, and the team code header", async () => {
  const response = await worker.fetch(new Request(mapUrl, { method: "OPTIONS", headers: { Origin: "https://evil.example" } }), {});
  assert.equal(response.status, 204);
  assert.equal(response.headers.get("Access-Control-Allow-Origin"), pagesOrigin);
  assert.equal(response.headers.get("Access-Control-Allow-Methods"), "GET, OPTIONS");
  assert.equal(response.headers.get("Access-Control-Allow-Headers"), "X-Team-Code");
});

test("other methods on /map are refused", async () => {
  const response = await worker.fetch(new Request(mapUrl, { method: "POST", headers: { "X-Team-Code": "code-1234" }, body: "{}" }), mapEnv());
  assert.equal(response.status, 405);
});

test("PUT /map/recorded stores the body and the time, and GET /map returns them", async () => {
  const env = mapEnv();
  const text = '{"sessions":[{"id":"teach_open-1"}],"note":""}';
  const response = await worker.fetch(recordedPut(text), env);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Access-Control-Allow-Origin"), null);
  const stored = await response.json();
  assert.equal(stored.ok, true);
  assert.equal(env.MAP.store.get("recorded"), text);
  assert.equal(env.MAP.store.get("recorded_updated"), stored.recorded_updated);
  assert.ok(!Number.isNaN(Date.parse(stored.recorded_updated)));
  const read = await (await worker.fetch(mapGet(), env)).json();
  assert.deepEqual(read.recorded, JSON.parse(text));
  assert.equal(read.recorded_updated, stored.recorded_updated);
});

test("PUT /map/recorded needs the right token and stores nothing otherwise", async () => {
  for (const headers of [{}, { Authorization: "Bearer ingest-1235" }, { Authorization: "ingest-1234" }, { "X-Team-Code": "code-1234" }]) {
    const env = mapEnv();
    const response = await worker.fetch(recordedPut("{}", headers), env);
    assert.equal(response.status, 401);
    assert.equal(env.MAP.store.size, 0);
  }
});

test("PUT /map/recorded with no INGEST_TOKEN secret is 500, never open", async () => {
  const env = mapEnv();
  delete env.INGEST_TOKEN;
  const response = await worker.fetch(recordedPut("{}", { Authorization: "Bearer " }), env);
  assert.equal(response.status, 500);
  assert.equal(env.MAP.store.size, 0);
});

test("PUT /map/recorded refuses anything but a JSON object within 10 MB", async () => {
  const cases = [["{", 400], ["[]", 400], ["3", 400], ["null", 400], [`{"a":"${"x".repeat(10_000_000)}"}`, 413]];
  for (const [text, status] of cases) {
    const env = mapEnv();
    const response = await worker.fetch(recordedPut(text), env);
    assert.equal(response.status, status, text.slice(0, 20));
    assert.equal(env.MAP.store.size, 0);
  }
});

test("a body just over the results limit is fine for recorded data", async () => {
  const env = mapEnv();
  const response = await worker.fetch(recordedPut(`{"a":"${"x".repeat(2_000_000)}"}`), env);
  assert.equal(response.status, 200);
});

test("PUT on the wrong route or GET on /map/recorded does not store", async () => {
  const env = mapEnv();
  const get = await worker.fetch(new Request("https://relay.example/map/recorded", { headers: { Authorization: "Bearer ingest-1234" } }), env);
  assert.equal(get.status, 405);
  const put = await worker.fetch(new Request(mapUrl, { method: "PUT", headers: { "X-Team-Code": "code-1234" }, body: "{}" }), env);
  assert.equal(put.status, 405);
  assert.equal(env.MAP.store.size, 0);
});

async function sendWith(headers, testEnv, payload = { title: "Robot data 2026-10-26", body }) {
  const sent = [];
  const response = await withGitHub(async (_url, options) => {
    const fields = JSON.parse(options.body);
    sent.push(fields);
    return Response.json({ number: sent.length, labels: (fields.labels ?? []).map((name) => ({ name })) }, { status: 201 });
  }, () => worker.fetch(request(payload, headers), testEnv));
  return { response, sent };
}

test("the right team code labels the issue and says it goes on the map", async () => {
  const { response, sent } = await sendWith({ "X-Team-Code": "code-1234" }, { ...env, TEAM_CODE: "code-1234" });
  assert.equal(response.status, 201);
  assert.deepEqual(await response.json(), { ok: true, issues: [1], on_map: true });
  assert.deepEqual(sent, [{ title: "Robot data 2026-10-26", body, labels: ["team"] }]);
});

test("GitHub refusing the label still files the results, and says they won't reach the map", async () => {
  const sent = [];
  const response = await withGitHub(async (_url, options) => {
    const fields = JSON.parse(options.body);
    sent.push(fields);
    if (fields.labels) return new Response("{}", { status: 422 });
    return Response.json({ number: sent.length, labels: [] }, { status: 201 });
  }, () => worker.fetch(request({ title: "Robot data 2026-10-26", body }, { "X-Team-Code": "code-1234" }), { ...env, TEAM_CODE: "code-1234" }));
  assert.equal(response.status, 201);
  assert.deepEqual(await response.json(), { ok: true, issues: [2], on_map: false });
  assert.equal(sent[1].labels, undefined);
});

test("GitHub dropping the label silently is not reported as on the map", async () => {
  const response = await withGitHub(async () => Response.json({ number: 1, labels: [] }, { status: 201 }),
    () => worker.fetch(request({ title: "Robot data 2026-10-26", body }, { "X-Team-Code": "code-1234" }), { ...env, TEAM_CODE: "code-1234" }));
  assert.equal((await response.json()).on_map, false);
});

test("a wrong or missing team code still files, unlabelled", async () => {
  for (const headers of [{}, { "X-Team-Code": "code-1235" }, { "X-Team-Code": "code-12345" }, { "X-Team-Code": "" }]) {
    const { response, sent } = await sendWith(headers, { ...env, TEAM_CODE: "code-1234" });
    assert.equal(response.status, 201);
    assert.equal((await response.json()).on_map, false);
    assert.deepEqual(sent, [{ title: "Robot data 2026-10-26", body }]);
  }
});

test("with no TEAM_CODE secret nothing is labelled, even for an empty code", async () => {
  for (const headers of [{}, { "X-Team-Code": "" }, { "X-Team-Code": "undefined" }]) {
    const { response, sent } = await sendWith(headers, env);
    assert.equal(response.status, 201);
    assert.equal((await response.json()).on_map, false);
    assert.equal(sent[0].labels, undefined);
  }
});

test("a sender cannot set labels in the body", async () => {
  const payload = { title: "Robot data 2026-10-26", body, labels: ["team"] };
  const { sent } = await sendWith({}, { ...env, TEAM_CODE: "code-1234" }, payload);
  assert.deepEqual(sent, [{ title: "Robot data 2026-10-26", body }]);
});

test("every part of a long send gets the label", async () => {
  const rows = Array.from({ length: 1200 }, (_, i) => `${i},${"x".repeat(55)}\r\n`).join("");
  const longBody = `Uploader 2.1.0, tester build build-22-abc1234, UTC 2026-10-26T20:00:00.0000000Z\r\n\r\n${rows}`;
  const { response, sent } = await sendWith(
    { "X-Team-Code": "code-1234" },
    { ...env, TEAM_CODE: "code-1234" },
    { title: "Robot data 2026-10-26", body: longBody },
  );
  assert.equal((await response.json()).on_map, true);
  assert.ok(sent.length > 1);
  for (const issue of sent) assert.deepEqual(issue.labels, ["team"]);
});

const plansUrl = "https://relay.example/plans";
const plansEnv = { GITHUB_TOKEN: "test-token", TEAM_CODE: "code-1234" };
const goodPlan = {
  schema: 1,
  kind: "proposed-auto-plan",
  name: "Left 2 goal",
  side: "L",
  note: "grab stack at the end of line 1",
  build: "build-70-e2fdfc5",
  lines: [{ points: [[-52.1, -18], [-30.25, -18]] }],
};

function plansPost(payload = goodPlan, headers = {}) {
  return new Request(plansUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Team-Code": "code-1234", "X-Scourge-Client": "web-uploader", ...headers },
    body: typeof payload === "string" ? payload : JSON.stringify(payload),
  });
}

async function sendPlanWith(req, testEnv = plansEnv, answer = (fields, sent) => Response.json({ number: sent.length }, { status: 201 })) {
  const sent = [];
  const response = await withGitHub(async (url, options) => {
    assert.equal(url, "https://api.github.com/repos/Whyater/40217S-Robot-Data/issues");
    assert.equal(options.headers.Authorization, "Bearer test-token");
    const fields = JSON.parse(options.body);
    sent.push(fields);
    return answer(fields, sent);
  }, () => worker.fetch(req, testEnv));
  return { response, sent };
}

// The text between the only pair of fences, which is what `autopath.py plans` has to read back.
function fencedPlan(issueBody) {
  const fences = issueBody.split("```");
  assert.equal(fences.length, 3, "exactly one opening and one closing fence");
  assert.ok(fences[1].startsWith("json\n"));
  return JSON.parse(fences[1].slice("json\n".length));
}

test("POST /plans files one labelled issue and answers with its number", async () => {
  const { response, sent } = await sendPlanWith(plansPost());
  assert.equal(response.status, 201);
  assert.equal(response.headers.get("Access-Control-Allow-Origin"), pagesOrigin);
  assert.deepEqual(await response.json(), { ok: true, issue: 1 });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].title, "Proposed auto plan: Left 2 goal");
  assert.deepEqual(sent[0].labels, ["proposed-auto-plan"]);
  assert.deepEqual(fencedPlan(sent[0].body), { ...goodPlan, actions: [] });
});

test("POST /plans summary says it is a proposal and gives side, line count, and inches", async () => {
  // Worked by hand: a 3-4-5 leg, then 6 straight up, then a 6-8-10 line. 5 + 6 + 10 = 21 inches.
  const lines = [{ points: [[0, 0], [3, 4], [3, 10]] }, { points: [[-6, -8], [0, 0]] }];
  const { sent } = await sendPlanWith(plansPost({ ...goodPlan, side: "R", lines }));
  const summary = sent[0].body.split("\n")[0];
  assert.equal(summary, "Proposal only, not run on a robot. Side R, 2 lines, 0 actions, 21.0 in total.");
});

test("POST /plans drops unknown fields, trims the name, and rounds to 2 places", async () => {
  const { sent } = await sendPlanWith(plansPost({
    ...goodPlan,
    name: "  Left 2 goal  ",
    labels: ["team"],
    assignees: ["someone"],
    title: "Robot data 2026-10-26",
    lines: [{ color: "red", points: [[-52.126, 18.004], [0.005, -0.001]] }],
  }));
  assert.deepEqual(Object.keys(sent[0]).sort(), ["body", "labels", "title"]);
  assert.deepEqual(sent[0].labels, ["proposed-auto-plan"]);
  assert.equal(sent[0].title, "Proposed auto plan: Left 2 goal");
  assert.doesNotMatch(sent[0].body, /team|someone|Robot data|red/);
  const plan = fencedPlan(sent[0].body);
  assert.deepEqual(Object.keys(plan), ["schema", "kind", "name", "side", "note", "build", "lines", "actions"]);
  assert.equal(plan.name, "Left 2 goal");
  assert.deepEqual(plan.lines, [{ points: [[-52.13, 18], [0.01, 0]] }]);
});

test("POST /plans keeps field only when it is override or pinnacle", async () => {
  const pin = await sendPlanWith(plansPost({ ...goodPlan, field: "pinnacle" }));
  assert.equal(fencedPlan(pin.sent[0].body).field, "pinnacle");
  assert.match(pin.sent[0].body.split("\n")[0], /Pinnacle field\.$/);
  const ov = await sendPlanWith(plansPost({ ...goodPlan, field: "override" }));
  assert.equal(fencedPlan(ov.sent[0].body).field, "override");
  assert.doesNotMatch(ov.sent[0].body.split("\n")[0], /Pinnacle/);
  for (const bad of ["Pinnacle", "other", 1, null, ["pinnacle"]]) {
    const r = await sendPlanWith(plansPost({ ...goodPlan, field: bad }));
    assert.equal(r.response.status, 201);
    assert.equal("field" in fencedPlan(r.sent[0].body), false);
  }
});

test("POST /plans: backticks in a note or name cannot close the fence, and read back unchanged", async () => {
  const note = "before\n```\n@everyone ` ``` after";
  const name = "a```b";
  const build = "`build`";
  const { sent } = await sendPlanWith(plansPost({ ...goodPlan, name, note, build }));
  const fence = sent[0].body.split("```json\n")[1];
  const inside = fence.slice(0, fence.lastIndexOf("\n```"));
  assert.doesNotMatch(inside, /`/);
  assert.match(inside, /\\u0060/);
  assert.doesNotMatch(inside, /\n/, "a line break in the note stays escaped, so it can't start a fence line");
  const plan = fencedPlan(sent[0].body);
  assert.equal(plan.note, note);
  assert.equal(plan.name, name);
  assert.equal(plan.build, build);
});

test("POST /plans: name and note appear only in the title and the fence", async () => {
  const { sent } = await sendPlanWith(plansPost({ ...goodPlan, name: "@name-handle", note: "@note-handle" }));
  const outside = sent[0].body.replace(/```json\n[^\n]*\n```/, "");
  assert.doesNotMatch(outside, /name-handle|note-handle|@/);
});

test("POST /plans removes control characters from the title and keeps them escaped in the fence", async () => {
  const name = "Left\u0000 2\u0007\n\r\t goal\u007f\u0085";
  const { response, sent } = await sendPlanWith(plansPost({ ...goodPlan, name }));
  assert.equal(response.status, 201);
  assert.equal(sent[0].title, "Proposed auto plan: Left 2 goal");
  assert.equal(fencedPlan(sent[0].body).name, name);
});

test("POST /plans accepts everything at its limit", async () => {
  const point = [100, -100];
  const longest = { points: Array.from({ length: 500 }, () => point) };
  const cases = [
    { name: "n".repeat(80) },
    { name: `  ${"n".repeat(80)}  ` },
    { name: "\u{1F600}".repeat(80) },
    { note: "" },
    { note: "n".repeat(2000) },
    { build: null },
    { build: "b".repeat(100) },
    { side: "R" },
    { lines: Array.from({ length: 50 }, () => ({ points: [[0, 0], [1, 1]] })) },
    { lines: [longest] },
  ];
  for (const fields of cases) {
    const { response } = await sendPlanWith(plansPost({ ...goodPlan, ...fields }));
    assert.equal(response.status, 201, JSON.stringify(fields).slice(0, 60));
  }
});

const badPlans = [
  ["an array", []],
  ["null", null],
  ["a number", 3],
  ["the wrong schema", { ...goodPlan, schema: 2 }],
  ["a string schema", { ...goodPlan, schema: "1" }],
  ["the wrong kind", { ...goodPlan, kind: "route" }],
  ["no name", { ...goodPlan, name: undefined }],
  ["a number name", { ...goodPlan, name: 7 }],
  ["a blank name", { ...goodPlan, name: "   " }],
  ["a name of only control characters", { ...goodPlan, name: "\u0000\u0001" }],
  ["a name over 80", { ...goodPlan, name: "n".repeat(81) }],
  ["no note", { ...goodPlan, note: undefined }],
  ["a null note", { ...goodPlan, note: null }],
  ["a note over 2000", { ...goodPlan, note: "n".repeat(2001) }],
  ["a bad side", { ...goodPlan, side: "left" }],
  ["no side", { ...goodPlan, side: undefined }],
  ["no build", { ...goodPlan, build: undefined }],
  ["a number build", { ...goodPlan, build: 70 }],
  ["a build over 100", { ...goodPlan, build: "b".repeat(101) }],
  ["lines that are not an array", { ...goodPlan, lines: { points: [[0, 0], [1, 1]] } }],
  ["no lines", { ...goodPlan, lines: [] }],
  ["51 lines", { ...goodPlan, lines: Array.from({ length: 51 }, () => ({ points: [[0, 0], [1, 1]] })) }],
  ["a line that is an array", { ...goodPlan, lines: [[[0, 0], [1, 1]]] }],
  ["a null line", { ...goodPlan, lines: [null] }],
  ["a line of one point", { ...goodPlan, lines: [{ points: [[0, 0]] }] }],
  ["a line of 501 points", { ...goodPlan, lines: [{ points: Array.from({ length: 501 }, () => [0, 0]) }] }],
  ["5001 points in total", { ...goodPlan, lines: Array.from({ length: 11 }, (_, i) => ({ points: Array.from({ length: i === 10 ? 1 : 500 }, () => [0, 0]) })) }],
  ["a point of one number", { ...goodPlan, lines: [{ points: [[0], [1, 1]] }] }],
  ["a point of three numbers", { ...goodPlan, lines: [{ points: [[0, 0, 0], [1, 1]] }] }],
  ["a point object", { ...goodPlan, lines: [{ points: [{ x: 0, y: 0 }, [1, 1]] }] }],
  ["a string coordinate", { ...goodPlan, lines: [{ points: [["1", 0], [1, 1]] }] }],
  ["a null coordinate", { ...goodPlan, lines: [{ points: [[null, 0], [1, 1]] }] }],
  ["a coordinate over 100", { ...goodPlan, lines: [{ points: [[100.01, 0], [1, 1]] }] }],
  ["a coordinate under -100", { ...goodPlan, lines: [{ points: [[0, -100.01], [1, 1]] }] }],
];

for (const [name, payload] of badPlans) {
  test(`POST /plans refuses ${name} and files nothing`, async () => {
    const { response, sent } = await sendPlanWith(plansPost(payload));
    assert.equal(response.status, 400);
    assert.equal(response.headers.get("Access-Control-Allow-Origin"), pagesOrigin);
    assert.equal((await response.json()).ok, false);
    assert.equal(sent.length, 0);
  });
}

test("POST /plans refuses invalid JSON and a coordinate that parses to infinity", async () => {
  const infinite = JSON.stringify(goodPlan).replace("-52.1", "1e999");
  assert.equal(JSON.parse(infinite).lines[0].points[0][0], Infinity);
  for (const text of ["{", infinite]) {
    const { response, sent } = await sendPlanWith(plansPost(text));
    assert.equal(response.status, 400, text.slice(0, 20));
    assert.equal(sent.length, 0);
  }
});

test("POST /plans with a wrong or missing team code is 401 and files nothing", async () => {
  for (const code of [null, "", "code-1235", "code-12345"]) {
    const req = plansPost();
    if (code === null) req.headers.delete("X-Team-Code");
    else req.headers.set("X-Team-Code", code);
    const { response, sent } = await sendPlanWith(req);
    assert.equal(response.status, 401);
    assert.equal(response.headers.get("Access-Control-Allow-Origin"), pagesOrigin);
    assert.deepEqual(await response.json(), { ok: false, error: "wrong team code" });
    assert.equal(sent.length, 0);
  }
});

test("POST /plans with no TEAM_CODE or GITHUB_TOKEN secret is 500, never open", async () => {
  for (const testEnv of [{ GITHUB_TOKEN: "test-token" }, { TEAM_CODE: "code-1234" }]) {
    const { response, sent } = await sendPlanWith(plansPost(goodPlan, { "X-Team-Code": "" }), testEnv);
    assert.equal(response.status, 500);
    assert.equal(sent.length, 0);
  }
});

test("POST /plans without a client header is 403", async () => {
  const req = plansPost();
  req.headers.delete("X-Scourge-Client");
  const { response, sent } = await sendPlanWith(req);
  assert.equal(response.status, 403);
  assert.equal(response.headers.get("Access-Control-Allow-Origin"), pagesOrigin);
  assert.equal(sent.length, 0);
});

test("POST /plans over 200 KB is 413, by header or by actual size, and the browser can read it", async () => {
  const claimed = plansPost();
  claimed.headers.set("Content-Length", "200001");
  const padded = plansPost({ ...goodPlan, junk: "x".repeat(200_000) });
  for (const req of [claimed, padded]) {
    const { response, sent } = await sendPlanWith(req);
    assert.equal(response.status, 413);
    assert.equal(response.headers.get("Access-Control-Allow-Origin"), pagesOrigin);
    assert.equal(sent.length, 0);
  }
});

test("POST /plans: junk that fits under 200 KB is still dropped", async () => {
  const { response, sent } = await sendPlanWith(plansPost({ ...goodPlan, junk: "x".repeat(190_000) }));
  assert.equal(response.status, 201);
  assert.ok(sent[0].body.length < 1000);
});

test("POST /plans: a plan too long for one issue is 413 before GitHub is asked", async () => {
  // The longest points are inside the limits and fit, but a note of backticks costs 6 characters each once escaped.
  const lines = Array.from({ length: 6 }, () => ({ points: Array.from({ length: 500 }, () => [-99.25, -98.75]) }));
  const { response, sent } = await sendPlanWith(plansPost({ ...goodPlan, lines, note: "`".repeat(2000) }));
  assert.equal(response.status, 413);
  assert.match((await response.json()).error, /fewer points/);
  assert.equal(sent.length, 0);
});

test("POST /plans: the most points allowed, with the longest ordinary note, fits one issue; one more point is 400", async () => {
  const lines = Array.from({ length: 6 }, () => ({ points: Array.from({ length: 500 }, () => [-99.25, -98.75]) }));
  const { response, sent } = await sendPlanWith(plansPost({ ...goodPlan, lines, name: "n".repeat(80), note: "x".repeat(2000) }));
  assert.equal(response.status, 201);
  assert.ok(sent[0].body.length <= 60_000);
  lines[0].points.pop();
  lines.push({ points: [[0, 0], [1, 1]] });
  const over = await sendPlanWith(plansPost({ ...goodPlan, lines }));
  assert.equal(over.response.status, 400);
});

const onePlanLine = [{ points: [[0, 0], [10, 0]] }];
const planFence = (body) => JSON.parse(/```json\n(.*)\n```/s.exec(body)[1]);

test("POST /plans keeps actions in order and says how many; a plan from before actions still files", async () => {
  const actions = [
    { type: "roller_on", line: 1, along: 2.345, at: [2.345, 0], detail: "", junk: "dropped" },
    { type: "score", line: 1, along: 10, at: [10, 0], detail: "second `Pin`" },
  ];
  const { response, sent } = await sendPlanWith(plansPost({ ...goodPlan, lines: onePlanLine, actions }));
  assert.equal(response.status, 201);
  assert.match(sent[0].body, /1 line, 2 actions, 10\.0 in total/);
  assert.deepEqual(planFence(sent[0].body).actions, [
    { type: "roller_on", line: 1, along: 2.35, at: [2.35, 0], detail: "" },
    { type: "score", line: 1, along: 10, at: [10, 0], detail: "second `Pin`" },
  ]);
  assert.ok(!sent[0].body.split("```json")[1].includes("`Pin"), "a backtick in a detail can't close the fence");
  const old = await sendPlanWith(plansPost({ ...goodPlan, lines: onePlanLine }));
  assert.equal(old.response.status, 201);
  assert.deepEqual(planFence(old.sent[0].body).actions, []);
});

test("POST /plans refuses a bad action", async () => {
  const good = { type: "score", line: 1, along: 5, at: [5, 0], detail: "" };
  const bad = [
    "nope", [good, null], [{ ...good, type: "Score!" }], [{ ...good, line: 0 }], [{ ...good, line: 2 }], [{ ...good, line: 1.5 }],
    [{ ...good, along: -1 }], [{ ...good, along: 11.5 }], [{ ...good, along: "5" }], [{ ...good, at: [5] }], [{ ...good, at: [5, 101] }],
    [{ ...good, detail: "x".repeat(121) }], [{ ...good, detail: undefined }], Array.from({ length: 201 }, () => good),
  ];
  for (const actions of bad) {
    const { response, sent } = await sendPlanWith(plansPost({ ...goodPlan, lines: onePlanLine, actions }));
    assert.equal(response.status, 400, JSON.stringify(actions).slice(0, 80));
    assert.equal(sent.length, 0);
  }
  const rounds = await sendPlanWith(plansPost({ ...goodPlan, lines: [{ points: [[0, 0], [5.01, 0]] }], actions: [{ ...good, along: 6.014 }] }));
  assert.equal(rounds.response.status, 201);
  const roundsOver = await sendPlanWith(plansPost({ ...goodPlan, lines: [{ points: [[0, 0], [5, 0]] }], actions: [{ ...good, along: 6.006 }] }));
  assert.equal(roundsOver.response.status, 400, "checked after rounding, as the reader sees it");
  const edge = await sendPlanWith(plansPost({ ...goodPlan, lines: onePlanLine, actions: [{ ...good, along: 11 }] }));
  assert.equal(edge.response.status, 201, "the line's length plus 1 in is allowed");
});

test("POST /plans is limited per address before the code is checked or GitHub is asked", async () => {
  const keys = [];
  const testEnv = { ...plansEnv, LIMITER: { limit: async ({ key }) => { keys.push(key); return { success: false }; } } };
  const { response, sent } = await sendPlanWith(plansPost(goodPlan, { "X-Team-Code": "wrong", "CF-Connecting-IP": "203.0.113.9" }), testEnv);
  assert.equal(response.status, 429);
  assert.equal(response.headers.get("Access-Control-Allow-Origin"), pagesOrigin);
  assert.deepEqual(keys, ["203.0.113.9"]);
  assert.equal(sent.length, 0);
});

test("POST /plans: GitHub refusing the label retries unlabelled and still succeeds", async () => {
  const { response, sent } = await sendPlanWith(plansPost(), plansEnv, (fields, all) => (
    fields.labels ? new Response("{}", { status: 422 }) : Response.json({ number: 77 + all.length }, { status: 201 })
  ));
  assert.equal(response.status, 201);
  assert.deepEqual(await response.json(), { ok: true, issue: 79 });
  assert.equal(sent.length, 2);
  assert.deepEqual(sent[0].labels, ["proposed-auto-plan"]);
  assert.equal(sent[1].labels, undefined);
  assert.equal(sent[1].title, sent[0].title);
  assert.equal(sent[1].body, sent[0].body);
});

test("POST /plans: a 422 on the unlabelled retry too is a 502", async () => {
  const { response, sent } = await sendPlanWith(plansPost(), plansEnv, () => new Response("{}", { status: 422 }));
  assert.equal(response.status, 502);
  assert.equal(sent.length, 2);
});

test("POST /plans: GitHub failures are 502 without exposing the token or the code", async () => {
  const answers = [
    () => Response.json({ message: "secret details" }, { status: 500 }),
    () => { throw new TypeError("network down"); },
    () => new Response("<html>", { status: 201 }),
    () => Response.json({ number: "42" }, { status: 201 }),
  ];
  for (const answer of answers) {
    const { response } = await sendPlanWith(plansPost(), plansEnv, answer);
    assert.equal(response.status, 502);
    assert.equal(response.headers.get("Access-Control-Allow-Origin"), pagesOrigin);
    const text = await response.text();
    assert.doesNotMatch(text, /test-token|code-1234|secret details/);
    assert.equal(JSON.parse(text).ok, false);
  }
});

test("OPTIONS /plans allows the Pages origin, POST, and the three headers, with no code", async () => {
  const response = await worker.fetch(new Request(plansUrl, { method: "OPTIONS", headers: { Origin: "https://evil.example" } }), {});
  assert.equal(response.status, 204);
  assert.equal(response.headers.get("Access-Control-Allow-Origin"), pagesOrigin);
  assert.equal(response.headers.get("Access-Control-Allow-Methods"), "POST, OPTIONS");
  assert.equal(response.headers.get("Access-Control-Allow-Headers"), "X-Team-Code, X-Scourge-Client, Content-Type");
});

test("other methods on /plans are refused", async () => {
  const response = await worker.fetch(new Request(plansUrl, { headers: { "X-Team-Code": "code-1234" } }), plansEnv);
  assert.equal(response.status, 405);
});

test("adding /plans leaves /map's CORS and /results' lack of it alone", async () => {
  const map = await worker.fetch(new Request(mapUrl, { method: "OPTIONS" }), {});
  assert.equal(map.headers.get("Access-Control-Allow-Methods"), "GET, OPTIONS");
  assert.equal(map.headers.get("Access-Control-Allow-Headers"), "X-Team-Code");
  const { response } = await sendWith({}, env);
  assert.equal(response.headers.get("Access-Control-Allow-Origin"), null);
});

function simPut(tag, body, headers = { Authorization: "Bearer ingest-1234" }, method = "PUT") {
  return new Request(`https://relay.example/map/sim/${tag}`, { method, headers, body: method === "PUT" ? body : undefined });
}

test("PUT /map/sim stores the prediction for that build and as latest, and GET serves it", async () => {
  const env = mapEnv();
  const put = await worker.fetch(simPut("build-234-abc1234", '{"schema":1,"routes":[]}'), env);
  assert.equal(put.status, 200);
  for (const query of ["?build=build-234-abc1234", ""]) {
    const got = await (await worker.fetch(mapGet(query), env)).json();
    assert.deepEqual(got.sim, { schema: 1, routes: [] });
  }
});

test("PUT /map/sim refuses a wrong token and stores nothing", async () => {
  const env = mapEnv();
  for (const headers of [{}, { Authorization: "Bearer nope" }, { Authorization: "Bearer code-1234" }]) {
    assert.equal((await worker.fetch(simPut("build-1-a", "{}", headers), env)).status, 401);
  }
  assert.equal((await (await worker.fetch(mapGet(), env)).json()).sim, null);
});

test("PUT /map/sim refuses bad tags, bad JSON, other methods, and a missing token secret", async () => {
  const env = mapEnv();
  assert.equal((await worker.fetch(simPut("latest", "{}"), env)).status, 400);
  assert.equal((await worker.fetch(simPut("a%2Fb", "{}"), env)).status, 400);
  assert.equal((await worker.fetch(simPut("build-1-a", "not json"), env)).status, 400);
  assert.equal((await worker.fetch(simPut("build-1-a", "[1]"), env)).status, 400);
  assert.equal((await worker.fetch(simPut("build-1-a", null, {}, "GET"), env)).status, 405);
  const open = mapEnv();
  delete open.INGEST_TOKEN;
  assert.equal((await worker.fetch(simPut("build-1-a", "{}"), open)).status, 500);
});

/* ---------- alliance partners ---------- */

const partnersUrl = "https://relay.example/partners";
const partnerMapUrl = "https://relay.example/partner/map";
const samplePoints = (n, x0) => Array.from({ length: n }, (_, i) => ({ t: i * 100, x: x0 + i, y: -60 + i, h: 0 }));
const opening = { t: 2970, step: -1, type: "opening", tx: 1.48, ty: -45.35, th: 90.57, x: 1.48, y: -45.35, h: 90.57, ok: true };
// The shape sim_export.py writes, with every kind of route it can hold. The commit is the tag's short hash, as in a real export.
function simBlob(tag = "build-70-abc1234", build = 70) {
  return JSON.stringify({
    schema: 1, tag, build, commit: tag.split("-").pop(), generated: "2026-11-09T20:37:44Z", assumptions: "calibrated to Build 251",
    routes: [
      { id: "awp-L", slot: null, name: "AWP", side: "L", total_ms: 13050, samples: samplePoints(5, 8), events: [opening], secret: "x" },
      { id: "awp-R", slot: null, name: "AWP", side: "R", total_ms: 13050, samples: samplePoints(5, 8), events: [opening] },
      { id: "taught-A-L", slot: "A", name: "Taught A", side: "L", total_ms: 9000, samples: samplePoints(5, 20), events: [] },
      { id: "taught-A-R", slot: "A", name: "Taught A", side: "R", total_ms: 9000, samples: samplePoints(5, 20), events: [] },
      { id: "recf", slot: "recf", name: "RECF: right Goal + roller", side: "R", field: "pinnacle", total_ms: 8100, samples: samplePoints(5, 60), events: [] },
      { id: "skills", slot: "skills", name: "Skills", side: "L", field: "skills", total_ms: 52800, samples: samplePoints(5, 30), events: [opening] },
      { id: "future-route", slot: null, name: "New", side: "L", samples: samplePoints(5, 0), events: [] },
    ],
  });
}

function partnerEnv(values = {}, teams = null) {
  const env = mapEnv({ "sim/latest": simBlob("build-71-def5678", 71), "sim/build-70-abc1234": simBlob(), recorded: '{"sessions":[{"id":"run-1"}]}', ...values });
  if (teams) env.MAP.store.set("partners", JSON.stringify({ version: 1, teams }));
  return env;
}
const archive = { name: "Archive", code: "archive", build: "latest", added: "2026-11-09T00:00:00.000Z" };

function partnerGet(code, url = partnerMapUrl) {
  return new Request(url, { headers: code === null ? {} : { "X-Partner-Code": code } });
}
function partnersCall(method, { body, query = "", code = "code-1234", headers = {} } = {}) {
  return new Request(partnersUrl + query, {
    method,
    headers: { ...(code === null ? {} : { "X-Team-Code": code }), ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...headers },
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  });
}
const addTeam = (env, body) => worker.fetch(partnersCall("POST", { body }), env);

test("GET /partner/map with the right code returns only the match auton routes", async () => {
  const env = partnerEnv({}, [archive]);
  for (const code of ["archive", "Archive ", "  ARCHIVE"]) {
    const response = await worker.fetch(partnerGet(code), env);
    assert.equal(response.status, 200, code);
    assert.equal(response.headers.get("Access-Control-Allow-Origin"), pagesOrigin);
    assert.equal(response.headers.get("Cache-Control"), "no-store");
    const text = await response.text();
    const body = JSON.parse(text);
    assert.deepEqual(Object.keys(body).sort(), ["build", "generated", "ok", "routes", "tag", "team"]);
    assert.equal(body.team, "Archive");
    assert.equal(body.tag, "build-71-def5678");
    assert.equal(body.build, 71);
    assert.equal(body.generated, "2026-11-09T20:37:44.000Z");
    assert.deepEqual(body.routes.map((r) => r.id), ["awp-L", "awp-R"]);
    assert.deepEqual(Object.keys(body.routes[0]).sort(), ["events", "id", "name", "samples", "side", "total_ms"]);
    assert.deepEqual(body.routes[0].events, [opening]);
    for (const leak of ["taught", "recf", "skills", "Skills", "RECF", "future-route", "recorded", "sessions", "run-1", "assumptions", "secret", "code-1234", "archive"]) {
      assert.doesNotMatch(text, new RegExp(leak), leak);
    }
    // The commit field is left out, but the tag carries the same short hash, as the public release names do.
    assert.equal("commit" in body, false);
    assert.equal(JSON.parse(env.MAP.store.get("sim/latest")).commit, "def5678");
    assert.ok(body.tag.endsWith("-def5678"));
  }
});

test("GET /partner/map with a wrong, missing or team code is 401 with one body", async () => {
  const env = partnerEnv({}, [archive]);
  const bodies = new Set();
  for (const code of [null, "", "archiv", "archive2", "code-1234", "ingest-1234", "x".repeat(5000)]) {
    const response = await worker.fetch(partnerGet(code), env);
    assert.equal(response.status, 401, String(code).slice(0, 10));
    assert.equal(response.headers.get("Access-Control-Allow-Origin"), pagesOrigin);
    bodies.add(await response.text());
  }
  assert.deepEqual([...bodies], ['{"ok":false,"error":"wrong password"}']);
  const none = await worker.fetch(partnerGet("archive"), partnerEnv());
  assert.equal(none.status, 401, "no partner list means no partner gets in");
});

test("a partner code is refused by every other endpoint", async () => {
  const env = partnerEnv({}, [archive]);
  const map = await worker.fetch(mapGet("", { "X-Team-Code": "archive" }), env);
  assert.equal(map.status, 401);
  const partners = await worker.fetch(partnersCall("GET", { code: "archive" }), env);
  assert.equal(partners.status, 401);
  const asPartnerHeader = await worker.fetch(new Request(partnersUrl, { headers: { "X-Partner-Code": "archive" } }), env);
  assert.equal(asPartnerHeader.status, 401);
  const plans = await sendPlanWith(plansPost(goodPlan, { "X-Team-Code": "archive" }));
  assert.equal(plans.response.status, 401);
  const { response, sent } = await sendWith({ "X-Team-Code": "archive" }, { ...env, GITHUB_TOKEN: "test-token" });
  assert.equal((await response.json()).on_map, false);
  assert.equal(sent[0].labels, undefined);
  const sim = await worker.fetch(simPut("build-1-aaaaaaa", "{}", { Authorization: "Bearer archive" }), env);
  assert.equal(sim.status, 401);
  const recorded = await worker.fetch(recordedPut("{}", { Authorization: "Bearer archive" }), env);
  assert.equal(recorded.status, 401);
});

test("the partner endpoint reads only the partner list and that one prediction", async () => {
  const env = partnerEnv({}, [{ ...archive, build: "build-70-abc1234" }]);
  const reads = [];
  const get = env.MAP.get;
  env.MAP.get = async (key) => { reads.push(key); return get(key); };
  const body = await (await worker.fetch(partnerGet("archive"), env)).json();
  assert.deepEqual(reads, ["partners", "sim/build-70-abc1234"]);
  assert.equal(body.tag, "build-70-abc1234");
  assert.equal(body.build, 70);
});

test("a pinned build stays pinned, latest follows sim/latest", async () => {
  const env = partnerEnv({}, [{ ...archive, build: "build-70-abc1234" }, { name: "Other", code: "other", build: "latest", added: archive.added }]);
  assert.equal((await (await worker.fetch(partnerGet("archive"), env)).json()).tag, "build-70-abc1234");
  assert.equal((await (await worker.fetch(partnerGet("other"), env)).json()).tag, "build-71-def5678");
  env.MAP.store.set("sim/latest", simBlob("build-72-0123456", 72));
  assert.equal((await (await worker.fetch(partnerGet("archive"), env)).json()).tag, "build-70-abc1234");
  assert.equal((await (await worker.fetch(partnerGet("other"), env)).json()).tag, "build-72-0123456");
});

test("a partner cannot choose a build", async () => {
  const env = partnerEnv({}, [{ ...archive, build: "build-70-abc1234" }]);
  const body = await (await worker.fetch(partnerGet("archive", `${partnerMapUrl}?build=build-71-def5678`), env)).json();
  assert.equal(body.tag, "build-70-abc1234");
});

test("GET /partner/map fails closed on a missing or odd prediction", async () => {
  const blobs = [
    undefined, "not json", "[]", "null", '{"routes":"x"}', '{"schema":2,"routes":[]}',
    JSON.stringify({ routes: [{ id: "skills", samples: samplePoints(5, 0) }] }),
    JSON.stringify({ routes: [{ id: "awp-L", slot: "A", samples: samplePoints(5, 0) }] }),
    JSON.stringify({ routes: [{ id: "awp-L", field: "skills", samples: samplePoints(5, 0) }] }),
    JSON.stringify({ routes: [{ id: "awp-L", side: "R", samples: samplePoints(5, 0) }] }),
    JSON.stringify({ routes: [{ id: "awp-L", samples: [{ t: 0, x: 0, y: 0 }, { t: 1, x: "1", y: 0 }] }] }),
    JSON.stringify({ routes: [{ id: "awp-L", samples: samplePoints(1, 0) }] }),
    JSON.stringify({ routes: [{ id: "awp-L", samples: samplePoints(5, 0), events: "x" }] }),
  ];
  for (const blob of blobs) {
    const env = partnerEnv({}, [archive]);
    if (blob === undefined) env.MAP.store.delete("sim/latest");
    else env.MAP.store.set("sim/latest", blob);
    const response = await worker.fetch(partnerGet("archive"), env);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true, team: "Archive", tag: null, build: null, generated: null, routes: [] }, String(blob).slice(0, 60));
  }
});

test("a damaged partner list lets nobody in", async () => {
  for (const stored of ["not json", "[]", '{"version":2,"teams":[]}', '{"version":1,"teams":[{"name":"A","code":""}]}']) {
    const env = partnerEnv();
    env.MAP.store.set("partners", stored);
    assert.equal((await worker.fetch(partnerGet(""), env)).status, 401, stored);
    assert.equal((await worker.fetch(partnerGet("archive"), env)).status, 401, stored);
  }
});

test("GET /partner/map is rate limited before anything is read", async () => {
  const env = partnerEnv({}, [archive]);
  const keys = [];
  env.LIMITER_READ = { limit: async ({ key }) => { keys.push(key); return { success: false }; } };
  env.MAP.get = async () => { throw new Error("read before the limit"); };
  const response = await worker.fetch(new Request(partnerMapUrl, { headers: { "X-Partner-Code": "archive", "CF-Connecting-IP": "203.0.113.9" } }), env);
  assert.equal(response.status, 429);
  assert.equal(response.headers.get("Access-Control-Allow-Origin"), pagesOrigin);
  assert.deepEqual(keys, ["203.0.113.9"]);
});

test("OPTIONS on the partner paths allows exactly the Pages origin and their headers", async () => {
  const one = await worker.fetch(new Request(partnerMapUrl, { method: "OPTIONS", headers: { Origin: "https://evil.example" } }), {});
  assert.equal(one.status, 204);
  assert.equal(one.headers.get("Access-Control-Allow-Origin"), pagesOrigin);
  assert.equal(one.headers.get("Access-Control-Allow-Methods"), "GET, OPTIONS");
  assert.equal(one.headers.get("Access-Control-Allow-Headers"), "X-Partner-Code");
  const all = await worker.fetch(new Request(partnersUrl, { method: "OPTIONS" }), {});
  assert.equal(all.status, 204);
  assert.equal(all.headers.get("Access-Control-Allow-Origin"), pagesOrigin);
  assert.equal(all.headers.get("Access-Control-Allow-Methods"), "GET, POST, DELETE, OPTIONS");
  assert.equal(all.headers.get("Access-Control-Allow-Headers"), "X-Team-Code, Content-Type");
  const map = await worker.fetch(new Request(mapUrl, { method: "OPTIONS" }), {});
  assert.equal(map.headers.get("Access-Control-Allow-Headers"), "X-Team-Code", "/map is unchanged");
});

test("other methods on the partner paths are refused", async () => {
  const env = partnerEnv({}, [archive]);
  assert.equal((await worker.fetch(new Request(partnerMapUrl, { method: "POST", headers: { "X-Partner-Code": "archive" }, body: "{}" }), env)).status, 405);
  assert.equal((await worker.fetch(partnersCall("PUT", { body: {} }), env)).status, 405);
});

test("managing partners needs the team code, and stores nothing without it", async () => {
  for (const code of [null, "", "code-1235", "archive"]) {
    const env = partnerEnv({}, [archive]);
    for (const req of [partnersCall("GET", { code }), partnersCall("POST", { code, body: { name: "B", code: "bbbb", build: "latest" } }), partnersCall("DELETE", { code, query: "?name=Archive" })]) {
      const response = await worker.fetch(req, env);
      assert.equal(response.status, 401);
      assert.equal(response.headers.get("Access-Control-Allow-Origin"), pagesOrigin);
      assert.deepEqual(await response.json(), { ok: false, error: "wrong team code" });
    }
    assert.deepEqual(JSON.parse(env.MAP.store.get("partners")).teams, [archive]);
  }
  const open = partnerEnv();
  delete open.TEAM_CODE;
  assert.equal((await worker.fetch(partnersCall("GET", { code: "" }), open)).status, 500);
});

test("add, list, update and remove a partner", async () => {
  const env = partnerEnv();
  assert.deepEqual(await (await worker.fetch(partnersCall("GET"), env)).json(), { ok: true, teams: [] });
  const added = await addTeam(env, { name: "  Archive ", code: " Archive ", build: "latest", junk: "dropped" });
  assert.equal(added.status, 201);
  const [team] = (await added.json()).teams;
  assert.deepEqual(Object.keys(team).sort(), ["added", "build", "code", "name"]);
  assert.equal(team.name, "Archive");
  assert.equal(team.code, "archive");
  assert.ok(!Number.isNaN(Date.parse(team.added)));
  assert.equal((await worker.fetch(partnerGet("archive"), env)).status, 200);

  const updated = await addTeam(env, { name: "archive", code: "new-pass", build: "build-70-abc1234" });
  assert.equal(updated.status, 200);
  const teams = (await updated.json()).teams;
  assert.equal(teams.length, 1);
  assert.equal(teams[0].added, team.added, "an update keeps when it was added");
  assert.equal((await worker.fetch(partnerGet("archive"), env)).status, 401, "the old password stops working");
  assert.equal((await (await worker.fetch(partnerGet("new-pass"), env)).json()).tag, "build-70-abc1234");

  assert.equal((await worker.fetch(partnersCall("DELETE", { query: "?name=Nobody" }), env)).status, 404);
  const removed = await worker.fetch(partnersCall("DELETE", { query: "?name=ARCHIVE" }), env);
  assert.equal(removed.status, 200);
  assert.deepEqual((await removed.json()).teams, []);
  assert.equal((await worker.fetch(partnerGet("new-pass"), env)).status, 401, "access removed");
});

test("partner validation", async () => {
  const env = partnerEnv({}, [archive]);
  const bad = [
    ["not an object", []],
    ["no name", { code: "abcd", build: "latest" }],
    ["blank name", { name: "   ", code: "abcd", build: "latest" }],
    ["name of control characters", { name: "\u0000\u0007", code: "abcd", build: "latest" }],
    ["name of invisible formatting characters", { name: "\u200b\u200f\u202e\u2066\ufeff", code: "abcd", build: "latest" }],
    ["name over 40", { name: "n".repeat(41), code: "abcd", build: "latest" }],
    ["no code", { name: "B", build: "latest" }],
    ["empty code", { name: "B", code: "", build: "latest" }],
    ["code of spaces", { name: "B", code: "      ", build: "latest" }],
    ["code under 4", { name: "B", code: "abc", build: "latest" }],
    ["code over 64", { name: "B", code: "c".repeat(65), build: "latest" }],
    ["code with non-ASCII", { name: "B", code: "café-1", build: "latest" }],
    ["number code", { name: "B", code: 12345, build: "latest" }],
    ["the team code", { name: "B", code: "code-1234", build: "latest" }],
    ["the team code in other case", { name: "B", code: " CODE-1234 ", build: "latest" }],
    ["the ingest token", { name: "B", code: "ingest-1234", build: "latest" }],
    ["another team's code", { name: "B", code: "ARCHIVE", build: "latest" }],
    ["no build", { name: "B", code: "bbbb" }],
    ["a bad build", { name: "B", code: "bbbb", build: "../recorded" }],
    ["a build with no prediction", { name: "B", code: "bbbb", build: "build-1-aaaaaaa" }],
    ["a recorded key as build", { name: "B", code: "bbbb", build: "recorded" }],
  ];
  for (const [name, body] of bad) {
    const response = await addTeam(env, body);
    assert.equal(response.status, 400, name);
    assert.equal((await response.json()).ok, false);
    assert.deepEqual(JSON.parse(env.MAP.store.get("partners")).teams, [archive], name);
  }
  assert.equal((await worker.fetch(partnersCall("POST", { body: "{" }), env)).status, 400);
  assert.equal((await worker.fetch(partnersCall("POST", { body: { name: "B", code: "x".repeat(5000), build: "latest" } }), env)).status, 413);
  for (const ok of [{ name: "n".repeat(40), code: "c".repeat(64), build: "latest" }, { name: "Four", code: "four", build: "build-70-abc1234" }]) {
    assert.equal((await addTeam(env, ok)).status, 201, ok.name);
  }
});

test("invisible formatting characters are taken out of a partner's name", async () => {
  const env = partnerEnv();
  const added = await addTeam(env, { name: "\u202eIron\u200b Lions\u2069\ufeff", code: "iron-lions-9", build: "latest" });
  assert.equal(added.status, 201);
  assert.equal((await added.json()).teams[0].name, "Iron Lions");
  const removed = await worker.fetch(partnersCall("DELETE", { query: "?name=Iron%E2%80%8B%20Lions" }), env);
  assert.equal(removed.status, 200, "a name sent with one still matches");
});

test("the list holds 20 teams; an update still works when it is full", async () => {
  const env = partnerEnv();
  for (let i = 0; i < 20; i += 1) assert.equal((await addTeam(env, { name: `Team ${i}`, code: `pass-${i}`, build: "latest" })).status, 201);
  const full = await addTeam(env, { name: "Team 20", code: "pass-20", build: "latest" });
  assert.equal(full.status, 400);
  assert.match((await full.json()).error, /20 teams/);
  assert.equal((await addTeam(env, { name: "Team 3", code: "pass-three", build: "latest" })).status, 200);
  assert.equal(JSON.parse(env.MAP.store.get("partners")).teams.length, 20);
});

test("partner changes use the stricter limit, the list read the read limit, before the code check", async () => {
  const env = partnerEnv();
  const used = [];
  env.LIMITER = { limit: async () => { used.push("write"); return { success: false }; } };
  env.LIMITER_READ = { limit: async () => { used.push("read"); return { success: false }; } };
  assert.equal((await worker.fetch(partnersCall("POST", { code: "wrong", body: {} }), env)).status, 429);
  assert.equal((await worker.fetch(partnersCall("DELETE", { code: "wrong", query: "?name=a" }), env)).status, 429);
  assert.equal((await worker.fetch(partnersCall("GET", { code: "wrong" }), env)).status, 429);
  assert.deepEqual(used, ["write", "write", "read"]);
});
