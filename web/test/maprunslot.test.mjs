import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

// The map page's pure block, the same way tools/autopath/map_check.mjs loads it.
const html = readFileSync(fileURLToPath(new URL('../map.html', import.meta.url)), 'utf8');
const code = html.slice(html.indexOf('/*<pure>*/') + 10, html.indexOf('/*</pure>*/'));
const AP = new vm.Script('(function(){' + code + '\nreturn AP;})()').runInThisContext();

const run = (id, build, secs) => ({ id, kind: 'run', build, samples: [{ t: 0, x: 0, y: 0, h: 0 }, { t: secs * 1000, x: 5, y: 0, h: 0 }], marks: [], events: [] });
const pred = (id, slot, name) => ({ id, slot, name, side: 'L', total_ms: 15000, samples: [{ t: 0, x: 0, y: 0, h: 0 }, { t: 900, x: 1, y: 0, h: 0 }], events: [] });

test('a long run lists under Skills, not AWP; a Skills label or RECF label picks its tab; the rest stay on AWP', () => {
  const m = AP.buildModel({
    mapData: { time_unit: 'ms', sessions: [run('awp', 'AWP mirror', 14.5), run('skills', 'Skills', 44.4), run('long', 'AWP mirror', 45), run('early', ' skills ', 6), run('recf', 'RECF right', 12)] },
    simulated: { schema: 1, routes: [pred('awp-L', null, 'AWP'), pred('skills', 'skills', 'Skills'), pred('recf', 'recf', 'RECF: right Goal + roller')] },
  });
  const entries = AP.routeEntries(m), listed = (key) => m.sessions.filter((s) => AP.belongs(entries, entries.find((e) => e.key === key), s)).map((s) => s.id).sort();
  assert.deepEqual(listed('awp'), ['awp']);
  assert.deepEqual(listed('skills'), ['early', 'long', 'skills']);
  assert.deepEqual(listed('p-recf'), ['recf']);
});

test('with no Skills prediction in the data, a long run stays under AWP so it can still be opened', () => {
  const m = AP.buildModel({ mapData: { time_unit: 'ms', sessions: [run('skills', 'Skills', 44.4)] }, simulated: { schema: 1, routes: [pred('awp-L', null, 'AWP')] } });
  const entries = AP.routeEntries(m);
  assert.equal(AP.belongs(entries, entries[0], m.sessions[0]), true);
});
