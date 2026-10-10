/*
 * 砚台 · 人设馆 0.2
 * A native SillyTavern persona workspace. Native personas, descriptions and
 * locks are read from ST; this extension adds an organiser, gallery and AI
 * helper around the existing panel.
 */
(async () => {
  'use strict';

  const VERSION = '0.2.2-dev16';
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
          editMode = false;
          app?.close();
          adapter?.setNativeTakeover?.(false);
          adapter?.setNativeEditMode?.(false);
        } else {
          await adapter?.installEntry?.();
        }
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
    adapter?.dispose?.();
    app?.dispose?.();
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
    return { version: 3, enabled: true, personaMeta: {}, drafts: [], gallery: [], assistantThreads: {}, assistantActiveThreadKey: '', ui: { tab: 'current', gallerySheet: 'avatars', selectedAssetId: '', editingPersonaId: '' } };
  }
  async function loadState() {
    const saved = await adapter.loadExtensionState(defaultState());
    state = adapter.normalizeState({ ...defaultState(), ...saved });
    // Blob URLs are session-scoped. Rehydrate gallery entries from IndexedDB
    // so imported images remain visible after a reload or device reconnect.
    const persisted = await storage.listAssets().catch(() => []);
    state.gallery = storage.mergeGallery(state.gallery, persisted.map(item => ({ ...item, blob: undefined })));
    state.gallery = await storage.hydrateGallery(state.gallery);
    return state;
  }
  function activeTarget() {
    const ctx = adapter.context();
    return { chatId: adapter.chatKey(ctx), cardKey: adapter.cardFingerprint(ctx), character: adapter.currentCharacter(ctx), chatTitle: adapter.chatTitle(ctx) };
  }
  function assistantIdentity() {
    const ctx = adapter.context() || {};
    const user = ctx.user || ctx.currentUser || ctx.userProfile || {};
    return String(ctx.userId ?? ctx.user_id ?? user.id ?? ctx.userName ?? ctx.user_name ?? user.name ?? user.username ?? 'local-session');
  }
  function assistantThreadKey(target = activeTarget()) {
    return [assistantIdentity(), target.cardKey || 'no-card', target.chatId || 'no-chat', state?.sessionOverride || ''].map(value => String(value).replace(/[|\s]+/g, '_')).join('|');
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
      assistant: answer.slice(0, 1000),
      memory: memory.slice(0, 1000),
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
  async function save() { await adapter.saveExtensionState(state); await refresh(); }

  async function open({ ensureNative = true, tab = 'current' } = {}) {
    if (!initialized) await initialize();
    if (state.enabled === false) {
      report('人设馆已关闭。可在「砚台总库」的模块开关中重新启用。', 'info');
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
      async addGalleryAssets(files, kind = null) { const added = await storage.importFiles(files, { kind }); state.gallery = storage.mergeGallery(state.gallery, added); await save(); return added; },
      async removeGalleryAsset(id) { state.gallery = state.gallery.filter(item => item.id !== id); storage.releasePreview?.(id); await storage.remove(id); await save(); },
      async uploadGalleryAvatar(id, targetPersonaId = '') {
        const asset = await storage.getAsset(id);
        if (!asset?.blob) throw new Error('找不到这张图片的本地文件，请重新导入。');
        const currentPersona = adapter.readNativePersona();
        const overwriteName = String(targetPersonaId || currentPersona?.id || '');
        const result = await adapter.uploadNativeAvatar(asset.blob, { resizePrompt: true, overwriteName, createPersona: !overwriteName });
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
    adapter.on('CHAT_CHANGED', refresh);
    adapter.on('CHARACTER_CHANGED', refresh);
    adapter.on('PERSONA_CHANGED', refresh);
    adapter.on('PERSONA_UPDATED', refresh);
    adapter.on('PERSONA_CREATED', refresh);
    adapter.on('PERSONA_RENAMED', refresh);
    adapter.on('PERSONA_DELETED', refresh);
    await adapter.installEntry();
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
            await adapter.installEntry();
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
          element.matches?.('#PersonaManagement, #persona-management-button, #persona-management-block, #extensionsMenu')
          || element.querySelector?.('#PersonaManagement, #persona-management-button, #persona-management-block, #extensionsMenu'),
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
