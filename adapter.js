/**
 * SillyTavern bridge for 砚台·人设馆.
 * The native persona store remains the source of truth.
 */
export const EXTENSION_ID = 'yantai-persona-studio';
let nativeModulePromise = null;

export function getStContext(root = globalThis) {
  try {
    const getter = root?.SillyTavern?.getContext;
    const value = typeof getter === 'function' ? getter() : null;
    return value && typeof value === 'object' ? value : {};
  } catch (error) {
    console.warn('[砚台·人设馆] unable to read SillyTavern context', error);
    return {};
  }
}
export function getCurrentCharacter(context = getStContext()) {
  const index = Array.isArray(context?.characterId) ? context.characterId[0] : context?.characterId;
  return context?.characters?.[index] ?? context?.character ?? null;
}
export function getCurrentChat(context = getStContext()) { return context?.chat ?? context?.chatId ?? context?.chatName ?? null; }
export function getChatId(context = getStContext()) { return context?.chatId ?? context?.chat_id ?? context?.chatName ?? context?.chatMetadata?.chatId ?? context?.chat_metadata?.chat_id ?? null; }
export function getCharacterId(context = getStContext()) {
  const character = getCurrentCharacter(context);
  return character?.avatar ?? character?.id ?? (Array.isArray(context?.characterId) ? context.characterId[0] : context?.characterId) ?? null;
}
function fnv1a(value) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) { hash ^= value.charCodeAt(i); hash = Math.imul(hash, 0x01000193); }
  return (hash >>> 0).toString(16).padStart(8, '0');
}
export function characterFingerprint(character = {}, context = {}) {
  const data = character?.data || character || {};
  const source = [character?.avatar, data?.name, data?.description, data?.personality, data?.scenario, data?.first_mes, data?.creator, data?.creator_notes].filter(value => value !== undefined && value !== null).join('\u001f');
  return 'card_' + fnv1a(source);
}
export function getCardFingerprint(context = getStContext()) { return characterFingerprint(getCurrentCharacter(context), context); }

function normalizeBinding(value) {
  if (!value) return null;
  if (typeof value === 'string') return value === 'none' ? { mode: 'none' } : { mode: 'bind', personaId: value };
  if (value.mode === 'none' || value.none === true) return { mode: 'none' };
  const personaId = value.personaId ?? value.id ?? value.persona ?? value.avatar;
  return personaId ? { mode: 'bind', personaId: String(personaId) } : null;
}
export function resolveBinding(bindings = {}, context = getStContext()) {
  const cardKey = bindings.cardKey ?? getCardFingerprint(context);
  const chatKey = bindings.chatKey ?? getChatId(context);
  const card = bindings.card?.[cardKey] ?? bindings.card;
  const chat = bindings.chat?.[chatKey] ?? bindings.chat;
  for (const [scope, binding] of [['session', normalizeBinding(bindings.session)], ['chat', normalizeBinding(chat)], ['card', normalizeBinding(card)], ['global', normalizeBinding(bindings.global)]]) {
    if (binding) return { ...binding, scope, cardKey, chatKey };
  }
  return { mode: 'none', scope: 'none', cardKey, chatKey };
}

export function getExtensionSettings(context = getStContext(), extensionId = EXTENSION_ID) { return context?.extensionSettings?.[extensionId] ?? {}; }

// Assistant records used to be keyed by the current user name.  That value is
// not stable between a phone and a desktop browser, so keep a device-neutral
// prefix and migrate the old four-part keys when settings are read.
export const ASSISTANT_THREAD_KEY_VERSION = 'v2';
const RECOVERY_STORAGE_KEY = 'yantai-persona-studio.recovery.v1';
const SETTINGS_GET_PATH = '/api/settings/get';
const SETTINGS_SAVE_PATH = '/api/settings/save';

function keyPart(value, fallback = '') {
  const text = String(value ?? fallback).trim();
  return (text || fallback).replace(/[|\s]+/g, '_');
}
export function assistantThreadBaseKey(cardKey = 'no-card', chatKey = 'no-chat', session = '') {
  return [ASSISTANT_THREAD_KEY_VERSION, keyPart(cardKey, 'no-card'), keyPart(chatKey, 'no-chat'), keyPart(session)].join('|');
}
export function canonicalAssistantThreadKey(value) {
  const key = String(value || '');
  if (!key) return '';
  const parts = key.split('|');
  if (parts[0] === ASSISTANT_THREAD_KEY_VERSION) return key;
  // v1: identity|card|chat|session[|new_timestamp].  Identity is deliberately
  // dropped; card/chat/session still keep the thread scoped to its target.
  if (parts.length >= 4) {
    const base = assistantThreadBaseKey(parts[1], parts[2], parts[3]);
    return parts.length > 4 ? `${base}|${parts.slice(4).join('|')}` : base;
  }
  return key;
}

function turnSignature(turn = {}) {
  return JSON.stringify([
    turn?.at || 0,
    String(turn?.user || ''),
    String(turn?.assistant || ''),
    String(turn?.memory || ''),
    String(turn?.mode || ''),
    Array.isArray(turn?.proposals) ? turn.proposals : [],
  ]);
}
function cloneThread(thread, id) {
  const turns = Array.isArray(thread?.turns) ? thread.turns.map(turn => ({ ...turn })) : [];
  return {
    ...(thread && typeof thread === 'object' ? thread : {}),
    id,
    turns,
    createdAt: Number(thread?.createdAt || 0) || Date.now(),
    updatedAt: Number(thread?.updatedAt || 0) || Number(thread?.createdAt || 0) || Date.now(),
  };
}
export function mergeAssistantThreads(...maps) {
  const merged = {};
  for (const source of maps) {
    if (!source || typeof source !== 'object' || Array.isArray(source)) continue;
    for (const [rawKey, rawThread] of Object.entries(source)) {
      if (!rawThread || typeof rawThread !== 'object') continue;
      const key = canonicalAssistantThreadKey(rawKey) || canonicalAssistantThreadKey(rawThread.id) || String(rawKey);
      const incoming = cloneThread(rawThread, key);
      const current = merged[key];
      if (!current) {
        merged[key] = incoming;
        continue;
      }
      const turns = [...current.turns, ...incoming.turns];
      const bySignature = new Map();
      for (const turn of turns) bySignature.set(turnSignature(turn), turn);
      current.turns = [...bySignature.values()].sort((a, b) => Number(a?.at || 0) - Number(b?.at || 0));
      current.createdAt = Math.min(Number(current.createdAt || Date.now()), Number(incoming.createdAt || Date.now()));
      current.updatedAt = Math.max(Number(current.updatedAt || 0), Number(incoming.updatedAt || 0));
      if (!current.title && incoming.title) current.title = incoming.title;
    }
  }
  return merged;
}

function mergeById(remote = [], local = []) {
  const values = new Map();
  for (const item of Array.isArray(remote) ? remote : []) {
    const id = String(item?.id || '');
    if (id) values.set(id, { ...item });
  }
  for (const item of Array.isArray(local) ? local : []) {
    const id = String(item?.id || '');
    if (!id) continue;
    const old = values.get(id);
    if (!old || Number(item?.updatedAt || 0) > Number(old?.updatedAt || 0)) values.set(id, { ...old, ...item });
  }
  return [...values.values()];
}
function mergeGallerySync(remote, local) {
  if (!remote || typeof remote !== 'object') return local;
  if (!local || typeof local !== 'object') return remote;
  const assets = mergeById(remote.assets, local.assets);
  const removed = { ...(remote.removed || {}) };
  for (const [id, at] of Object.entries(local.removed || {})) removed[id] = Math.max(Number(removed[id] || 0), Number(at || 0));
  return { ...remote, ...local, assets, removed, updatedAt: Math.max(Number(remote.updatedAt || 0), Number(local.updatedAt || 0)) };
}
export function mergeExtensionState(remote = {}, local = {}) {
  const remoteState = remote && typeof remote === 'object' ? remote : {};
  const localState = local && typeof local === 'object' ? local : {};
  const merged = { ...remoteState, ...localState };
  if (remoteState.versionBackup || localState.versionBackup) {
    const remoteBackupAt = Date.parse(remoteState.versionBackup?.savedAt || '') || 0;
    const localBackupAt = Date.parse(localState.versionBackup?.savedAt || '') || 0;
    merged.versionBackup = localBackupAt > remoteBackupAt ? localState.versionBackup : remoteState.versionBackup;
  }
  merged.personaMeta = { ...(remoteState.personaMeta || {}), ...(localState.personaMeta || {}) };
  merged.personaGroups = mergeById(remoteState.personaGroups, localState.personaGroups);
  merged.drafts = mergeById(remoteState.drafts, localState.drafts).sort((a, b) => Number(b?.updatedAt || b?.createdAt || 0) - Number(a?.updatedAt || a?.createdAt || 0));
  merged.gallery = mergeById(remoteState.gallery, localState.gallery);
  merged.galleryRemoved = { ...(remoteState.galleryRemoved || {}) };
  for (const [id, at] of Object.entries(localState.galleryRemoved || {})) merged.galleryRemoved[id] = Math.max(Number(merged.galleryRemoved[id] || 0), Number(at || 0));
  merged.gallerySync = mergeGallerySync(remoteState.gallerySync, localState.gallerySync);
  merged.assistantThreads = mergeAssistantThreads(remoteState.assistantThreads, localState.assistantThreads);
  const localActive = canonicalAssistantThreadKey(localState.assistantActiveThreadKey);
  const remoteActive = canonicalAssistantThreadKey(remoteState.assistantActiveThreadKey);
  const activeCandidates = [localActive, remoteActive].filter(Boolean);
  const freshCandidates = activeCandidates.filter(key => /\|new_[^|]+$/.test(key) && merged.assistantThreads[key])
    .sort((a, b) => Number(merged.assistantThreads[b]?.updatedAt || 0) - Number(merged.assistantThreads[a]?.updatedAt || 0))[0] || '';
  const newestTurnAt = Object.values(merged.assistantThreads)
    .filter(thread => Array.isArray(thread?.turns) && thread.turns.length)
    .reduce((latest, thread) => Math.max(latest, Number(thread?.updatedAt || 0)), 0);
  const explicitNewAt = Number(localState.assistantActiveThreadChangedAt || 0);
  const freshThread = freshCandidates && !merged.assistantThreads[freshCandidates]?.turns?.length && explicitNewAt > newestTurnAt
    ? freshCandidates
    : '';
  const nonEmpty = activeCandidates.find(key => merged.assistantThreads[key]?.turns?.length);
  const latest = Object.entries(merged.assistantThreads)
    .filter(([, thread]) => Array.isArray(thread?.turns) && thread.turns.length)
    .sort((a, b) => Number(b[1]?.updatedAt || 0) - Number(a[1]?.updatedAt || 0))[0]?.[0] || '';
  merged.assistantActiveThreadKey = freshThread || latest || nonEmpty || localActive || remoteActive || '';
  merged.ui = { ...(remoteState.ui || {}), ...(localState.ui || {}) };
  return merged;
}

function requestHeaders(context = {}) {
  const getter = context?.getRequestHeaders || globalThis.getRequestHeaders;
  try {
    const value = typeof getter === 'function' ? getter() : {};
    const headers = value && typeof value === 'object' ? { ...value } : {};
    if (!Object.keys(headers).some(key => key.toLowerCase() === 'content-type')) headers['Content-Type'] = 'application/json';
    return headers;
  } catch (_) { return {}; }
}
async function readRemoteSettings(context = {}) {
  const request = globalThis.fetch;
  if (typeof request !== 'function') throw new Error('当前酒馆没有可用的网络接口。');
  const response = await request(SETTINGS_GET_PATH, { method: 'POST', headers: requestHeaders(context), body: JSON.stringify({}), cache: 'no-cache' });
  if (!response?.ok) throw new Error(`读取酒馆设置失败（${response?.status || '网络错误'}）。`);
  const data = await response.json();
  if (data?.result === 'file not find') throw new Error('酒馆尚未返回设置快照。');
  const rawSettings = data?.settings ?? (data?.extension_settings || data?.extensionSettings ? data : null);
  if (!rawSettings) throw new Error('酒馆尚未返回设置快照。');
  const settings = typeof rawSettings === 'string' ? JSON.parse(rawSettings) : rawSettings;
  if (!settings || typeof settings !== 'object') throw new Error('酒馆设置快照格式无效。');
  return settings;
}
export async function fetchRemoteExtensionState(context = {}, extensionId = EXTENSION_ID) {
  const settings = await readRemoteSettings(context);
  return settings?.extension_settings?.[extensionId] ?? settings?.extensionSettings?.[extensionId] ?? {};
}
function recoveryStorage(root = globalThis) {
  try { return root?.localStorage || null; } catch (_) { return null; }
}
function recoverySnapshot(state = {}) {
  const copy = JSON.parse(JSON.stringify(state || {}, (key, value) => key === 'blob' || key === 'data' ? undefined : value));
  return { savedAt: Date.now(), state: copy };
}
export function writeRecoveryBackup(state = {}, root = globalThis) {
  const storage = recoveryStorage(root);
  if (!storage) return false;
  try { storage.setItem(RECOVERY_STORAGE_KEY, JSON.stringify(recoverySnapshot(state))); return true; } catch (_) { return false; }
}
export function readRecoveryBackup(root = globalThis) {
  const storage = recoveryStorage(root);
  if (!storage) return null;
  try {
    const value = JSON.parse(storage.getItem(RECOVERY_STORAGE_KEY) || 'null');
    return value?.state && typeof value.state === 'object' ? value : null;
  } catch (_) { return null; }
}
function remoteStateSnapshot(state = {}) {
  const copy = { ...(state && typeof state === 'object' ? state : {}) };
  // Image bytes belong in the shared image endpoint or the gallery sync
  // manifest. Do not duplicate data URLs/Blob placeholders in full settings;
  // that can make a normal tab save exceed the host settings payload limit.
  if (Array.isArray(copy.gallery)) copy.gallery = copy.gallery.map(item => {
    if (!item || typeof item !== 'object') return item;
    const { blob, data, ...metadata } = item;
    return metadata;
  });
  return copy;
}
async function saveRemoteSettings(state, context = {}, extensionId = EXTENSION_ID) {
  // Keep a device-local copy before any network operation.  This is the last
  // line of recovery if a mobile tab is still open but its server write fails.
  writeRecoveryBackup(state);
  const remote = await readRemoteSettings(context);
  const remoteExtension = remote?.extension_settings?.[extensionId] ?? remote?.extensionSettings?.[extensionId] ?? {};
  const mergedExtension = mergeExtensionState(remoteExtension, remoteStateSnapshot(state));
  writeRecoveryBackup(mergedExtension);
  const payload = { ...remote, extension_settings: { ...(remote.extension_settings || {}), [extensionId]: mergedExtension } };
  if (remote.extensionSettings) payload.extensionSettings = { ...remote.extensionSettings, [extensionId]: mergedExtension };
  const request = globalThis.fetch;
  const response = await request(SETTINGS_SAVE_PATH, { method: 'POST', headers: requestHeaders(context), body: JSON.stringify(payload), cache: 'no-cache' });
  if (!response?.ok) throw new Error(`保存酒馆设置失败（${response?.status || '网络错误'}）。`);
  const settings = context.extensionSettings ?? (context.extensionSettings = {});
  settings[extensionId] = mergedExtension;
  writeRecoveryBackup(mergedExtension);
  return mergedExtension;
}
export async function saveExtensionSettings(patch = {}, context = getStContext(), extensionId = EXTENSION_ID) {
  const local = { ...getExtensionSettings(context, extensionId), ...(patch || {}) };
  return saveRemoteSettings(local, context, extensionId);
}
export function getChatMetadata(context = getStContext()) { return context?.chatMetadata ?? context?.chat_metadata ?? {}; }
export async function saveChatMetadata(patch = {}, context = getStContext()) {
  const metadata = context.chatMetadata ?? context.chat_metadata ?? (context.chatMetadata = {});
  Object.assign(metadata, patch);
  const saver = context.saveMetadata ?? context.saveChatDebounced ?? context.saveChat;
  if (typeof saver === 'function') await Promise.resolve(saver.call(context));
  return metadata;
}

function powerSettings(context) { return context?.powerUserSettings ?? context?.power_user ?? context?.settings?.power_user ?? {}; }
async function emitNativeEvent(context, name, payload) {
  const type = context?.eventTypes?.[name] ?? context?.event_types?.[name] ?? name;
  if (context?.eventSource?.emit && type) await Promise.resolve(context.eventSource.emit(type, payload));
}
function descriptionRecord(value) {
  if (typeof value === 'string') return { description: value, title: '' };
  if (!value || typeof value !== 'object') return { description: '', title: '' };
  return { ...value, description: String(value.description ?? value.content ?? value.text ?? ''), title: String(value.title ?? ''), position: value.position, depth: value.depth, role: value.role };
}
async function nativeApi() {
  if (!nativeModulePromise) nativeModulePromise = import('/scripts/personas.js').catch(() => null);
  return nativeModulePromise;
}

function avatarFileName(value) {
  let raw = String(value || '').trim();
  if (!raw) return '';
  try { raw = decodeURIComponent(raw); } catch (_) { /* keep the original path */ }
  raw = raw.split(/[?#]/, 1)[0].replace(/\\/g, '/');
  const marker = raw.toLowerCase().lastIndexOf('/user avatars/');
  if (marker >= 0) raw = raw.slice(marker + '/user avatars/'.length);
  return raw.split('/').filter(Boolean).pop() || '';
}

async function nativeAvatarUrl(file, context = {}, native = null) {
  const avatarId = avatarFileName(file);
  if (!avatarId) return '';
  try {
    const url = await Promise.resolve(context?.getThumbnailUrl?.('persona', avatarId));
    if (url) return String(url);
  } catch (_) { /* use the stable thumbnail fallback below */ }
  try {
    const url = await Promise.resolve(native?.getUserAvatar?.(avatarId));
    if (url) return String(url);
  } catch (_) { /* use the stable thumbnail fallback below */ }
  return '/thumbnail?type=persona&file=' + encodeURIComponent(avatarId);
}
function originalAvatarUrl(file) {
  const avatarId = avatarFileName(file);
  return avatarId ? '/User Avatars/' + encodeURIComponent(avatarId) : '';
}

function fileToBase64(file) {
  return file.arrayBuffer().then(buffer => {
    const bytes = new Uint8Array(buffer);
    let binary = '';
    const chunkSize = 0x8000;
    for (let offset = 0; offset < bytes.length; offset += chunkSize) {
      binary += String.fromCharCode(...bytes.subarray(offset, Math.min(offset + chunkSize, bytes.length)));
    }
    return btoa(binary);
  });
}

/**
 * Upload an image through SillyTavern's own avatar endpoint.  Keeping this
 * here (rather than storing a blob URL only in the extension) means the image
 * survives reloads and can be used by the native persona store.  The crop
 * dialog and crop query are the same ones used by personas.js.
 */
export async function uploadNativeAvatar(file, { resizePrompt = true, overwriteName = '', createPersona = true, context = getStContext() } = {}) {
  // IndexedDB may restore a Blob from another realm, so avoid a strict
  // instanceof check here. FormData and the native helpers only need the
  // standard Blob/File methods.
  if (!file || typeof file.arrayBuffer !== 'function') throw new Error('请选择一个图片文件。');
  if (!overwriteName && createPersona === false) throw new Error('应用头像时必须指定已有的人设。');
  const [native, popupModule, utilsModule, scriptModule] = await Promise.all([
    nativeApi(),
    import('/scripts/popup.js').catch(() => ({})),
    import('/scripts/utils.js').catch(() => ({})),
    import('/scripts/script.js').catch(() => ({})),
  ]);
  const { Popup, POPUP_TYPE } = popupModule;
  const getBase64Async = utilsModule.getBase64Async;
  const ensureImageFormatSupported = utilsModule.ensureImageFormatSupported;
  const power = powerSettings(context);
  let url = '/api/avatars/upload';
  if (resizePrompt && !power.never_resize_avatars && typeof Popup === 'function' && POPUP_TYPE?.CROP && typeof getBase64Async === 'function') {
    const dataUrl = await getBase64Async(file);
    const dialog = new Popup('设置头像裁切位置', POPUP_TYPE.CROP, '', { cropImage: dataUrl });
    const result = await dialog.show();
    if (!result) return { cancelled: true };
    if (dialog.cropData !== undefined) url += `?crop=${encodeURIComponent(JSON.stringify(dialog.cropData))}`;
  }
  const uploadFile = typeof ensureImageFormatSupported === 'function' ? await ensureImageFormatSupported(file) : file;
  const formData = new FormData();
  formData.append('avatar', uploadFile, uploadFile.name || 'avatar.png');
  if (overwriteName) formData.append('overwrite_name', overwriteName);
  const getHeaders = scriptModule.getRequestHeaders || context?.getRequestHeaders || globalThis.getRequestHeaders;
  const headers = typeof getHeaders === 'function' ? getHeaders({ omitContentType: true }) : {};
  const response = await fetch(url, { method: 'POST', headers, cache: 'no-cache', body: formData });
  if (!response.ok) throw new Error(`头像上传失败：${response.statusText}`);
  const data = await response.json().catch(() => ({}));
  const avatarId = String(data?.path || data?.file || overwriteName || '');
  if (!avatarId) throw new Error('酒馆没有返回头像文件名。');
  if (overwriteName) {
    await fetch('/User Avatars/' + encodeURIComponent(avatarId), { cache: 'reload' }).catch(() => {});
    await fetch('/thumbnail?type=persona&file=' + encodeURIComponent(avatarId), { cache: 'reload' }).catch(() => {});
  } else {
    // Match changeUserAvatar(): refresh the native list before opening the
    // name/description prompt, then focus the newly-created persona.
    await native?.getUserAvatars?.(false);
    if (createPersona && typeof native?.createPersona === 'function') await native.createPersona(avatarId);
  }
  // A rendered avatar-list refresh calls addMissingPersonas() in SillyTavern.
  // The overwrite path already targets an existing persona, so only refresh
  // the raw list here; this avoids turning an unrelated gallery file into a
  // new [Unnamed Persona].
  await native?.getUserAvatars?.(false, avatarId);
  return { avatarId, created: !overwriteName && createPersona };
}

/**
 * Store a gallery image in SillyTavern's per-user image directory.  The
 * avatar endpoint must never be used here: getUserAvatars() treats every file
 * in User Avatars as a persona and silently creates [Unnamed Persona] records.
 * The image endpoint is shared across clients but is not enumerated by the
 * persona manager.
 */
export async function uploadGalleryAsset(file, { assetId = '', context = getStContext() } = {}) {
  if (!file || typeof file.arrayBuffer !== 'function') throw new Error('请选择一个图片文件。');
  const utilsModule = await import('/scripts/utils.js').catch(() => ({}));
  const scriptModule = await import('/scripts/script.js').catch(() => ({}));
  const ensureImageFormatSupported = utilsModule.ensureImageFormatSupported;
  const convertImageFile = utilsModule.convertImageFile;
  let uploadFile = typeof ensureImageFormatSupported === 'function' ? await ensureImageFormatSupported(file) : file;
  let mime = String(uploadFile.type || file.type || 'image/png').toLowerCase();
  if (!/^image\/(?:png|jpe?g|webp|gif|bmp|jfif)$/i.test(mime)) {
    if (typeof convertImageFile !== 'function') throw new Error('酒馆当前版本不支持这种图片格式，请改用 PNG、JPG、WEBP、GIF 或 BMP。');
    uploadFile = await convertImageFile(uploadFile, 'image/png');
    mime = 'image/png';
  }
  const ext = mime.includes('jpeg') || mime.includes('jpg') ? '.jpg'
    : mime.includes('webp') ? '.webp'
      : mime.includes('gif') ? '.gif'
        : mime.includes('bmp') ? '.bmp'
          : mime.includes('jfif') ? '.jfif' : '.png';
  const base = String(assetId || file.name || `asset-${Date.now()}`)
    .replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 90) || `asset-${Date.now()}`;
  const overwriteName = `ytps-${base}${ext}`;
  const encoded = await fileToBase64(uploadFile);
  const getHeaders = scriptModule.getRequestHeaders || context?.getRequestHeaders || globalThis.getRequestHeaders;
  const headers = typeof getHeaders === 'function' ? getHeaders() : {};
  headers['Content-Type'] = 'application/json';
  const response = await fetch('/api/images/upload', {
    method: 'POST', headers, cache: 'no-cache',
    body: JSON.stringify({ image: encoded, format: ext.slice(1), filename: overwriteName }),
  });
  if (!response.ok) throw new Error(`图库上传失败：${response.statusText}`);
  const result = await response.json().catch(() => ({}));
  const returnedPath = String(result?.path || `/user/images/${encodeURIComponent(overwriteName)}`).trim();
  const remoteUrl = returnedPath.startsWith('/') ? returnedPath : '/' + returnedPath;
  if (!remoteUrl) throw new Error('酒馆没有返回图库文件地址。');
  await fetch(remoteUrl, { cache: 'reload' }).catch(() => {});
  return { avatarId: overwriteName, fileName: overwriteName, remoteUrl };
}

/** Delete a server-backed gallery image without touching persona settings. */
export async function deleteGalleryAsset(remoteUrl, { context = getStContext() } = {}) {
  const value = String(remoteUrl || '').trim();
  if (!/^\/?user\/images\//i.test(value)) return false;
  const scriptModule = await import('/scripts/script.js').catch(() => ({}));
  const getHeaders = scriptModule.getRequestHeaders || context?.getRequestHeaders || globalThis.getRequestHeaders;
  const headers = typeof getHeaders === 'function' ? getHeaders() : {};
  headers['Content-Type'] = 'application/json';
  const response = await fetch('/api/images/delete', {
    method: 'POST', headers, cache: 'no-cache', body: JSON.stringify({ path: value.replace(/^\//, '') }),
  });
  return response.ok;
}

/** Remove a legacy gallery file that was accidentally uploaded as an avatar. */
export async function removeLegacyGalleryAvatar(file, { context = getStContext() } = {}) {
  // Legacy cleanup is intentionally disabled while settings may be stale on a
  // second device.  Deleting a file from User Avatars can delete a persona
  // that was created or edited on the phone.  A later maintenance pass can
  // remove these files after a server-side persona list has been confirmed.
  return false;
}

/** Create a persona directly from the extension workspace without opening the native drawer. */
export async function createNativePersona({ name, title = '', description = '', position, depth, role, lorebook = '' } = {}, context = getStContext(), api = null) {
  const personaName = String(name || '').trim();
  if (!personaName) throw new Error('请先填写人设名称。');
  const native = api || await nativeApi();
  const settings = powerSettings(context);
  const slug = personaName.replace(/[^a-zA-Z0-9]+/g, '').slice(0, 40) || 'persona';
  let avatarId = `${Date.now()}-${slug}.png`;
  while (settings.personas?.[avatarId]) avatarId = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}-${slug}.png`;
  const descriptor = { description: String(description || ''), title: String(title || ''), position, depth, role, lorebook: String(lorebook || '') };

  const response = await fetch('/img/user-default.png', { cache: 'no-cache' });
  if (!response.ok) throw new Error(`创建人设头像失败：${response.statusText}`);
  const blob = await response.blob();
  const file = typeof File === 'function' ? new File([blob], 'persona-default.png', { type: blob.type || 'image/png' }) : blob;
  await uploadNativeAvatar(file, { resizePrompt: false, overwriteName: avatarId, createPersona: false, context });
  if (typeof native?.initPersona === 'function') {
    await native.initPersona(avatarId, personaName, descriptor.description, descriptor.title, { silent: true, position, depth, role, lorebook: descriptor.lorebook });
  } else {
    settings.personas = settings.personas || {};
    settings.persona_descriptions = settings.persona_descriptions || {};
    settings.personas[avatarId] = personaName;
    settings.persona_descriptions[avatarId] = { ...descriptor };
    const saver = context.saveSettingsDebounced ?? context.saveSettings;
    if (typeof saver === 'function') await Promise.resolve(saver.call(context));
  }
  await native?.getUserAvatars?.(false, avatarId);
  await emitNativeEvent(context, 'PERSONA_CREATED', { avatarId, name: personaName, description: descriptor.description, title: descriptor.title });
  return { id: avatarId, avatarId, name: personaName };
}
function currentNativeId(context, api = null) {
  const settings = powerSettings(context);
  return api?.user_avatar ?? context?.user_avatar ?? settings.user_avatar ?? context?.currentAvatar ?? null;
}
function personaImageUrl(context, avatarId, api = null) {
  const id = String(avatarId || '');
  if (!id) return '';
  if (/^(?:https?:|data:|blob:)/i.test(id)) return id;
  try {
    if (typeof api?.getUserAvatar === 'function') return api.getUserAvatar(id);
  } catch (_) { /* use the stable native endpoint below */ }
  // The thumbnail endpoint is intentionally only a fallback. It is useful on
  // older ST/TT builds, but it downscales the image and made the editor look
  // blurry even when the original avatar was sharp.
  return '/User Avatars/' + encodeURIComponent(id);
}

/** Read every persona already present in the native store. No import step. */
export function listNativePersonas(context = getStContext(), api = null) {
  const settings = powerSettings(context);
  const names = settings.personas && typeof settings.personas === 'object' ? settings.personas : {};
  const descriptions = settings.persona_descriptions && typeof settings.persona_descriptions === 'object' ? settings.persona_descriptions : {};
  const currentId = currentNativeId(context, api);
  const defaultId = settings.default_persona ?? settings.defaultPersona ?? null;
  return Object.entries(names).map(([nativeId, name]) => {
    const record = descriptionRecord(descriptions[nativeId]);
    return { id: String(nativeId), nativeId: String(nativeId), name: String(name || nativeId), description: record.description, title: record.title, lorebook: String(record.lorebook || ''), connections: Array.isArray(record.connections) ? record.connections : [], position: record.position, depth: record.depth, role: record.role, avatarRef: personaImageUrl(context, nativeId, api), isCurrent: String(nativeId) === String(currentId ?? ''), isDefault: String(nativeId) === String(defaultId ?? ''), source: 'native', raw: record };
  });
}
export function readNativePersona(context = getStContext(), api = null) {
  const id = currentNativeId(context, api);
  const item = listNativePersonas(context, api).find(persona => String(persona.id) === String(id));
  if (item) return item;
  const fallback = context?.persona ?? context?.currentPersona ?? context?.userPersona ?? {};
  return { id: fallback?.id || fallback?.name || id || null, name: String(fallback?.name || fallback?.title || ''), description: String(fallback?.description || fallback?.content || fallback?.text || ''), title: String(fallback?.title || ''), raw: fallback };
}
function nativeLockCandidates(settings, context) {
  const chatMeta = getChatMetadata(context);
  const cardKey = getCharacterId(context) || getCardFingerprint(context);
  const currentCharacterId = getCharacterId(context);
  const groupId = context?.groupId ?? context?.selected_group ?? context?.selectedGroup ?? null;
  const connection = groupId ? { type: 'group', id: String(groupId) } : currentCharacterId ? { type: 'character', id: String(currentCharacterId) } : null;
  let character = null;
  // SillyTavern stores character locks on each persona descriptor rather than
  // in a separate persona_links map. Keep the returned shape small, but use
  // the native connection records as the source of truth.
  const descriptions = settings?.persona_descriptions && typeof settings.persona_descriptions === 'object'
    ? settings.persona_descriptions
    : {};
  if (connection) {
    const persona = Object.entries(descriptions).find(([, descriptor]) =>
      Array.isArray(descriptor?.connections)
      && descriptor.connections.some(item => item?.type === connection.type && String(item.id) === connection.id));
    if (persona) character = persona[0];
  }
  return { session: null, chat: chatMeta.persona ?? chatMeta.personaId ?? chatMeta.user_persona ?? null, card: character, global: settings.default_persona ?? settings.defaultPersona ?? null, cardKey: getCardFingerprint(context), chatKey: getChatId(context) };
}
export function readPersonaBindings(context = getStContext(), extensionId = EXTENSION_ID) {
  const own = getExtensionSettings(context, extensionId);
  const native = nativeLockCandidates(powerSettings(context), context);
  return { session: own.sessionBinding ?? null, chat: native.chat ?? own.chatBinding ?? null, card: native.card ?? own.cardBindings ?? null, global: native.global ?? own.defaultPersonaId ?? null, cardKey: native.cardKey, chatKey: native.chatKey };
}
export function getEffectivePersonaBinding(context = getStContext(), extensionId = EXTENSION_ID) { return resolveBinding(readPersonaBindings(context, extensionId), context); }

async function executeNativeCommand(command, context) {
  const runners = [context?.executeSlashCommands, context?.executeSlashCommandsWithOptions, globalThis?.executeSlashCommands];
  const runner = runners.find(fn => typeof fn === 'function');
  // Keep an unavailable runner distinct from a command that returned false
  // (for example, when the user cancels the native confirmation dialog).
  if (!runner) return null;
  return await Promise.resolve(runner.call(context, command));
}
function escapeSelector(value) { return globalThis.CSS?.escape ? CSS.escape(String(value)) : String(value).replace(/[^a-zA-Z0-9_-]/g, '\\$&'); }
function findNativeCard(id) { return document.querySelector('#user_avatar_block .avatar-container[data-avatar-id="' + escapeSelector(id) + '"], #user_avatar_block [data-avatar-id="' + escapeSelector(id) + '"]'); }
export async function selectNativePersona(id, context = getStContext(), api = null) {
  if (!id) return false;
  const setter = [api?.setUserAvatar, api?.selectPersona, api?.setPersona, context?.selectPersona, context?.setPersona, context?.setUserAvatar].find(fn => typeof fn === 'function');
  if (setter) { await Promise.resolve(setter.call(api || context, id)); return true; }
  const card = findNativeCard(id);
  if (card) { card.click(); return true; }
  return false;
}
export async function setNativeDefaultPersona(id, context = getStContext(), api = null) {
  const settings = powerSettings(context);
  if (id && !(String(id) in (settings.personas || {}))) return false;
  if (typeof api?.setDefaultPersona === 'function') {
    await Promise.resolve(api.setDefaultPersona(id || null));
    await emitNativeEvent(context, 'PERSONA_UPDATED', id || null);
    return true;
  }
  if (id) settings.default_persona = id;
  else delete settings.default_persona;
  const saver = context.saveSettingsDebounced ?? context.saveSettings;
  if (typeof saver === 'function') await Promise.resolve(saver.call(context));
  await emitNativeEvent(context, 'PERSONA_UPDATED', id || null);
  return true;
}

/**
 * Update the small, user-facing part of a persona without opening the
 * crowded native editor.  The native persona store remains the source of
 * truth; this only writes the same power-user records that personas.js uses.
 */
export async function updateNativePersona(id, patch = {}, context = getStContext(), api = null) {
  const avatarId = String(id || '');
  const settings = powerSettings(context);
  if (!avatarId || !settings.personas || !(avatarId in settings.personas)) return false;
  const descriptor = settings.persona_descriptions?.[avatarId] || {
    description: '', position: 0, depth: 4, role: 0, lorebook: '', title: '',
  };
  if (patch.name !== undefined) settings.personas[avatarId] = String(patch.name || avatarId);
  settings.persona_descriptions = settings.persona_descriptions || {};
  settings.persona_descriptions[avatarId] = {
    ...descriptor,
    ...(patch.description !== undefined ? { description: String(patch.description || '') } : {}),
    ...(patch.note !== undefined ? { title: String(patch.note || '') } : {}),
    ...(patch.title !== undefined ? { title: String(patch.title || '') } : {}),
    ...(patch.lorebook !== undefined ? { lorebook: String(patch.lorebook || '') } : {}),
  };
  const current = currentNativeId(context, api);
  if (String(current || '') === avatarId) {
    if (patch.description !== undefined) settings.persona_description = String(patch.description || '');
    if (patch.lorebook !== undefined) settings.persona_description_lorebook = String(patch.lorebook || '');
  }
  const saver = context.saveSettingsDebounced ?? context.saveSettings;
  if (typeof saver === 'function') await Promise.resolve(saver.call(context));
  await emitNativeEvent(context, 'PERSONA_UPDATED', avatarId);
  const native = api || await nativeApi();
  await native?.getUserAvatars?.(false, avatarId);
  return true;
}

/** Use the native confirmation and deletion path for a persona. */
export async function deleteNativePersona(id, context = getStContext(), api = null) {
  const avatarId = String(id || '');
  if (!avatarId) return false;

  // Delete by explicit avatar id through SillyTavern's own command. The old
  // path first selected the target with setUserAvatar(), which could trigger
  // auto-locking for the current chat. Deleting an ordinary archive persona
  // could then make the default persona appear to be unbound after reload.
  // The native command keeps current/default/card bindings untouched and
  // still uses the native confirmation UI.
  const escapedId = avatarId.replace(/([\\"])/g, '\\\\$1');
  const commandResult = await executeNativeCommand(`/persona-delete persona="${escapedId}"`, context);
  // `null` alone means no runner. A runner may legitimately resolve to
  // `undefined` after handling the command, so that value is still treated as
  // handled rather than falling back to the active-persona button path.
  if (commandResult !== null) {
    const value = commandResult && typeof commandResult === 'object' && 'pipe' in commandResult
      ? commandResult.pipe
      : commandResult;
    return value !== false && value !== 'false';
  }

  const native = api || await nativeApi();
  if (native?.setUserAvatar) await native.setUserAvatar(avatarId, { toastPersonaNameChange: false });
  const button = document.querySelector('#persona_delete_button');
  if (button) {
    button.click();
    return true;
  }
  return false;
}

/** Duplicate a persona through SillyTavern's public persona helpers. */
export async function duplicateNativePersona(id, context = getStContext(), api = null) {
  const avatarId = String(id || '');
  if (!avatarId) return false;
  const native = api || await nativeApi();
  const settings = powerSettings(context);
  const personaName = String(settings.personas?.[avatarId] || '');
  if (!personaName) return false;

  // The native slash command always emits an English toast and has no quiet
  // option. Reproduce its public operation without changing the active persona.
  const newAvatarId = `${Date.now()}-${personaName.replace(/[^a-zA-Z0-9]/g, '')}.png`;
  const descriptor = settings.persona_descriptions?.[avatarId] || {};
  const sourceUrl = typeof native?.getUserAvatar === 'function'
    ? native.getUserAvatar(avatarId)
    : '/User Avatars/' + encodeURIComponent(avatarId);
  const sourceResponse = await fetch(sourceUrl, { cache: 'no-cache' });
  if (!sourceResponse.ok) throw new Error(`复制人设头像失败：${sourceResponse.statusText}`);
  const sourceBlob = await sourceResponse.blob();
  const uploadFile = typeof File === 'function'
    ? new File([sourceBlob], 'avatar.png', { type: sourceBlob.type || 'image/png' })
    : sourceBlob;
  const formData = new FormData();
  formData.append('avatar', uploadFile, 'avatar.png');
  formData.append('overwrite_name', newAvatarId);
  const getHeaders = context?.getRequestHeaders || globalThis.getRequestHeaders;
  const headers = typeof getHeaders === 'function' ? getHeaders({ omitContentType: true }) : {};
  const uploadResponse = await fetch('/api/avatars/upload', { method: 'POST', headers, cache: 'no-cache', body: formData });
  if (!uploadResponse.ok) throw new Error(`复制人设头像失败：${uploadResponse.statusText}`);

  if (typeof native?.initPersona === 'function') {
    await native.initPersona(newAvatarId, personaName, descriptor.description || '', descriptor.title || '', {
      silent: true,
      position: descriptor.position,
      depth: descriptor.depth,
      role: descriptor.role,
      lorebook: descriptor.lorebook || '',
    });
  } else {
    settings.personas[newAvatarId] = personaName;
    settings.persona_descriptions = settings.persona_descriptions || {};
    settings.persona_descriptions[newAvatarId] = { ...descriptor };
    const saver = context.saveSettingsDebounced ?? context.saveSettings;
    if (typeof saver === 'function') await Promise.resolve(saver.call(context));
  }
  await native?.getUserAvatars?.(false, newAvatarId);
  await emitNativeEvent(context, 'PERSONA_CREATED', { avatarId: newAvatarId, name: personaName, description: descriptor.description || '', title: descriptor.title || '', duplicatedFromAvatarId: avatarId });
  const toast = globalThis.toastr?.success;
  if (typeof toast === 'function') toast.call(globalThis.toastr, `人设“${personaName}”已成功复制`, '砚台 · 人设馆');
  return true;
}

/**
 * Open SillyTavern's native persona-lorebook selector for a target persona.
 * The active persona is never changed; callers receive {cancelled, lorebook}.
 */
export async function choosePersonaLorebook(id, context = getStContext(), api = null) {
  const avatarId = String(id || currentNativeId(context, api) || '');
  const settings = powerSettings(context);
  const descriptor = settings.persona_descriptions?.[avatarId] || {};
  const initialLorebook = String(descriptor.lorebook || (String(currentNativeId(context, api) || '') === avatarId ? settings.persona_description_lorebook || '' : ''));
  if (!avatarId || !settings.personas?.[avatarId]) return { cancelled: true, lorebook: initialLorebook };

  const [worldInfo, popup, templates] = await Promise.all([
    import('/scripts/world-info.js').catch(() => ({})),
    import('/scripts/popup.js').catch(() => ({})),
    import('/scripts/templates.js').catch(() => ({})),
  ]);
  if (typeof templates.renderTemplateAsync !== 'function' || typeof popup.callGenericPopup !== 'function') {
    throw new Error('酒馆原生世界书选择器尚未加载。');
  }
  const rendered = await templates.renderTemplateAsync('personaLorebook', {}, true, true);
  if (!rendered || !globalThis.document) throw new Error('无法打开酒馆世界书选择器。');
  const host = document.createElement('div');
  host.innerHTML = String(rendered).trim();
  const content = host.firstElementChild || host;
  const select = content.querySelector?.('.persona_world_info_selector, select');
  if (!select) throw new Error('酒馆世界书选择器缺少下拉框。');
  const names = Array.isArray(worldInfo.world_names) ? worldInfo.world_names : [];
  for (const worldName of names) {
    const option = document.createElement('option');
    option.value = String(worldName);
    option.textContent = String(worldName);
    option.selected = initialLorebook === String(worldName);
    select.appendChild(option);
  }
  select.value = initialLorebook;
  const result = await popup.callGenericPopup(content, popup.POPUP_TYPE?.TEXT ?? 1);
  if (!result) return { cancelled: true, lorebook: initialLorebook };
  const lorebook = String(select.value || '');
  await updateNativePersona(avatarId, { lorebook }, context, api || await nativeApi());
  return { cancelled: false, lorebook };
}
export async function setNativeBinding(scope, id, context = getStContext(), api = null) {
  const native = api || await nativeApi();
  if (scope === 'global') {
    if (!id) {
      const settings = powerSettings(context);
      const locked = settings.default_persona ?? settings.defaultPersona ?? null;
      if (locked) {
        if (typeof native?.setPersonaLockState === 'function') {
          await selectNativePersona(locked, context, native);
          await native.setPersonaLockState(false, 'default');
        } else {
          delete settings.default_persona;
          delete settings.defaultPersona;
          const saver = context.saveSettingsDebounced ?? context.saveSettings;
          if (typeof saver === 'function') await Promise.resolve(saver.call(context));
        }
        await emitNativeEvent(context, 'PERSONA_UPDATED', null);
      }
      return true;
    }
    const settings = powerSettings(context);
    if (String(settings.default_persona) !== String(id)) {
      await selectNativePersona(id, context, native);
      if (typeof native?.setPersonaLockState === 'function') await native.setPersonaLockState(true, 'default');
      else await setNativeDefaultPersona(id, context, native);
    }
    return true;
  }
  if (scope === 'session') return id ? selectNativePersona(id, context, native) : false;

  const settings = powerSettings(context);
  if (scope === 'chat') {
    const metadata = getChatMetadata(context);
    if (id) {
      await selectNativePersona(id, context, native);
      if (typeof native?.setPersonaLockState === 'function') await native.setPersonaLockState(true, 'chat');
      else metadata.persona = String(id);
    } else {
      const locked = metadata.persona;
      if (locked) {
        await selectNativePersona(locked, context, native);
        if (typeof native?.setPersonaLockState === 'function') await native.setPersonaLockState(false, 'chat');
        else delete metadata.persona;
      }
    }
    if (typeof native?.setPersonaLockState !== 'function') {
      const saver = context.saveMetadata ?? context.saveMetadataDebounced ?? context.saveChatDebounced;
      if (typeof saver === 'function') await Promise.resolve(saver.call(context));
    }
    await emitNativeEvent(context, 'PERSONA_UPDATED', id || null);
    return true;
  }

  if (scope === 'card') {
    if (typeof native?.setPersonaLockState !== 'function') return false;
    const locked = nativeLockCandidates(settings, context).card;
    if (id) {
      await selectNativePersona(id, context, native);
      await native.setPersonaLockState(true, 'character');
    } else if (locked) {
      await selectNativePersona(locked, context, native);
      await native.setPersonaLockState(false, 'character');
    }
    await emitNativeEvent(context, 'PERSONA_UPDATED', id || null);
    return true;
  }

  return false;
}
export async function openNativePersonaPanel() {
  const panel = () => [...document.querySelectorAll('#persona-management-block')].find(item => item.offsetParent !== null) || document.querySelector('#persona-management-block');
  const isOpen = () => [...document.querySelectorAll('#PersonaManagement.drawer-content, #persona-management-button .drawer-content')].some(item => item.classList.contains('openDrawer') && item.offsetParent !== null);
  if (!isOpen()) {
    const button = document.querySelector('#persona-management-button .drawer-toggle, #persona-management-button, [data-i18n="Persona Management"]');
    button?.click();
  }
  // The native drawer may render after the click on mobile layouts. Wait for
  // the real block instead of falling back to document.body and creating a
  // detached second page.
  for (let attempt = 0; attempt < 24; attempt += 1) {
    const block = panel();
    if (block && (isOpen() || attempt > 3)) return block;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  return panel();
}
export function isNativePersonaPanelOpen() {
  return [...document.querySelectorAll('#PersonaManagement.drawer-content, #persona-management-button .drawer-content')].some(item => item.classList.contains('openDrawer') && item.offsetParent !== null);
}
export function setNativeTakeover(active = true) {
  const block = [...document.querySelectorAll('#persona-management-block')].find(item => item.offsetParent !== null) || document.querySelector('#persona-management-block');
  if (!block) return false;
  block.classList.toggle('ytps-takeover', Boolean(active));
  block.classList.toggle('ytps-native-edit', false);
  return true;
}
export function setNativeEditMode(active = true) {
  const block = document.querySelector('#persona-management-block');
  if (!block) return false;
  block.classList.toggle('ytps-takeover', false);
  block.classList.toggle('ytps-native-edit', Boolean(active));
  return true;
}
export function focusNativePersona(id) {
  const card = findNativeCard(id);
  card?.scrollIntoView?.({ block: 'nearest' });
  card?.classList.add('ytps-native-focus');
  setTimeout(() => card?.classList.remove('ytps-native-focus'), 1200);
  return Boolean(card);
}
function renameNativeTransferLabels(active = true) {
  const specs = [
    ['#personas_backup', /备份/g, '导出', '将用户设定导出到文件中'],
    ['#personas_restore', /恢复/g, '导入', '从文件中导入用户设定'],
  ];
  for (const [selector, pattern, replacement, title] of specs) {
    const button = document.querySelector(selector);
    if (!button) continue;
    const textNode = button.querySelector('span') || Array.from(button.childNodes || []).find(node => node.nodeType === 3 && (pattern.test(node.nodeValue || '') || Object.prototype.hasOwnProperty.call(button.dataset, 'yantaiOriginalTransferText')));
    pattern.lastIndex = 0;
    if (!textNode) continue;
    if (!Object.prototype.hasOwnProperty.call(button.dataset, 'yantaiOriginalTransferText')) button.dataset.yantaiOriginalTransferText = textNode.textContent || textNode.nodeValue || '';
    if (active) {
      // installEntry also runs after DOM mutations. Assigning textContent even
      // to the same text replaces child nodes and would retrigger the observer.
      const currentText = textNode.textContent || textNode.nodeValue || '';
      const nextText = currentText.replace(pattern, replacement);
      if (nextText !== currentText) textNode.textContent = nextText;
      if (!Object.prototype.hasOwnProperty.call(button.dataset, 'yantaiOriginalTransferTitle')) button.dataset.yantaiOriginalTransferTitle = button.getAttribute('title') || '';
      if (button.getAttribute('title') !== title) button.setAttribute('title', title);
    } else {
      textNode.textContent = button.dataset.yantaiOriginalTransferText || textNode.textContent || textNode.nodeValue || '';
      if (Object.prototype.hasOwnProperty.call(button.dataset, 'yantaiOriginalTransferTitle')) {
        const originalTitle = button.dataset.yantaiOriginalTransferTitle;
        if (originalTitle) button.setAttribute('title', originalTitle); else button.removeAttribute('title');
      }
      delete button.dataset.yantaiOriginalTransferText;
      delete button.dataset.yantaiOriginalTransferTitle;
    }
  }
}

function renameNativePersonaHeader(active = true) {
  const heading = document.querySelector('#PersonaManagement h3');
  if (!heading) return;
  if (active) {
    if (!Object.prototype.hasOwnProperty.call(heading.dataset, 'yantaiOriginalPersonaHeaderDisplay')) heading.dataset.yantaiOriginalPersonaHeaderDisplay = heading.style.display || '';
    heading.style.display = 'none';
  } else if (Object.prototype.hasOwnProperty.call(heading.dataset, 'yantaiOriginalPersonaHeaderDisplay')) {
    heading.style.display = heading.dataset.yantaiOriginalPersonaHeaderDisplay || '';
    delete heading.dataset.yantaiOriginalPersonaHeaderDisplay;
  }
  const label = Array.from(heading.querySelectorAll('span')).find(item => !item.closest('a')) || heading.firstElementChild;
  const help = heading.querySelector('a');
  if (label) {
    if (!Object.prototype.hasOwnProperty.call(label.dataset, 'yantaiOriginalPersonaHeader')) label.dataset.yantaiOriginalPersonaHeader = label.textContent || '';
    label.textContent = active ? '人设管理' : (label.dataset.yantaiOriginalPersonaHeader || label.textContent || '');
  }
  if (help) {
    if (!Object.prototype.hasOwnProperty.call(help.dataset, 'yantaiOriginalPersonaHelpDisplay')) help.dataset.yantaiOriginalPersonaHelpDisplay = help.style.display || '';
    help.style.display = active ? 'none' : (help.dataset.yantaiOriginalPersonaHelpDisplay || '');
    if (!active) delete help.dataset.yantaiOriginalPersonaHelpDisplay;
  }
  if (!active && label) delete label.dataset.yantaiOriginalPersonaHeader;
}
function normalizeChatMessages(value) {
  const messages = Array.isArray(value)
    ? value
    : Array.isArray(value?.messages)
      ? value.messages
      : (typeof value === 'string' && value.trim() ? [{ mes: value, is_user: false }] : []);
  return messages.slice(-12).map(item => ({
    name: String(item?.name || item?.sender || ''),
    is_user: Boolean(item?.is_user ?? item?.isUser ?? item?.role === 'user'),
    mes: String(item?.mes ?? item?.message ?? item?.content ?? '').slice(0, 1600),
  })).filter(item => item.mes.trim());
}

function worldNamesForContext(context, worldApi = {}) {
  const names = [];
  const add = value => {
    if (Array.isArray(value)) value.forEach(add);
    else if (typeof value === 'string' && value.trim() && !names.includes(value.trim())) names.push(value.trim());
  };
  // Global books are exposed by world-info.js, not by getContext().
  add(worldApi.selected_world_info);
  add(worldApi.world_info?.globalSelect);
  const character = getCurrentCharacter(context);
  const data = character?.data || character || {};
  add(data?.extensions?.world);
  const avatar = String(character?.avatar || data?.avatar || '');
  const charLore = Array.isArray(worldApi.world_info?.charLore) ? worldApi.world_info.charLore : [];
  const extra = charLore.find(item => {
    const key = String(item?.name || '');
    return key && [avatar, data?.name, character?.name].some(value => value && String(value) === key);
  });
  add(extra?.extraBooks);
  const metadata = getChatMetadata(context);
  add(metadata?.world_info ?? metadata?.worldInfo ?? metadata?.chatLorebook);
  const power = powerSettings(context);
  add(power?.persona_description_lorebook ?? power?.personaDescriptionLorebook);
  return names;
}

async function readRelatedWorldbooks(context) {
  const worldApi = await import('/scripts/world-info.js').catch(() => null);
  if (!worldApi) return { selected: [], books: [], unavailable: ['world-info.js'] };
  const names = worldNamesForContext(context, worldApi);
  const books = [];
  const unavailable = [];
  for (const name of names) {
    try {
      const data = typeof worldApi.loadWorldInfo === 'function' ? await worldApi.loadWorldInfo(name) : null;
      if (!data || typeof data !== 'object') { unavailable.push(name); continue; }
      const entries = data.entries && typeof data.entries === 'object' ? Object.values(data.entries) : [];
      books.push({ name, entries: entries.map(entry => ({
        key: Array.isArray(entry?.key) ? entry.key.map(String).slice(0, 24) : entry?.key,
        content: String(entry?.content ?? ''),
        comment: String(entry?.comment ?? ''),
        enabled: entry?.disable !== true,
        position: entry?.position,
        depth: entry?.depth,
      })) });
    } catch (_) { unavailable.push(name); }
  }
  return { selected: names, books, unavailable };
}

/**
 * Read the native production context. World info is loaded through the
 * official world-info module rather than guessed from getContext(), which
 * intentionally does not expose the live world-book cache.
 */
export async function snapshot(context = getStContext()) {
  const character = getCurrentCharacter(context); const data = character?.data || character || {};
  const worldbook = await readRelatedWorldbooks(context);
  return {
    character: { name: data.name || character?.name || '', description: data.description || character?.description || '', personality: data.personality || character?.personality || '', scenario: data.scenario || character?.scenario || '', first_mes: data.first_mes || character?.first_mes || '', mes_example: data.mes_example || character?.mes_example || '', creator_notes: data.creator_notes || character?.creator_notes || '', avatar: character?.avatar || '' },
    chat: normalizeChatMessages(context?.chat),
    worldbook,
    currentPersona: readNativePersona(context),
  };
}

export function createAdapter({ namespace = EXTENSION_ID, version = '0.2.0', report = () => {} } = {}) {
  const context = () => getStContext(); const listeners = new Map(); const hookedButtons = new Set(); const ownedQuickEntries = new Set(); let native = null;
  const loadNativeApi = async () => { if (!native) native = await nativeApi(); return native; };
  const refreshNativePersonas = async () => {
    const api = await loadNativeApi();
    // `false` is deliberate: the rendering path's default can register
    // unlisted avatar files as [Unnamed Persona] entries.
    await api?.getUserAvatars?.(false);
    return api;
  };
  const on = (name, fn) => {
    const ctx = context(); const source = ctx.eventSource; const types = ctx.eventTypes || ctx.event_types || {}; const type = types[name] || name;
    if (!source?.on || typeof fn !== 'function') return;
    const key = name + ':' + fn;
    if (listeners.has(key)) return;
    source.on(type, fn); listeners.set(key, [source, type, fn]);
  };
  const off = (name, fn) => {
    const key = name + ':' + fn; const record = listeners.get(key); if (!record) return;
    const [source, type, handler] = record;
    if (source?.removeListener) source.removeListener(type, handler); else source?.off?.(type, handler);
    listeners.delete(key);
  };
  const dispose = () => {
    for (const [key, [source, type, fn]] of listeners) {
      if (source?.removeListener) source.removeListener(type, fn); else source?.off?.(type, fn);
      listeners.delete(key);
    }
    for (const button of hookedButtons) {
      const handler = button.__yantaiPersonaStudioOpenHandler;
      if (handler) button.removeEventListener('click', handler);
      if (Object.prototype.hasOwnProperty.call(button, '__yantaiPersonaStudioOriginalTitle')) {
        const title = button.__yantaiPersonaStudioOriginalTitle;
        if (title === null) button.removeAttribute?.('title'); else button.setAttribute?.('title', title);
      }
      delete button.__yantaiPersonaStudioOriginalTitle;
      delete button.__yantaiPersonaStudioOpenHandler;
      delete button.dataset.yantaiPersonaHooked;
    }
    hookedButtons.clear();
    for (const entry of ownedQuickEntries) entry.remove?.();
    ownedQuickEntries.clear();
    globalThis.document?.getElementById?.('yantai-persona-studio-entry')?.remove?.();
    renameNativeTransferLabels(false);
    renameNativePersonaHeader(false);
    const block = document.querySelector('#persona-management-block');
    block?.classList.remove('ytps-takeover', 'ytps-native-edit');
  };
  const recoveryMerge = (state, backup) => {
    const backupThreads = backup?.state?.assistantThreads;
    if (!backupThreads || typeof backupThreads !== 'object') return state;
    const current = state.assistantThreads && typeof state.assistantThreads === 'object' ? state.assistantThreads : {};
    const newer = {};
    for (const [rawKey, thread] of Object.entries(backupThreads)) {
      const key = canonicalAssistantThreadKey(rawKey);
      const existing = current[key];
      if (!existing || Number(thread?.updatedAt || 0) > Number(existing?.updatedAt || 0)) newer[key] = thread;
    }
    if (Object.keys(newer).length) {
      state.assistantThreads = mergeAssistantThreads(current, newer);
      const newest = Object.entries(state.assistantThreads)
        .filter(([, item]) => Array.isArray(item?.turns) && item.turns.length)
        .sort((a, b) => Number(b[1]?.updatedAt || 0) - Number(a[1]?.updatedAt || 0))[0]?.[0];
      if (newest) state.assistantActiveThreadKey = newest;
    }
    return state;
  };
  const loadExtensionState = async (fallback = {}) => {
    const ctx = context();
    const local = { ...fallback, ...getExtensionSettings(ctx, namespace) };
    let remote = {};
    try { remote = await fetchRemoteExtensionState(ctx, namespace); } catch (_) { /* offline startup: do not write until a fresh read succeeds */ }
    const merged = mergeExtensionState(remote, local);
    // Version switching in older builds stored a full extension snapshot. If
    // the current map was overwritten, use that snapshot as another guarded
    // source of assistant turns; newer explicit clears still win by timestamp.
    recoveryMerge(merged, { state: merged.versionBackup?.settings });
    recoveryMerge(merged, readRecoveryBackup());
    writeRecoveryBackup(merged);
    const settings = ctx.extensionSettings ?? (ctx.extensionSettings = {});
    settings[namespace] = merged;
    return merged;
  };
  const saveExtensionState = async state => saveExtensionSettings(state, context(), namespace);
  const normalizeState = state => {
    const value = state && typeof state === 'object' ? state : {};
    const threads = mergeAssistantThreads(value.assistantThreads);
    return { ...value, version: Math.max(Number(value.version || 0), 3), personaMeta: value.personaMeta && typeof value.personaMeta === 'object' ? value.personaMeta : {}, personaGroups: Array.isArray(value.personaGroups) ? value.personaGroups.filter(group => group && typeof group === 'object' && String(group.id || '').trim() && String(group.name || '').trim()).map(group => ({ id: String(group.id), name: String(group.name).trim().slice(0, 40), createdAt: Number(group.createdAt || 0) || Date.now() })) : [], drafts: Array.isArray(value.drafts) ? value.drafts : [], gallery: Array.isArray(value.gallery) ? value.gallery : [], assistantThreads: threads, assistantActiveThreadKey: canonicalAssistantThreadKey(value.assistantActiveThreadKey) || '', ui: { tab: 'current', libraryGroup: 'all', ...(value.ui || {}) } };
  };
  const nativePersonas = () => listNativePersonas(context(), native);
  const resolvePersona = ({ state, target: passedTarget } = {}) => { const ctx = context(); const nativeBindings = readPersonaBindings(ctx, namespace); const binding = resolveBinding({ ...nativeBindings, session: state?.sessionOverride ?? nativeBindings.session }, ctx); const all = listNativePersonas(ctx, native); const persona = all.find(item => String(item.id) === String(binding.personaId)) || (binding.scope === 'none' ? readNativePersona(ctx, native) : null); return { ...binding, persona, target: passedTarget || { cardKey: getCardFingerprint(ctx), chatKey: getChatId(ctx) || 'current-chat' }, all }; };
  const writeBinding = async ({ scope, mode, personaId = null }) => setNativeBinding(scope, mode === 'none' ? null : personaId, context(), await nativeApi());
  const createDraftPersona = value => ({ ...value, id: value?.id || 'draft_' + Date.now().toString(36), source: value?.source || 'yantai' });
  const installEntry = async () => {
    // The native top button is deliberately left untouched. SillyTavern's
    // drawer handler owns its async open/close animation; observing the final
    // class state avoids the old double-toggle race and keeps other drawers
    // (including the wand) independent.
    document.getElementById('yantai-persona-studio-entry')?.remove?.();
    renameNativeTransferLabels(true);
    renameNativePersonaHeader(true);
  };
  return { context, on, off, dispose, loadNativeApi, refreshNativePersonas, loadExtensionState, saveExtensionState, normalizeState, assistantThreadBaseKey, canonicalAssistantThreadKey, mergeAssistantThreads, chatKey: ctx => getChatId(ctx) || 'current-chat', cardKey: ctx => getCardFingerprint(ctx), cardFingerprint: ctx => getCardFingerprint(ctx), currentCharacter: getCurrentCharacter, chatTitle: ctx => ctx?.chatMetadata?.title || ctx?.chatName || '当前存档', contextSnapshot: async () => snapshot(context()), nativePersonas, readNativePersona: () => readNativePersona(context(), native), readNativePersonas: nativePersonas, resolvePersona, createDraftPersona, createPersona: async value => createNativePersona(value, context(), await loadNativeApi()), referencesToPersona: () => [], clearPersonaReferences: async () => {}, writeBinding, applyPersona: async persona => selectNativePersona(persona?.nativeId || persona?.id, context(), await loadNativeApi()), setDefault: async id => setNativeDefaultPersona(id, context(), await loadNativeApi()), updatePersona: async (id, patch) => updateNativePersona(id, patch, context(), await loadNativeApi()), choosePersonaLorebook: async id => choosePersonaLorebook(id, context(), await loadNativeApi()), deletePersona: async id => deleteNativePersona(id, context(), await loadNativeApi()), duplicatePersona: async id => duplicateNativePersona(id, context(), await loadNativeApi()), focusNativePersona, openNativePersonaPanel, isNativePersonaPanelOpen, setNativeTakeover, setNativeEditMode, setNativePresentation: active => { renameNativeTransferLabels(active); renameNativePersonaHeader(active); }, installEntry, listNativePersonas, readPersonaBindings: () => readPersonaBindings(context(), namespace), selectNativePersona: async id => selectNativePersona(id, context(), await loadNativeApi()), setNativeBinding: async (scope, id) => setNativeBinding(scope, id, context(), await loadNativeApi()), uploadNativeAvatar, uploadGalleryAsset: async (file, options = {}) => uploadGalleryAsset(file, { ...options, context: context() }), deleteGalleryAsset: async url => deleteGalleryAsset(url, { context: context() }), removeLegacyGalleryAvatar: async file => removeLegacyGalleryAvatar(file, { context: context() }), report, version };
}
export { nativeApi, normalizeBinding, normalizeChatMessages, worldNamesForContext };
