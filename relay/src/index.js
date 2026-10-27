const REPOSITORY = "Whyater/40217S-Robot-Data";
const MAX_REQUEST_BYTES = 1_000_000;
const MAX_BODY_CHARS = 600_000;
const MAX_ISSUE_CHARS = 60_000;
const MAX_PARTS = 12; // 600000 chars always fits: part headers and whole-line packing waste far less than 2 parts

function jsonResponse(payload, status) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function splitDataLines(data) {
  const lines = data.match(/[\s\S]*?(?:\r\n|\n|$)/g)?.filter(Boolean) ?? [];
  return lines;
}

function makeParts(header, data, lineEnding) {
  const lines = splitDataLines(data);

  for (let partCount = 2; partCount <= MAX_PARTS; partCount += 1) {
    const chunks = [];
    let current = "";

    for (const line of lines) {
      let index = chunks.length;
      let capacity = MAX_ISSUE_CHARS - `${header} (part ${index + 1} of ${partCount})${lineEnding}${lineEnding}`.length;
      if (current && current.length + line.length > capacity) {
        chunks.push(current);
        current = "";
        index = chunks.length;
        capacity = MAX_ISSUE_CHARS - `${header} (part ${index + 1} of ${partCount})${lineEnding}${lineEnding}`.length;
      }
      if (line.length > capacity) return null;
      current += line;
    }
    if (current) chunks.push(current);

    if (chunks.length === partCount) {
      return chunks.map((chunk, index) => ({
        titleSuffix: ` (part ${index + 1} of ${partCount})`,
        body: `${header} (part ${index + 1} of ${partCount})${lineEnding}${lineEnding}${chunk}`,
      }));
    }
  }
  return null;
}

async function readRequestBody(request) {
  const contentLength = request.headers.get("Content-Length");
  if (contentLength !== null) {
    const parsedLength = Number(contentLength);
    if (!Number.isFinite(parsedLength) || parsedLength > MAX_REQUEST_BYTES) {
      return { error: jsonResponse({ ok: false, error: "request too large" }, 413) };
    }
  }

  const bytes = await request.arrayBuffer();
  if (bytes.byteLength > MAX_REQUEST_BYTES) {
    return { error: jsonResponse({ ok: false, error: "request too large" }, 413) };
  }
  return { text: new TextDecoder().decode(bytes) };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname !== "/results") {
      return jsonResponse({ ok: false, error: "not found" }, 404);
    }
    if (request.method !== "POST") {
      return jsonResponse({ ok: false, error: "method not allowed" }, 405);
    }
    if (!request.headers.get("X-Scourge-Client")) {
      return jsonResponse({ ok: false, error: "missing X-Scourge-Client" }, 403);
    }
    // The client is public, so anyone can call this. A per-address limit keeps a spammer to a
    // trickle of issues; a whole team sending from one school address stays far under it.
    if (env?.LIMITER) {
      const { success } = await env.LIMITER.limit({ key: request.headers.get("CF-Connecting-IP") || "unknown" });
      if (!success) return jsonResponse({ ok: false, error: "too many sends, try again in a minute" }, 429);
    }
    if (!env?.GITHUB_TOKEN) {
      return jsonResponse({ ok: false, error: "relay not configured" }, 500);
    }

    const bodyRead = await readRequestBody(request);
    if (bodyRead.error) return bodyRead.error;

    let payload;
    try {
      payload = JSON.parse(bodyRead.text);
    } catch {
      return jsonResponse({ ok: false, error: "invalid JSON" }, 400);
    }

    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      return jsonResponse({ ok: false, error: "JSON must be an object" }, 400);
    }
    if (typeof payload.title !== "string" || !/^Robot data \d{4}-\d{2}-\d{2}$/.test(payload.title)) {
      return jsonResponse({ ok: false, error: "invalid title" }, 400);
    }
    if (typeof payload.body !== "string") {
      return jsonResponse({ ok: false, error: "body must be a string" }, 400);
    }
    if (payload.body.length > MAX_BODY_CHARS) {
      return jsonResponse({ ok: false, error: "body too large" }, 413);
    }

    const firstBreak = payload.body.search(/\r?\n/);
    if (firstBreak < 0) {
      return jsonResponse({ ok: false, error: "body needs a header and data" }, 400);
    }
    const lineEnding = payload.body[firstBreak] === "\r" ? "\r\n" : "\n";
    const header = payload.body.slice(0, firstBreak);
    if (!header.startsWith("Uploader ") || header.length > 300) {
      return jsonResponse({ ok: false, error: "invalid body header" }, 400);
    }
    const afterHeader = payload.body.slice(firstBreak + lineEnding.length);
    if (!afterHeader.startsWith(lineEnding)) {
      return jsonResponse({ ok: false, error: "body needs a blank line after header" }, 400);
    }
    const data = afterHeader.slice(lineEnding.length);
    if (!splitDataLines(data).some((line) => line.replace(/\r?\n$/, "").length > 0)) {
      return jsonResponse({ ok: false, error: "body needs data" }, 400);
    }

    let issues = [{ titleSuffix: "", body: payload.body }];
    if (payload.body.length > MAX_ISSUE_CHARS) {
      issues = makeParts(header, data, lineEnding) ?? [];
      if (issues.length === 0) {
        return jsonResponse({ ok: false, error: "body cannot be split into issue-sized parts" }, 413);
      }
    }

    const numbers = [];
    for (const issue of issues) {
      let response;
      try {
        response = await fetch(`https://api.github.com/repos/${REPOSITORY}/issues`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${env.GITHUB_TOKEN}`,
            Accept: "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
            "User-Agent": "40217S-results-relay",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ title: payload.title + issue.titleSuffix, body: issue.body }),
        });
      } catch {
        return jsonResponse({ ok: false, error: "GitHub unavailable", issues: numbers }, 502);
      }
      if (!response.ok) {
        return jsonResponse({ ok: false, error: `GitHub answered ${response.status}`, issues: numbers }, 502);
      }
      let created;
      try {
        created = await response.json();
      } catch {
        return jsonResponse({ ok: false, error: "GitHub answered with invalid JSON", issues: numbers }, 502);
      }
      if (!Number.isInteger(created?.number)) {
        return jsonResponse({ ok: false, error: "GitHub answered with invalid JSON", issues: numbers }, 502);
      }
      numbers.push(created.number);
    }

    return jsonResponse({ ok: true, issues: numbers }, 201);
  },
};
