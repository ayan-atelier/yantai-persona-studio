'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createStateStore, StateError, safeUserKey } = require('../state-store');
const { info, requestUserId } = require('../index');

async function fixture() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'yantai-persona-sync-'));
  return { directory, store: createStateStore({ directory }) };
}

test('per-user state uses revision CAS and writes a backup', async () => {
  const { directory, store } = await fixture();
  const first = await store.read('alice');
  assert.equal(first.revision, '0');
  const saved = await store.put('alice', { state: { enabled: true }, baseRevision: first.revision });
  assert.equal(saved.state.enabled, true);
  assert.notEqual(saved.revision, first.revision);
  const savedAgain = await store.put('alice', { state: { enabled: false }, baseRevision: saved.revision });
  assert.equal(savedAgain.state.enabled, false);
  await assert.rejects(() => store.put('alice', { state: { enabled: true }, baseRevision: saved.revision }), error => {
    assert.equal(error.code, 'REVISION_MISMATCH');
    assert.match(error.conflictFile, /^conflicts\//);
    return true;
  });
  const files = await fs.readdir(directory);
  assert.ok(files.includes(`${safeUserKey('alice')}.json`));
  assert.ok(files.includes(`${safeUserKey('alice')}.json.bak`));
  assert.equal((await fs.readdir(path.join(directory, 'conflicts'))).length, 1);
});

test('writes for one user are serialized and malformed state is rejected', async () => {
  const { store } = await fixture();
  await assert.rejects(() => store.put('alice', { state: {}, baseRevision: '' }), error => error.code === 'PRECONDITION_REQUIRED');
  const initial = await store.read('alice');
  const writes = await Promise.all([
    store.put('alice', { state: { n: 1 }, baseRevision: initial.revision }),
    store.put('bob', { state: { n: 2 }, baseRevision: initial.revision }),
  ]);
  assert.equal(writes.length, 2);
  await assert.rejects(() => store.put('alice', { state: [], baseRevision: writes[0].revision }), error => error.code === 'INVALID_STATE');
  await assert.rejects(() => store.put('alice', { state: { ok: true } }), error => error.code === 'PRECONDITION_REQUIRED');
});

test('different identities map to different files', () => {
  assert.notEqual(safeUserKey('alice'), safeUserKey('bob'));
  assert.equal(safeUserKey('../alice').includes('/'), false);
});

test('rejects oversized stale payloads before creating a conflict archive', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'yantai-persona-sync-small-'));
  const store = createStateStore({ directory, maxStateBytes: 32 });
  await assert.rejects(() => store.put('alice', { state: { value: 'this payload is intentionally much larger than the configured limit' }, baseRevision: 'stale' }), error => error.code === 'STATE_TOO_LARGE');
  await assert.rejects(() => fs.access(path.join(directory, 'conflicts')), error => error.code === 'ENOENT');
});

test('uses the SillyTavern account handle and rejects anonymous requests', () => {
  assert.equal(info.id, 'yantai-persona-sync');
  assert.equal(requestUserId({ user: { profile: { handle: 'alice' } } }), 'alice');
  assert.equal(requestUserId({}), null);
});
