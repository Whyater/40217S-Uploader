const REPOSITORY = "Whyater/40217S-Robot-Data";
const MAX_REQUEST_BYTES = 1_000_000;
const MAX_BODY_CHARS = 600_000;
const MAX_ISSUE_CHARS = 60_000;
const MAX_PARTS = 12; // 600000 chars always fits: part headers and whole-line packing waste far less than 2 parts
const MAX_RECORDED_BYTES = 10_000_000;
const PAGES_ORIGIN = "https://whyater.github.io";
const TEAM_LABEL = "team";
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": PAGES_ORIGIN,
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "X-Team-Code",
};
const BUILD_TAG = /^(?!latest$)[\w.-]{1,100}$/;

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

async function readRequestBody(request, maxBytes = MAX_REQUEST_BYTES) {
  const contentLength = request.headers.get("Content-Length");
  if (contentLength !== null) {
    const parsedLength = Number(contentLength);
    if (!Number.isFinite(parsedLength) || parsedLength > maxBytes) {
      return { error: jsonResponse({ ok: false, error: "request too large" }, 413) };
    }
  }

  const bytes = await request.arrayBuffer();
  if (bytes.byteLength > maxBytes) {
    return { error: jsonResponse({ ok: false, error: "request too large" }, 413) };
  }
  return { text: new TextDecoder().decode(bytes) };
}

function mapResponse(payload, status) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...CORS_HEADERS },
  });
}

function sameSecret(given, secret) {
  const a = new TextEncoder().encode(given ?? "");
  const b = new TextEncoder().encode(secret);
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let i = 0; i < a.length; i += 1) difference |= a[i] ^ b[i];
  return difference === 0;
}

async function handleMap(request, env, url) {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }
  if (request.method !== "GET") {
    return mapResponse({ ok: false, error: "method not allowed" }, 405);
  }
  if (env?.LIMITER_READ) {
    const { success } = await env.LIMITER_READ.limit({ key: request.headers.get("CF-Connecting-IP") || "unknown" });
    if (!success) return mapResponse({ ok: false, error: "too many tries, try again in a minute" }, 429);
  }
  if (!env?.TEAM_CODE || !env?.MAP) {
    return mapResponse({ ok: false, error: "relay not configured" }, 500);
  }
  if (!sameSecret(request.headers.get("X-Team-Code"), env.TEAM_CODE)) {
    return mapResponse({ ok: false, error: "wrong team code" }, 401);
  }

  const tag = url.searchParams.get("build");
  let simKey = "sim/latest";
  if (tag) simKey = BUILD_TAG.test(tag) ? `sim/${tag}` : null;
  const [sim, recorded, recordedUpdated] = await Promise.all([
    simKey ? env.MAP.get(simKey) : null,
    env.MAP.get("recorded"),
    env.MAP.get("recorded_updated"),
  ]);
  // Both values are JSON by the time they're stored (PUT checks one, sim_export writes the other), so they are joined
  // as text. Parsing megabytes on every read would spend the Worker's CPU limit for nothing.
  const body = `{"ok":true,"sim":${sim ?? "null"},"recorded":${recorded ?? "null"},` +
    `"recorded_updated":${JSON.stringify(recordedUpdated)},"sim_is_latest":${!tag}}`;
  return new Response(body, {
    status: 200,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...CORS_HEADERS },
  });
}

async function handleRecorded(request, env) {
  if (request.method !== "PUT") {
    return jsonResponse({ ok: false, error: "method not allowed" }, 405);
  }
  if (!env?.INGEST_TOKEN || !env?.MAP) {
    return jsonResponse({ ok: false, error: "relay not configured" }, 500);
  }
  const auth = request.headers.get("Authorization") ?? "";
  if (!auth.startsWith("Bearer ") || !sameSecret(auth.slice("Bearer ".length), env.INGEST_TOKEN)) {
    return jsonResponse({ ok: false, error: "wrong token" }, 401);
  }

  const bodyRead = await readRequestBody(request, MAX_RECORDED_BYTES);
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

  const updated = new Date().toISOString();
  await env.MAP.put("recorded", bodyRead.text);
  await env.MAP.put("recorded_updated", updated);
  return jsonResponse({ ok: true, recorded_updated: updated }, 200);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/map") return handleMap(request, env, url);
    if (url.pathname === "/map/recorded") return handleRecorded(request, env);
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

    // Only the relay sets the label: a sender can only earn it with the team code, and a wrong code still files.
    const onMap = Boolean(env.TEAM_CODE) && sameSecret(request.headers.get("X-Team-Code"), env.TEAM_CODE);
    const labels = onMap ? { labels: [TEAM_LABEL] } : {};

    const createIssue = (fields) => fetch(`https://api.github.com/repos/${REPOSITORY}/issues`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.GITHUB_TOKEN}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "40217S-results-relay",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(fields),
    });

    const numbers = [];
    let allLabelled = onMap;
    for (const issue of issues) {
      const fields = { title: payload.title + issue.titleSuffix, body: issue.body };
      let response;
      try {
        response = await createIssue({ ...fields, ...labels });
        // A label problem must never lose the results: file them unlabelled, and say they won't reach the map.
        if (onMap && response.status === 422) {
          allLabelled = false;
          response = await createIssue(fields);
        }
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
      if (!created.labels?.some((label) => label?.name === TEAM_LABEL)) allLabelled = false;
      numbers.push(created.number);
    }

    return jsonResponse({ ok: true, issues: numbers, on_map: allLabelled }, 201);
  },
};
