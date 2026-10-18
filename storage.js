/** Lightweight IndexedDB resource store with an in-memory fallback for previews/tests. */

export const DB_NAME = 'yantai-persona-studio';
export const STORE_NAME = 'assets';
const memory = new Map();
let dbPromise;

function canUseIndexedDB() {
  return typeof indexedDB !== 'undefined';
}

export function openResourceStore({ dbName = DB_NAME, storeName = STORE_NAME } = {}) {
  if (!canUseIndexedDB()) return Promise.resolve(null);
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(dbName, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(storeName)) {
        const store = db.createObjectStore(storeName, { keyPath: 'id' });
        store.createIndex('kind', 'kind', { unique: false });
        store.createIndex('updatedAt', 'updatedAt', { unique: false });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => { dbPromise = null; reject(request.error); };
  });
  return dbPromise;
}

function ensureAsset(asset) {
  if (!asset?.id) throw new Error('asset.id is required');
  return { ...asset, updatedAt: asset.updatedAt ?? Date.now() };
}

export async function putAsset(asset, options = {}) {
  const item = ensureAsset(asset);
  const db = await openResourceStore(options).catch(() => null);
  if (!db) { memory.set(item.id, item); return item; }
  return new Promise((resolve, reject) => {
    const request = db.transaction(options.storeName ?? STORE_NAME, 'readwrite').objectStore(options.storeName ?? STORE_NAME).put(item);
    request.onsuccess = () => resolve(item);
    request.onerror = () => reject(request.error);
  });
}

export async function getAsset(id, options = {}) {
  const db = await openResourceStore(options).catch(() => null);
  if (!db) return memory.get(id) ?? null;
  return new Promise((resolve, reject) => {
    const request = db.transaction(options.storeName ?? STORE_NAME, 'readonly').objectStore(options.storeName ?? STORE_NAME).get(id);
    request.onsuccess = () => resolve(request.result ?? null);
    request.onerror = () => reject(request.error);
  });
}

export async function deleteAsset(id, options = {}) {
  const db = await openResourceStore(options).catch(() => null);
  if (!db) return memory.delete(id);
  return new Promise((resolve, reject) => {
    const request = db.transaction(options.storeName ?? STORE_NAME, 'readwrite').objectStore(options.storeName ?? STORE_NAME).delete(id);
    request.onsuccess = () => resolve(true);
    request.onerror = () => reject(request.error);
  });
}

export async function listAssets({ kind, ...options } = {}) {
  const db = await openResourceStore(options).catch(() => null);
  if (!db) return [...memory.values()].filter(item => !kind || item.kind === kind).sort((a, b) => b.updatedAt - a.updatedAt);
  return new Promise((resolve, reject) => {
    const tx = db.transaction(options.storeName ?? STORE_NAME, 'readonly');
    const store = tx.objectStore(options.storeName ?? STORE_NAME);
    const request = kind ? store.index('kind').getAll(kind) : store.getAll();
    request.onsuccess = () => resolve((request.result ?? []).sort((a, b) => b.updatedAt - a.updatedAt));
    request.onerror = () => reject(request.error);
  });
}

export class ResourceStore {
  constructor(options = {}) { this.options = options; }
  put(asset) { return putAsset(asset, this.options); }
  get(id) { return getAsset(id, this.options); }
  delete(id) { return deleteAsset(id, this.options); }
  list(kind) { return listAssets({ ...this.options, kind }); }
}

function uid(prefix = 'asset') {
  return `${prefix}_${globalThis.crypto?.randomUUID?.() || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`}`;
}

async function digestFile(file) {
  try {
    const buffer = await file.arrayBuffer();
    if (globalThis.crypto?.subtle) {
      const hash = await crypto.subtle.digest('SHA-256', buffer);
      return [...new Uint8Array(hash)].map(v => v.toString(16).padStart(2, '0')).join('');
    }
  } catch (_) { /* fall through */ }
  return `${file.size}:${file.lastModified}:${file.name}`;
}

// Legacy JSON-safe records are still accepted so existing installs can
// migrate. New gallery images are hosted by SillyTavern's server and settings
// carry only a compact manifest; data URLs are a compatibility fallback.
async function blobToDataUrl(blob) {
  if (!blob) return '';
  if (typeof FileReader !== 'undefined') return new Promise(resolve => { const r = new FileReader(); r.onload = () => resolve(String(r.result || '')); r.onerror = () => resolve(''); r.readAsDataURL(blob); });
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = ''; for (const b of bytes) binary += String.fromCharCode(b);
  return `data:${blob.type || 'application/octet-stream'};base64,${btoa(binary)}`;
}
async function dataUrlToBlob(url, mime = '') {
  if (!url || typeof fetch !== 'function') return null;
  try { const response = await fetch(url); return await response.blob(); } catch (_) { return null; }
}

function galleryFileName(value) {
  let raw = String(value || '').trim();
  if (!raw || /^(?:data|blob):/i.test(raw)) return '';
  try {
    const parsed = new URL(raw, globalThis.location?.href || 'http://localhost/');
    raw = parsed.searchParams.get('file') || parsed.pathname || raw;
  } catch (_) { /* parse the path below */ }
  try { raw = decodeURIComponent(raw); } catch (_) { /* keep the original path */ }
  raw = raw.split(/[?#]/, 1)[0].replace(/\\/g, '/');
  const marker = raw.toLowerCase().lastIndexOf('/user avatars/');
  if (marker >= 0) raw = raw.slice(marker + '/user avatars/'.length);
  return raw.split('/').filter(Boolean).pop() || '';
}
function galleryOriginalUrl(value) {
  if (!/\/thumbnail(?:\?|$)/i.test(String(value || ''))) return '';
  const file = galleryFileName(value);
  return file ? '/User Avatars/' + encodeURIComponent(file) : '';
}
function isThumbnailUrl(value) { return /\/thumbnail(?:\?|$)/i.test(String(value || '')); }
function isLegacyAvatarUrl(value) { return /\/User(?:%20|\s)Avatars\//i.test(String(value || '')); }
function isEphemeralUrl(value) { return /^(?:blob|data):/i.test(String(value || '').trim()); }
function preferGalleryUrl(primary, secondary) {
  const first = isEphemeralUrl(primary) ? '' : String(primary || '').trim();
  const second = isEphemeralUrl(secondary) ? '' : String(secondary || '').trim();
  if (first && !isThumbnailUrl(first)) return first;
  if (second && !isThumbnailUrl(second)) return second;
  return first || second;
}

export function createStorage({ report = () => {} } = {}) {
  const previewUrls = new Map();
  const makePreview = (id, blob, fallback = '') => {
    if (!blob || typeof globalThis.URL?.createObjectURL !== 'function') return fallback || '';
    const old = previewUrls.get(id);
    if (old) {
      try { globalThis.URL.revokeObjectURL(old); } catch (_) { /* stale preview */ }
    }
    const url = globalThis.URL.createObjectURL(blob);
    previewUrls.set(id, url);
    return url;
  };
  const hydrateGallery = async (items = []) => {
    const result = [];
    for (const item of items || []) {
      if (!item?.id) continue;
      const stored = await getAsset(item.id).catch(() => null);
      const blob = stored?.blob || item.blob;
      // Blob URLs are scoped to the origin that created them. Never carry a
      // stale blob: URL across a localhost/LAN address change; it renders as
      // a broken image and hides the fact that the original file is missing.
      // Blob URLs are scoped to the current browser origin/session.  A
      // server-backed gallery entry remains usable on another device, so use
      // it before falling back to any legacy non-blob URL.
      const sourceRemote = String(item.remoteUrl || '').trim();
      const sourceUrl = String(item.url || '').trim();
      const remoteUrl = galleryOriginalUrl(sourceRemote) || galleryOriginalUrl(sourceUrl) || (isEphemeralUrl(sourceRemote) ? '' : sourceRemote) || (isEphemeralUrl(sourceUrl) ? '' : sourceUrl);
      const previewUrl = String(item.previewUrl || (isThumbnailUrl(sourceRemote) ? sourceRemote : isThumbnailUrl(sourceUrl) ? sourceUrl : '')).trim();
      const fallback = remoteUrl || previewUrl;
      result.push({ ...item, remoteUrl, previewUrl, url: makePreview(item.id, blob, fallback) });
    }
    return result;
  };
  const releasePreview = id => {
    const url = previewUrls.get(id);
    if (!url) return;
    try { globalThis.URL.revokeObjectURL(url); } catch (_) { /* already released */ }
    previewUrls.delete(id);
  };
  const importFiles = async (files, { kind: preferredKind = null } = {}) => {
    const result = [];
    for (const file of [...(files || [])]) {
      const hash = await digestFile(file);
      const kind = preferredKind === 'card' || preferredKind === 'avatar'
        ? preferredKind
        : (/\.json$/i.test(file.name) || /\.png$/i.test(file.name) && /card|character|角色|卡/i.test(file.name) ? 'card' : 'avatar');
      const item = { id: `asset_${hash.slice(0, 24)}`, hash, kind, name: file.name, mime: file.type || 'application/octet-stream', size: file.size, blob: file, url: makePreview(`asset_${hash.slice(0, 24)}`, file), createdAt: Date.now(), updatedAt: Date.now() };
      await putAsset(item);
      result.push({ ...item, blob: undefined });
    }
    return result;
  };
  const mergeGallery = (current, added) => {
    const byId = new Map((current || []).map(item => [item.id, item]));
    for (const item of added || []) {
      const previous = byId.get(item.id);
      if (!previous) { byId.set(item.id, item); continue; }
      const newer = (item.updatedAt || 0) >= (previous.updatedAt || 0) ? item : previous;
      const older = newer === item ? previous : item;
      // A same-file re-import gets the same deterministic id. Treat its
      // fresh local Blob URL as a replacement, so a stale hosted URL from a
      // deleted server file cannot suppress the upload of the new bytes.
      const localReplacement = !String(newer.remoteUrl || '').trim()
        && (Number(newer.remoteResetAt || 0) > 0 || isEphemeralUrl(newer.url) || newer.blob);
      // Metadata from another device may be newer while the local browser
      // still owns the only Blob preview. Preserve both the hosted URL and a
      // usable local URL instead of replacing one record wholesale.
      byId.set(item.id, {
        ...older,
        ...newer,
        remoteUrl: localReplacement ? '' : preferGalleryUrl(newer.remoteUrl, older.remoteUrl),
        previewUrl: localReplacement ? '' : (newer.previewUrl || older.previewUrl || ''),
        url: localReplacement ? String(newer.url || '') : preferGalleryUrl(newer.url, older.url),
        remoteResetAt: localReplacement
          ? Number(newer.remoteResetAt || newer.updatedAt || Date.now())
          : (String(newer.remoteUrl || '').trim() ? 0 : Number(newer.remoteResetAt || older.remoteResetAt || 0)),
      });
    }
    return [...byId.values()].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  };
  // Publish local image bytes through a host-provided uploader.  Legacy
  // releases stored gallery images in User Avatars; retry those entries too so
  // they can move to the dedicated image directory and stop polluting the
  // native persona list.
  const publishAssets = async (items = [], uploader) => {
    const changed = []; const failed = [];
    if (typeof uploader !== 'function') return { changed, failed };
    for (const item of items || []) {
      if (!item?.id) continue;
      const legacyRemoteUrl = String(item.remoteUrl || '').trim();
      if (legacyRemoteUrl && !isLegacyAvatarUrl(legacyRemoteUrl)) continue;
      const stored = await getAsset(item.id).catch(() => null);
      let blob = stored?.blob || item.blob;
      if (!blob && legacyRemoteUrl && typeof fetch === 'function') {
        try {
          const response = await fetch(legacyRemoteUrl, { cache: 'no-cache' });
          if (response.ok) blob = await response.blob();
        } catch (_) { /* leave the old URL in place when the server is offline */ }
      }
      if (!blob || typeof blob.arrayBuffer !== 'function') continue;
      const mime = String(item.mime || stored?.mime || blob.type || '');
      if (!/^image\//i.test(mime)) continue;
      try {
        const hosted = await uploader(blob, item);
        const remoteUrl = String(hosted?.remoteUrl || hosted?.url || '').trim();
        if (!remoteUrl) throw new Error('服务器没有返回图库地址');
        const previewUrl = String(hosted?.previewUrl || hosted?.thumbnailUrl || '').trim();
        const updated = { ...item, remoteUrl, previewUrl, url: remoteUrl, hostedAt: Date.now(), blob, legacyRemoteUrl: legacyRemoteUrl || '' };
        await putAsset(updated);
        changed.push({ ...updated, blob: undefined });
      } catch (error) {
        failed.push({ item, error });
      }
    }
    return { changed, failed };
  };
  const clear = async () => { const items = await listAssets(); for (const item of items) { releasePreview(item.id); await deleteAsset(item.id); } };
  // The server-backed image store is the normal path.  Keep a generous
  // 500 MiB data-URL fallback for older Tavern builds or a temporarily
  // unavailable image endpoint, instead of silently imposing the old 8 MiB
  // ceiling on a gallery that may contain full-resolution images.
  const exportSync = async ({ maxBytes = 500 * 1024 * 1024, removed = {}, includeData = true } = {}) => {
    const items = await listAssets(); const assets = []; const skipped = []; let used = 0;
    for (const item of items) {
      // Hosted files are already shared through the Tavern server.  Keep only
      // their small metadata in extension settings; never base64-encode them.
      if (item.remoteUrl) {
        assets.push({ ...item, blob: undefined, data: '', url: item.remoteUrl, previewUrl: item.previewUrl || '' });
        continue;
      }
      if (!includeData) {
        skipped.push({ id: item.id, size: Number(item.size || 0) });
        continue;
      }
      const data = await blobToDataUrl(item.blob); const bytes = data.length;
      if (!data || used + bytes > maxBytes) { skipped.push({ id: item.id, size: Number(item.size || 0) }); continue; }
      used += bytes; assets.push({ ...item, blob: undefined, data });
    }
    const liveById = new Map(items.map(item => [String(item.id), Number(item.updatedAt || 0)]));
    const safeRemoved = {};
    for (const [id, at] of Object.entries(removed || {})) {
      if (!liveById.has(String(id)) || Number(at || 0) >= Number(liveById.get(String(id)) || 0)) safeRemoved[id] = Number(at || 0);
    }
    return { version: 1, updatedAt: Date.now(), assets, skipped, removed: safeRemoved };
  };
  const importSync = async (payload = {}) => {
    const assets = Array.isArray(payload.assets) ? payload.assets : [];
    const removed = payload.removed && typeof payload.removed === 'object' ? payload.removed : {};
    const restored = [];
    for (const id of Object.keys(removed)) {
      // A stale tombstone from another device must not erase a newer local
      // upload with the same deterministic asset id.
      const existing = await getAsset(id).catch(() => null);
      if (existing && Number(existing.updatedAt || 0) > Number(removed[id] || 0)) continue;
      await deleteAsset(id).catch(() => {});
    }
    for (const item of assets) {
      if (!item?.id || !item.data) continue;
      if (Number(removed[item.id] || 0) >= Number(item.updatedAt || 0)) continue;
      const existing = await getAsset(item.id).catch(() => null);
      if (existing && Number(existing.updatedAt || 0) >= Number(item.updatedAt || 0)) continue;
      const blob = await dataUrlToBlob(item.data, item.mime); if (!blob) continue;
      await putAsset({ ...item, blob, url: undefined }); restored.push(item.id);
    }
    return restored;
  };
  return { openResourceStore, putAsset, getAsset, remove: deleteAsset, listAssets, importFiles, mergeGallery, hydrateGallery, publishAssets, releasePreview, clear, exportSync, importSync, uid };
}
