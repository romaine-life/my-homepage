import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from '@romaine-life/logline';
import { errorText, outside, OUTSIDE_LIMIT } from './log.js';

const here = path.dirname(fileURLToPath(import.meta.url));

test('outside and errorText mask credentials and cap the text', () => {
  assert.equal(outside('upstream: Authorization: Bearer abc.def'), 'upstream: Authorization: Bearer ***');
  assert.equal(outside('x'.repeat(OUTSIDE_LIMIT + 10)).length, OUTSIDE_LIMIT + 3);
  assert.equal(errorText(new Error('password=hunter2'), { stack: false }), 'Error: password=***');
  assert.match(errorText(new Error('boom')), /^Error: boom\n {4}at /);
});

test('the server writes only standard lines: one per request, then the self-test result', () => {
  // The source self-test serves its routes through the real app, so its output is the
  // server's own log: a request line for each route it fetches.
  const result = spawnSync(process.execPath, [path.join(here, 'server.js'), '--self-test', '--source'], { cwd: here, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(result.stderr, '');
  const entries = result.stdout.split('\n').filter(Boolean).map((line) => {
    const entry = parse(line);
    return { ...entry, fields: Object.fromEntries(entry.fields) };
  });
  const requests = entries.filter((e) => e.message === 'request');
  assert.ok(requests.some((e) => e.fields.path === '/health' && e.fields.status === '200' && e.fields.method === 'GET'));
  assert.ok(requests.some((e) => e.fields.path === '/fzt.wasm'));
  for (const e of requests) {
    assert.equal(e.level, 'info');
    assert.match(e.fields.ms, /^\d+$/);
  }
  assert.deepEqual(entries.at(-1).fields, { routes: 'source' });
  assert.equal(entries.at(-1).message, 'my-homepage self-test passed');
});
