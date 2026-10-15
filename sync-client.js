/*
 * The persona extension deliberately keeps cross-device state out of
 * SillyTavern's global settings file.  This client talks to the optional
 * yantai-persona-sync service, which stores a separate document and accepts
 * compare-and-swap writes.
 *
 * There is no silent fallback to saveSettingsDebounced here.  If the service
 * is unavailable, callers receive a typed error and can switch to a read-only
 * or export-only mode instead of risking an old device overwriting a newer
 * document.
 */

export const SYNC_ENDPOINT = '/api/plugins/yantai-persona-sync/state';
export const SYNC_ROOT = '/api/plugins/yantai-persona-sync';
export const SYNC_SCHEMA_VERSION = 1;
export const DEVICE_STORAGE_KEY = 'yantai-persona-studio.sync.deviceId';

let volatileDeviceId = '';

/**
 * A small, deterministic JSON representation used for checksums and tests.
 * Object keys are sorted, while array order is preserved because conversation
 * turns are ordered records. Undefined object fields follow JSON.stringify's
 * omission rules.
 */
export function stableStringify(value) {
  const seen = new WeakSet();
  const encode = (input, inArray = false) => {
    if (input === null || typeof input !== 'object') {
      const result = JSON.stringify(input);
      return result === undefined ? (inArray ? 'null' : undefined) : result;
    }
    // Match JSON.stringify for standard JSON-like values such as Date while
    // still sorting keys on ordinary objects.
    if (typeof input.toJSON === 'function') return encode(input.toJSON(), inArray);
    if (seen.has(input)) throw new TypeError('同步数据不能包含循环引用。');
    seen.add(input);
    let result;
    if (Array.isArray(input)) {
      result = '[' + input.map(item => encode(item, true)).join(',') + ']';
    } else {
      const entries = Object.keys(input)
        .filter(key => input[key] !== undefined)
        .sort()
        .map(key => {
          const encoded = encode(input[key]);
          return encoded === undefined ? '' : JSON.stringify(key) + ':' + encoded;
        })
        .filter(Boolean);
      result = '{' + entries.join(',') + '}';
    }
    seen.delete(input);
    return result;
  };
  return encode(value);
}

// FNV-1a is intentionally used as a synchronous fallback.  The server's
// revision is authoritative; this checksum is only for diagnostics and
// post-write verification when SubtleCrypto is not available.
export function fnv1a(value) {
  const input = String(value);
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

/** Return a SHA-256 checksum when available, with a portable fallback. */
export async function checksumState(state, cryptoObject = globalThis.crypto) {
  const source = stableStringify(state);
  const subtle = cryptoObject?.subtle;
  if (subtle?.digest) {
    const bytes = new TextEncoder().encode(source);
    const digest = await subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
  }
  return fnv1a(source);
}

function randomId(prefix = '') {
  try {
    if (typeof globalThis.crypto?.randomUUID === 'function') return `${prefix}${globalThis.crypto.randomUUID()}`;
    if (typeof globalThis.crypto?.getRandomValues === 'function') {
      const bytes = new Uint8Array(16);
      globalThis.crypto.getRandomValues(bytes);
      const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
      return `${prefix}${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20)}`;
    }
  } catch (_) { /* use the timestamp fallback below */ }
  return `${prefix}${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
}

function validId(value) {
  return typeof value === 'string' && value.trim().length >= 8 && value.trim().length <= 200;
}

/**
 * Return a stable per-browser identifier. localStorage is deliberately used
 * only for the identifier, never for shared persona state. Private browsing
 * and blocked storage are handled with a module-local identifier.
 */
export function getOrCreateDeviceId(storage = globalThis.localStorage, key = DEVICE_STORAGE_KEY) {
  try {
    const existing = storage?.getItem?.(key);
    if (validId(existing)) return existing.trim();
  } catch (_) { /* storage can be disabled or throw in private mode */ }
  if (!validId(volatileDeviceId)) volatileDeviceId = randomId('device-');
  try { storage?.setItem?.(key, volatileDeviceId); } catch (_) { /* continue without persistence */ }
  return volatileDeviceId;
}

export function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** Validate the top-level document without mutating the caller's state. */
export function assertSyncState(state) {
  if (!isPlainObject(state)) throw new SyncValidationError('同步状态必须是 JSON 对象。', { field: 'state' });
  // Force a serialization pass here. It catches BigInt, functions hidden in
  // unusual objects, and circular references before a network write starts.
  stableStringify(state);
  return state;
}

export function normalizeRevision(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' && typeof value !== 'number') throw new SyncValidationError('服务端版本号格式无效。', { field: 'revision' });
  return String(value);
}

export function revisionEqual(left, right) {
  const a = normalizeRevision(left);
  const b = normalizeRevision(right);
  return a === b;
}

function asObject(value) { return isPlainObject(value) ? value : {}; }

/**
 * Normalize a server envelope. The service returns {state, revision}; the
 * tolerant nested forms make diagnostics readable across older development
 * builds without accepting an invalid array/null state.
 */
export function normalizeEnvelope(payload, { allowStateOnly = false } = {}) {
  const root = asObject(payload);
  const candidate = isPlainObject(root.data) && ('state' in root.data || 'revision' in root.data)
    ? root.data : root;
  const hasState = Object.prototype.hasOwnProperty.call(candidate, 'state');
  if (!hasState && !allowStateOnly) throw new SyncValidationError('同步服务没有返回有效的 state。', { payload: root });
  const state = hasState ? candidate.state : candidate;
  assertSyncState(state);
  return {
    state,
    revision: normalizeRevision(candidate.revision ?? candidate.currentRevision ?? candidate.baseRevision),
    checksum: candidate.checksum ? String(candidate.checksum) : '',
    updatedAt: candidate.updatedAt || candidate.updated_at || '',
    updatedBy: candidate.updatedBy || candidate.deviceId || candidate.updated_by || '',
    conflictId: candidate.conflictId || candidate.conflict_id || '',
    backupId: candidate.backupId || candidate.backup_id || '',
    raw: payload,
  };
}

function responseStatus(response) {
  return Number(response?.status || 0);
}

async function responsePayload(response) {
  if (!response) return {};
  if (typeof response.json === 'function') {
    try { return await response.json(); } catch (_) { /* try text for useful errors */ }
  }
  if (typeof response.text === 'function') {
    const text = await response.text().catch(() => '');
    if (!text) return {};
    try { return JSON.parse(text); } catch (_) { return { message: text }; }
  }
  return isPlainObject(response.body) ? response.body : {};
}

function errorMessage(payload, fallback) {
  return String(payload?.message || payload?.error_description || payload?.error || fallback);
}

export class SyncError extends Error {
  constructor(message, { code = 'SYNC_ERROR', status = 0, details = null, retryable = false } = {}) {
    super(message);
    this.name = 'YantaiPersonaSyncError';
    this.code = code;
    this.status = status;
    this.details = details;
    this.retryable = Boolean(retryable);
  }
}

export class SyncUnavailableError extends SyncError {
  constructor(message = '人设馆同步服务不可用。', details = null) {
    super(message, { code: 'SYNC_UNAVAILABLE', status: details?.status || 0, details, retryable: true });
    this.name = 'YantaiPersonaSyncUnavailableError';
  }
}

export class SyncValidationError extends SyncError {
  constructor(message, details = null) {
    super(message, { code: 'SYNC_INVALID_RESPONSE', status: 200, details, retryable: false });
    this.name = 'YantaiPersonaSyncValidationError';
  }
}

export class SyncConflictError extends SyncError {
  constructor({ message = '同步冲突：远端数据已经被其他设备修改。', status = 409, payload = {}, requestId = '' } = {}) {
    const current = payload?.current && isPlainObject(payload.current) ? payload.current : payload;
    const currentState = current?.state ?? payload?.currentState;
    super(message, {
      code: String(payload?.code || payload?.errorCode || 'REVISION_MISMATCH'),
      status,
      details: payload,
      retryable: false,
    });
    this.name = 'YantaiPersonaSyncConflictError';
    this.requestId = requestId;
    this.conflictId = String(payload?.conflictId || payload?.conflict_id || payload?.conflictFile || '');
    this.currentRevision = normalizeRevision(current?.revision ?? payload?.currentRevision);
    this.currentState = isPlainObject(currentState) ? currentState : null;
    this.current = this.currentState ? {
      state: this.currentState,
      revision: this.currentRevision,
      updatedAt: current?.updatedAt || current?.updated_at || '',
      updatedBy: current?.updatedBy || current?.deviceId || '',
    } : null;
  }
}

export class SyncBackupError extends SyncError {
  constructor(message = '同步前备份失败，已停止写入。', { status = 0, payload = null, retryable = true } = {}) {
    super(message, { code: String(payload?.code || 'BACKUP_FAILED'), status, details: payload, retryable });
    this.name = 'YantaiPersonaSyncBackupError';
  }
}

function route(root, suffix = '') {
  const base = String(root || SYNC_ROOT).replace(/\/$/, '');
  return suffix ? `${base}/${String(suffix).replace(/^\//, '')}` : base;
}

function defaultFetcher(...args) {
  if (typeof globalThis.fetch !== 'function') throw new SyncUnavailableError('当前酒馆环境没有可用的网络请求接口。');
  return globalThis.fetch(...args);
}

/**
 * Create a CAS client. All mutating operations require the revision observed
 * by getState(); a stale write is surfaced as SyncConflictError and never
 * retried automatically.
 */
export function createSyncClient({
  endpoint = SYNC_ENDPOINT,
  fetcher = defaultFetcher,
  deviceId = '',
  storage = globalThis.localStorage,
  deviceStorageKey = DEVICE_STORAGE_KEY,
  requestIdFactory = () => randomId('request-'),
  getRequestHeaders = null,
  headers: extraHeaders = {},
  clientVersion = '',
} = {}) {
  const resolvedDeviceId = validId(deviceId) ? deviceId.trim() : getOrCreateDeviceId(storage, deviceStorageKey);
  const root = String(endpoint || SYNC_ENDPOINT).replace(/\/state\/?$/, '');
  const stateEndpoint = /\/state\/?$/.test(String(endpoint)) ? String(endpoint).replace(/\/$/, '') : route(root, 'state');
  let revision = null;

  const makeHeaders = (requestId = '') => {
    let hostHeaders = {};
    try { if (typeof getRequestHeaders === 'function') hostHeaders = getRequestHeaders({ omitContentType: false }) || {}; } catch (_) { /* caller headers are optional */ }
    return {
      ...hostHeaders,
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'X-Yantai-Device-Id': resolvedDeviceId,
      ...(clientVersion ? { 'X-Yantai-Client-Version': String(clientVersion) } : {}),
      ...(requestId ? { 'X-Yantai-Request-Id': requestId } : {}),
      ...extraHeaders,
    };
  };

  const request = async (url, { method = 'GET', body, baseRevision = null, requestId = '', signal, headers = {}, backup = false } = {}) => {
    const mergedHeaders = { ...makeHeaders(requestId), ...headers };
    if (baseRevision !== null && baseRevision !== undefined) {
      mergedHeaders['If-Match'] = String(baseRevision);
    }
    let response;
    try {
      response = await fetcher(url, {
        method,
        headers: mergedHeaders,
        cache: 'no-store',
        credentials: 'same-origin',
        signal,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch (error) {
      if (error?.name === 'AbortError') throw error;
      throw new SyncUnavailableError('无法连接人设馆同步服务。', { cause: error });
    }
    const status = responseStatus(response);
    const payload = await responsePayload(response);
    if (response?.ok !== false && (status === 0 || (status >= 200 && status < 300))) return payload;
    if (backup && (status === 409 || status === 412 || status === 428 || payload?.code === 'BACKUP_REQUIRED')) {
      throw new SyncBackupError(errorMessage(payload, '同步服务拒绝写入，因为备份没有完成。'), { status, payload });
    }
    if (status === 409 || status === 412 || payload?.code === 'REVISION_MISMATCH' || payload?.error === 'conflict') {
      throw new SyncConflictError({ status: status || 409, payload, requestId });
    }
    if (status === 404 || status === 405 || status === 501 || status === 0) {
      throw new SyncUnavailableError(errorMessage(payload, '当前酒馆没有安装人设馆同步服务。'), { status, payload });
    }
    if (backup || payload?.code === 'BACKUP_FAILED' || payload?.error === 'backup_failed') {
      throw new SyncBackupError(errorMessage(payload, '同步前备份失败，已停止写入。'), { status, payload });
    }
    throw new SyncError(errorMessage(payload, `同步请求失败（${status || '未知状态'}）。`), { code: String(payload?.code || 'SYNC_REQUEST_FAILED'), status, details: payload, retryable: status >= 500 });
  };

  const getState = async ({ signal } = {}) => {
    const payload = await request(stateEndpoint, { signal });
    const envelope = normalizeEnvelope(payload);
    revision = envelope.revision;
    return { ...envelope, deviceId: resolvedDeviceId };
  };

  const putState = async (state, { baseRevision = revision, requestId = requestIdFactory(), signal, backup = false } = {}) => {
    assertSyncState(state);
    const casRevision = normalizeRevision(baseRevision);
    const payload = await request(stateEndpoint, {
      method: 'PUT',
      baseRevision: casRevision,
      requestId,
      signal,
      backup,
      body: { state, baseRevision: casRevision, deviceId: resolvedDeviceId, requestId },
    });
    const envelope = normalizeEnvelope(payload, { allowStateOnly: true });
    revision = envelope.revision;
    return { ...envelope, deviceId: resolvedDeviceId, requestId };
  };

  const createBackup = async (state, { baseRevision = revision, requestId = requestIdFactory(), reason = 'before-sync', signal } = {}) => {
    assertSyncState(state);
    const payload = await request(route(root, 'backups'), {
      method: 'POST', requestId, signal, backup: true,
      body: { state, revision: normalizeRevision(baseRevision), deviceId: resolvedDeviceId, requestId, reason },
    });
    return { ...asObject(payload), deviceId: resolvedDeviceId, requestId };
  };

  const listBackups = async ({ limit = 20, signal } = {}) => {
    const payload = await request(`${route(root, 'backups')}?limit=${encodeURIComponent(Math.max(1, Math.min(100, Number(limit) || 20)))}`, { signal });
    return Array.isArray(payload) ? payload : (Array.isArray(payload?.backups) ? payload.backups : []);
  };

  const listConflicts = async ({ includeResolved = false, limit = 20, signal } = {}) => {
    const query = new URLSearchParams({
      limit: String(Math.max(1, Math.min(100, Number(limit) || 20))),
      ...(includeResolved ? { includeResolved: 'true' } : {}),
    });
    const payload = await request(`${route(root, 'conflicts')}?${query.toString()}`, { signal });
    return Array.isArray(payload) ? payload : (Array.isArray(payload?.conflicts) ? payload.conflicts : []);
  };

  const getRevision = () => revision;
  return {
    endpoint: stateEndpoint,
    deviceId: resolvedDeviceId,
    get revision() { return revision; },
    getRevision,
    getState,
    putState,
    createBackup,
    backup: createBackup,
    listBackups,
    listConflicts,
    checksumState,
  };
}

