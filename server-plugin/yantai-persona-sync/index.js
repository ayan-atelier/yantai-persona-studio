'use strict';

const path = require('node:path');
const { createStateStore, StateError } = require('./state-store');

const PLUGIN_ID = 'yantai-persona-sync';
const VERSION = '1.0.0';
let store;

const info = {
  id: PLUGIN_ID,
  name: '砚台 · 人设同步',
  version: VERSION,
  author: '砚台',
  description: 'Per-user JSON state synchronization for 砚台 · 人设馆 (revision/CAS protected).',
};

function dataDirectory() {
  if (process.env.YANTAI_PERSONA_SYNC_DIR) return path.resolve(process.env.YANTAI_PERSONA_SYNC_DIR);
  if (process.env.ST_DATA_DIR) return path.resolve(process.env.ST_DATA_DIR, PLUGIN_ID);
  const root = globalThis.DATA_ROOT || path.join(process.cwd(), 'data');
  return path.resolve(root, PLUGIN_ID);
}

function requestUserId(req) {
  const user = req?.user;
  if (!user) return null;
  const profile = user?.profile || {};
  const candidates = [
    typeof user === 'string' ? user : null,
    user?.id, user?.uid, user?.userId, user?.username, user?.handle, user?.name,
    profile?.id, profile?.uid, profile?.userId, profile?.username, profile?.handle, profile?.name,
    req?.userId, req?.user_id,
  ];
  const value = candidates.find(item => item !== undefined && item !== null && String(item).trim() !== '');
  // When accounts are disabled SillyTavern still supplies req.user.profile.
  // A missing req.user means an unauthenticated request on an accounts-enabled
  // install; never let that request fall into the shared default document.
  if (value == null) return null;
  return value == null ? 'default' : String(value);
}

function bodyOf(req) {
  if (req?.body && typeof req.body === 'object') return req.body;
  if (typeof req?.body === 'string' && req.body.trim()) {
    try { return JSON.parse(req.body); } catch (_) { throw new StateError('request body is not valid JSON', 'INVALID_JSON'); }
  }
  return {};
}

function send(res, status, payload) {
  if (typeof res.status === 'function') res.status(status);
  if (typeof res.json === 'function') return res.json(payload);
  if (typeof res.send === 'function') return res.send(payload);
  return payload;
}

function errorResponse(res, error) {
  if (error?.code === 'REVISION_MISMATCH') {
    return send(res, 409, {
      error: 'conflict', code: error.code, message: error.message,
      current: error.current, conflictFile: error.conflictFile || null,
    });
  }
  if (error?.code === 'PRECONDITION_REQUIRED') {
    return send(res, 428, { error: 'precondition_required', code: error.code, message: error.message, current: error.current });
  }
  if (error?.code === 'INVALID_JSON' || error?.code === 'INVALID_STATE' || error?.code === 'INVALID_REVISION' || error?.code === 'STATE_TOO_LARGE') {
    return send(res, 400, { error: 'invalid_request', code: error.code, message: error.message });
  }
  if (error?.code === 'CORRUPT_STATE' || error?.code === 'UNSUPPORTED_SCHEMA') {
    return send(res, 500, { error: 'stored_state_invalid', code: error.code, message: error.message });
  }
  console.error(`[${PLUGIN_ID}] request failed`, error);
  return send(res, 500, { error: 'internal_error', message: 'Unable to read or write state.' });
}

function init(router) {
  if (!router || typeof router.get !== 'function' || typeof router.put !== 'function') {
    throw new TypeError('yantai-persona-sync init requires an Express router');
  }
  store = createStateStore({ directory: dataDirectory() });
  const requireUser = (req, res) => {
    const id = requestUserId(req);
    if (!id) { send(res, 401, { error: 'unauthorized', message: 'Please sign in to SillyTavern first.' }); return null; }
    return id;
  };
  router.get('/state', async (req, res) => {
    try {
      const id = requireUser(req, res); if (!id) return;
      const value = await store.read(id);
      return send(res, 200, value);
    } catch (error) { return errorResponse(res, error); }
  });
  router.put('/state', async (req, res) => {
    try {
      const id = requireUser(req, res); if (!id) return;
      const payload = bodyOf(req);
      const headerRevision = req?.headers?.['if-match'] ?? req?.headers?.['If-Match'];
      const state = Object.prototype.hasOwnProperty.call(payload, 'state') ? payload.state : payload;
      const value = await store.put(id, {
        state,
        expectedRevision: payload.baseRevision ?? payload.expectedRevision ?? payload.revision ?? headerRevision,
      });
      return send(res, 200, value);
    } catch (error) { return errorResponse(res, error); }
  });
  if (typeof router.post === 'function') router.post('/backups', async (req, res) => {
    try {
      const id = requireUser(req, res); if (!id) return;
      const payload = bodyOf(req);
      const current = await store.read(id);
      const expected = payload.baseRevision ?? payload.revision ?? req?.headers?.['if-match'] ?? req?.headers?.['If-Match'];
      if (expected != null && String(expected).replace(/^W\//, '').replace(/^"|"$/g, '') !== current.revision) {
        throw new StateError('state revision has changed', 'REVISION_MISMATCH', { current });
      }
      const backup = await store.backup(store.fileFor(id));
      return send(res, 200, { backup, revision: current.revision, updatedAt: current.updatedAt });
    } catch (error) { return errorResponse(res, error); }
  });
  router.get('/backups', async (req, res) => {
    try {
      const id = requireUser(req, res); if (!id) return;
      const file = store.fileFor(id);
      const names = [];
      if (await require('node:fs/promises').access(file).then(() => true).catch(() => false)) names.push({ name: path.basename(file), kind: 'current' });
      if (await require('node:fs/promises').access(`${file}.bak`).then(() => true).catch(() => false)) names.push({ name: path.basename(file) + '.bak', kind: 'backup' });
      return send(res, 200, { backups: names });
    } catch (error) { return errorResponse(res, error); }
  });
  router.get('/conflicts', async (req, res) => {
    try {
      const id = requireUser(req, res); if (!id) return;
      const fs = require('node:fs/promises');
      const directory = store.conflictDirectory();
      const prefix = `${require('./state-store').safeUserKey(id)}.`;
      const files = await fs.readdir(directory).catch(() => []);
      const conflicts = [];
      for (const name of files.filter(item => item.startsWith(prefix)).slice(-100)) {
        const file = path.join(directory, name);
        const stat = await fs.stat(file).catch(() => null);
        if (stat) conflicts.push({ id: `conflicts/${name}`, createdAt: stat.mtimeMs, size: stat.size });
      }
      return send(res, 200, { conflicts: conflicts.sort((a, b) => b.createdAt - a.createdAt) });
    } catch (error) { return errorResponse(res, error); }
  });
  return store;
}

module.exports = { info, init, requestUserId, createStateStore };
