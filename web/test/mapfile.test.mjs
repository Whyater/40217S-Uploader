import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const html = readFileSync(fileURLToPath(new URL('../map.html', import.meta.url)), 'utf8');

test('map.html has the host API', () => {
  assert.match(html, /ScourgeMap/);
  assert.match(html, /scourge-map/);
});

test('map.html carries no sample data', () => {
  assert.ok(!html.includes('map_sample_data'));
  assert.ok(!html.includes('<!--sample:'));
  assert.ok(!/__SAMPLE_DATA__\s*=/.test(html));
});

test('map.html loads nothing from the network', () => {
  // The only http text allowed is an SVG namespace string.
  const urls = [...html.matchAll(/https?:\/\/[^\s"'<>)]+/g)].map((m) => m[0]);
  assert.ok(urls.every((u) => u === 'http://www.w3.org/2000/svg'), `unexpected URLs: ${urls.join(', ')}`);
  assert.ok(!/(src|href)\s*=\s*["']?\s*(https?:)?\/\//i.test(html), 'external src or href');
  assert.ok(!/url\(\s*["']?\s*(https?:)?\/\//i.test(html), 'external url()');
  assert.ok(!/@import/.test(html));
  assert.ok(!/\b(fetch|XMLHttpRequest|WebSocket|sendBeacon|EventSource)\b/.test(html), 'network API');
  assert.ok(!/<script[^>]*\ssrc=/i.test(html), 'external script');
});
