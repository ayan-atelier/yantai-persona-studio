/*
 * 砚台 · 人设馆 0.2
 * A native SillyTavern persona workspace. Native personas, descriptions and
 * locks are read from ST; this extension adds an organiser, gallery and AI
 * helper around the existing panel.
 */
(async () => {
  'use strict';

  const { PERSONA_VERSION, createVersionManager } = await import(new URL('./versions.js', import.meta.url));
  const { openVersionDialog } = await import(new URL('./version-ui.js', import.meta.url));
  const VERSION = PERSONA_VERSION;
  const NS = 'yantai-persona-studio';
  const root = globalThis;
  const CONTROL_REGISTRY_KEY = Symbol.for('yantai.control.registry.v1');
  const RUNTIME_KEY = '__yantaiPersonaStudioRuntime';
  const previousRuntime = root[RUNTIME_KEY];
  if (previousRuntime?.dispose) {
    try { await previousRuntime.dispose(); } catch (error) { console.warn('[砚台·人设馆] previous runtime cleanup failed', error); }
  }
  const report = (message, type = 'info') => {
    const toast = root.toastr;
    if (toast?.[type]) toast[type](message, '砚台 · 人设馆');
    else (type === 'error' ? console.error : console.log)('[砚台·人设馆]', message);
  };

  function element(tag, className = '', text = '') {
    const el = document.createElement(tag);
    if (className) el.className = className;
    if (text) el.textContent = text;
    return el;
  }
  function button(text, className, click, title) {
    const el = element('button', className, text); el.type = 'button';
    if (title) { el.title = title; el.setAttribute('aria-label', title); }
    if (click) el.addEventListener('click', click);
    return el;
  }
  function dialog(title) {
    const modal = document.createElement('dialog'); modal.className = 'ytps-version-dialog';
    const head = element('header', 'ytps-version-head');
    const heading = element('h2', '', title); const close = button('×', 'ytps-version-close', () => modal.close(), '关闭');
    head.append(heading, close);
    const body = element('div', 'ytps-version-body'); const notice = element('p', 'ytps-version-notice');
    modal.append(head, body, notice); document.body.append(modal);
    modal.addEventListener('close', () => modal.remove(), { once: true });
    modal.addEventListener('click', event => { if (event.target === modal) modal.close(); });
    try { modal.showModal(); } catch (_) { modal.setAttribute('open', ''); }
    return { modal, body, notice };
  }

  let adapter;
  let storage;
  let ui;
  let ai;
  let app;
  let state;
  let initialized = false;
  let observer = null;
  let panelObserver = null;
  let panelObserverTargets = new WeakSet();
  let observerTimer = null;
  let disposed = false;
  let editMode = false;
  let lastNativeOpen = null;
  let syncTimer = null;
  let controlModule = null;
  let versionManager = null;
  let gallerySync = null;
  let gallerySyncDirty = true;
  let syncClient = null;
  let syncRevision = null;
  let syncStatus = 'checking';
  // The server plugin is the strongest sync provider.  When it is not
  // installed, SillyTavern still persists this extension's namespace through
  // extensionSettings + saveSettingsDebounced, so ordinary installs can sync
  // without copying a second plugin.  This fallback has no server CAS.
  let syncMode = 'checking';
  let syncRemoteState = null;
  // The selected assistant thread is a browser-local navigation choice. It
  // must never be persisted in shared settings, otherwise opening the plugin
  // on another device can switch that device into the wrong page. Keep the
  // choice in localStorage so a reload on the same device does not hide a
  // freshly-created thread.
  const LOCAL_THREAD_STORAGE_BASE = `${NS}.assistant-thread.v1`;
  // Milo is a user-owned notebook rather than a property of the currently
  // open role card. Legacy card/chat threads are merged into this portable
  // base thread during load, while an explicit "新开一段" session keeps its
  // own local navigation key.
  const GLOBAL_ASSISTANT_THREAD_KEY = 'milo-global';
  function threadStorage() { try { return root.sessionStorage || root.localStorage; } catch (_) { return null; } }
  function storageScope() {
    let context = null;
    try { context = root.SillyTavern?.getContext?.() || null; } catch (_) { /* use the origin fallback */ }
    const user = context?.user?.profile || context?.user || context?.currentUser || {};
    const identity = user?.handle || user?.username || user?.id || context?.userId || root.location?.origin || 'local';
    return encodeURIComponent(String(identity)).replace(/%/g, '_').slice(0, 120) || 'local';
  }
  function scopedStorageKey(base) { return `${base}.${storageScope()}`; }
  function readLocalAssistantThreadKey() {
    try { return String(threadStorage()?.getItem(scopedStorageKey(LOCAL_THREAD_STORAGE_BASE)) || ''); } catch (_) { return ''; }
  }
  function writeLocalAssistantThreadKey(value) {
    try { if (value) threadStorage()?.setItem(scopedStorageKey(LOCAL_THREAD_STORAGE_BASE), String(value)); else threadStorage()?.removeItem(scopedStorageKey(LOCAL_THREAD_STORAGE_BASE)); } catch (_) { /* private mode or quota */ }
  }
  let localAssistantThreadKey = readLocalAssistantThreadKey();
  let assistantGenerationToken = 0;
  let refreshSequence = 0;

  function controlRegistry() {
    const existing = root[CONTROL_REGISTRY_KEY];
    if (existing && existing.version === 1 && existing.modules instanceof Map) return existing;
    const registry = existing && typeof existing === 'object' ? existing : {};
    registry.version = 1;
    registry.modules = registry.modules instanceof Map ? registry.modules : new Map();
    root[CONTROL_REGISTRY_KEY] = registry;
    return registry;
  }

  function registerControlModule() {
    const registry = controlRegistry();
    controlModule = {
      id: NS,
      label: '人设库与人设助手',
      version: VERSION,
      schemaVersion: 3,
      namespace: NS,
      inspect() {
        const ctx = adapter?.context?.() || {};
        const gallery = Array.isArray(state?.gallery) ? state.gallery : [];
        const previewCount = gallery.filter(item => String(item?.url || '').trim()).length;
        const missingPreview = Math.max(0, gallery.length - previewCount);
        const threads = state?.assistantThreads && typeof state.assistantThreads === 'object' ? state.assistantThreads : {};
        return {
          installed: true,
          enabled: state?.enabled !== false,
          health: missingPreview || ['unavailable', 'error', 'conflict', 'needs-migration'].includes(syncStatus) ? 'degraded' : 'ok',
          sources: [
            { kind: 'persona-sync-server', namespace: NS, scope: 'server', portable: 'yes', readable: syncMode === 'server', writable: syncMode === 'server' && syncStatus === 'ready' },
            { kind: 'host-settings-sync', namespace: NS, scope: 'host', portable: 'yes', readable: true, writable: syncMode === 'host' },
            { kind: 'indexeddb', namespace: 'yantai-persona-studio/assets', scope: 'device', portable: 'no', readable: true, writable: true, count: gallery.length, missingCount: missingPreview },
          ],
          checks: [
            { id: 'gallery-preview', label: '图库预览', status: missingPreview ? 'degraded' : 'ok', detail: missingPreview ? `${missingPreview} 项只有元数据，当前设备没有可用预览` : `本设备可预览 ${previewCount} 项` },
            { id: 'assistant-history', label: 'Milo 记录', status: 'ok', detail: `${Object.keys(threads).length} 个对话线程保存在人设馆设置中` },
            { id: 'sync', label: '数据同步', status: syncStatus === 'ready' || syncStatus === 'host-ready' ? 'ok' : 'degraded', detail: syncMode === 'server' && syncStatus === 'ready' ? `安全同步服务端版本 ${syncRevision || '0'}` : syncMode === 'host' ? '通过酒馆扩展设置同步（保护有限，无需额外插件）' : syncStatus === 'needs-migration' ? '等待明确迁移旧版记录' : syncStatus === 'conflict' ? '存在待处理冲突，已停止覆盖' : '同步服务未连接' },
            { id: 'context', label: '当前酒馆上下文', status: ctx ? 'ok' : 'unknown', detail: root.location?.origin || '当前来源未知' },
          ],
        };
      },
      open(options = {}) { return open(options); },
      async setEnabled(value) {
        state.enabled = Boolean(value);
        writeLocalSettings({ enabled: state.enabled });
        await refresh();
        if (!state.enabled) {
          lastNativeOpen = null;
          editMode = false;
          app?.close();
          adapter?.setNativeTakeover?.(false);
          adapter?.setNativeEditMode?.(false);
          adapter?.setNativePresentation?.(false);
        } else {
          adapter?.setNativePresentation?.(true);
          await adapter?.installEntry?.();
          // The native drawer may already be open when the user re-enables
          // the module. Force a fresh state check so takeover resumes without
          // requiring a close/reopen click.
          lastNativeOpen = null;
          await syncNativeDrawer();
        }
        updateSettingsUi();
        root.dispatchEvent?.(new CustomEvent('yantai:control:updated'));
        return state.enabled;
      },
      async migrateToSafeSync() { const result = await migrateToSafeSync(); updateSettingsUi(); return result; },
    };
    registry.modules.set(NS, controlModule);
    root.dispatchEvent?.(new CustomEvent('yantai:control:updated'));
  }

  function unregisterControlModule() {
    const registry = root[CONTROL_REGISTRY_KEY];
    if (registry?.modules instanceof Map && registry.modules.get(NS) === controlModule) registry.modules.delete(NS);
    root.dispatchEvent?.(new CustomEvent('yantai:control:updated'));
    controlModule = null;
  }

  const localSettingBase = 'yantai-persona-studio.local-settings.v1';
  function localSettingKey() { return scopedStorageKey(localSettingBase); }
  function readLocalSettings() {
    try {
      const value = JSON.parse(globalThis.localStorage?.getItem(localSettingKey()) || '{}');
      return value && typeof value === 'object' ? value : {};
    } catch (_) { return {}; }
  }
  function writeLocalSettings(patch = {}) {
    try {
      const current = readLocalSettings();
      globalThis.localStorage?.setItem(localSettingKey(), JSON.stringify({ ...current, ...patch }));
    } catch (_) { /* private mode or quota */ }
  }
  function pendingStateKey() { return scopedStorageKey('yantai-persona-studio.pending-sync.v1'); }
  function queuePendingState(value) {
    try { globalThis.localStorage?.setItem(pendingStateKey(), JSON.stringify(value)); } catch (_) { /* keep the in-memory copy */ }
  }
  function readPendingState() {
    try {
      const value = JSON.parse(globalThis.localStorage?.getItem(pendingStateKey()) || 'null');
      return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
    } catch (_) { return null; }
  }
  function clearPendingState() { try { globalThis.localStorage?.removeItem(pendingStateKey()); } catch (_) {} }

  function stopObserver() {
    observer?.disconnect?.();
    observer = null;
    panelObserver?.disconnect?.();
    panelObserver = null;
    panelObserverTargets = new WeakSet();
    if (observerTimer) clearTimeout(observerTimer);
    observerTimer = null;
    if (globalThis.document?.body?.dataset) delete globalThis.document.body.dataset.yantaiPersonaObserver;
  }

  async function dispose() {
    if (disposed) return;
    disposed = true;
    stopObserver();
    if (syncTimer) clearTimeout(syncTimer);
    syncTimer = null;
    versionManager?.dispose?.();
    versionManager = null;
    adapter?.dispose?.();
    app?.dispose?.();
    document.getElementById('ytps-settings')?.remove?.();
    unregisterControlModule();
    initialized = false;
    if (root[RUNTIME_KEY]?.dispose === dispose) delete root[RUNTIME_KEY];
  }

  root[RUNTIME_KEY] = { dispose };

  async function loadModules() {
    const base = new URL('.', import.meta.url);
    const [adapterModule, storageModule, uiModule, aiModule, syncModule] = await Promise.all([
      import(new URL('./adapter.js', base)),
      import(new URL('./storage.js', base)),
      import(new URL('./ui.js', base)),
      import(new URL('./ai.js', base)),
      import(new URL('./sync-client.js', base)),
    ]);
    adapter = adapterModule.createAdapter({ namespace: NS, version: VERSION, report });
    // Load the real native persona module once so the current selection and
    // setter use SillyTavern's live bindings instead of a stale context copy.
    await adapter.loadNativeApi();
    storage = storageModule.createStorage({ namespace: NS, report });
    ui = uiModule;
    ai = aiModule.createAiHelper({ namespace: NS, version: VERSION, adapter, report });
    const context = adapter.context();
    const getter = context?.getRequestHeaders || globalThis.getRequestHeaders;
    syncClient = syncModule.createSyncClient({ getRequestHeaders: typeof getter === 'function' ? getter.bind(context) : null, clientVersion: VERSION });
  }

  function defaultState() {
    // Persona folders belong to the extension organiser rather than the
    // native persona store.  A missing groupId deliberately means “未分类”,
    // so older settings remain compatible without a migration pass.
    return { version: 3, enabled: true, personaMeta: {}, personaGroups: [], gallery: [], galleryRemoved: {}, assistantThreads: {}, assistantGlobalClearedAt: 0, assistantActiveThreadKey: '', ui: { tab: 'current', gallerySheet: 'avatars', selectedAssetId: '', editingPersonaId: '', libraryGroup: 'all' } };
  }

  function sharedState(source = state) {
    const value = source && typeof source === 'object' ? source : {};
    const { ui: _ui, assistantActiveThreadKey: _active, sessionOverride: _session, enabled: _enabled, ...shared } = value;
    if (shared.gallerySync && typeof shared.gallerySync === 'object') {
      const gallerySync = { ...shared.gallerySync };
      if (Array.isArray(gallerySync.assets)) {
        gallerySync.assets = gallerySync.assets.map(item => {
          const copy = { ...item };
          for (const key of ['data', 'blob', 'base64', 'url', 'remoteUrl', 'previewUrl', 'thumbnailUrl']) {
            if (/^(?:data:|blob:)/i.test(String(copy[key] || ''))) delete copy[key];
          }
          return copy;
        });
      }
      shared.gallerySync = gallerySync;
    }
    if (Array.isArray(shared.gallery)) {
      const fields = ['id', 'kind', 'name', 'mime', 'size', 'hash', 'createdAt', 'updatedAt', 'remoteUrl', 'previewUrl', 'thumbnailUrl', 'source', 'avatarId'];
      shared.gallery = shared.gallery.map(item => {
        const copy = {};
        for (const field of fields) if (item?.[field] !== undefined) copy[field] = item[field];
        for (const field of ['url', 'remoteUrl', 'previewUrl', 'thumbnailUrl']) {
          if (/^(?:data:|blob:)/i.test(String(copy[field] || ''))) delete copy[field];
        }
        return copy;
      }).filter(item => item.id);
    }
    return { ...shared, version: Math.max(Number(shared.version || 0), 3) };
  }
  function hasSharedData(value = state) {
    const shared = sharedState(value);
    return Object.keys(shared.personaMeta || {}).length > 0
      || Array.isArray(shared.personaGroups) && shared.personaGroups.length > 0
      || Array.isArray(shared.gallery) && shared.gallery.length > 0
      || Object.values(shared.assistantThreads || {}).some(thread => Array.isArray(thread?.turns) && thread.turns.length > 0)
      || Array.isArray(shared.drafts) && shared.drafts.length > 0
      || Boolean(shared.gallerySync);
  }
  function mergeSharedState(remote = {}, local = {}) {
    const result = { ...local, ...remote };
    const assistantGlobalClearedAt = Math.max(Number(remote.assistantGlobalClearedAt || 0), Number(local.assistantGlobalClearedAt || 0));
    const survivesAssistantClear = turn => assistantGlobalClearedAt <= 0 || Number(turn?.at || 0) > assistantGlobalClearedAt;
    result.assistantGlobalClearedAt = assistantGlobalClearedAt;
    result.personaMeta = { ...(local.personaMeta || {}), ...(remote.personaMeta || {}) };
    const groups = new Map();
    for (const group of [...(local.personaGroups || []), ...(remote.personaGroups || [])]) {
      if (!group?.id) continue;
      const previous = groups.get(String(group.id));
      if (!previous || Number(group.createdAt || 0) >= Number(previous.createdAt || 0)) groups.set(String(group.id), group);
    }
    result.personaGroups = [...groups.values()];
    result.gallery = storage?.mergeGallery ? storage.mergeGallery(remote.gallery || [], local.gallery || []) : [...(remote.gallery || []), ...(local.gallery || [])];
    const remoteManifest = remote.gallerySync && typeof remote.gallerySync === 'object' ? remote.gallerySync : null;
    const localManifest = local.gallerySync && typeof local.gallerySync === 'object' ? local.gallerySync : null;
    result.galleryRemoved = {};
    for (const source of [local.galleryRemoved, remote.galleryRemoved, localManifest?.removed, remoteManifest?.removed]) {
      for (const [id, at] of Object.entries(source || {})) {
        result.galleryRemoved[id] = Math.max(Number(result.galleryRemoved[id] || 0), Number(at || 0));
      }
    }
    // A host-settings save merges the candidate with the older namespace.
    // Apply tombstones during that merge so a deleted image cannot be
    // immediately reintroduced into the current view. A later re-import with
    // a newer timestamp is still allowed to revive the deterministic asset.
    const isGalleryRemoved = item => Number(result.galleryRemoved[String(item?.id || '')] || 0) >= Number(item?.updatedAt || 0);
    result.gallery = result.gallery.filter(item => !isGalleryRemoved(item));
    const threads = {};
    const threadKeys = new Set([...Object.keys(remote.assistantThreads || {}), ...Object.keys(local.assistantThreads || {})]);
    for (const key of threadKeys) {
      const remoteThread = remote.assistantThreads?.[key];
      const localThread = local.assistantThreads?.[key];
      const incomingTurns = [
        ...(Array.isArray(remoteThread?.turns) ? remoteThread.turns : []),
        ...(Array.isArray(localThread?.turns) ? localThread.turns : []),
      ].filter(survivesAssistantClear);
      const byId = new Map();
      for (const turn of incomingTurns) {
        const id = String(turn?.turnId || `${turn?.at || 0}|${turn?.user || ''}|${turn?.assistant || turn?.memory || ''}`);
        if (!byId.has(id)) byId.set(id, turn);
      }
      const base = { ...(localThread || {}), ...(remoteThread || {}) };
      threads[key] = {
        ...base,
        target: remoteThread?.target || localThread?.target,
        turns: [...byId.values()].sort((a, b) => Number(a?.at || 0) - Number(b?.at || 0)),
        updatedAt: Math.max(Number(localThread?.updatedAt || 0), Number(remoteThread?.updatedAt || 0)),
      };
    }
    result.assistantThreads = threads;
    const drafts = new Map();
    for (const draft of [...(remote.drafts || []), ...(local.drafts || [])]) if (draft?.id && !drafts.has(String(draft.id))) drafts.set(String(draft.id), draft);
    result.drafts = [...drafts.values()].slice(0, 20);
    if (remoteManifest || localManifest) {
      const assets = new Map();
      for (const item of [...(localManifest?.assets || []), ...(remoteManifest?.assets || [])]) {
        if (!item?.id) continue;
        const previous = assets.get(String(item.id));
        if (!previous || Number(item.updatedAt || 0) >= Number(previous.updatedAt || 0)) assets.set(String(item.id), item);
      }
      const removed = { ...result.galleryRemoved };
      for (const source of [localManifest?.removed, remoteManifest?.removed]) {
        for (const [id, at] of Object.entries(source || {})) removed[id] = Math.max(Number(removed[id] || 0), Number(at || 0));
      }
      result.gallerySync = {
        ...(localManifest || {}), ...(remoteManifest || {}),
        version: Math.max(Number(localManifest?.version || 0), Number(remoteManifest?.version || 0), 2),
        assets: [...assets.values()].filter(item => Number(removed[String(item?.id || '')] || 0) < Number(item?.updatedAt || 0)), removed,
      };
    } else result.gallerySync = null;
    return result;
  }
  function mergeGalleryManifest(manifest) {
    const assets = Array.isArray(manifest?.assets) ? manifest.assets.map(item => ({
      ...item,
      remoteUrl: /^(?:blob|data):/i.test(String(item?.remoteUrl || item?.url || '').trim()) ? '' : String(item?.remoteUrl || item?.url || '').trim(),
      url: String(item?.url || item?.remoteUrl || '').trim(),
      previewUrl: String(item?.previewUrl || item?.thumbnailUrl || '').trim(),
      blob: undefined,
    })).filter(item => item.id) : [];
    if (assets.length) state.gallery = storage.mergeGallery(state.gallery, assets);
  }
  async function loadState() {
    const saved = await adapter.loadExtensionState(defaultState());
    state = adapter.normalizeState({ ...defaultState(), ...saved });
    const pending = readPendingState();
    if (pending) {
      state = adapter.normalizeState({ ...defaultState(), ...state, ...mergeSharedState(pending, sharedState(state)) });
      report('发现上次未确认的本机同步副本，已先保留在当前页面，等待安全同步确认。', 'warning');
    }
    // Older builds exposed a single aiTurns array. Move it into the exact
    // current target thread once so the strict UI filter does not discard
    // recoverable history or show it under another card/chat.
    if (Array.isArray(state.aiTurns) && state.aiTurns.length && !Object.keys(state.assistantThreads || {}).length) {
      const target = activeTarget();
      const key = assistantThreadKey(target);
      state.assistantThreads[key] = { id: key, target: { cardKey: target.cardKey || 'no-card', legacyCardKey: target.legacyCardKey || target.cardFingerprint || '', chatId: target.chatId || 'no-chat' }, createdAt: Date.now(), updatedAt: Date.now(), turns: state.aiTurns.slice() };
      delete state.aiTurns;
    }
    mergeAssistantThreadsToGlobal();
    const localSettings = readLocalSettings();
    if (typeof localSettings.enabled === 'boolean') state.enabled = localSettings.enabled;
    state.galleryRemoved = state.galleryRemoved && typeof state.galleryRemoved === 'object' ? state.galleryRemoved : {};
    gallerySync = state.gallerySync || saved?.gallerySync || null;
    gallerySyncDirty = !gallerySync;
    if (gallerySync) await storage.importSync(gallerySync).catch(() => {});
    // Hosted manifests contain the cross-device URL even when this browser
    // has no IndexedDB Blob. Merge them before hydration so a stale local
    // blob URL cannot hide the server-backed preview.
    mergeGalleryManifest(gallerySync);
    // Blob URLs are session-scoped. Rehydrate gallery entries from IndexedDB
    // so imported images remain visible after a reload or device reconnect.
    const persisted = await storage.listAssets().catch(() => []);
    state.gallery = storage.mergeGallery(state.gallery, persisted.map(item => ({ ...item, blob: undefined })));
    state.gallery = state.gallery.filter(item => Number(state.galleryRemoved[item.id] || 0) <= Number(item.updatedAt || 0));
    state.gallery = await storage.hydrateGallery(state.gallery);
    // Existing installs may contain local-only images from the old sync path
    // data-URL sync. Mark them for one-time server migration after the app is
    // ready; the local Blob remains usable even if upload is unavailable.
    if (gallerySync?.provider !== 'tavern-user-images' || state.gallery.some(item => /^image\//i.test(String(item?.mime || '')) && !item.remoteUrl)) gallerySyncDirty = true;
    syncMode = 'checking';
    syncStatus = 'unavailable';
    syncRevision = null;
    syncRemoteState = null;
    if (syncClient) {
      try {
        const remote = await syncClient.getState();
        syncMode = 'server';
        syncRevision = remote.revision || '0';
        syncRemoteState = remote.state || {};
        if (syncRevision !== '0' || hasSharedData(syncRemoteState)) {
          if (pending) {
            // A queued local candidate means this browser has changes that
            // were never acknowledged by the server. Keep that candidate in
            // view and stop; silently selecting the remote document here
            // would make the phone's last edits appear to vanish.
            syncStatus = 'conflict';
            report('远端已有新版本，而本机还有未确认的修改；已停止自动合并，请在设置中确认合并。', 'warning');
          } else {
            state = adapter.normalizeState({ ...defaultState(), ...state, ...mergeSharedState(syncRemoteState, sharedState(state)) });
            gallerySync = state.gallerySync || gallerySync;
            if (gallerySync) await storage.importSync(gallerySync).catch(() => {});
            mergeGalleryManifest(gallerySync);
            mergeAssistantThreadsToGlobal();
            syncStatus = 'ready';
          }
        } else if (hasSharedData(state)) {
          // A new server document must never silently replace a legacy local
          // document. The settings panel exposes an explicit migration action.
          syncStatus = 'needs-migration';
        } else {
          syncStatus = 'ready';
        }
      } catch (error) {
        if (error?.code === 'SYNC_UNAVAILABLE') {
          // A normal install does not contain a Node server plugin. Fall back
          // to the extension's own namespace in SillyTavern settings so the
          // GitHub extension remains one-click installable.
          syncMode = 'host';
          syncRevision = 'host';
          syncRemoteState = sharedState(saved);
          syncStatus = 'host-ready';
        } else {
          syncMode = 'host';
          syncRevision = 'host';
          syncRemoteState = sharedState(saved);
          syncStatus = 'host-ready';
          report(`安全同步服务暂不可用，已切换到酒馆设置兼容同步：${error?.message || error}`, 'warning');
        }
      }
    } else {
      syncMode = 'host';
      syncRevision = 'host';
      syncRemoteState = sharedState(saved);
      syncStatus = 'host-ready';
    }
    mergeAssistantThreadsToGlobal();
    return state;
  }
  function activeTarget() {
    const ctx = adapter.context();
    return { chatId: adapter.chatKey(ctx), cardKey: adapter.cardKey(ctx), legacyCardKey: adapter.cardFingerprint(ctx), character: adapter.currentCharacter(ctx), chatTitle: adapter.chatTitle(ctx) };
  }
  function globalAssistantTarget() { return { scope: 'global', cardKey: '*', legacyCardKey: '*', chatId: '*' }; }
  function mergeAssistantThreadsToGlobal() {
    state.assistantThreads = state.assistantThreads && typeof state.assistantThreads === 'object' ? state.assistantThreads : {};
    const existing = state.assistantThreads[GLOBAL_ASSISTANT_THREAD_KEY];
    const global = existing && typeof existing === 'object' ? { ...existing } : { id: GLOBAL_ASSISTANT_THREAD_KEY, ...globalAssistantTarget(), createdAt: Date.now(), updatedAt: Date.now(), turns: [] };
    const byId = new Map();
    const clearAt = Number(state.assistantGlobalClearedAt || 0);
    const survivesClear = turn => clearAt <= 0 || Number(turn?.at || 0) > clearAt;
    for (const turn of (Array.isArray(global.turns) ? global.turns : []).filter(survivesClear)) {
      const id = String(turn?.turnId || `${turn?.at || 0}|${turn?.user || ''}|${turn?.assistant || turn?.memory || ''}`);
      if (!byId.has(id)) byId.set(id, turn);
    }
    // A clear is a portable tombstone. Without it, old card-scoped archives
    // would be reintroduced the next time the two devices merge settings.
    if (!clearAt) {
      for (const [key, thread] of Object.entries(state.assistantThreads)) {
        if (key === GLOBAL_ASSISTANT_THREAD_KEY || key.startsWith(`${GLOBAL_ASSISTANT_THREAD_KEY}|new_`)) continue;
        for (const turn of (Array.isArray(thread?.turns) ? thread.turns : [])) {
          const id = String(turn?.turnId || `${turn?.at || 0}|${turn?.user || ''}|${turn?.assistant || turn?.memory || ''}`);
          if (!byId.has(id)) byId.set(id, turn);
        }
      }
    }
    global.id = GLOBAL_ASSISTANT_THREAD_KEY;
    global.target = globalAssistantTarget();
    global.turns = [...byId.values()].sort((a, b) => Number(a?.at || 0) - Number(b?.at || 0));
    global.createdAt = Math.min(Number(global.createdAt || Date.now()), ...global.turns.map(turn => Number(turn?.at || Date.now())));
    global.updatedAt = Math.max(Number(global.updatedAt || 0), ...global.turns.map(turn => Number(turn?.at || 0)), clearAt);
    state.assistantThreads[GLOBAL_ASSISTANT_THREAD_KEY] = global;
    return global;
  }
  function assistantThreadKey(target = activeTarget()) {
    return GLOBAL_ASSISTANT_THREAD_KEY;
  }
  function targetKey(target = activeTarget()) {
    return adapter?.targetKey
      ? adapter.targetKey({ cardKey: target.cardKey || 'no-card', chatId: target.chatId || 'no-chat' })
      : [target.cardKey || 'no-card', target.chatId || 'no-chat'].map(value => String(value).replace(/[|\s]+/g, '_')).join('|');
  }
  function provisionalAssistantTarget(target = {}) {
    const character = target?.character;
    const data = character?.data || character || {};
    const hasCharacter = Boolean(character && (character.avatar || character.id || data.name));
    const card = String(target?.cardKey || '').trim();
    const chat = String(target?.chatId || '').trim();
    return !hasCharacter || !card || card === 'no-card' || card === 'card_811c9c5' || !chat || chat === 'no-chat' || chat === 'current-chat';
  }
  function responseDestination(target, thread) {
    const current = activeTarget();
    if (targetKey(current) === targetKey(target)) return { target, thread };
    // A card/chat can be provisionally empty while SillyTavern finishes
    // loading it. If that is the only change during the request, move the
    // response into the now-stable thread so the UI does not hide it behind
    // the temporary no-card/no-chat key. A real switch between two loaded
    // cards remains isolated and keeps the response on its original thread.
    if (provisionalAssistantTarget(target) && !provisionalAssistantTarget(current)) {
      return { target: current, thread: activeAssistantThread(current) };
    }
    const fromCards = [target.cardKey, target.legacyCardKey, target.cardFingerprint].map(value => String(value || '').trim()).filter(Boolean);
    const toCards = [current.cardKey, current.legacyCardKey, current.cardFingerprint].map(value => String(value || '').trim()).filter(Boolean);
    if (fromCards.some(card => toCards.includes(card)) && String(target.chatId || '') === String(current.chatId || '')) {
      return { target: current, thread: activeAssistantThread(current) };
    }
    return { target, thread };
  }
  function makeTurnId() {
    try { if (typeof crypto?.randomUUID === 'function') return crypto.randomUUID(); } catch (_) { /* use the fallback below */ }
    return `turn_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
  }
  function findCompatibleThread(target, key) {
    state.assistantThreads = state.assistantThreads && typeof state.assistantThreads === 'object' ? state.assistantThreads : {};
    const exact = state.assistantThreads[key];
    if (exact && Array.isArray(exact.turns)) return exact;
    const wanted = adapter?.targetKey ? adapter.targetKey(target) : targetKey(target);
    const legacyWanted = adapter?.targetKey ? adapter.targetKey({ cardKey: target.legacyCardKey || target.cardKey, chatId: target.chatId }) : wanted;
    const candidates = Object.entries(state.assistantThreads).filter(([candidateKey, item]) => {
      if (!item || !Array.isArray(item.turns)) return false;
      if (adapter?.threadMatchesTarget?.(item, target)) return true;
      // Legacy v1.0.1 keys were identity|card|chat|session. Their target
      // metadata was absent, so match only the final portable segments.
      const parts = String(candidateKey).split('|');
      if (parts.length < 3) return false;
      return parts.slice(-3, -1).join('|') === wanted
        || parts.slice(-3, -1).join('|') === legacyWanted
        || parts.slice(-2).join('|') === wanted;
    }).sort((a, b) => Number(b[1]?.updatedAt || 0) - Number(a[1]?.updatedAt || 0));
    const source = candidates[0]?.[1];
    if (!source) return null;
    const migrated = { ...source, id: key, target: { cardKey: target.cardKey || 'no-card', legacyCardKey: target.legacyCardKey || target.cardFingerprint || '', chatId: target.chatId || 'no-chat' }, turns: Array.isArray(source.turns) ? source.turns.slice() : [] };
    state.assistantThreads[key] = migrated;
    return migrated;
  }
  function ensureAssistantThread(key = assistantThreadKey(), target = activeTarget()) {
    state.assistantThreads = state.assistantThreads && typeof state.assistantThreads === 'object' ? state.assistantThreads : {};
    const current = findCompatibleThread(target, key);
    if (current) {
      // Keep both representations while a card is loading. Tavern can first
      // expose a content fingerprint and then switch to the avatar file id.
      current.target = String(key) === GLOBAL_ASSISTANT_THREAD_KEY || String(key).startsWith(`${GLOBAL_ASSISTANT_THREAD_KEY}|new_`)
        ? globalAssistantTarget()
        : { ...(current.target && typeof current.target === 'object' ? current.target : {}), cardKey: target.cardKey || 'no-card', legacyCardKey: target.legacyCardKey || target.cardFingerprint || current.target?.legacyCardKey || '', chatId: target.chatId || 'no-chat' };
      current.id = key;
      return current;
    }
    const thread = { id: key, target: String(key) === GLOBAL_ASSISTANT_THREAD_KEY || String(key).startsWith(`${GLOBAL_ASSISTANT_THREAD_KEY}|new_`) ? globalAssistantTarget() : { cardKey: target.cardKey || 'no-card', legacyCardKey: target.legacyCardKey || target.cardFingerprint || '', chatId: target.chatId || 'no-chat' }, createdAt: Date.now(), updatedAt: Date.now(), turns: [] };
    state.assistantThreads[key] = thread;
    return thread;
  }
  function activeAssistantThread(target = activeTarget()) {
    const baseKey = assistantThreadKey(target);
    const activeKey = String(localAssistantThreadKey || '');
    // A manually opened session is local to this browser. Never trust the
    // shared assistantActiveThreadKey from settings as a page selector.
    const key = activeKey.startsWith(baseKey + '|new_') ? activeKey : baseKey;
    localAssistantThreadKey = key;
    writeLocalAssistantThreadKey(localAssistantThreadKey);
    return ensureAssistantThread(key, target);
  }
  function generationIsCurrent(target, token, thread) {
    if (token !== assistantGenerationToken) return false;
    // SillyTavern can emit CHARACTER_CHANGED/CHAT_CHANGED while a request is
    // still in flight (for example while a character chat finishes loading).
    // The target key may briefly change from a provisional no-card/no-chat
    // value to its stable card/chat identity. Treating that normal refresh as
    // cancellation silently dropped a completed API reply. The captured
    // thread is still the right destination; a deliberate “new thread” or
    // “clear” action increments assistantGenerationToken and cancels it.
    const current = state.assistantThreads?.[thread?.id];
    return thread === current;
  }
  function appendAssistantTurn(thread, user, result) {
    if (!thread || !String(user || '').trim() || !result || result.error) return;
    const answer = String(result.reply || result.summary || result.draft?.summary || '').trim();
    const candidates = Array.isArray(result.candidates) ? result.candidates : (Array.isArray(result.draft?.candidates) ? result.draft.candidates : []);
    const proposalData = candidates.map((item, index) => {
      const title = String(item?.title || `方向 ${index + 1}`).trim();
      const concept = String(item?.concept || '').trim();
      const fit = String(item?.fit || '').trim();
      const tradeoffs = String(item?.tradeoffs || '').trim();
      const persona = String(item?.persona || '').trim();
      const hooks = Array.isArray(item?.interactionHooks) ? item.interactionHooks.filter(Boolean).map(value => String(value).trim()).join('\n') : '';
      return { title, concept, fit, tradeoffs, persona, interactionHooks: hooks ? hooks.split('\n').filter(Boolean) : [] };
    }).filter(item => item.title || item.persona || item.concept);
    // Keep the conversational reply separate from the reusable persona text.
    // The UI can render and copy both candidates without turning the reply
    // bubble into an unbounded wall of text, while the API memory retains only
    // a compact title/concept trace for continuity.
    const memory = [answer, ...proposalData.map(item => [item.title, item.concept].filter(Boolean).join('：')).filter(Boolean)].filter(Boolean).join('\n');
    if (!answer.trim() && !proposalData.length) return;
    thread.turns = [...(Array.isArray(thread.turns) ? thread.turns : []), {
      turnId: makeTurnId(),
      user: String(user).slice(0, 2400),
      assistant: answer,
      memory,
      proposals: proposalData,
      mode: String(result.mode || 'propose'),
      at: Date.now(),
    }];
    thread.updatedAt = Date.now();
  }
  function assistantContext(input = {}, snapshot = {}) {
    const includeCard = input.includeCard !== false;
    const includeWorld = input.includeWorld === true;
    const includeChat = input.includeChat === true;
    return { ...snapshot, includeCard, includeWorld, includeChat, character: includeCard ? snapshot.character : '', currentPersona: includeCard ? snapshot.currentPersona : '', worldbook: includeWorld ? snapshot.worldbook : '', chat: includeChat ? snapshot.chat : '' };
  }
  function nativeGallery() {
    const ctx = adapter.context();
    const chars = Array.isArray(ctx.characters) ? ctx.characters : [];
    return chars.map((character, index) => {
      const data = character?.data || character || {};
      const avatar = character?.avatar || data?.avatar || '';
      if (!avatar && !data?.name) return null;
      let url = '';
      if (avatar && /^(?:https?:|data:|blob:)/i.test(String(avatar))) url = String(avatar);
      else if (avatar) url = '/characters/' + encodeURIComponent(avatar);
      // Keep the thumbnail endpoint only as a fallback for unusual character
      // providers that do not expose a stable original file path.
      if (!url && avatar) {
        try { url = typeof ctx.getThumbnailUrl === 'function' ? ctx.getThumbnailUrl('avatar', avatar) : ''; } catch (_) { /* fallback below */ }
      }
      if (!url && avatar) url = '/thumbnail?type=avatar&file=' + encodeURIComponent(avatar);
      return { id: 'native-card-' + (avatar || index), avatarId: avatar, name: data.name || character?.name || '角色卡', kind: 'card', url, source: 'native', characterIndex: index };
    }).filter(Boolean);
  }
  function resolved() { return adapter.resolvePersona({ state, target: activeTarget() }); }
  async function refresh() {
    if (!app) return;
    const sequence = ++refreshSequence;
    const target = activeTarget();
    const targetIdentity = targetKey(target);
    const baseKey = assistantThreadKey(target);
    if (!String(localAssistantThreadKey || '').startsWith(baseKey + '|new_')) { localAssistantThreadKey = baseKey; writeLocalAssistantThreadKey(localAssistantThreadKey); }
    // Hydrate/migrate only the thread belonging to this exact target. This
    // lets existing v1.0.1 history appear without ever selecting a different
    // card/chat's newest thread.
    ensureAssistantThread(localAssistantThreadKey, target);
    // Keep the in-memory field aligned for the view layer, while
    // sharedState() strips it before any server write. It is a local
    // navigation pointer, never portable data.
    state.assistantActiveThreadKey = localAssistantThreadKey;
    const contextSnapshot = await adapter.contextSnapshot({ includeWorld: false });
    if (sequence !== refreshSequence || targetKey(activeTarget()) !== targetIdentity || !app) return;
    app.update({ state, target, assistantActiveThreadKey: localAssistantThreadKey, current: resolved(), bindings: adapter.readPersonaBindings(), native: adapter.readNativePersona(), personas: adapter.readNativePersonas(), nativeGallery: nativeGallery(), contextSnapshot });
  }
  async function persistHostSharedState(candidate) {
    const context = adapter?.context?.();
    if (!context || typeof context !== 'object') throw new Error('酒馆上下文不可用，无法保存人设馆设置。');
    const settings = context.extensionSettings && typeof context.extensionSettings === 'object'
      ? context.extensionSettings
      : (context.extensionSettings = {});
    let currentNamespace = settings[NS] && typeof settings[NS] === 'object' ? settings[NS] : {};
    // Another browser may have changed the namespace since this page loaded.
    // Read the current settings document for merging, then still write via
    // SillyTavern's own debounced saver so unrelated settings are not replaced
    // by a raw full-file request.
    try {
      const getter = context.getRequestHeaders || globalThis.getRequestHeaders;
      const headers = typeof getter === 'function' ? (getter.call(context, { omitContentType: false }) || {}) : {};
      const response = await fetch('/api/settings/get', { method: 'POST', headers, cache: 'no-store', credentials: 'same-origin' });
      if (response.ok) {
        const payload = await response.json();
        const raw = typeof payload?.settings === 'string' ? JSON.parse(payload.settings) : payload?.settings;
        const extensions = raw?.extension_settings || raw?.extensionSettings;
        if (extensions?.[NS] && typeof extensions[NS] === 'object') {
          currentNamespace = extensions[NS];
          settings[NS] = { ...currentNamespace };
        }
      }
    } catch (_) { /* older Tavern builds may not expose the read endpoint */ }
    const current = adapter.normalizeState({ ...defaultState(), ...currentNamespace });
    // Merge against the latest namespace visible to this page, preserving
    // unrelated extension settings. The candidate is the local winner for
    // fields changed on this device; assistant turns and gallery records are
    // unioned by mergeSharedState(). This is a compatibility provider without
    // the server plugin's compare-and-swap guarantee.
    // Keep the compatibility payload shared-only. Do not let normalizeState's
    // defaults (enabled/ui/current thread) overwrite browser-local choices in
    // the host namespace.
    const merged = mergeSharedState(candidate, sharedState(current));
    settings[NS] = { ...currentNamespace, ...merged };
    const saver = context.saveSettingsDebounced;
    if (typeof saver !== 'function') throw new Error('当前酒馆没有可用的设置保存入口。');
    await Promise.resolve(saver.call(context));
    state = adapter.normalizeState({
      ...defaultState(), ...state, ...merged,
      enabled: state.enabled,
      ui: state.ui,
      assistantActiveThreadKey: state.assistantActiveThreadKey,
    });
    syncRemoteState = sharedState(merged);
    syncRevision = 'host';
    syncMode = 'host';
    syncStatus = 'host-ready';
    clearPendingState();
    return true;
  }
  async function persistSharedState(candidate = sharedState(state)) {

    if (syncMode === 'host') {
      try {
        return await persistHostSharedState(candidate);
      } catch (error) {
        queuePendingState(candidate);
        syncStatus = 'error';
        report(`酒馆设置兼容同步失败：${error?.message || error}。本次修改已保留在本机。`, 'warning');
        return false;
      }
    }
    if (!syncClient || syncStatus === 'unavailable' || syncStatus === 'error' || syncStatus === 'conflict') {
      queuePendingState(candidate);
      report(syncStatus === 'conflict'
        ? '安全同步存在冲突，已停止继续写入；请先重新读取并合并本机副本。'
        : '同步服务未连接，本次修改只保留在当前页面。', 'warning');
      return false;
    }
    if (syncStatus === 'needs-migration') {
      queuePendingState(candidate);
      report('检测到旧版人设馆记录。请先在扩展设置中点击“迁移到安全同步”，当前修改不会覆盖旧数据。', 'warning');
      return false;
    }
    try {
      const result = await syncClient.putState(candidate, { baseRevision: syncRevision });
      syncRevision = result.revision;
      syncStatus = 'ready';
      syncRemoteState = candidate;
      clearPendingState();
      return true;
    } catch (error) {
      queuePendingState(candidate);
      if (error?.code === 'REVISION_MISMATCH') {
        syncStatus = 'conflict';
        report('发现另一台设备刚刚修改了人设馆数据。为防止互相覆盖，本次修改已保留在本机，未覆盖远端；请重新读取后再合并。', 'warning');
      } else {
        syncStatus = error?.code === 'SYNC_UNAVAILABLE' ? 'unavailable' : 'error';
        report(`安全同步失败：${error?.message || error}。本次修改已保留在本机，未写入远端。`, 'warning');
      }
      return false;
    }
  }

  async function makeTavernSnapshot() {
    const context = adapter.context();
    const getter = context?.getRequestHeaders || globalThis.getRequestHeaders;
    const headers = typeof getter === 'function' ? (getter.call(context, { omitContentType: false }) || {}) : {};
    const response = await fetch('/api/settings/make-snapshot', { method: 'POST', headers, cache: 'no-store', credentials: 'same-origin' });
    if (!response.ok) throw new Error(`酒馆设置快照失败（HTTP ${response.status}）`);
  }

  async function migrateToSafeSync() {
    if (syncMode === 'host') {
      const persisted = await persistHostSharedState(sharedState(state));
      await refresh();
      updateSettingsUi();
      return persisted;
    }
    if (!syncClient) throw new Error('当前没有加载安全同步客户端。');
    const remote = await syncClient.getState();
    if (remote.revision !== '0' || hasSharedData(remote.state)) {
      syncRevision = remote.revision;
      syncRemoteState = remote.state;
      // This button is the explicit conflict decision. Keep the local queued
      // candidate's metadata as the winner while still unioning groups,
      // gallery records, turns and drafts with the remote document.
      state = adapter.normalizeState({ ...defaultState(), ...state, ...mergeSharedState(sharedState(state), remote.state) });
      syncStatus = 'ready';
      const persisted = await persistSharedState();
      await refresh();
      if (persisted) report('已确认合并本机副本与远端记录，合并结果已写入安全同步。', 'info');
      updateSettingsUi();
      return persisted;
    }
    await makeTavernSnapshot();
    const result = await syncClient.putState(sharedState(state), { baseRevision: remote.revision });
    syncRevision = result.revision;
    syncRemoteState = result.state;
    syncStatus = 'ready';
    clearPendingState();
    report('已完成安全同步迁移；旧版酒馆设置仍保留为备份。', 'info');
    updateSettingsUi();
    return true;
  }

  async function saveImpl({ syncGallery = true, queuedShared = null } = {}) {
    // Gallery bytes still go through SillyTavern's image API. The gallery
    // manifest and all other extension data go to the independent CAS store
    // when available, or the extension namespace through Tavern's own saver
    // in compatibility mode.
    // Assistant responses only need the lightweight shared-state write. A
    // first save on a device with legacy gallery entries can otherwise wait
    // for every image upload before the reply reaches the mobile UI.
    if (syncGallery && (gallerySyncDirty || !gallerySync) && (syncStatus === 'ready' || syncStatus === 'host-ready')) {
      // Publish image bytes through SillyTavern's shared user image store
      // before writing settings. Settings then carry only metadata and a URL;
      // IndexedDB remains the local/offline cache.
      const hosted = await storage.publishAssets(state.gallery, async (blob, item) => adapter.uploadGalleryAsset?.(blob, { assetId: item.id }));
      if (hosted.changed.length) {
        state.gallery = storage.mergeGallery(state.gallery, hosted.changed);
        // Releases before the API fix put gallery images in User Avatars.
        // Remove only our deterministic ytps-* files after a successful move;
        // native persona files are left untouched. The adapter deliberately
        // does not save the global settings file during this cleanup.
        for (const item of hosted.changed) {
          if (item?.legacyRemoteUrl) await Promise.resolve(adapter.removeLegacyGalleryAvatar?.(item.legacyRemoteUrl)).catch(() => {});
        }
        gallerySyncDirty = true;
      }
      if (hosted.failed.length) report(`图库服务器同步失败 ${hosted.failed.length} 张，当前设备仍保留本地副本。`, 'warning');
      // Keep the settings payload a compact manifest. Legacy data URLs are
      // still accepted/imported, but new files use the server-backed path.
      // Keep the 500 MiB fallback for older Tavern builds where the image API
      // is unavailable; hosted images still contribute only their manifest.
      // The dedicated state document is intentionally small. Image bytes stay
      // in SillyTavern's user image store or this browser's IndexedDB; only a
      // hosted manifest is allowed into the CAS document.
      const nextGallerySync = await storage.exportSync({ removed: state.galleryRemoved, includeData: false, maxBytes: 3 * 1024 * 1024 }).catch(() => null);
      if (nextGallerySync) {
        const latestGallerySync = syncRemoteState?.gallerySync || gallerySync;
        if (latestGallerySync) {
          // Prefer the hosted manifest, while retaining a legacy data-URL
          // entry when its local upload failed or the current device has no
          // Blob to retry. This keeps an old image recoverable instead of
          // trading the migration for data loss.
          const assets = new Map((latestGallerySync.assets || []).map(item => [item.id, item]));
          for (const item of nextGallerySync.assets) {
            const previous = assets.get(item.id);
            if (!previous || Number(item.updatedAt || 0) >= Number(previous.updatedAt || 0)) assets.set(item.id, item);
          }
          const removed = { ...(latestGallerySync.removed || {}), ...(nextGallerySync.removed || {}) };
          nextGallerySync.assets = [...assets.values()].filter(item => Number(removed[item.id] || 0) <= Number(item.updatedAt || 0));
          nextGallerySync.removed = removed;
        }
        gallerySync = { ...nextGallerySync, version: 2, provider: 'tavern-user-images' }; gallerySyncDirty = false;
      }
    }
    state.gallerySync = gallerySync;
    await persistSharedState(queuedShared || sharedState(state));
    await refresh();
  }
  let saveChain = Promise.resolve();
  function save(options = {}) {
    // Assistant saves can wait behind a previous host refresh. Capture the
    // shared snapshot at enqueue time so that refresh cannot replace the new
    // turn with the older settings document before persistHostSharedState runs.
    const queuedShared = options.syncGallery === false ? sharedState(state) : null;
    const queuedOptions = queuedShared ? { ...options, queuedShared } : options;
    const run = saveChain.then(() => saveImpl(queuedOptions), () => saveImpl(queuedOptions));
    saveChain = run.catch(() => {});
    return run;
  }

  function showVersionManager() {
    versionManager ||= createVersionManager({
      settings: () => state,
      save,
      flush: save,
      context: () => adapter.context(),
      apiRoot: new URL('../../../../', import.meta.url),
      moduleURL: import.meta.url,
      currentVersion: VERSION,
      beforeChange: async () => {
        // Version switching changes the code currently driving the takeover.
        // Return the native drawer to a stable state before mutating the install.
        editMode = false;
        lastNativeOpen = null;
        app?.close();
        adapter?.setNativeTakeover?.(false);
        adapter?.setNativeEditMode?.(false);
        adapter?.setNativePresentation?.(false);
      },
    });
    openVersionDialog({ manager: versionManager, element, button, dialog, currentVersion: VERSION,
      notify: message => report(message), refresh: async () => { await save(); location.reload(); } });
  }

  function updateSettingsUi() {
    const enabled = state?.enabled !== false;
    const check = document.querySelector('#ytps-settings input[data-setting="enabled"]');
    if (check) check.checked = enabled;
    const openButton = document.querySelector('#ytps-settings [data-action="open-persona"]');
    if (openButton) openButton.disabled = !enabled;
    const status = document.querySelector('#ytps-settings [data-role="status"]');
    if (status) {
      const syncLabel = syncStatus === 'ready' ? '安全同步已启用' : syncStatus === 'host-ready' ? '兼容同步已启用（保护有限）' : syncStatus === 'needs-migration' ? '等待迁移旧记录' : syncStatus === 'conflict' ? '同步冲突已停止覆盖' : syncStatus === 'checking' ? '正在检查同步服务' : syncStatus === 'error' ? '同步保存失败' : '同步服务未连接';
      status.textContent = `${enabled ? '已启用' : '已关闭'} · V${VERSION} · ${syncLabel}`;
    }
    const migrate = document.querySelector('#ytps-settings [data-action="migrate-sync"]');
    if (migrate) migrate.hidden = syncMode !== 'server' || !['needs-migration', 'ready', 'conflict'].includes(syncStatus);
    if (migrate) migrate.textContent = syncStatus === 'needs-migration' ? '备份并迁移旧记录' : syncStatus === 'conflict' ? '重新读取并合并本机副本' : '重新读取安全同步';
  }

  function installSettingsEntry() {
    const host = document.getElementById('extensions_settings2') || document.getElementById('extensions_settings');
    if (!host || document.getElementById('ytps-settings')) return;
    const panel = element('div'); panel.id = 'ytps-settings';
    const drawer = element('div', 'inline-drawer');
    const header = element('div', 'inline-drawer-toggle inline-drawer-header');
    const icon = element('div', 'inline-drawer-icon fa-solid fa-circle-chevron-down down'); icon.setAttribute('aria-hidden', 'true');
    header.tabIndex = 0; header.setAttribute('role', 'button'); header.setAttribute('aria-expanded', 'false'); header.setAttribute('aria-controls', 'ytps-settings-content');
    header.append(element('b', '', '砚台 · 人设馆'), icon);
    header.addEventListener('click', () => header.setAttribute('aria-expanded', String(icon.classList.contains('down'))));
    header.addEventListener('keydown', event => { if (['Enter', ' '].includes(event.key)) { event.preventDefault(); event.stopPropagation(); header.click(); } });
    const content = element('div', 'inline-drawer-content'); content.id = 'ytps-settings-content';
    const status = element('small', 'ytps-install-status', ''); status.dataset.role = 'status';
    content.append(status, element('p', 'ytps-settings-help', '分组、图库清单和小助手记录会随同一个酒馆实例的设置同步；页面选项只保留在当前设备。酒馆原生人设和绑定仍由酒馆设置管理。安装可选的同步服务端插件后可获得版本校验和冲突保护。'));
    const label = element('label', 'checkbox_label'); const check = element('input'); check.type = 'checkbox'; check.dataset.setting = 'enabled';
    check.addEventListener('change', () => { void controlModule?.setEnabled(check.checked).then(updateSettingsUi).catch(error => report(error.message, 'error')); });
    label.append(check, element('span', '', '启用人设馆接管')); content.append(label);
    const actions = element('div', 'ytps-settings-actions');
    actions.append(button('打开人设馆', 'menu_button', () => open({ tab: 'current' }), '打开砚台人设馆'));
    actions.lastElementChild.dataset.action = 'open-persona';
    const migrate = button('备份并迁移旧记录', 'menu_button', () => { void Promise.resolve(controlModule?.migrateToSafeSync?.()).catch(error => report(error.message || String(error), 'error')); });
    migrate.dataset.action = 'migrate-sync';
    actions.append(migrate);
    actions.append(button('版本与更新', 'menu_button ytps-version-open', showVersionManager));
    content.append(actions);
    drawer.append(header, content); panel.append(drawer); host.append(panel); updateSettingsUi();
  }

  async function open({ ensureNative = true, tab = 'current' } = {}) {
    if (!initialized) await initialize();
    if (state.enabled === false) {
      report('人设馆已关闭。可在「扩展设置 → 砚台 · 人设馆」中重新启用。', 'info');
      return false;
    }
    // Opening the native smiley lands on the current view; explicit quick
    // entries may request the gallery or another workspace tab.
    const allowedTabs = new Set(['current', 'library', 'editor', 'create', 'gallery', 'assistant']);
    state.ui.tab = allowedTabs.has(tab) ? tab : 'current';
    app?.setLocalUi?.({ tab: state.ui.tab });
    app?.update?.({ state });
    const nativePanel = ensureNative ? await adapter.openNativePersonaPanel() : ([...document.querySelectorAll('#persona-management-block')].find(item => item.offsetParent !== null) || document.querySelector('#persona-management-block'));
    if (!ensureNative && !adapter.isNativePersonaPanelOpen()) {
      app?.close();
      adapter.setNativeTakeover(false);
      return;
    }
    if (!nativePanel) {
      report('没有找到酒馆原生人设面板，请先打开“人设管理”后再试。', 'warning');
      return;
    }
    if (!app?.open()) {
      report('原生人设面板尚未完成加载，请稍后再试。', 'warning');
      return;
    }
    editMode = false;
    adapter.setNativeTakeover(true);
    await refresh();
  }

  async function syncNativeDrawer() {
    const isOpen = Boolean(adapter?.isNativePersonaPanelOpen?.());
    if (state.enabled === false) {
      app?.close();
      adapter?.setNativeTakeover?.(false);
      adapter?.setNativeEditMode?.(false);
      adapter?.setNativePresentation?.(false);
      return;
    }
    if (isOpen === lastNativeOpen && !editMode) return;
    lastNativeOpen = isOpen;
    if (isOpen) {
      if (editMode) {
        app?.close();
        adapter?.setNativeEditMode?.(true);
      } else {
        await open({ ensureNative: false });
      }
      return;
    }
    editMode = false;
    app?.close();
    adapter?.setNativeTakeover?.(false);
    adapter?.setNativeEditMode?.(false);
  }

  async function initialize() {
    if (initialized) return;
    initialized = true;
    await loadModules();
    await loadState();
    registerControlModule();
    app = ui.createApp({ version: VERSION, adapter, storage, actions: {}, report, getState: () => ({ state, target: activeTarget(), current: resolved() }) });
    const actions = {
      open,
      close: () => { editMode = false; app?.close(); adapter.setNativeTakeover(false); adapter.setNativeEditMode(false); },
      refresh,
      async setTab(tab) { state.ui = { ...(state.ui || {}), tab }; app?.setLocalUi?.({ tab }); },
      async setEditingPersona(id) {
        state.ui = { ...(state.ui || {}), tab: 'editor', editingPersonaId: String(id || '') };
        app?.setLocalUi?.({ tab: 'editor', editingPersonaId: String(id || '') });
      },
      async startNewPersona() {
        state.ui = { ...(state.ui || {}), tab: 'create', editingPersonaId: '' };
        app?.setLocalUi?.({ tab: 'create', editingPersonaId: '' });
      },
      async setGallerySheet(sheet) { const value = sheet === 'cards' ? 'cards' : 'avatars'; state.ui = { ...(state.ui || {}), gallerySheet: value }; app?.setLocalUi?.({ gallerySheet: value }); },
      async selectGalleryAsset(id) { const value = String(id || ''); state.ui = { ...(state.ui || {}), selectedAssetId: value }; app?.setLocalUi?.({ selectedAssetId: value }); },
      async setLibraryGroup(groupId) {
        const wanted = String(groupId || 'all');
        const known = wanted === 'all' || wanted === '__uncategorized__' || state.personaGroups.some(group => String(group?.id || '') === wanted);
        state.ui.libraryGroup = known ? wanted : 'all';
        app?.setLocalUi?.({ libraryGroup: state.ui.libraryGroup });
      },
      async createPersonaGroup(name) {
        const label = String(name || '').trim().replace(/\s+/g, ' ').slice(0, 40);
        if (!label) return null;
        state.personaGroups = Array.isArray(state.personaGroups) ? state.personaGroups : [];
        const reserved = new Set(['全部', '全部分组', '未分类', '无分组', '默认']);
        if (reserved.has(label.toLocaleLowerCase()) || state.personaGroups.some(group => String(group?.name || '').trim().toLocaleLowerCase() === label.toLocaleLowerCase())) {
          throw new Error('已经有同名的人设文件夹。');
        }
        const id = `group_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
        const group = { id, name: label, createdAt: Date.now() };
        state.personaGroups = [...state.personaGroups, group];
        state.ui.libraryGroup = id;
        await save();
        return group;
      },
      async renamePersonaGroup(groupId, name) {
        const id = String(groupId || '');
        if (!id || id === 'all' || id === '__uncategorized__') throw new Error('这个分组不能重命名。');
        state.personaGroups = Array.isArray(state.personaGroups) ? state.personaGroups : [];
        const current = state.personaGroups.find(group => String(group?.id || '') === id);
        if (!current) throw new Error('找不到这个分组。');
        const label = String(name || '').trim().replace(/\s+/g, ' ').slice(0, 40);
        if (!label) throw new Error('分组名称不能为空。');
        const reserved = new Set(['全部', '全部分组', '未分类', '无分组', '默认']);
        const lower = label.toLocaleLowerCase();
        if (reserved.has(lower)) throw new Error('这个名称是系统保留名称，请换一个。');
        if (state.personaGroups.some(group => String(group?.id || '') !== id && String(group?.name || '').trim().toLocaleLowerCase() === lower)) {
          throw new Error('已经有同名的人设分组。');
        }
        current.name = label;
        await save();
        return current;
      },
      async deletePersonaGroup(groupId) {
        const id = String(groupId || '');
        if (!id || id === 'all' || id === '__uncategorized__') throw new Error('这个分组不能删除。');
        state.personaGroups = Array.isArray(state.personaGroups) ? state.personaGroups : [];
        if (!state.personaGroups.some(group => String(group?.id || '') === id)) throw new Error('找不到这个分组。');
        state.personaGroups = state.personaGroups.filter(group => String(group?.id || '') !== id);
        const nextMeta = {};
        for (const [personaId, meta] of Object.entries(state.personaMeta && typeof state.personaMeta === 'object' ? state.personaMeta : {})) {
          if (!meta || typeof meta !== 'object' || String(meta.groupId || '') !== id) { nextMeta[personaId] = meta; continue; }
          const { groupId: _groupId, ...rest } = meta;
          if (Object.keys(rest).length) nextMeta[personaId] = rest;
        }
        state.personaMeta = nextMeta;
        if (String(state.ui?.libraryGroup || '') === id) state.ui.libraryGroup = '__uncategorized__';
        await save();
        return true;
      },
      async setPersonaGroupForPersona(personaId, groupId) {
        const id = String(personaId || '');
        if (!id) return false;
        const wanted = String(groupId || '__uncategorized__');
        if (wanted !== '__uncategorized__' && !state.personaGroups.some(group => String(group?.id || '') === wanted)) return false;
        state.personaMeta = state.personaMeta && typeof state.personaMeta === 'object' ? state.personaMeta : {};
        const current = state.personaMeta[id] && typeof state.personaMeta[id] === 'object' ? state.personaMeta[id] : {};
        if (wanted === '__uncategorized__') {
          const { groupId: _groupId, ...rest } = current;
          if (Object.keys(rest).length) state.personaMeta[id] = rest;
          else delete state.personaMeta[id];
        } else {
          state.personaMeta[id] = { ...current, groupId: wanted };
        }
        await save();
        return true;
      },
      async setDefault(id) { await adapter.setDefault(id || null); await refresh(); },
      async updatePersona(id, patch) { const ok = await adapter.updatePersona?.(id, patch); if (ok) await refresh(); return ok; },
      async createPersona(input) {
        const created = await adapter.createPersona?.(input);
        state.ui = { ...(state.ui || {}), tab: 'create', editingPersonaId: '' };
        await refresh();
        return created;
      },
      async choosePersonaLorebook(id) { return adapter.choosePersonaLorebook?.(id) || { cancelled: true }; },
      async duplicatePersona(id) { const ok = await adapter.duplicatePersona?.(id); if (ok) await refresh(); return ok; },
      async setBinding(scope, mode, personaId = null) {
        // The compact UI deliberately presents one binding choice. Clear the
        // other native locks first so selecting a second row never appears to
        // get stuck behind the previous chat/card/default lock.
        if (mode === 'none') {
          for (const other of ['chat', 'card', 'global']) await adapter.setNativeBinding(other, null);
          state.sessionOverride = null;
        } else {
          for (const other of ['chat', 'card', 'global']) if (other !== scope) await adapter.setNativeBinding(other, null);
          state.sessionOverride = null;
        }
        if (mode !== 'none') await adapter.setNativeBinding(scope, personaId);
        await save();
      },
      async usePersona(id) {
        const ok = await adapter.selectNativePersona(id);
        if (!ok) throw new Error('酒馆没有接受这次人设切换，请刷新人设面板后重试。');
        await refresh();
      },
      async copyPersona(id) {
        await adapter.duplicatePersona(id);
        await new Promise(resolve => setTimeout(resolve, 300));
        await refresh();
      },
      async deletePersona(id) {
        // Native adapter delegates to SillyTavern's confirmation dialog and
        // deletion path, including linked chat/default cleanup.
        const ok = await adapter.deletePersona(id);
        if (!ok) throw new Error('酒馆没有完成删除，请保留当前人设并刷新后重试。');
        await new Promise(resolve => setTimeout(resolve, 320));
        state.ui.tab = 'current';
        await save();
      },
      async focusPersona(id) { await adapter.focusNativePersona(id); await refresh(); },
      async openNativeCreate() {
        const panel = await adapter.openNativePersonaPanel?.();
        const button = panel?.querySelector?.('#create_dummy_persona') || document.querySelector('#create_dummy_persona');
        if (button) {
          editMode = true;
          app?.close();
          adapter.setNativeTakeover(false);
          adapter.setNativeEditMode(true);
          button.click();
          report('已打开酒馆的“创建空白用户设定”，保存后会作为一份全新人设出现。', 'info');
          return true;
        }
        report('当前酒馆没有找到原生“创建空白用户设定”按钮，请先展开原生人设面板。', 'warning');
        return false;
      },
      async openNativeEdit(id) { editMode = true; adapter.setNativeEditMode(true); app?.close(); await adapter.selectNativePersona(id); await adapter.focusNativePersona(id); report('已切换到酒馆原生编辑区；编辑完成后关闭并重新打开人设按钮即可回到砚台工作区。', 'info'); },
      async addGalleryAssets(files, kind = null) { const added = await storage.importFiles(files, { kind }); state.galleryRemoved = state.galleryRemoved && typeof state.galleryRemoved === 'object' ? state.galleryRemoved : {}; for (const item of added) delete state.galleryRemoved[item.id]; state.gallery = storage.mergeGallery(state.gallery, added); gallerySyncDirty = true; await save(); return added; },
      async removeGalleryAsset(id) { const removedItem = state.gallery.find(item => String(item?.id || '') === String(id)); await Promise.resolve(adapter.deleteGalleryAsset?.(removedItem?.remoteUrl)).catch(() => {}); state.gallery = state.gallery.filter(item => item.id !== id); state.galleryRemoved = state.galleryRemoved && typeof state.galleryRemoved === 'object' ? state.galleryRemoved : {}; state.galleryRemoved[String(id)] = Date.now(); storage.releasePreview?.(id); await storage.remove(id); gallerySyncDirty = true; await save(); },
      async uploadGalleryAvatar(id, targetPersonaId = '') {
        const asset = await storage.getAsset(id).catch(() => null);
        let blob = asset?.blob;
        // The IndexedDB Blob is device-local.  A gallery manifest can still
        // point at the shared SillyTavern image endpoint after another device
        // imported the image, so recover the original bytes before opening the
        // native crop dialog instead of asking the user to import it again.
        if (!blob || typeof blob.arrayBuffer !== 'function') {
          const item = state.gallery.find(entry => String(entry?.id || '') === String(id));
          const sources = [asset?.remoteUrl, item?.remoteUrl, asset?.url, item?.url]
            .map(value => String(value || '').trim())
            .filter(Boolean);
          for (const source of sources) {
            // A blob URL belongs to the browser session that created it and
            // cannot be resolved on another device. Data URLs remain valid as
            // a compatibility fallback for older, local-only manifests.
            if (/^blob:/i.test(source) || typeof fetch !== 'function') continue;
            const url = /^user\/images\//i.test(source) ? '/' + source : source;
            try {
              const response = await fetch(url, { cache: 'no-cache' });
              if (!response.ok) continue;
              const recovered = await response.blob();
              if (recovered && typeof recovered.arrayBuffer === 'function') {
                blob = recovered;
                break;
              }
            } catch (_) { /* try the next manifest URL */ }
          }
        }
        if (!blob || typeof blob.arrayBuffer !== 'function') throw new Error('找不到这张图片的可用原图，请重新导入。');
        // Applying an avatar is only valid from an existing editor target.
        // Never fall back to the active persona: an empty target must fail
        // safely instead of entering the native create-persona flow.
        const overwriteName = String(targetPersonaId || '');
        if (!overwriteName) throw new Error('请先从已有的人设编辑页进入图库，再应用头像；图片已保留在图库中。');
        const personas = adapter.readNativePersonas?.() || [];
        if (personas.length && !personas.some(persona => String(persona?.id || '') === overwriteName)) throw new Error('找不到要应用头像的人设，请重新打开编辑页后再试。');
        // Gallery application always overwrites an existing persona avatar.
        // It must never fall through to the native “create persona” branch.
        const result = await adapter.uploadNativeAvatar(blob, { resizePrompt: true, overwriteName, createPersona: false });
        if (!result?.cancelled) await refresh();
        return result;
      },
      async createDraft(input) {
        const target = activeTarget();
        const token = ++assistantGenerationToken;
        const snapshot = await adapter.contextSnapshot({ includeWorld: input?.includeWorld === true });
        const source = assistantContext(input, snapshot);
        const thread = activeAssistantThread(target);
        const result = await ai.generateDirections({ input, target, state, context: source, history: thread.turns, thread, mode: 'propose' });
        const destination = responseDestination(target, thread);
        if (!generationIsCurrent(destination.target, token, destination.thread)) return { ...result, __yantaiStale: true };
        appendAssistantTurn(destination.thread, input?.request || '', result);
        if (result?.draft) state.drafts = [{ ...result.draft, targetKey: targetKey(destination.target), target: { cardKey: destination.target.cardKey || 'no-card', legacyCardKey: destination.target.legacyCardKey || '', chatId: destination.target.chatId || 'no-chat' } }, ...state.drafts].slice(0, 20);
        await save({ syncGallery: false });
        return result;
      },
      async assistantChat(input = {}) {
        const target = activeTarget();
        const token = ++assistantGenerationToken;
        const snapshot = await adapter.contextSnapshot({ includeWorld: input?.includeWorld === true });
        const source = assistantContext(input, snapshot);
        const thread = activeAssistantThread(target);
        const fn = ai.continueChat || ai.chat || ai.generateChat;
        if (typeof fn !== 'function') throw new Error('当前版本尚未加载小助手对话接口，请刷新酒馆后重试。');
        const result = await fn({ input, target, state, context: source, history: thread.turns, thread, mode: 'chat' });
        const destination = responseDestination(target, thread);
        if (!generationIsCurrent(destination.target, token, destination.thread)) return { ...result, __yantaiStale: true };
        appendAssistantTurn(destination.thread, input?.request || '', result);
        await save({ syncGallery: false });
        return result;
      },
      async clearAssistantThread() {
        assistantGenerationToken += 1;
        const thread = activeAssistantThread(activeTarget());
        thread.turns = [];
        thread.updatedAt = Date.now();
        if (thread.id === GLOBAL_ASSISTANT_THREAD_KEY) state.assistantGlobalClearedAt = Date.now();
        await save({ syncGallery: false });
        return thread;
      },
      async newAssistantThread() {
        assistantGenerationToken += 1;
        const target = activeTarget();
        const key = assistantThreadKey(target) + '|new_' + Date.now().toString(36);
        localAssistantThreadKey = key;
        writeLocalAssistantThreadKey(localAssistantThreadKey);
        state.assistantThreads = state.assistantThreads && typeof state.assistantThreads === 'object' ? state.assistantThreads : {};
        state.assistantThreads[key] = { id: key, target: globalAssistantTarget(), createdAt: Date.now(), updatedAt: Date.now(), turns: [] };
        // An empty thread is a local navigation event. It is not written as a
        // shared active selector; the first actual turn is shared normally.
        await refresh();
        return { ...state.assistantThreads[key], activeThreadKey: key };
      },
      async reviseDraft(draftId, instruction) {
        const target = activeTarget();
        const draft = state.drafts.find(item => item.id === draftId && (!item.targetKey || item.targetKey === targetKey(target)));
        if (!draft) return;
        const token = ++assistantGenerationToken;
        const thread = activeAssistantThread(target);
        const snapshot = await adapter.contextSnapshot({ includeWorld: false });
        const source = assistantContext({ includeCard: true }, snapshot);
        const result = await ai.reviseDraft({ draft, instruction, target, state, context: source, history: thread.turns, thread, mode: 'revision' });
        const destination = responseDestination(target, thread);
        if (!generationIsCurrent(destination.target, token, destination.thread)) return { ...result, __yantaiStale: true };
        appendAssistantTurn(destination.thread, instruction, result);
        if (result?.draft) { state.drafts = [{ ...result.draft, targetKey: targetKey(destination.target), target: { cardKey: destination.target.cardKey || 'no-card', legacyCardKey: destination.target.legacyCardKey || '', chatId: destination.target.chatId || 'no-chat' } }, ...state.drafts.filter(item => item.id !== draftId)].slice(0, 20); await save({ syncGallery: false }); }
        return result;
      },
      async saveCandidate(draftId, candidate) {
        const draft = state.drafts.find(item => item.id === draftId);
        if (draft) { draft.acceptedCandidateId = candidate.id; draft.status = 'accepted'; }
        await save({ syncGallery: false });
        await actions.openNativeCreate();
        report('候选已保留。酒馆原生新建窗口已打开，请把候选正文放入原生描述框；这样人设仍由酒馆管理，不会产生第二份副本。', 'info');
      },
      state: () => state,
    };
    app.options.actions = actions;
    if (state.gallery.some(item => /^image\//i.test(String(item?.mime || '')) && !item.remoteUrl)) {
      report('发现尚未上传到酒馆图库的本地图片；为避免打开电脑时产生写入，已暂不自动迁移，请在确认安全同步后执行一次明确保存。', 'info');
    }
    adapter.on('CHAT_CHANGED', refresh);
    adapter.on('CHARACTER_CHANGED', refresh);
    adapter.on('PERSONA_CHANGED', refresh);
    adapter.on('PERSONA_UPDATED', refresh);
    adapter.on('PERSONA_CREATED', refresh);
    adapter.on('PERSONA_RENAMED', refresh);
    const personaDeleted = async payload => {
      const deletedId = typeof payload === 'string'
        ? payload
        : payload?.avatarId ?? payload?.personaId ?? payload?.id ?? '';
      await refresh();
      if (!state.personaMeta || typeof state.personaMeta !== 'object') return;
      const known = new Set(adapter.readNativePersonas().map(persona => String(persona?.id || '')));
      const removed = deletedId
        ? [String(deletedId)]
        : Object.keys(state.personaMeta).filter(id => !known.has(id));
      let changed = false;
      for (const id of removed) {
        if (!id || !Object.prototype.hasOwnProperty.call(state.personaMeta, id)) continue;
        delete state.personaMeta[id];
        changed = true;
      }
      if (changed) await save();
    };
    adapter.on('PERSONA_DELETED', personaDeleted);
    if (state.enabled !== false) await adapter.installEntry();
    adapter.setNativePresentation?.(state.enabled !== false);
    installSettingsEntry();
    // Native drawers can be mounted lazily, especially on mobile and after a
    // theme reload. Keep a tiny, scoped observer so the takeover hook is not
    // lost when SillyTavern replaces the settings subtree.
    if (document.body && !observer && typeof MutationObserver === 'function') {
      document.body.dataset.yantaiPersonaObserver = 'true';
      const scheduleSync = () => {
        if (disposed || syncTimer) return;
        syncTimer = setTimeout(async () => {
          syncTimer = null;
          if (disposed) return;
          try {
            if (state.enabled !== false) await adapter.installEntry();
            else adapter.setNativePresentation?.(false);
            installSettingsEntry();
            await syncNativeDrawer();
          } catch (error) {
            console.error('[砚台·人设馆] drawer sync failed', error);
          }
        }, 30);
      };
      const hasPersonaNode = node => {
        if (!node || node.nodeType !== 1) return false;
        const element = /** @type {Element} */ (node);
        return Boolean(
          element.matches?.('#PersonaManagement, #persona-management-button, #persona-management-block, #extensionsMenu, #extensions_settings, #extensions_settings2')
          || element.querySelector?.('#PersonaManagement, #persona-management-button, #persona-management-block, #extensionsMenu, #extensions_settings, #extensions_settings2'),
        );
      };
      const attachPanelObserver = () => {
        const targets = [
          document.querySelector('#PersonaManagement'),
          document.querySelector('#persona-management-button'),
        ].filter(Boolean);
        if (!targets.length) return;
        // The drawer open/close state lives on these small native containers.
        // Watching them directly avoids observing class/style churn across the
        // entire chat DOM (which used to run installEntry every few frames).
        panelObserver ||= new MutationObserver(() => scheduleSync());
        for (const target of targets) {
          if (panelObserverTargets.has(target)) continue;
          panelObserver.observe(target, { attributes: true, attributeFilter: ['class', 'hidden'] });
          panelObserverTargets.add(target);
        }
      };
      // Keep the document observer to detect a lazy-mounted native drawer, but
      // only inspect added/removed nodes that could actually be the persona
      // panel. Chat message rendering therefore does not trigger a sync.
      observer = new MutationObserver(records => {
        attachPanelObserver();
        if (records.some(record => [...record.addedNodes, ...record.removedNodes].some(hasPersonaNode))) scheduleSync();
      });
      observer.observe(document.body, { childList: true, subtree: true });
      attachPanelObserver();
    }
    await syncNativeDrawer();
    await refresh();
  }

  root.yantaiPersonaStudioOpen = open;
  root.yantaiPersonaStudioActivate = initialize;
  root.yantaiPersonaStudioUpdate = async () => { await initialize(); report('已加载 V' + VERSION); };
  root.yantaiPersonaStudioClean = async () => { await storage?.clear(); };
  try { await initialize(); } catch (error) { initialized = false; console.error('[砚台·人设馆]', error); report('加载失败：' + (error?.message || error), 'error'); }
})();
