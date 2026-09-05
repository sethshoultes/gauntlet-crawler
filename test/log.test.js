// server/log.js emit(): JSON.stringify(fields) can throw on a circular object or a BigInt field,
// which would otherwise break the "never throws" contract documented on error()/info()/warn().
// Same in-process import pattern as test/stats.test.js (DATA_DIR pointed at a scratch dir before
// the dynamic import, since log.js pulls in server/db.js for the `errors` table).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), 'gauntlet-log-test-'));
const log = await import('../server/log.js');
const { db } = await import('../server/db.js');

/** Swap out a console method for the duration of `fn`, capturing every call's args. */
function captureConsole(method, fn) {
  const real = console[method];
  const calls = [];
  console[method] = (...args) => calls.push(args);
  try { fn(); } finally { console[method] = real; }
  return calls;
}

function errorRowCount() {
  return db.prepare('SELECT COUNT(*) AS n FROM errors').get().n;
}

test('info() does not throw on a circular fields object, and still emits a JSON line', () => {
  const circular = { name: 'circular' };
  circular.self = circular;
  let calls;
  assert.doesNotThrow(() => { calls = captureConsole('log', () => log.info('circular ref test', { extra: circular })); });
  assert.equal(calls.length, 1, 'exactly one line should have been printed');
  const line = calls[0][0];
  assert.equal(typeof line, 'string');
  const parsed = JSON.parse(line);
  assert.equal(parsed.level, 'info');
  assert.equal(parsed.msg, 'circular ref test');
});

test('warn() does not throw on a BigInt field, and still emits a JSON line', () => {
  let calls;
  assert.doesNotThrow(() => { calls = captureConsole('warn', () => log.warn('bigint test', { big: 9007199254740993n })); });
  assert.equal(calls.length, 1);
  const line = calls[0][0];
  assert.equal(typeof line, 'string');
  const parsed = JSON.parse(line);
  assert.equal(parsed.level, 'warn');
  assert.equal(parsed.msg, 'bigint test');
  // The BigInt should have been converted to a plain serializable representation, not dropped.
  assert.equal(parsed.big, '9007199254740993n');
});

test('error() with a circular field neither throws nor breaks the errors-table insert', () => {
  const circular = { name: 'circular' };
  circular.self = circular;
  const before = errorRowCount();
  let calls;
  assert.doesNotThrow(() => { calls = captureConsole('error', () => log.error('circular error test', { extra: circular })); });
  assert.equal(calls.length, 1, 'a line should still be emitted even though fields could not be serialized normally');
  const line = calls[0][0];
  const parsed = JSON.parse(line);
  assert.equal(parsed.level, 'error');
  // The DB insert path doesn't depend on JSON.stringify'ing `fields` at all (it reads
  // fields.stack/url/userId/ua directly), so it should still succeed here.
  assert.equal(errorRowCount(), before + 1, 'the error row should still be inserted');
});

test('error() with a BigInt field does not throw', () => {
  const before = errorRowCount();
  assert.doesNotThrow(() => log.error('bigint error test', { userId: 42n }));
  assert.equal(errorRowCount(), before + 1);
});

process.on('exit', () => { try { rmSync(process.env.DATA_DIR, { recursive: true, force: true }); } catch {} });
