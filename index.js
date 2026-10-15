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
          health: missingPreview ? 'degraded' : 'ok',
          sources: [
            { kind: 'host-settings', namespace: NS, scope: 'host', portable: 'partial', readable: true, writable: true },
            { kind: 'indexeddb', namespace: 'yantai-persona-studio/assets', scope: 'device', portable: 'no', readable: true, writable: true, count: gallery.length, missingCount: missingPreview },
          ],
          checks: [
            { id: 'gallery-preview', label: '图库预览', status: missingPreview ? 'degraded' : 'ok', detail: missingPreview ? `${missingPreview} 项只有元数据，当前设备没有可用预览` : `本设备可预览 ${previewCount} 项` },
            { id: 'assistant-history', label: 'Milo 记录', status: 'ok', detail: `${Object.keys(threads).length} 个对话线程保存在人设馆设置中` },
            { id: 'context', label: '当前酒馆上下文', status: ctx ? 'ok' : 'unknown', detail: root.location?.origin || '当前来源未知' },
          ],
        };
      },
      open(options = {}) { return open(options); },
      async setEnabled(value) {
        state.enabled = Boolean(value);
        await save();
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
    const [adapterModule, storageModule, uiModule, aiModule] = await Promise.all([
      import(new URL('./adapter.js', base)),
      import(new URL('./storage.js', base)),
      import(new URL('./ui.js', base)),
      import(new URL('./ai.js', base)),
    ]);
    adapter = adapterModule.createAdapter({ namespace: NS, version: VERSION, report });
    // Load the real native persona module once so the current selection and
    // setter use SillyTavern's live bindings instead of a stale context copy.
    await adapter.loadNativeApi();
    storage = storageModule.createStorage({ namespace: NS, report });
    ui = uiModule;
    ai = aiModule.createAiHelper({ namespace: NS, version: VERSION, adapter, report });
  }

  function defaultState() {
    // Persona folders belong to the extension organiser rather than the
    // native persona store.  A missing groupId deliberately means “未分类”,
    // so older settings remain compatible without a migration pass.
    return { version: 3, enabled: true, personaMeta: {}, personaGroups: [], gallery: [], galleryRemoved: {}, assistantThreads: {}, assistantActiveThreadKey: '', ui: { tab: 'current', gallerySheet: 'avatars', selectedAssetId: '', editingPersonaId: '', libraryGroup: 'all' } };
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
    state.galleryRemoved = state.galleryRemoved && typeof state.galleryRemoved === 'object' ? state.galleryRemoved : {};
    gallerySync = saved?.gallerySync || null;
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
    return state;
  }
  function activeTarget() {
    const ctx = adapter.context();
    return { chatId: adapter.chatKey(ctx), cardKey: adapter.cardFingerprint(ctx), character: adapter.currentCharacter(ctx), chatTitle: adapter.chatTitle(ctx) };
  }
  function assistantThreadKey(target = activeTarget()) {
    // The thread belongs to the card/chat/session, not to the browser user
    // identity.  adapter.normalizeState migrates the old identity-prefixed
    // keys when the extension starts.
    return adapter.assistantThreadBaseKey(target.cardKey || 'no-card', target.chatId || 'no-chat', state?.sessionOverride || '');
  }
  function ensureAssistantThread(key = assistantThreadKey()) {
    state.assistantThreads = state.assistantThreads && typeof state.assistantThreads === 'object' ? state.assistantThreads : {};
    const current = state.assistantThreads[key];
    if (current && Array.isArray(current.turns)) return current;
    const thread = { id: key, createdAt: Date.now(), updatedAt: Date.now(), turns: [] };
    state.assistantThreads[key] = thread;
    return thread;
  }
  function activeAssistantThread(target = activeTarget()) {
    const baseKey = assistantThreadKey(target);
    const activeKey = String(state.assistantActiveThreadKey || '');
    // A manually opened session gets a suffix. Keep using it until the
    // target changes; otherwise the next request would silently jump back to
    // the previous card/chat thread.
    const key = activeKey.startsWith(baseKey + '|new_') ? activeKey : baseKey;
    state.assistantActiveThreadKey = key;
    return ensureAssistantThread(key);
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
    const contextSnapshot = await adapter.contextSnapshot();
    app.update({ state, target: activeTarget(), current: resolved(), bindings: adapter.readPersonaBindings(), native: adapter.readNativePersona(), personas: adapter.readNativePersonas(), nativeGallery: nativeGallery(), contextSnapshot });
  }
  let saveQueue = Promise.resolve();
  async function persistState() {
    // Settings are shared through the host, so merge assistant turns with the
    // latest persisted snapshot before writing. This prevents another device
    // or tab from replacing an entire thread map with its older copy.
    let latestGallerySync = null;
    try {
      const latest = adapter.normalizeState(await adapter.loadExtensionState(defaultState()));
      const remote = latest.assistantThreads || {};
      const local = state.assistantThreads || {};
      // A clean local gallery must not overwrite a newer gallery synced by
      // another device while we are saving an assistant turn. Adopt the
      // remote snapshot before writing the merged settings back.
      const remoteGallerySync = latest.gallerySync;
      latestGallerySync = remoteGallerySync || null;
      if (!gallerySyncDirty && remoteGallerySync && (!gallerySync || Number(remoteGallerySync.updatedAt || 0) > Number(gallerySync.updatedAt || 0))) {
        gallerySync = remoteGallerySync;
        await storage.importSync(gallerySync).catch(() => {});
      }
      mergeGalleryManifest(latestGallerySync || gallerySync);
      if (Array.isArray(latest.gallery)) state.gallery = storage.mergeGallery(state.gallery, latest.gallery);
      const remoteRemoved = latest.galleryRemoved && typeof latest.galleryRemoved === 'object' ? latest.galleryRemoved : {};
      state.galleryRemoved = { ...(state.galleryRemoved || {}) };
      for (const [id, at] of Object.entries(remoteRemoved)) {
        const localItem = state.gallery.find(item => String(item?.id || '') === String(id));
        // Re-importing the same file produces the same deterministic id. A
        // newer local upload explicitly revives it and clears old tombstones.
        if (localItem && Number(localItem.updatedAt || 0) > Number(at || 0)) delete state.galleryRemoved[id];
        else state.galleryRemoved[id] = Math.max(Number(state.galleryRemoved[id] || 0), Number(at || 0));
      }
      state.gallery = state.gallery.filter(item => Number(state.galleryRemoved[item.id] || 0) <= Number(item.updatedAt || 0));
      for (const [key, remoteThread] of Object.entries(remote)) {
        const localThread = local[key];
        if (!localThread) { local[key] = remoteThread; continue; }
        const turns = [...(localThread.turns || []), ...(remoteThread.turns || [])];
        const bySig = new Map();
        for (const turn of turns) {
          const sig = `${turn.at || 0}|${turn.user || ''}|${turn.assistant || turn.memory || ''}`;
          bySig.set(sig, turn);
        }
        localThread.turns = [...bySig.values()].sort((a, b) => (a.at || 0) - (b.at || 0));
        localThread.createdAt = Math.min(localThread.createdAt || Date.now(), remoteThread.createdAt || Date.now());
        localThread.updatedAt = Math.max(localThread.updatedAt || 0, remoteThread.updatedAt || 0);
      }
      state.assistantThreads = local;
    } catch (_) { /* retain local state when host settings are unavailable */ }
    if (gallerySyncDirty || !gallerySync) {
      // Publish image bytes through SillyTavern's shared user image store
      // before writing settings. Settings then carry only metadata and a URL;
      // IndexedDB remains the local/offline cache.
      const hosted = await storage.publishAssets(state.gallery, async (blob, item) => adapter.uploadGalleryAsset?.(blob, { assetId: item.id }));
      if (hosted.changed.length) {
        state.gallery = storage.mergeGallery(state.gallery, hosted.changed);
        // Legacy gallery files remain in User Avatars until a server-side
        // persona list confirms they are not in use.  Deleting them here can
        // remove a persona created on another device from a stale browser.
        gallerySyncDirty = true;
      }
      if (hosted.failed.length) report(`图库服务器同步失败 ${hosted.failed.length} 张，当前设备仍保留本地副本。`, 'warning');
      // Keep the settings payload a compact manifest. Legacy data URLs are
      // still accepted/imported, but new files use the server-backed path.
      // Keep the 500 MiB fallback for older Tavern builds where the image API
      // is unavailable; hosted images still contribute only their manifest.
      const nextGallerySync = await storage.exportSync({ removed: state.galleryRemoved, includeData: true, maxBytes: 500 * 1024 * 1024 }).catch(() => null);
      if (nextGallerySync) {
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
    const persisted = await adapter.saveExtensionState(gallerySync ? { ...state, gallerySync } : state);
    state = adapter.normalizeState({ ...state, ...persisted });
    await refresh();
  }
  // Serialize writes from tab changes, gallery migration, and Milo replies.
  // Without a queue, two local saves could read the same remote snapshot and
  // let the slower stale request win after the newer one.
  function save() {
    const next = saveQueue.then(persistState, persistState);
    saveQueue = next.catch(() => {});
    return next;
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
    if (status) status.textContent = `${enabled ? '已启用' : '已关闭'} · V${VERSION}`;
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
    content.append(status, element('p', 'ytps-settings-help', '接管酒馆原生人设面板，关闭后可直接使用原生界面；人设、头像和图库文件不会被删除。'));
    const label = element('label', 'checkbox_label'); const check = element('input'); check.type = 'checkbox'; check.dataset.setting = 'enabled';
    check.addEventListener('change', () => { void controlModule?.setEnabled(check.checked).then(updateSettingsUi).catch(error => report(error.message, 'error')); });
    label.append(check, element('span', '', '启用人设馆接管')); content.append(label);
    const actions = element('div', 'ytps-settings-actions');
    actions.append(button('打开人设馆', 'menu_button', () => open({ tab: 'current' }), '打开砚台人设馆'));
    actions.lastElementChild.dataset.action = 'open-persona';
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
    // Refresh the native persona list from the server without invoking the
    // rendering helper that can register stray avatar files as new personas.
    await adapter.refreshNativePersonas?.().catch(() => {});
    registerControlModule();
    app = ui.createApp({ version: VERSION, adapter, storage, actions: {}, report, getState: () => ({ state, target: activeTarget(), current: resolved() }) });
    const actions = {
      open,
      close: () => { editMode = false; app?.close(); adapter.setNativeTakeover(false); adapter.setNativeEditMode(false); },
      refresh,
      async setTab(tab) { state.ui.tab = tab; await save(); },
      async setEditingPersona(id) {
        state.ui = { ...(state.ui || {}), tab: 'editor', editingPersonaId: String(id || '') };
        await save();
      },
      async startNewPersona() {
        state.ui = { ...(state.ui || {}), tab: 'create', editingPersonaId: '' };
        await save();
      },
      async setGallerySheet(sheet) { state.ui.gallerySheet = sheet === 'cards' ? 'cards' : 'avatars'; await save(); },
      async selectGalleryAsset(id) { state.ui.selectedAssetId = String(id || ''); await save(); },
      async setLibraryGroup(groupId) {
        const wanted = String(groupId || 'all');
        const known = wanted === 'all' || wanted === '__uncategorized__' || state.personaGroups.some(group => String(group?.id || '') === wanted);
        state.ui.libraryGroup = known ? wanted : 'all';
        await save();
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
        const snapshot = await adapter.contextSnapshot();
        const source = assistantContext(input, snapshot);
        const thread = activeAssistantThread(target);
        const result = await ai.generateDirections({ input, target, state, context: source, history: thread.turns, thread, mode: 'propose' });
        appendAssistantTurn(thread, input?.request || '', result);
        if (result?.draft) state.drafts = [result.draft, ...state.drafts].slice(0, 20);
        await save();
        return result;
      },
      async assistantChat(input = {}) {
        const target = activeTarget();
        const snapshot = await adapter.contextSnapshot();
        const source = assistantContext(input, snapshot);
        const thread = activeAssistantThread(target);
        const fn = ai.continueChat || ai.chat || ai.generateChat;
        if (typeof fn !== 'function') throw new Error('当前版本尚未加载小助手对话接口，请刷新酒馆后重试。');
        const result = await fn({ input, target, state, context: source, history: thread.turns, thread, mode: 'chat' });
        appendAssistantTurn(thread, input?.request || '', result);
        await save();
        return result;
      },
      async clearAssistantThread() {
        const thread = activeAssistantThread(activeTarget());
        thread.turns = [];
        thread.updatedAt = Date.now();
        await save();
        return thread;
      },
      async newAssistantThread() {
        const target = activeTarget();
        const key = assistantThreadKey(target) + '|new_' + Date.now().toString(36);
        state.assistantActiveThreadKey = key;
        state.assistantActiveThreadChangedAt = Date.now();
        state.assistantThreads[key] = { id: key, createdAt: Date.now(), updatedAt: Date.now(), turns: [] };
        await save();
        return state.assistantThreads[key];
      },
      async reviseDraft(draftId, instruction) {
        const draft = state.drafts.find(item => item.id === draftId);
        if (!draft) return;
        const target = activeTarget();
        const thread = activeAssistantThread(target);
        const snapshot = await adapter.contextSnapshot();
        const source = assistantContext({ includeCard: true }, snapshot);
        const result = await ai.reviseDraft({ draft, instruction, target, state, context: source, history: thread.turns, thread, mode: 'revision' });
        appendAssistantTurn(thread, instruction, result);
        if (result?.draft) { state.drafts = [result.draft, ...state.drafts.filter(item => item.id !== draftId)].slice(0, 20); await save(); }
        return result;
      },
      async saveCandidate(draftId, candidate) {
        const draft = state.drafts.find(item => item.id === draftId);
        if (draft) { draft.acceptedCandidateId = candidate.id; draft.status = 'accepted'; }
        await save();
        await actions.openNativeCreate();
        report('候选已保留。酒馆原生新建窗口已打开，请把候选正文放入原生描述框；这样人设仍由酒馆管理，不会产生第二份副本。', 'info');
      },
      state: () => state,
    };
    app.options.actions = actions;
    // Do not auto-save a gallery migration during startup.  Older versions
    // could reach this branch with a stale full settings snapshot and overwrite
    // a phone's newly-created persona before the user touched the extension.
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
      if (changed) await adapter.saveExtensionState(state);
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
