import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  PARTNER_URL, normalCode, defaultCode, checkCode, checkName, isGuessable, shareMessage, buildText, localRelay,
  cleanPartnerData, partnerInput, fetchPartnerMap, describePartner, partnersCall, findRelay,
} from '../partnerdata.js';
import { MANIFEST_URL } from '../mapcloud.js';

const RELAY = 'https://relay.example.workers.dev';
const read = (name) => readFileSync(fileURLToPath(new URL(`../${name}`, import.meta.url)), 'utf8');
const pts = (n) => Array.from({ length: n }, (_, i) => ({ t: i * 100, x: i, y: -60, h: 0 }));
const GOOD = {
  ok: true, team: 'Archive', tag: 'build-71-def5678', build: 71, generated: '2026-11-09T20:37:44.000Z',
  routes: [
    { id: 'awp-L', name: 'AWP', side: 'L', total_ms: 13050, samples: pts(3), events: [{ t: 2970, step: -1, type: 'opening' }] },
    { id: 'awp-R', name: 'AWP', side: 'R', total_ms: 13050, samples: pts(3), events: [] },
  ],
};

function fakeFetch(answer) {
  const calls = [];
  const fn = async (url, init = {}) => { calls.push({ url: String(url), init }); return answer(String(url), init); };
  fn.calls = calls;
  return fn;
}

/* ---------- names, passwords and the message ---------- */

test('passwords compare trimmed and in lower case', () => {
  assert.equal(normalCode('  Archive '), 'archive');
  assert.equal(normalCode(null), '');
});

test('the suggested password is the team name, lower case, with no spaces', () => {
  assert.equal(defaultCode('Archive'), 'archive');
  assert.equal(defaultCode('Iron  Lions 2'), 'ironlions2');
  assert.equal(defaultCode('Café'), 'caf');
  assert.equal(defaultCode('x'.repeat(80)).length, 64);
});

test('checkCode: what the owner may set', () => {
  assert.deepEqual(checkCode(' Archive '), { ok: true, value: 'archive', message: '' });
  assert.equal(checkCode('').ok, false);
  assert.equal(checkCode('abc').message, 'Use at least 4 characters.');
  assert.equal(checkCode('c'.repeat(65)).ok, false);
  assert.equal(checkCode('café-1').ok, false);
  assert.equal(checkCode('c'.repeat(64)).ok, true);
});

test('checkCode: a partner typing a short code is told it did not work, not the rule', () => {
  assert.equal(checkCode('', { forPartner: true }).message, 'Enter the password 40217S gave your team.');
  assert.equal(checkCode('abc', { forPartner: true }).message, "That password didn't work. Ask the 40217S team to confirm it.");
});

test('checkName trims, folds spaces, and caps at 40', () => {
  assert.deepEqual(checkName('  Iron   Lions '), { ok: true, value: 'Iron Lions', message: '' });
  assert.equal(checkName('   ').ok, false);
  assert.equal(checkName('\u0000\u0007').ok, false);
  assert.equal(checkName('n'.repeat(41)).ok, false);
  assert.equal(checkName('n'.repeat(40)).ok, true);
});

test('isGuessable flags team names, team numbers and short words, not a long mixed code', () => {
  assert.equal(isGuessable('archive', 'Archive'), true);
  assert.equal(isGuessable('ironlions', 'Iron Lions'), true);
  assert.equal(isGuessable('1234a', 'Archive'), true);
  assert.equal(isGuessable('pizza', 'Archive'), true);
  assert.equal(isGuessable('blue-falcon-27', 'Archive'), false);
  assert.equal(isGuessable('', 'Archive'), false);
});

test('the message has the link and the password, in the agreed words', () => {
  assert.equal(PARTNER_URL, 'https://whyater.github.io/40217S-Uploader/partner.html');
  assert.equal(shareMessage('archive'), '40217S Scourge match auton\nhttps://whyater.github.io/40217S-Uploader/partner.html\nPassword: archive');
  assert.ok(!shareMessage('archive').includes('  '), 'no double space');
  assert.ok(!shareMessage('archive').includes('?'), 'the password is never put in the link');
});

test('buildText', () => {
  assert.equal(buildText('build-70-abc1234'), 'Build 70');
  assert.equal(buildText('latest'), 'Newest build');
});

/* ---------- where the relay is ---------- */

test('a relay override works only from this computer and only to this computer', () => {
  const at = (hostname, search) => ({ hostname, search });
  assert.equal(localRelay(at('localhost', '?relay=http://localhost:8787')), 'http://localhost:8787');
  assert.equal(localRelay(at('127.0.0.1', '?relay=http://127.0.0.1:8787')), 'http://127.0.0.1:8787');
  assert.equal(localRelay(at('whyater.github.io', '?relay=http://localhost:8787')), '');
  assert.equal(localRelay(at('localhost', '?relay=https://evil.example')), '');
  assert.equal(localRelay(at('localhost', '?relay=http://localhost.evil.example')), '');
  assert.equal(localRelay(at('localhost', '?relay=http://localhost:8787/x')), '');
  assert.equal(localRelay(at('localhost', '')), '');
});

test('findRelay reads the manifest, and falls back to the saved address', async () => {
  const good = fakeFetch(() => new Response(JSON.stringify({ results_url: `${RELAY}/results` })));
  assert.equal(await findRelay({ fetchFn: good }), RELAY);
  assert.ok(good.calls[0].url.startsWith(MANIFEST_URL));
  const down = fakeFetch(() => { throw new TypeError('offline'); });
  assert.equal(await findRelay({ fetchFn: down, saved: 'https://saved.example' }), 'https://saved.example');
  assert.equal(await findRelay({ fetchFn: down }), '');
});

test('findRelay checks a saved address the same way as a fresh one', async () => {
  const down = fakeFetch(() => { throw new TypeError('offline'); });
  for (const saved of ['http://saved.example', 'javascript:alert(1)', 'https://saved.example?x=1', 'https://user@saved.example']) {
    assert.equal(await findRelay({ fetchFn: down, saved }), '', saved);
  }
  assert.equal(await findRelay({ fetchFn: down, saved: 'https://saved.example/' }), 'https://saved.example');
});

/* ---------- the partner's view ---------- */

test('cleanPartnerData keeps only the match auton routes and the known fields', () => {
  const data = cleanPartnerData({
    ...GOOD, recorded: { sessions: [1] },
    routes: [...GOOD.routes, { id: 'skills', samples: pts(3) }, { id: 'taught-A-L', samples: pts(3) }, { id: 'recf', samples: pts(3) }, { id: 'awp-L', samples: pts(3) }, { id: 'awp-R', samples: pts(1) }],
  });
  assert.deepEqual(Object.keys(data).sort(), ['build', 'generated', 'routes', 'tag', 'team']);
  assert.deepEqual(data.routes.map((r) => r.id), ['awp-L', 'awp-R']);
  assert.equal(data.team, 'Archive');
  assert.equal(data.build, 71);
  assert.deepEqual(cleanPartnerData(null), { team: '', tag: null, build: null, generated: null, routes: [] });
  assert.equal(cleanPartnerData({ ...GOOD, tag: '../recorded' }).tag, null);
});

test('partnerInput hands the map the prediction and nothing else', () => {
  const input = partnerInput(cleanPartnerData(GOOD));
  assert.deepEqual(Object.keys(input).sort(), ['csvTexts', 'mapData', 'simulated']);
  assert.equal(input.mapData, null);
  assert.deepEqual(input.csvTexts, []);
  assert.equal(input.simulated.schema, 1);
  assert.deepEqual(input.simulated.routes.map((r) => r.id), ['awp-L', 'awp-R']);
});

test('fetchPartnerMap sends the password only as a header', async () => {
  const f = fakeFetch(() => new Response(JSON.stringify(GOOD)));
  const r = await fetchPartnerMap({ base: RELAY, code: 'archive', fetchFn: f });
  assert.equal(r.status, 'ok');
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].url, `${RELAY}/partner/map`);
  assert.equal(f.calls[0].init.headers['X-Partner-Code'], 'archive');
  assert.equal(f.calls[0].init.cache, 'no-store');
});

test('fetchPartnerMap maps every answer to a status', async () => {
  const cases = [
    [() => new Response('{"ok":false,"error":"wrong password"}', { status: 401 }), 'wrong'],
    [() => new Response('{}', { status: 429 }), 'busy'],
    [() => new Response('{"ok":false}', { status: 500 }), 'server'],
    [() => new Response('<html>', { status: 200 }), 'server'],
    [() => new Response('{"ok":false}', { status: 200 }), 'server'],
    [() => { throw new TypeError('offline'); }, 'network'],
  ];
  for (const [answer, status] of cases) {
    assert.equal((await fetchPartnerMap({ base: RELAY, code: 'archive', fetchFn: fakeFetch(answer) })).status, status);
  }
  assert.equal((await fetchPartnerMap({ base: '', code: 'archive', fetchFn: fakeFetch(() => null) })).status, 'network');
});

test('describePartner: wrong password, access removed, unreachable, nothing shared', () => {
  const ok = (routes) => ({ status: 'ok', data: { routes } });
  assert.deepEqual(describePartner(ok([1])), { screen: 'route', kind: '', text: '' });
  assert.deepEqual(describePartner(ok([])), { screen: 'none', kind: '', text: '' });
  assert.equal(describePartner({ status: 'wrong' }).text, "That password didn't work. Ask the 40217S team to confirm it.");
  const removed = describePartner({ status: 'wrong' }, { hadAccess: true, cachedAt: 1 });
  assert.equal(removed.screen, 'lock', 'a removed partner never keeps the old copy on screen');
  assert.match(removed.text, /stopped sharing/);
  const off = describePartner({ status: 'network' });
  assert.equal(off.screen, 'lock');
  assert.equal(off.text, "Couldn't load the route. Check your connection and try again.");
  const offSaved = describePartner({ status: 'network' }, { hadAccess: true, cachedAt: Date.UTC(2026, 10, 9, 20, 0), locale: 'en-US' });
  assert.equal(offSaved.screen, 'route');
  assert.match(offSaved.text, /Showing the copy from Nov 9/);
  assert.equal(describePartner({ status: 'network' }, { hadAccess: true, cachedAt: 1, cachedEmpty: true }).screen, 'none',
    'a saved "nothing yet" stays that way offline');
  assert.equal(describePartner(ok([1]), { hadAccess: true, cachedAt: 1, cachedEmpty: true }).screen, 'route',
    'a fresh answer wins over the saved one');
  const pm = describePartner({ status: 'network' }, { hadAccess: true, cachedAt: Date.UTC(2026, 10, 9, 20, 0), locale: 'en-CA' }).text;
  assert.doesNotMatch(pm, /\.\.$/, 'no double period after p.m.');
  assert.match(pm, /\.$/);
  assert.match(describePartner({ status: 'busy' }).text, /Too many tries/);
  assert.equal(describePartner({ status: 'server' }).text, "Couldn't load the route. Try again in a minute.");
});

/* ---------- the owner's list ---------- */

test('partnersCall lists, adds and removes with the team code', async () => {
  const teams = [{ name: 'Archive', code: 'archive', build: 'latest', added: '2026-11-09T00:00:00.000Z', extra: 1 }];
  const f = fakeFetch(() => new Response(JSON.stringify({ ok: true, teams })));
  const list = await partnersCall({ base: RELAY, teamCode: 'team-code', fetchFn: f });
  assert.equal(list.ok, true);
  assert.deepEqual(list.teams, [{ name: 'Archive', code: 'archive', build: 'latest', added: '2026-11-09T00:00:00.000Z' }]);
  await partnersCall({ base: RELAY, teamCode: 'team-code', method: 'POST', body: { name: 'Archive', code: 'archive', build: 'latest' }, fetchFn: f });
  await partnersCall({ base: RELAY, teamCode: 'team-code', method: 'DELETE', name: 'Iron Lions', fetchFn: f });
  assert.deepEqual(f.calls.map((c) => [c.init.method, c.url]), [
    ['GET', `${RELAY}/partners`], ['POST', `${RELAY}/partners`], ['DELETE', `${RELAY}/partners?name=Iron%20Lions`],
  ]);
  for (const c of f.calls) assert.equal(c.init.headers['X-Team-Code'], 'team-code');
  assert.equal(f.calls[1].init.headers['Content-Type'], 'application/json');
  assert.deepEqual(JSON.parse(f.calls[1].init.body), { name: 'Archive', code: 'archive', build: 'latest' });
});

test('partnersCall turns refusals into sentences and flags a changed team code', async () => {
  const answer = (status, body) => fakeFetch(() => new Response(JSON.stringify(body), { status }));
  const bad = await partnersCall({ base: RELAY, teamCode: 't', method: 'POST', body: {}, fetchFn: answer(400, { ok: false, error: "password can't be the team code" }) });
  assert.equal(bad.message, "Password can't be the team code.");
  const gone = await partnersCall({ base: RELAY, teamCode: 't', fetchFn: answer(401, { ok: false }) });
  assert.equal(gone.unauthorized, true);
  assert.equal((await partnersCall({ base: RELAY, teamCode: 't', fetchFn: answer(429, {}) })).status, 429);
  const off = await partnersCall({ base: RELAY, teamCode: 't', fetchFn: fakeFetch(() => { throw new TypeError('x'); }) });
  assert.match(off.message, /Couldn't reach/);
  assert.equal((await partnersCall({ base: RELAY, teamCode: '', fetchFn: answer(200, {}) })).message, 'Enter the team code first.');
});

/* ---------- what the partner page loads ---------- */

const imports = (src) => [...src.matchAll(/^import[^'"]*['"]([^'"]+)['"]/gm)].map((m) => m[1]);

test('the partner page loads none of the uploader', () => {
  const html = read('partner.html');
  const scripts = [...html.matchAll(/<script[^>]*src=["']([^"']+)["']/g)].map((m) => m[1]);
  assert.deepEqual(scripts, ['partner.js']);
  assert.doesNotMatch(html, /app\.js|transport\.js|protocol\/|vendor\/|releases\.js|index\.html|manifest\.webmanifest|sw\.js/);
  // Every module it reaches, followed to the end.
  const seen = new Set();
  const walk = (name) => {
    if (seen.has(name)) return;
    seen.add(name);
    imports(read(name)).forEach((dep) => walk(dep.replace(/^\.\//, '')));
  };
  walk('partner.js');
  assert.deepEqual([...seen].sort(), ['mapcloud.js', 'mapdata.js', 'partner.js', 'partnerdata.js']);
});

test('the partner page asks the map for partner mode and checks it got it', () => {
  const js = read('partner.js');
  assert.match(js, /map\.html\?embed=1&partner=1/);
  assert.match(js, /api\.mode !== 'partner'/);
  assert.doesNotMatch(js, /X-Team-Code/);
});

function partnerOnly() {
  const html = read('map.html');
  const m = /function partnerOnly\(input\) \{[\s\S]*?\n {2}\}\n/.exec(html);
  assert.ok(m, 'map.html has partnerOnly');
  return new Function(`${m[0]}; return partnerOnly;`)();
}

test('map.html in partner mode reads only the match auton prediction', () => {
  const only = partnerOnly();
  const input = {
    mapData: { routes: [{ slot: 'A' }], sessions: [{ id: 'run-1' }] },
    csvTexts: [{ name: 'r.csv', text: 'SCOURGE,x' }],
    simulated: {
      schema: 1, tag: 'build-71-def5678', build: 71, generated: 'g', assumptions: 'private',
      routes: [{ id: 'awp-L' }, { id: 'awp-R' }, { id: 'skills', slot: 'skills' }, { id: 'recf', field: 'pinnacle' }, { id: 'taught-A-L', slot: 'A' }, { id: 'awp-L', slot: 'A' }],
    },
  };
  const out = only(input);
  assert.deepEqual(Object.keys(out), ['simulated']);
  assert.deepEqual(out.simulated.routes.map((r) => r.id), ['awp-L', 'awp-R']);
  assert.equal(out.simulated.assumptions, undefined);
  assert.deepEqual(only({}), { simulated: null });
  assert.deepEqual(only(null), { simulated: null });
});

test('map.html never offers drawing in partner mode', () => {
  const html = read('map.html');
  assert.match(html, /const canDraw = \(\) => !PARTNER && EMBED/);
  assert.match(html, /model = buildModel\(PARTNER \? partnerOnly\(input\) : input\)/);
  assert.match(html, /mode: PARTNER \? 'partner' : 'full'/);
});

test('the service worker keeps the share panel offline and never serves the partner page from its cache', () => {
  const sw = read('sw.js');
  for (const f of ['./mapshare.js', './partnerdata.js']) assert.ok(sw.includes(`'${f}'`), f);
  assert.ok(!/'\.\/partner\.(html|js)'/.test(sw));
  assert.match(sw, /searchParams\.get\('partner'\) === '1'/);
  assert.match(sw, /endsWith\('\/partner\.html'\)\) return fetch\(req\)/);
});
