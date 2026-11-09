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
const PLAN_KIND = "proposed-auto-plan";
const PLAN_LABEL = "proposed-auto-plan";
const PLAN_TITLE = "Proposed auto plan: ";
const MAX_PLAN_BYTES = 200_000;
const PLAN_CORS_HEADERS = {
  "Access-Control-Allow-Origin": PAGES_ORIGIN,
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "X-Team-Code, X-Scourge-Client, Content-Type",
};

// Alliance partners. The list lives in one MAP key; partners read only the match auton prediction.
const PARTNERS_KEY = "partners";
const MAX_PARTNERS = 20;
const PARTNER_NAME_MAX = 40;
const PARTNER_CODE_MIN = 4;
const PARTNER_CODE_MAX = 64;
const MAX_PARTNER_BODY = 4_000;
// A pinned partner build is a release tag, like build-70-abc1234.
const RELEASE_TAG = /^build-\d{1,7}-[0-9a-f]{7,40}$/;
// The 15 s match autonomous, from both starting tiles (sim_export.py's plan()). Taught routes, Skills, RECF and
// anything new are left out until someone adds them here on purpose.
const MATCH_ROUTE_IDS = new Set(["awp-L", "awp-R"]);
const MAX_ROUTE_SAMPLES = 5_000;
const MAX_ROUTE_EVENTS = 500;
const PARTNERS_CORS_HEADERS = {
  "Access-Control-Allow-Origin": PAGES_ORIGIN,
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "X-Team-Code, Content-Type",
};
const PARTNER_CORS_HEADERS = {
  "Access-Control-Allow-Origin": PAGES_ORIGIN,
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "X-Partner-Code",
};

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

function createIssue(env, fields) {
  return fetch(`https://api.github.com/repos/${REPOSITORY}/issues`, {
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
}

function plansResponse(payload, status) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json", ...PLAN_CORS_HEADERS },
  });
}

const isCoordinate = (value) => Number.isFinite(value) && Math.abs(value) <= 100;
const roundCoordinate = (value) => Math.round(value * 100) / 100;
const charCount = (text) => [...text].length;
const titleName = (name) => name.replace(/\p{Cc}/gu, "").trim();

// Builds a new plan from the known fields, so nothing else a sender adds reaches the issue. Null means a bad shape.
function cleanPlan(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  if (payload.schema !== 1 || payload.kind !== PLAN_KIND) return null;
  if (typeof payload.name !== "string" || typeof payload.note !== "string") return null;
  const name = payload.name.trim();
  // A name of only control characters is not empty until the title removes them.
  if (!titleName(name) || charCount(name) > 80 || charCount(payload.note) > 2000) return null;
  if (payload.side !== "L" && payload.side !== "R") return null;
  if (payload.build !== null && (typeof payload.build !== "string" || charCount(payload.build) > 100)) return null;
  if (!Array.isArray(payload.lines) || payload.lines.length < 1 || payload.lines.length > 50) return null;

  let pointCount = 0;
  const lines = [];
  for (const line of payload.lines) {
    const points = line?.points;
    if (!Array.isArray(points) || points.length < 2 || points.length > 500) return null;
    pointCount += points.length;
    if (pointCount > 3000) return null;
    if (!points.every((p) => Array.isArray(p) && p.length === 2 && p.every(isCoordinate))) return null;
    lines.push({ points: points.map((p) => p.map(roundCoordinate)) });
  }
  const actions = cleanActions(payload.actions, lines);
  if (!actions) return null;
  const plan = { schema: 1, kind: PLAN_KIND, name, side: payload.side, note: payload.note, build: payload.build, lines, actions };
  // Absent means the Override field, so only a known value is kept and old plans stay unchanged.
  if (payload.field === "override" || payload.field === "pinnacle") plan.field = payload.field;
  return plan;
}

function lineInches(points) {
  let inches = 0;
  for (let i = 1; i < points.length; i += 1) {
    inches += Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]);
  }
  return inches;
}

// Optional, so a page from before actions still sends. The type is only shape-checked: a new one needs no deploy.
function cleanActions(actions, lines) {
  if (actions === undefined) return [];
  if (!Array.isArray(actions) || actions.length > 200) return null;
  const cleaned = [];
  for (const action of actions) {
    if (!action || typeof action !== "object" || Array.isArray(action)) return null;
    const { type, line, along, at, detail } = action;
    if (typeof type !== "string" || !/^[a-z_]{1,30}$/.test(type)) return null;
    if (!Number.isInteger(line) || line < 1 || line > lines.length) return null;
    if (typeof along !== "number" || !Number.isFinite(along)) return null;
    const rounded = roundCoordinate(along); // checked as stored, so the reader's same check can't refuse what this one let through
    if (rounded < 0 || rounded > lineInches(lines[line - 1].points) + 1) return null;
    if (!Array.isArray(at) || at.length !== 2 || !at.every(isCoordinate)) return null;
    if (typeof detail !== "string" || charCount(detail) > 120) return null;
    cleaned.push({ type, line, along: rounded, at: at.map(roundCoordinate), detail });
  }
  return cleaned;
}

function planIssueBody(plan) {
  let inches = 0;
  for (const { points } of plan.lines) inches += lineInches(points);
  const count = plan.lines.length;
  const acted = plan.actions.length;
  // JSON only holds a backtick inside a string, where \u0060 reads back the same and can't close the fence.
  const json = JSON.stringify(plan).replace(/`/g, "\\u0060");
  const fieldNote = plan.field === "pinnacle" ? " Pinnacle field." : "";
  return `Proposal only, not run on a robot. Side ${plan.side}, ${count} ${count === 1 ? "line" : "lines"}, ` +
    `${acted} ${acted === 1 ? "action" : "actions"}, ${inches.toFixed(1)} in total.${fieldNote}\n\n\`\`\`json\n${json}\n\`\`\`\n`;
}

async function handlePlans(request, env) {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: PLAN_CORS_HEADERS });
  }
  if (request.method !== "POST") {
    return plansResponse({ ok: false, error: "method not allowed" }, 405);
  }
  if (!request.headers.get("X-Scourge-Client")) {
    return plansResponse({ ok: false, error: "missing X-Scourge-Client" }, 403);
  }
  // Before the code check, so this also slows guessing the team code.
  if (env?.LIMITER) {
    const { success } = await env.LIMITER.limit({ key: request.headers.get("CF-Connecting-IP") || "unknown" });
    if (!success) return plansResponse({ ok: false, error: "too many sends, try again in a minute" }, 429);
  }
  if (!env?.TEAM_CODE || !env?.GITHUB_TOKEN) {
    return plansResponse({ ok: false, error: "relay not configured" }, 500);
  }
  if (!sameSecret(request.headers.get("X-Team-Code"), env.TEAM_CODE)) {
    return plansResponse({ ok: false, error: "wrong team code" }, 401);
  }

  const bodyRead = await readRequestBody(request, MAX_PLAN_BYTES);
  if (bodyRead.error) return plansResponse({ ok: false, error: "request too large" }, 413);
  let payload;
  try {
    payload = JSON.parse(bodyRead.text);
  } catch {
    return plansResponse({ ok: false, error: "invalid JSON" }, 400);
  }
  const plan = cleanPlan(payload);
  if (!plan) return plansResponse({ ok: false, error: "invalid plan" }, 400);

  const fields = { title: PLAN_TITLE + titleName(plan.name), body: planIssueBody(plan) };
  // GitHub refuses a body this long, so say so here. Plans can't be split the way results are.
  if (fields.body.length > MAX_ISSUE_CHARS) {
    return plansResponse({ ok: false, error: "plan too long for one issue, use fewer points or actions, or shorter details" }, 413);
  }

  let response;
  try {
    response = await createIssue(env, { ...fields, labels: [PLAN_LABEL] });
    // A missing label must never lose the plan: reading plans goes by the title.
    if (response.status === 422) response = await createIssue(env, fields);
  } catch {
    return plansResponse({ ok: false, error: "GitHub unavailable" }, 502);
  }
  if (!response.ok) {
    return plansResponse({ ok: false, error: `GitHub answered ${response.status}` }, 502);
  }
  let created;
  try {
    created = await response.json();
  } catch {
    return plansResponse({ ok: false, error: "GitHub answered with invalid JSON" }, 502);
  }
  if (!Number.isInteger(created?.number)) {
    return plansResponse({ ok: false, error: "GitHub answered with invalid JSON" }, 502);
  }
  return plansResponse({ ok: true, issue: created.number }, 201);
}

// CI sends the predicted routes of the build it just published. They become that build's and the latest prediction.
async function handleSim(request, env, tag) {
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
  if (!BUILD_TAG.test(tag)) {
    return jsonResponse({ ok: false, error: "bad build tag" }, 400);
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
  await env.MAP.put(`sim/${tag}`, bodyRead.text);
  await env.MAP.put("sim/latest", bodyRead.text);
  return jsonResponse({ ok: true, tag }, 200);
}

/* ---------- alliance partners ---------- */

function corsJson(payload, status, cors) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...cors },
  });
}
const partnersResponse = (payload, status) => corsJson(payload, status, PARTNERS_CORS_HEADERS);
const partnerResponse = (payload, status) => corsJson(payload, status, PARTNER_CORS_HEADERS);

// Codes are compared trimmed and in lower case, so "Archive " and "archive" are the same password.
const normalCode = (code) => (typeof code === "string" ? code.trim().toLowerCase() : "");
// Invisible formatting characters (zero-width spaces, direction marks and overrides, the byte order mark) could make
// two names look the same or flip the text around them, so they go with the control characters.
const cleanTeamName = (name) => (typeof name === "string"
  ? name.replace(/[\p{Cc}\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/gu, "").replace(/\s+/g, " ").trim()
  : "");

// The stored list, or an empty one when it is missing or not the shape this code writes.
async function loadPartners(env) {
  let parsed = null;
  try {
    parsed = JSON.parse((await env.MAP.get(PARTNERS_KEY)) ?? "null");
  } catch {
    return [];
  }
  if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.teams)) return [];
  return parsed.teams.filter((t) => t && typeof t.name === "string" && typeof t.code === "string" && t.code &&
    typeof t.build === "string" && typeof t.added === "string").slice(0, MAX_PARTNERS)
    .map(({ name, code, build, added }) => ({ name, code, build, added }));
}

function savePartners(env, teams) {
  return env.MAP.put(PARTNERS_KEY, JSON.stringify({ version: 1, teams }));
}

// Checks one add or update. Returns { team } or { error }.
async function cleanPartner(payload, env, teams) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return { error: "JSON must be an object" };
  const name = cleanTeamName(payload.name);
  if (!name || charCount(name) > PARTNER_NAME_MAX) return { error: `team name must be 1 to ${PARTNER_NAME_MAX} characters` };
  const code = normalCode(payload.code);
  if (charCount(code) < PARTNER_CODE_MIN || charCount(code) > PARTNER_CODE_MAX) {
    return { error: `password must be ${PARTNER_CODE_MIN} to ${PARTNER_CODE_MAX} characters` };
  }
  // It travels in a header, which only carries plain characters.
  if (!/^[\x20-\x7e]+$/.test(code)) return { error: "password can only use plain letters, numbers and symbols" };
  if (code === normalCode(env.TEAM_CODE) || (env.INGEST_TOKEN && code === normalCode(env.INGEST_TOKEN))) {
    return { error: "password can't be the team code" };
  }
  const same = (t) => t.name.toLowerCase() === name.toLowerCase();
  if (teams.some((t) => !same(t) && t.code === code)) return { error: "another team already has that password" };
  const build = payload.build;
  if (build !== "latest") {
    if (typeof build !== "string" || !RELEASE_TAG.test(build)) return { error: "build must be a release tag or latest" };
    if ((await env.MAP.get(`sim/${build}`)) === null) return { error: "that build has no stored prediction" };
  }
  return { team: { name, code, build } };
}

async function handlePartners(request, env, url) {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: PARTNERS_CORS_HEADERS });
  }
  if (!["GET", "POST", "DELETE"].includes(request.method)) {
    return partnersResponse({ ok: false, error: "method not allowed" }, 405);
  }
  // Before the code check, so this also slows guessing the team code. Changes get the stricter limit.
  const limiter = request.method === "GET" ? env?.LIMITER_READ : env?.LIMITER;
  if (limiter) {
    const { success } = await limiter.limit({ key: request.headers.get("CF-Connecting-IP") || "unknown" });
    if (!success) return partnersResponse({ ok: false, error: "too many tries, try again in a minute" }, 429);
  }
  if (!env?.TEAM_CODE || !env?.MAP) {
    return partnersResponse({ ok: false, error: "relay not configured" }, 500);
  }
  if (!sameSecret(request.headers.get("X-Team-Code"), env.TEAM_CODE)) {
    return partnersResponse({ ok: false, error: "wrong team code" }, 401);
  }

  const teams = await loadPartners(env);
  if (request.method === "GET") return partnersResponse({ ok: true, teams }, 200);

  if (request.method === "DELETE") {
    const name = cleanTeamName(url.searchParams.get("name"));
    const kept = teams.filter((t) => t.name.toLowerCase() !== name.toLowerCase());
    if (!name || kept.length === teams.length) return partnersResponse({ ok: false, error: "no team by that name" }, 404);
    await savePartners(env, kept);
    return partnersResponse({ ok: true, teams: kept }, 200);
  }

  const bodyRead = await readRequestBody(request, MAX_PARTNER_BODY);
  if (bodyRead.error) return partnersResponse({ ok: false, error: "request too large" }, 413);
  let payload;
  try {
    payload = JSON.parse(bodyRead.text);
  } catch {
    return partnersResponse({ ok: false, error: "invalid JSON" }, 400);
  }
  const checked = await cleanPartner(payload, env, teams);
  if (checked.error) return partnersResponse({ ok: false, error: checked.error }, 400);
  const { team } = checked;
  const index = teams.findIndex((t) => t.name.toLowerCase() === team.name.toLowerCase());
  if (index < 0 && teams.length >= MAX_PARTNERS) {
    return partnersResponse({ ok: false, error: `the list holds up to ${MAX_PARTNERS} teams, remove one first` }, 400);
  }
  // An update keeps when the team was first added.
  const saved = { ...team, added: index < 0 ? new Date().toISOString() : teams[index].added };
  const next = index < 0 ? [...teams, saved] : teams.map((t, i) => (i === index ? saved : t));
  await savePartners(env, next);
  return partnersResponse({ ok: true, teams: next }, index < 0 ? 201 : 200);
}

async function digest(text) {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
}

// Which team this code belongs to, or null. Every stored code is checked, with no early exit, and hashes are
// compared so every comparison takes the same time whatever the codes' lengths.
async function matchPartner(given, teams) {
  const mine = await digest(normalCode(given));
  let found = null;
  for (const team of teams) {
    const theirs = await digest(team.code);
    let difference = 0;
    for (let i = 0; i < mine.length; i += 1) difference |= mine[i] ^ theirs[i];
    if (difference === 0 && found === null) found = team;
  }
  return found;
}

const isFiniteNumber = (v) => typeof v === "number" && Number.isFinite(v);
const numberOrNull = (v) => (isFiniteNumber(v) ? v : null);

// One match auton route, rebuilt from the fields the map draws. Anything else on it is dropped. Null when it is
// not a match auton route or not the expected shape.
function cleanMatchRoute(route) {
  if (!route || typeof route !== "object" || Array.isArray(route)) return null;
  if (!MATCH_ROUTE_IDS.has(route.id)) return null;
  if (route.slot !== null && route.slot !== undefined) return null;
  if (route.field !== undefined && route.field !== "override") return null;
  const side = route.id.slice(-1);
  if (route.side !== undefined && route.side !== side) return null;
  if (!Array.isArray(route.samples) || route.samples.length < 2 || route.samples.length > MAX_ROUTE_SAMPLES) return null;
  if (route.events !== undefined && (!Array.isArray(route.events) || route.events.length > MAX_ROUTE_EVENTS)) return null;
  const samples = [];
  for (const s of route.samples) {
    if (!s || !isFiniteNumber(s.t) || !isFiniteNumber(s.x) || !isFiniteNumber(s.y)) return null;
    samples.push({ t: s.t, x: s.x, y: s.y, h: isFiniteNumber(s.h) ? s.h : 0 });
  }
  const events = [];
  for (const e of route.events ?? []) {
    if (!e || !isFiniteNumber(e.t)) return null;
    events.push({
      t: e.t, step: Number.isInteger(e.step) ? e.step : null,
      type: typeof e.type === "string" && /^[a-z_]{1,30}$/.test(e.type) ? e.type : "",
      tx: numberOrNull(e.tx), ty: numberOrNull(e.ty), th: numberOrNull(e.th),
      x: numberOrNull(e.x), y: numberOrNull(e.y), h: numberOrNull(e.h), ok: e.ok === true,
    });
  }
  const total = isFiniteNumber(route.total_ms) && route.total_ms > 0 ? route.total_ms : null;
  return { id: route.id, name: "AWP", side, total_ms: total, samples, events };
}

// What a partner may see of a stored prediction. Fails closed: anything unreadable gives no routes, never the blob.
function partnerView(text, tag) {
  const empty = { tag: null, build: null, generated: null, routes: [] };
  if (typeof text !== "string") return empty;
  let sim;
  try {
    sim = JSON.parse(text);
  } catch {
    return empty;
  }
  if (!sim || typeof sim !== "object" || Array.isArray(sim) || !Array.isArray(sim.routes)) return empty;
  if (sim.schema !== undefined && sim.schema !== 1) return empty;
  const seen = new Set();
  const routes = [];
  for (const route of sim.routes) {
    const clean = cleanMatchRoute(route);
    if (clean && !seen.has(clean.id)) {
      seen.add(clean.id);
      routes.push(clean);
    }
  }
  if (!routes.length) return empty;
  return {
    tag: typeof sim.tag === "string" && RELEASE_TAG.test(sim.tag) ? sim.tag : tag,
    build: Number.isInteger(sim.build) && sim.build >= 0 && sim.build < 10_000_000 ? sim.build : null,
    generated: typeof sim.generated === "string" && !Number.isNaN(Date.parse(sim.generated)) ? new Date(sim.generated).toISOString() : null,
    routes,
  };
}

async function handlePartnerMap(request, env) {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: PARTNER_CORS_HEADERS });
  }
  if (request.method !== "GET") {
    return partnerResponse({ ok: false, error: "method not allowed" }, 405);
  }
  if (env?.LIMITER_READ) {
    const { success } = await env.LIMITER_READ.limit({ key: request.headers.get("CF-Connecting-IP") || "unknown" });
    if (!success) return partnerResponse({ ok: false, error: "too many tries, try again in a minute" }, 429);
  }
  if (!env?.MAP) {
    return partnerResponse({ ok: false, error: "relay not configured" }, 500);
  }
  const team = await matchPartner(request.headers.get("X-Partner-Code") ?? "", await loadPartners(env));
  if (!team) return partnerResponse({ ok: false, error: "wrong password" }, 401);

  const pinned = team.build !== "latest" && RELEASE_TAG.test(team.build) ? team.build : null;
  if (team.build !== "latest" && !pinned) return partnerResponse({ ok: true, team: team.name, ...partnerView(null, null) }, 200);
  const text = await env.MAP.get(pinned ? `sim/${pinned}` : "sim/latest");
  return partnerResponse({ ok: true, team: team.name, ...partnerView(text, pinned) }, 200);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/map") return handleMap(request, env, url);
    if (url.pathname === "/partners") return handlePartners(request, env, url);
    if (url.pathname === "/partner/map") return handlePartnerMap(request, env);
    if (url.pathname === "/map/recorded") return handleRecorded(request, env);
    if (url.pathname.startsWith("/map/sim/")) {
      return handleSim(request, env, decodeURIComponent(url.pathname.slice("/map/sim/".length)));
    }
    if (url.pathname === "/plans") return handlePlans(request, env);
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

    const numbers = [];
    let allLabelled = onMap;
    for (const issue of issues) {
      const fields = { title: payload.title + issue.titleSuffix, body: issue.body };
      let response;
      try {
        response = await createIssue(env, { ...fields, ...labels });
        // A label problem must never lose the results: file them unlabelled, and say they won't reach the map.
        if (onMap && response.status === 422) {
          allLabelled = false;
          response = await createIssue(env, fields);
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
