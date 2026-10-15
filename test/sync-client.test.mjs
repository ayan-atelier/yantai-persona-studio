import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SyncBackupError,
  SyncConflictError,
  createSyncClient,
  getOrCreateDeviceId,
  normalizeEnvelope,
  stableStringify,
} from '../sync-client.js';

function storage() {
  const values = new Map();
  return { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
}

test('stableStringify sorts object keys and preserves array order', () => {
  assert.equal(stableStringify({ z: 1, a: { y: 2, x: 3 }, list: [2, 1] }), '{"a":{"x":3,"y":2},"list":[2,1],"z":1}');
  assert.equal(stableStringify({ omitted: undefined, fn: () => {}, list: [undefined, () => {}] }), '{"list":[null,null]}');
});

test('device id is stable in the provided storage', () => {
  const store = storage();
  const first = getOrCreateDeviceId(store, 'id');
  assert.ok(first.startsWith('device-'));
  assert.equal(first, getOrCreateDeviceId(store, 'id'));
});

test('GET then PUT sends the observed revision as a CAS precondition', async () => {
  const calls = [];
  const client = createSyncClient({
    storage: storage(),
    deviceId: 'test-device-12345678',
    requestIdFactory: () => 'request-12345678',
    fetcher: async (url, options) => {
      calls.push({ url, options });
      return {
        ok: true,
        status: 200,
        async json() { return options.method === 'PUT' ? { state: { turns: [1, 2] }, revision: 'r2' } : { state: { turns: [1] }, revision: 'r1' }; },
      };
    },
  });
  const before = await client.getState();
  const after = await client.putState({ turns: [1, 2] });
  assert.equal(before.revision, 'r1');
  assert.equal(after.revision, 'r2');
  assert.equal(calls[1].options.headers['If-Match'], 'r1');
  assert.deepEqual(JSON.parse(calls[1].options.body), {
    state: { turns: [1, 2] },
    baseRevision: 'r1',
    deviceId: 'test-device-12345678',
    requestId: 'request-12345678',
  });
});

test('HTTP 409 exposes the current state and conflict file without retrying', async () => {
  let count = 0;
  const client = createSyncClient({
    deviceId: 'test-device-12345678',
    fetcher: async () => {
      count += 1;
      return {
        ok: false,
        status: 409,
        async json() {
          return { error: 'conflict', code: 'REVISION_MISMATCH', conflictFile: 'conflicts/a.json', current: { revision: 'r9', state: { turns: [9] } } };
        },
      };
    },
  });
  await assert.rejects(() => client.putState({ turns: [2] }, { baseRevision: 'r1' }), error => {
    assert.ok(error instanceof SyncConflictError);
    assert.equal(error.currentRevision, 'r9');
    assert.deepEqual(error.currentState, { turns: [9] });
    assert.equal(error.conflictId, 'conflicts/a.json');
    return true;
  });
  assert.equal(count, 1);
});

test('backup failures use a typed error', async () => {
  const client = createSyncClient({
    deviceId: 'test-device-12345678',
    fetcher: async () => ({ ok: false, status: 500, async json() { return { code: 'BACKUP_FAILED', message: 'disk full' }; } }),
  });
  await assert.rejects(() => client.createBackup({ turns: [] }), error => {
    assert.ok(error instanceof SyncBackupError);
    assert.equal(error.code, 'BACKUP_FAILED');
    return true;
  });
});

test('invalid server state is rejected before it reaches the caller', () => {
  assert.throws(() => normalizeEnvelope({ state: [] }), /JSON 对象/);
  assert.throws(() => normalizeEnvelope({ schemaVersion: 9, state: {} }), error => error.code === 'UNSUPPORTED_SCHEMA');
});
