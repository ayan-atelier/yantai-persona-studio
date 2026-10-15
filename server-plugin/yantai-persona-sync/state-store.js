'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const SCHEMA_VERSION = 1;
const INITIAL_REVISION = '0';
const MAX_STATE_BYTES = 4 * 1024 * 1024;

class StateError extends Error {
  constructor(message, code = 'INVALID_STATE', details = {}) {
    super(message);
    this.name = 'StateError';
    this.code = code;
    Object.assign(this, details);
  }
}

function now() { return new Date().toISOString(); }

function randomRevision() {
  return `r_${Date.now().toString(36)}_${crypto.randomBytes(8).toString('hex')}`;
}

function cloneJson(value) {
  try { return JSON.parse(JSON.stringify(value)); } catch (_) { throw new StateError('state must be JSON serializable'); }
}

function assertState(value, maxBytes = MAX_STATE_BYTES) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new StateError('state must be a JSON object');
  }
  let serialized;
  try { serialized = JSON.stringify(value); }
  catch (_) { throw new StateError('state must be JSON serializable'); }
  if (serialized === undefined) throw new StateError('state must be JSON serializable');
  if (Buffer.byteLength(serialized, 'utf8') > maxBytes) {
    throw new StateError(`state exceeds ${maxBytes} bytes`, 'STATE_TOO_LARGE');
  }
  return cloneJson(value);
}

function assertRevision(value, { allowInitial = true } = {}) {
  const revision = String(value ?? '');
  if (!revision && allowInitial) return INITIAL_REVISION;
  if (!revision || revision.length > 160 || !/^[A-Za-z0-9._:-]+$/.test(revision)) {
    throw new StateError('revision is invalid', 'INVALID_REVISION');
  }
  return revision;
}

function validateRecord(record, { allowInitial = false, maxStateBytes = MAX_STATE_BYTES } = {}) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    throw new StateError('stored state must be an object');
  }
  if (Number(record.schemaVersion) !== SCHEMA_VERSION) {
    throw new StateError(`unsupported state schemaVersion (expected ${SCHEMA_VERSION})`, 'UNSUPPORTED_SCHEMA');
  }
  const revision = assertRevision(record.revision, { allowInitial });
  const state = assertState(record.state, maxStateBytes);
  const updatedAt = record.updatedAt == null ? null : String(record.updatedAt);
  return { schemaVersion: SCHEMA_VERSION, revision, updatedAt, state };
}

function safeUserKey(identity) {
  const value = String(identity ?? '').trim() || 'default';
  const slug = value.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 64) || 'default';
  const digest = crypto.createHash('sha256').update(value).digest('hex').slice(0, 12);
  return `${slug}-${digest}`;
}

async function exists(file) {
  try { await fs.access(file); return true; } catch (_) { return false; }
}

async function writeAtomic(file, data, mode = 0o600) {
  const directory = path.dirname(file);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = path.join(directory, `.${path.basename(file)}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`);
  try {
    await fs.writeFile(temporary, data, { encoding: 'utf8', mode });
    try {
      await fs.rename(temporary, file);
    } catch (error) {
      // Windows refuses to rename over an existing file. Keep the normal
      // rename path atomic; only the platform-specific replacement fallback
      // removes the old target first.
      if (process.platform !== 'win32' || !['EEXIST', 'EPERM', 'ENOTEMPTY'].includes(error?.code)) throw error;
      await fs.rm(file, { force: true });
      await fs.rename(temporary, file);
    }
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => {});
  }
}

function initialRecord() {
  return { schemaVersion: SCHEMA_VERSION, revision: INITIAL_REVISION, updatedAt: null, state: {} };
}

class StateStore {
  constructor({ directory, maxStateBytes = MAX_STATE_BYTES } = {}) {
    if (!directory) throw new TypeError('directory is required');
    this.directory = path.resolve(directory);
    this.maxStateBytes = maxStateBytes;
    this.locks = new Map();
  }

  fileFor(identity) {
    return path.join(this.directory, `${safeUserKey(identity)}.json`);
  }

  conflictDirectory() { return path.join(this.directory, 'conflicts'); }

  async read(identity) {
    const file = this.fileFor(identity);
    let raw;
    try { raw = await fs.readFile(file, 'utf8'); }
    catch (error) {
      if (error.code === 'ENOENT') return initialRecord();
      throw error;
    }
    let parsed;
    try { parsed = JSON.parse(raw); }
    catch (_) { throw new StateError('stored state is not valid JSON', 'CORRUPT_STATE'); }
    return validateRecord(parsed, { maxStateBytes: this.maxStateBytes });
  }

  async backup(file) {
    if (!await exists(file)) return null;
    const backup = `${file}.bak`;
    const raw = await fs.readFile(file);
    await writeAtomic(backup, raw.toString('utf8'));
    return path.basename(backup);
  }

  async conflict(identity, payload, expectedRevision, current) {
    const stamp = `${Date.now()}-${crypto.randomBytes(5).toString('hex')}`;
    const file = path.join(await this.conflictDirectory(), `${safeUserKey(identity)}.${stamp}.json`);
    const record = {
      schemaVersion: SCHEMA_VERSION,
      kind: 'yantai-persona-sync-conflict',
      createdAt: now(),
      expectedRevision: expectedRevision ?? null,
      currentRevision: current?.revision ?? INITIAL_REVISION,
      state: payload,
    };
    await writeAtomic(file, JSON.stringify(record, null, 2));
    return path.relative(this.directory, file).split(path.sep).join('/');
  }

  async withUserLock(identity, operation) {
    const key = safeUserKey(identity);
    const previous = this.locks.get(key) || Promise.resolve();
    const current = previous.catch(() => {}).then(operation);
    this.locks.set(key, current);
    try { return await current; }
    finally { if (this.locks.get(key) === current) this.locks.delete(key); }
  }

  async put(identity, input = {}) {
    return this.withUserLock(identity, async () => {
      const current = await this.read(identity);
      // Validate and clone before the CAS branch as well.  A stale client
      // must not be able to write an oversized/invalid payload into the
      // conflict archive and bypass the normal state-size limit.
      const state = assertState(input.state, this.maxStateBytes);
      const expected = input.expectedRevision ?? input.baseRevision ?? input.revision;
      if (expected == null || String(expected).trim() === '') {
        throw new StateError('baseRevision is required for compare-and-swap', 'PRECONDITION_REQUIRED', { current });
      }
      const normalizedExpected = String(expected).replace(/^W\//, '').replace(/^"|"$/g, '');
      if (normalizedExpected !== current.revision) {
        let conflictFile = null;
        try { conflictFile = await this.conflict(identity, state, normalizedExpected, current); } catch (_) { /* preserve the CAS response if disk is read-only */ }
        throw new StateError('state revision has changed', 'REVISION_MISMATCH', { current, conflictFile });
      }
      const next = { schemaVersion: SCHEMA_VERSION, revision: randomRevision(), updatedAt: now(), state };
      const file = this.fileFor(identity);
      await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
      await this.backup(file);
      await writeAtomic(file, JSON.stringify(next, null, 2));
      return next;
    });
  }
}

function createStateStore(options) { return new StateStore(options); }

module.exports = {
  SCHEMA_VERSION,
  INITIAL_REVISION,
  MAX_STATE_BYTES,
  StateError,
  StateStore,
  createStateStore,
  assertState,
  validateRecord,
  safeUserKey,
  writeAtomic,
};
