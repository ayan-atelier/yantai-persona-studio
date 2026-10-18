const TABS = {
  current: { label: '当前', icon: 'fa-house' },
  library: { label: '人设档案', icon: 'fa-address-card' },
  create: { label: '新建', icon: 'fa-user-plus' },
  editor: { label: '编辑', icon: 'fa-pen-to-square' },
  // Keep the navigation label task-oriented. Milo's name is shown once the
  // assistant page is open, so the tab remains clear to first-time users.
  assistant: { label: '人设助手', icon: 'fa-wand-magic-sparkles' },
};
const UNCATEGORIZED_GROUP = '__uncategorized__';
const LOCAL_UI_STORAGE_KEY = 'yantai-persona-studio.ui.v1';
function uiStorage() { try { return globalThis.sessionStorage || globalThis.localStorage; } catch (_) { return null; } }
function readLocalUi() {
  const fallback = { tab: 'current', gallerySheet: 'avatars', selectedAssetId: '', editingPersonaId: '', libraryGroup: 'all' };
  try {
    const raw = uiStorage()?.getItem(LOCAL_UI_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    return { ...fallback, ...(parsed && typeof parsed === 'object' ? parsed : {}) };
  } catch (_) { return fallback; }
}
function writeLocalUi(value) {
  try { uiStorage()?.setItem(LOCAL_UI_STORAGE_KEY, JSON.stringify(value)); } catch (_) { /* private mode or quota */ }
}
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const short = (value, n = 180) => { const s = String(value ?? '').trim(); return s.length > n ? s.slice(0, n) + '…' : s; };
function galleryFileName(url) {
  let raw = String(url || '').trim();
  if (!raw || /^(?:data|blob):/i.test(raw)) return '';
  try {
    const parsed = new URL(raw, globalThis.location?.href || 'http://localhost/');
    const queryFile = parsed.searchParams.get('file');
    if (queryFile) return queryFile;
    raw = parsed.pathname || raw;
  } catch (_) { /* parse the path below */ }
  try { raw = decodeURIComponent(raw); } catch (_) { /* keep the original path */ }
  raw = raw.split(/[?#]/, 1)[0].replace(/\\/g, '/');
  const marker = raw.toLowerCase().lastIndexOf('/user avatars/');
  if (marker >= 0) raw = raw.slice(marker + '/user avatars/'.length);
  return raw.split('/').filter(Boolean).pop() || '';
}
function galleryFallbackUrl(url, type = 'persona') {
  if (!url || /\/thumbnail(?:\?|$)/i.test(String(url))) return '';
  if (type !== 'avatar' && !/\/User(?:%20|\s)Avatars\//i.test(String(url))) return '';
  const file = galleryFileName(url);
  return file ? '/thumbnail?type=' + encodeURIComponent(type) + '&file=' + encodeURIComponent(file) : '';
}

class App {
  constructor(options = {}) {
    this.options = options;
    this.root = null;
    this.host = null;
    this.fileInput = null;
    this.visible = false;
    this.localUi = readLocalUi();
    this.state = { activeTab: 'current', gallerySheet: 'avatars', selectedAssetId: '', editingPersonaId: '', libraryGroup: 'all', personaGroups: [], personaMeta: {}, personas: [], gallery: [], nativeGallery: [], drafts: [], assistantThreads: {}, assistantActiveThreadKey: '', current: {}, target: {}, aiBusy: false, aiSessionFresh: false, query: '', assetQuery: '', aiPrompt: '', includeCard: true, includeWorld: false, includeChat: false, editorDraft: null, recentCreatedPersona: null };
  }
  setLocalUi(patch = {}) {
    this.localUi = { ...this.localUi, ...patch };
    writeLocalUi(this.localUi);
    this.state = { ...this.state, ...this.localUi };
    return this.localUi;
  }
  currentTargetKey(target = this.state.target || {}) {
    const clean = value => String(value ?? '').trim().replace(/[|\s]+/g, '_') || 'none';
    return [clean(target.cardKey || target.cardFingerprint || 'no-card'), clean(target.chatId || target.chatKey || 'no-chat')].join('|');
  }
  threadMatchesCurrentTarget(thread) {
    if (!thread || typeof thread !== 'object') return false;
    const record = thread.target && typeof thread.target === 'object' ? thread.target : thread;
    // The Milo base thread is intentionally portable across role cards and
    // chats. Keep it visible when the user moves between cards on either
    // device; card-scoped legacy threads still use the strict match below.
    if (record.scope === 'global' || record.cardKey === '*' || record.chatId === '*') return true;
    const cards = [record.cardKey, record.cardFingerprint, record.legacyCardKey].map(value => String(value ?? '').trim()).filter(Boolean);
    const target = this.state.target || {};
    const wantedCards = [target.cardKey, target.cardFingerprint, target.legacyCardKey].map(value => String(value ?? '').trim()).filter(Boolean);
    const chat = String(record.chatId || record.chatKey || '').trim();
    const wantedChat = String(target.chatId || target.chatKey || '').trim();
    // A card can briefly identify itself by content fingerprint before its
    // avatar id is available. Keep the same thread visible across that
    // transition while retaining strict chat isolation.
    return Boolean(cards.length && wantedCards.length && chat && wantedChat
      && chat === wantedChat && cards.some(card => wantedCards.includes(card)));
  }
  mount() {
    if (this.root && this.root.isConnected) return this;
    this.host = [...document.querySelectorAll('#persona-management-block')].find(item => item.offsetParent !== null) || document.querySelector('#persona-management-block');
    if (!this.host) return null;
    this.root = document.createElement('section');
    this.root.id = 'yt-persona-native-workspace';
    this.root.setAttribute('aria-label', '砚台人设馆');
    this.host.prepend(this.root);
    this.root.addEventListener('click', event => this.onClick(event));
    this.root.addEventListener('input', event => this.onInput(event));
    this.root.addEventListener('change', event => this.onChange(event));
    this.root.addEventListener('keydown', event => this.onKeyDown(event));
    this.root.addEventListener('error', event => {
      const image = event.target;
      if (image?.tagName !== 'IMG' || image.dataset.ytpsFallbackTried !== undefined) return;
      const fallback = image.dataset.fallbackSrc;
      if (!fallback || image.src === fallback) return;
      image.dataset.ytpsFallbackTried = '1';
      image.src = fallback;
    }, true);
    this.root.addEventListener('dragover', event => { const z = event.target.closest('.ytps-dropzone'); if (z) { event.preventDefault(); z.classList.add('is-dragging'); } });
    this.root.addEventListener('dragleave', event => event.target.closest('.ytps-dropzone')?.classList.remove('is-dragging'));
    this.root.addEventListener('drop', event => { const z = event.target.closest('.ytps-dropzone'); if (!z) return; event.preventDefault(); z.classList.remove('is-dragging'); this.importFiles(event.dataTransfer.files); });
    return this;
  }
  open() { if (!this.mount()) return null; this.visible = true; this.render(); return this; }
  close() { this.visible = false; if (this.root && !this.root.hidden) this.root.hidden = true; return this; }
  dispose() {
    this.fileInput?.remove?.();
    this.root?.remove?.();
    this.fileInput = null;
    this.visible = false;
    this.root = null;
    this.host = null;
    return this;
  }
  update(data = {}) {
    const s = data.state || {};
    const local = this.localUi || readLocalUi();
    this.localUi = local;
    const personas = data.personas || [];
    const editingPersonaId = local.editingPersonaId && personas.length && !personas.some(item => String(item?.id || '') === String(local.editingPersonaId)) ? '' : local.editingPersonaId;
    if (editingPersonaId !== local.editingPersonaId) this.setLocalUi({ editingPersonaId });
    this.state = {
      ...this.state, ...data, ...s,
      activeTab: local.tab || 'current',
      gallerySheet: local.gallerySheet === 'cards' ? 'cards' : 'avatars',
      selectedAssetId: local.selectedAssetId || '',
      editingPersonaId,
      libraryGroup: local.libraryGroup || 'all',
      personaGroups: Array.isArray(s.personaGroups || data.personaGroups) ? (s.personaGroups || data.personaGroups) : this.state.personaGroups || [],
      personaMeta: s.personaMeta || data.personaMeta || this.state.personaMeta || {},
      personas,
      gallery: s.gallery || [],
      nativeGallery: data.nativeGallery || [],
      drafts: s.drafts || [],
      assistantThreads: s.assistantThreads || data.assistantThreads || this.state.assistantThreads || {},
      assistantActiveThreadKey: s.assistantActiveThreadKey || data.assistantActiveThreadKey || this.state.assistantActiveThreadKey || '',
      current: data.current || s.current || {},
      target: data.target || s.target || {},
    };
    if (!this.state.suggestions?.length && !this.state.aiSessionFresh) this.state.suggestions = this.state.drafts[0]?.candidates || [];
    if (this.root) this.render();
    return this;
  }
  call(name, ...args) { const fn = this.options.actions?.[name]; if (typeof fn !== 'function') return Promise.resolve(); try { return Promise.resolve(fn(...args)); } catch (error) { this.options.report?.(error.message || String(error), 'error'); return Promise.reject(error); } }
  sourceLabel(scope) { return ({ session: '未绑定', chat: '当前存档', card: '当前角色卡', global: '当前默认', none: '未绑定' }[scope] || '未绑定'); }
  render() {
    if (!this.root) return;
    const tab = this.state.activeTab || 'current';
    // The host already provides the surrounding persona-management title.
    // Keep this takeover focused on the four working tabs instead of adding a
    // second branded header and a low-discoverability collapse arrow.
    this.root.innerHTML = '<nav class=\"ytps-tabs\">' + Object.keys(TABS).map(key => '<button class=\"ytps-tab ' + (tab === key ? 'is-active' : '') + '\" data-action=\"tab\" data-tab=\"' + key + '\"><i class=\"fa-solid ' + TABS[key].icon + '\"></i><span>' + TABS[key].label + '</span></button>').join('') + '</nav>' +
      '<div class=\"ytps-body\">' + this.view() + '</div>';
    if (this.root.hidden !== !this.visible) this.root.hidden = !this.visible;
    if (tab === 'assistant') {
      requestAnimationFrame(() => {
        const history = this.root?.querySelector('.ytps-ai-history');
        if (history) history.scrollTop = history.scrollHeight;
      });
    }
  }
  view() { return this.state.activeTab === 'library' ? this.library() : (this.state.activeTab === 'editor' || this.state.activeTab === 'create') ? this.editor() : this.state.activeTab === 'gallery' ? this.gallery() : this.state.activeTab === 'assistant' ? this.assistant() : this.current(); }
  current() {
    const p = this.state.current?.persona || this.state.native || {};
    const name = p.name || '尚未选择人设';
    const desc = p.description || '暂无描述';
    const rows = [['global', '默认'], ['card', '当前角色卡'], ['chat', '当前存档']];
    return '<div class="ytps-current"><div class="ytps-current-avatar">' + (p.avatarRef ? '<img src="' + esc(p.avatarRef) + '" alt="">' : '<i class="fa-solid fa-user"></i>') + '<span class="ytps-image-fade"></span></div><div class="ytps-current-copy"><div class="ytps-kicker">当前生效 · ' + esc(this.sourceLabel(this.state.current?.scope)) + '</div><h2>' + esc(name) + '</h2><p>' + esc(short(desc, 260)) + '</p></div></div>' +
      '<div class="ytps-section-title"><strong>绑定到：</strong></div>' +
      '<div class="ytps-binding-grid" role="group" aria-label="绑定到">' + rows.map(([scope, label]) => { const active = this.state.current?.scope === scope; return '<button class="ytps-choice ' + (active ? 'is-active' : '') + '" data-action="bind-current" data-scope="' + scope + '" data-mode="' + (active ? 'none' : 'bind') + '" aria-pressed="' + active + '" title="' + (active ? '再次点击解除绑定' : '绑定到' + label) + '">' + label + (active ? ' <i class="fa-solid fa-link" aria-hidden="true"></i>' : '') + '</button>'; }).join('') + '</div>';
  }
  personaGroups() {
    const groups = Array.isArray(this.state.personaGroups) ? this.state.personaGroups : [];
    return [{ id: UNCATEGORIZED_GROUP, name: '默认' }, ...groups.filter(group => String(group?.id || '') && String(group.id) !== UNCATEGORIZED_GROUP).map(group => ({ id: String(group.id), name: String(group.name || '未命名分组') }))];
  }
  personaGroupId(persona) {
    const id = String(persona?.id || '');
    const wanted = this.state.personaMeta?.[id]?.groupId;
    return this.personaGroups().some(group => String(group.id) === String(wanted)) ? String(wanted) : UNCATEGORIZED_GROUP;
  }
  personaGroupName(persona) { return this.personaGroups().find(group => String(group.id) === this.personaGroupId(persona))?.name || '默认'; }
  library() {
    const q = String(this.state.query || '').toLowerCase();
    const groups = this.personaGroups();
    const requestedGroup = String(this.state.libraryGroup || 'all');
    const selectedGroup = requestedGroup === 'all' || groups.some(group => String(group.id) === requestedGroup) ? requestedGroup : 'all';
    const groupOptions = '<option value="all" ' + (selectedGroup === 'all' ? 'selected' : '') + '>全部</option>' + groups.map(group => '<option value="' + esc(group.id) + '" ' + (selectedGroup === String(group.id) ? 'selected' : '') + '>' + esc(group.name) + '</option>').join('');
    const selectedCustomGroup = selectedGroup !== 'all' && selectedGroup !== UNCATEGORIZED_GROUP ? groups.find(group => String(group.id) === selectedGroup) : null;
    const groupManage = selectedCustomGroup ? '<span class="ytps-group-manage" role="group" aria-label="管理分组"><button class="ytps-icon-btn ytps-group-manage-btn" data-action="rename-persona-group" data-id="' + esc(selectedCustomGroup.id) + '" title="重命名分组" aria-label="重命名分组"><i class="fa-solid fa-pen"></i></button><button class="ytps-icon-btn ytps-group-manage-btn ytps-danger" data-action="delete-persona-group" data-id="' + esc(selectedCustomGroup.id) + '" title="删除分组" aria-label="删除分组"><i class="fa-solid fa-trash"></i></button></span>' : '';
    // SillyTavern keeps native persona entries in insertion order, so the
    // oldest persona is first and the newest is last. Reverse the filtered
    // result so recent personas are immediately visible at the top.
    const list = this.state.personas.filter(p => (!q || (p.name + ' ' + p.title + ' ' + p.description).toLowerCase().includes(q)) && (selectedGroup === 'all' || this.personaGroupId(p) === selectedGroup)).slice().reverse();
    return '<div class="ytps-toolbar"><input class="ytps-input" data-field="query" value="' + esc(this.state.query || '') + '" placeholder="搜索人设档案…"><select class="ytps-input ytps-library-group" data-field="libraryGroup" aria-label="筛选人设分组">' + groupOptions + '</select>' + groupManage + '<span class="ytps-count">' + list.length + ' / ' + this.state.personas.length + '</span><button class="ytps-btn ytps-group-create" data-action="create-persona-group"><i class="fa-solid fa-folder-plus"></i> 新建分组</button></div>' + (list.length ? '<div class="ytps-persona-list">' + list.map(p => this.personaRow(p)).join('') + '</div>' : '<div class="ytps-empty">这个分组里还没有人设。</div>');
  }
  personaBindingLabel(p) {
    const bindings = this.state.bindings || {};
    if (bindings.global && String(bindings.global) === String(p.id)) return '当前默认';
    if (bindings.chat && String(bindings.chat) === String(p.id)) return '当前存档：' + String(this.state.target?.chatTitle || '当前存档');
    if (bindings.card && String(bindings.card) === String(p.id)) {
      const character = this.state.target?.character?.data || this.state.target?.character || {};
      return '当前角色卡：' + String(character.name || '当前角色卡');
    }
    const connections = Array.isArray(p.connections || p.raw?.connections) ? (p.connections || p.raw.connections) : [];
    if (connections.length) {
      const cards = this.state.nativeGallery || [];
      const names = connections.map(item => {
        const id = String(item?.id || '');
        const card = cards.find(entry => String(entry.avatarId || '') === id || String(entry.id || '') === 'native-card-' + id);
        return card?.name || '';
      }).filter(Boolean);
      if (names.length) return '已绑定：' + names.join('、');
      const currentCharacter = this.state.target?.character?.data || this.state.target?.character || {};
      const currentId = this.state.target?.character?.avatar || currentCharacter.avatar || '';
      const current = connections.find(item => item?.type === 'character' && String(item.id || '') === String(currentId));
      if (current) return '角色卡：' + String(currentCharacter.name || '当前角色卡');
      return '已绑定角色卡 ' + connections.length + ' 个';
    }
    if (p.isCurrent) return '当前使用 · 未单独绑定';
    return '未绑定';
  }
  personaRow(p) {
    const binding = this.personaBindingLabel(p);
    const note = p.title || '原生人设';
    const groupOptions = this.personaGroups().map(group => '<option value="' + esc(group.id) + '" ' + (this.personaGroupId(p) === String(group.id) ? 'selected' : '') + '>' + esc(group.name) + '</option>').join('');
    const useAction = p.isCurrent
      ? '<span class="ytps-current-state" role="status" title="当前正在使用的人设">当前</span>'
      : '<button class="ytps-btn ytps-primary" data-action="use" data-id="' + esc(p.id) + '">设为当前</button>';
    return '<article class="ytps-persona-row ' + (p.isCurrent ? 'is-current' : '') + '"><div class="ytps-row-avatar">' + (p.avatarRef ? '<img src="' + esc(p.avatarRef) + '" alt="">' : '<i class="fa-solid fa-user"></i>') + '<span class="ytps-image-fade"></span></div><div class="ytps-row-main"><div class="ytps-row-title"><strong>' + esc(p.name) + '</strong><span class="ytps-binding-inline">（' + esc(binding) + '）</span>' + (p.isDefault ? '<span class="ytps-chip">默认</span>' : '') + '</div><div class="ytps-row-meta"><small>' + esc(note) + '</small><div class="ytps-row-primary">' + useAction + '</div></div><p>' + esc(short(p.description || '暂无描述', 155)) + '</p></div><div class="ytps-row-actions"><label class="ytps-persona-group"><select data-field="personaGroup" data-id="' + esc(p.id) + '" aria-label="移动' + esc(p.name) + '到分组">' + groupOptions + '</select></label><div class="ytps-row-tools"><button class="ytps-icon-btn" data-action="edit-persona" data-id="' + esc(p.id) + '" title="编辑人设"><i class="fa-solid fa-pen"></i></button><button class="ytps-icon-btn" data-action="copy-persona" data-id="' + esc(p.id) + '" title="复制人设"><i class="fa-solid fa-copy"></i></button><button class="ytps-icon-btn ytps-danger" data-action="delete-persona" data-id="' + esc(p.id) + '" title="删除人设"><i class="fa-solid fa-trash"></i></button></div></div></article>';
  }
  editorPersona() {
    if (this.state.activeTab === 'create' || this.state.creatingPersona) return {};
    const wanted = String(this.state.editingPersonaId || this.state.current?.persona?.id || '');
    return this.state.personas.find(item => String(item.id) === wanted) || this.state.current?.persona || {};
  }
  personaScope(id) {
    const wanted = String(id || '');
    if (String(this.state.current?.persona?.id || '') === wanted && this.state.current?.scope && this.state.current.scope !== 'none') return this.state.current.scope;
    const bindings = this.state.bindings || {};
    for (const scope of ['chat', 'card', 'global']) if (String(bindings[scope] || '') === wanted) return scope;
    return 'none';
  }
  editor() {
    const creating = this.state.activeTab === 'create' || this.state.creatingPersona === true;
    const persona = creating ? {} : this.editorPersona();
    const id = String(persona.id || '');
    const existing = this.state.editorDraft && String(this.state.editorDraft.id || '') === id ? this.state.editorDraft : null;
    const draft = existing || { id, name: persona.name || '', note: persona.title || '', description: persona.description || '', lorebook: persona.lorebook || '' };
    if (!existing && (id || creating)) this.state.editorDraft = draft;
    const avatar = persona.avatarRef || '';
    const image = avatar ? '<img src="' + esc(avatar) + '" alt="' + esc(draft.name || '人设头像') + '"><span class="ytps-image-fade"></span>' : '<i class="fa-solid fa-user"></i><span class="ytps-image-fade"></span>';
    if (creating) {
      const createButton = '<button class="ytps-btn ytps-primary ytps-editor-save" data-action="save-new-persona"><i class="fa-solid fa-check"></i> 创建人设</button>';
      const recent = this.state.recentCreatedPersona;
      const recentBar = recent?.id ? '<div class="ytps-create-result" role="status"><span><i class="fa-solid fa-circle-check"></i> 已创建“' + esc(recent.name || '未命名人设') + '”</span><div class="ytps-create-result-actions"><button class="ytps-btn ytps-primary" data-action="edit-persona" data-id="' + esc(recent.id) + '">立即编辑</button><button class="ytps-btn" data-action="continue-new-persona">继续新建</button></div></div>' : '';
      return '<div class="ytps-editor"><div class="ytps-editor-head"><div><span class="ytps-kicker">人设馆</span><h2>新建人设</h2><p class="ytps-muted">填写后点击“创建人设”保存。</p></div></div>' + recentBar + '<div class="ytps-editor-fields ytps-create-fields"><label class="ytps-field ytps-name-field"><span class="ytps-name-label"><b>名称</b>' + createButton + '</span><input class="ytps-input" data-field="editorName" value="' + esc(draft.name) + '" placeholder="人设名称"></label><label class="ytps-field"><span>备注 <small>显示在头像下面</small></span><input class="ytps-input" data-field="editorNote" value="' + esc(draft.note) + '" placeholder="一句简短说明"></label><label class="ytps-field"><span>描述</span><textarea class="ytps-textarea" data-field="editorDescription" placeholder="这份人设会以什么身份进入故事？">' + esc(draft.description) + '</textarea></label><p class="ytps-muted">保存后可通过“立即编辑”更换头像、设置世界书与归属。</p></div></div>';
    }
    const currentScope = this.personaScope(id);
    const scopeButton = (scope, label) => '<button class="ytps-choice ' + (currentScope === scope ? 'is-active' : '') + '" data-action="editor-bind" data-scope="' + scope + '" data-id="' + esc(id) + '">' + label + '</button>';
    const lorebookField = '<div class="ytps-field ytps-lorebook-field"><span>绑定人设世界书 <small>可留空</small></span><div class="ytps-lorebook-picker"><input class="ytps-input" data-field="editorLorebook" value="' + esc(draft.lorebook) + '" placeholder="未选择" readonly><button class="ytps-btn" data-action="choose-lorebook" data-id="' + esc(id) + '" type="button"><i class="fa-solid fa-book-open"></i> 选择</button></div></div>';
    const saveButton = '<button class="ytps-btn ytps-primary ytps-editor-save" data-action="save-editor" data-id="' + esc(id) + '"><i class="fa-solid fa-check"></i> 保存修改</button>';
    const nativeEditButton = '<button class="ytps-btn ytps-quiet ytps-editor-native" data-action="open-native-edit" data-id="' + esc(id) + '"><i class="fa-solid fa-sliders"></i> 原生编辑</button>';
    return '<div class="ytps-editor"><div class="ytps-editor-layout"><button class="ytps-editor-avatar" data-action="editor-avatar-gallery" title="点击打开人设头像图库">' + image + '<span class="ytps-editor-avatar-hint"><i class="fa-solid fa-images"></i> 更换头像</span></button><div class="ytps-editor-fields"><label class="ytps-field ytps-name-field"><span class="ytps-name-label"><b>名称</b>' + saveButton + '</span><input class="ytps-input" data-field="editorName" value="' + esc(draft.name) + '" placeholder="人设名称"></label><label class="ytps-field"><span>备注 <small>显示在头像下面</small></span><input class="ytps-input" data-field="editorNote" value="' + esc(draft.note) + '" placeholder="一句简短说明"></label><label class="ytps-field"><span>描述</span><textarea class="ytps-textarea" data-field="editorDescription" placeholder="这份人设会以什么身份进入故事？">' + esc(draft.description) + '</textarea>' + lorebookField + '</div></div><section class="ytps-editor-section"><div class="ytps-section-title"><strong>常用归属</strong><span>选择后会沿用酒馆原生绑定</span>' + nativeEditButton + '</div><div class="ytps-choice-grid"><button class="ytps-choice ' + (currentScope === 'none' ? 'is-active' : '') + '" data-action="editor-unbind" data-id="' + esc(id) + '">未绑定</button>' + scopeButton('global', '默认') + scopeButton('card', '当前角色卡') + scopeButton('chat', '当前存档') + '</div></section><div class="ytps-editor-footer"><button class="ytps-btn ytps-quiet" data-action="export-persona" data-id="' + esc(id) + '"><i class="fa-solid fa-file-export"></i> 导出</button></div></div>';
  }
  gallery() {
    const sheet = this.state.gallerySheet === 'cards' ? 'cards' : 'avatars';
    const custom = this.state.gallery || [];
    const all = sheet === 'cards' ? [...(this.state.nativeGallery || []), ...custom.filter(a => a.kind === 'card')] : custom.filter(a => a.kind !== 'card');
    const q = String(this.state.assetQuery || '').toLowerCase();
    const list = all.filter(a => !q || String(a.name).toLowerCase().includes(q));
    const selected = list.find(a => String(a.id) === String(this.state.selectedAssetId || ''));
    const sheetTabs = '<div class="ytps-gallery-tabs" role="tablist"><button class="ytps-gallery-tab ' + (sheet === 'avatars' ? 'is-active' : '') + '" data-action="gallery-sheet" data-sheet="avatars" role="tab" aria-selected="' + (sheet === 'avatars') + '"><i class="fa-solid fa-user"></i><span>人设头像</span><small>上传、选择、裁切</small></button><button class="ytps-gallery-tab ' + (sheet === 'cards' ? 'is-active' : '') + '" data-action="gallery-sheet" data-sheet="cards" role="tab" aria-selected="' + (sheet === 'cards') + '"><i class="fa-solid fa-address-card"></i><span>角色卡图库</span><small>为书架联动预留</small></button></div>';
    const uploadLabel = sheet === 'avatars' ? '从相册导入素材' : '导入角色卡文件';
    const empty = sheet === 'avatars' ? '还没有头像素材。导入后会保存在图库，不会自动新建人设。' : '还没有角色卡素材；当前酒馆角色卡会自动汇总到这里。';
    const galleryTargetId = String(this.state.editingPersonaId || '');
    const selectedBar = selected && sheet === 'avatars' ? '<div class="ytps-gallery-selection"><span><i class="fa-solid fa-check"></i> 已选：' + esc(selected.name || '这张图片') + '</span>' + (galleryTargetId
      ? '<button class="ytps-btn ytps-primary" data-action="upload-gallery-avatar" data-id="' + esc(selected.id) + '"><i class="fa-solid fa-crop-simple"></i> 裁切并应用到当前人设</button>'
      : '<small class="ytps-muted">请从已有的人设编辑页进入图库，再应用这张图片；导入素材不会创建人设。</small>') + '</div>' : '';
    return '<div class="ytps-gallery-back"><button class="ytps-btn ytps-quiet" data-action="gallery-back-editor"><i class="fa-solid fa-arrow-left"></i> 返回新建 / 编辑</button></div>' + sheetTabs + '<div class="ytps-toolbar"><input class="ytps-input" data-field="assetQuery" value="' + esc(this.state.assetQuery || '') + '" placeholder="搜索' + (sheet === 'avatars' ? '头像' : '角色卡') + '…"><button class="ytps-btn ytps-primary" data-action="import-assets"><i class="fa-solid fa-' + (sheet === 'avatars' ? 'images' : 'upload') + '"></i> ' + uploadLabel + '</button><span class="ytps-count">' + list.length + ' 项</span></div><div class="ytps-gallery-help"><i class="fa-solid fa-circle-info"></i><span>' + (sheet === 'avatars' ? '点击图片即可选中；右上角可查看原图。图片只会进入图库，不会自动创建人设；应用时仍会走酒馆原生裁切。' : '角色卡图片单独放置，后续可与砚台书架的封面管理联动。') + '</span></div>' + selectedBar + '<div class="ytps-dropzone" data-action="import-assets"><i class="fa-solid fa-cloud-arrow-up"></i><span>拖入' + (sheet === 'avatars' ? '头像图片' : 'PNG 角色卡或 JSON') + '</span></div>' + (list.length ? '<div class="ytps-gallery-grid ' + (sheet === 'cards' ? 'is-card-sheet' : 'is-avatar-sheet') + '">' + list.map(a => this.assetCard(a)).join('') + '</div>' : '<div class="ytps-empty">' + empty + '</div>');
  }
  async importFiles(files) {
    if (!files?.length) return;
    const added = await this.call('addGalleryAssets', files, this.state.gallerySheet === 'cards' ? 'card' : 'avatar');
    // Browsers do not fire change when the user chooses the same file twice.
    if (this.fileInput) this.fileInput.value = '';
    const first = Array.isArray(added) ? added[0] : null;
    if (first?.id) {
      this.state.selectedAssetId = first.id;
      this.render();
      await this.call('selectGalleryAsset', first.id);
    }
  }
  previewAsset(url, name = '图库预览', fallback = '') {
    if (!url || !this.root) return;
    this.root.querySelector('.ytps-lightbox')?.remove?.();
    const box = document.createElement('div');
    box.className = 'ytps-lightbox';
    box.innerHTML = '<button class="ytps-lightbox-close" data-action="lightbox-close" title="关闭"><i class="fa-solid fa-xmark"></i></button><figure><img src="' + esc(url) + '"' + (fallback ? ' data-fallback-src="' + esc(fallback) + '"' : '') + ' alt=""><figcaption>' + esc(name) + '</figcaption></figure>';
    this.root.appendChild(box);
  }
  assetCard(a) {
    const selected = this.state.selectedAssetId && String(this.state.selectedAssetId) === String(a.id);
    const isNative = a.source === 'native';
    const fallback = galleryFallbackUrl(a.url, isNative ? 'avatar' : 'persona');
    const preview = a.url ? '<button class="ytps-asset-preview" data-action="preview-asset" data-url="' + esc(a.url) + '" data-fallback="' + esc(fallback) + '" data-name="' + esc(a.name || '') + '" title="查看原图"><i class="fa-solid fa-expand"></i></button>' : '';
    const image = a.url ? '<img src="' + esc(a.url) + '"' + (fallback ? ' data-fallback-src="' + esc(fallback) + '"' : '') + ' alt="">' : '<i class="fa-solid ' + (a.kind === 'card' ? 'fa-address-card' : 'fa-image') + '"></i>';
    return '<article class="ytps-asset ' + (selected ? 'is-selected' : '') + ' ' + (isNative ? 'is-native' : '') + '"><button class="ytps-asset-select" data-action="select-asset" data-id="' + esc(a.id) + '" title="' + (isNative ? '选择此图' : '选用此图') + '">' + (selected ? '<i class="fa-solid fa-check"></i>' : '<i class="fa-solid fa-' + (isNative ? 'eye' : 'check') + '"></i>') + '</button>' + preview + '<div class="ytps-asset-thumb" data-action="select-asset" data-id="' + esc(a.id) + '" title="点击选择这张图">' + image + '</div><div class="ytps-asset-meta"><b>' + esc(a.name) + '</b><small>' + (isNative ? '酒馆角色卡' : a.kind === 'card' ? '角色卡文件' : '头像素材') + '</small></div>' + (!isNative ? '<button class="ytps-remove" data-action="remove-asset" data-id="' + esc(a.id) + '" title="移除素材"><i class="fa-solid fa-xmark"></i></button>' : '') + '</article>';
  }
  assistantTurns() {
    const threads = this.state.assistantThreads && typeof this.state.assistantThreads === 'object' ? this.state.assistantThreads : {};
    const active = threads[this.state.assistantActiveThreadKey];
    // Never fall back to the newest thread. A newest thread can belong to a
    // different card/chat and made the mobile page appear to switch personas.
    if (!active || !this.threadMatchesCurrentTarget(active)) return [];
    return Array.isArray(active.turns) ? active.turns : [];
  }
  assistantRound(turn, index, proposal = '') {
    const user = String(turn?.user || '').trim();
    const answer = String(turn?.assistant || turn?.reply || turn?.summary || '').trim();
    // Replies and reusable persona bodies are kept as separate fields. This
    // prevents the conversational bubble from growing into a wall of text,
    // while still leaving each candidate fully visible and copyable.
    const storedProposal = Array.isArray(turn?.proposals) && turn.proposals.length ? this.assistantProposalText(turn.proposals) : proposal;
    const shownAnswer = [answer, storedProposal].filter(Boolean).join('\n\n').trim();
    if (!user && !shownAnswer) return '';
    // A turn is rendered as two ordinary chat bubbles. The API still receives
    // the same paired turn, but the UI no longer exposes internal round
    // numbers or proposal labels.
    return '<article class="ytps-ai-turn">' + (user ? '<div class="ytps-ai-bubble ytps-ai-user"><b>你</b><p>' + esc(short(user, 2400)) + '</p></div>' : '') + (shownAnswer ? '<div class="ytps-ai-bubble ytps-ai-assistant"><b>Milo</b><p>' + esc(shownAnswer) + '</p></div>' : '') + '</article>';
  }
  assistantProposalText(candidates = []) {
    if (!Array.isArray(candidates) || !candidates.length) return '';
    return candidates.slice(0, 2).map((item, index) => {
      const title = String(item?.title || ('方向 ' + (index + 1))).trim();
      const body = String(item?.persona || item?.concept || item?.description || '').trim();
      return '人设 ' + (index + 1) + ' · ' + title + (body ? '\n' + body : '');
    }).filter(Boolean).join('\n\n');
  }
  assistant() {
    const turns = this.assistantTurns();
    const currentTarget = this.currentTargetKey();
    const draft = (this.state.drafts || []).find(item => item?.targetKey && item.targetKey === currentTarget);
    const suggestions = this.state.suggestions?.length ? this.state.suggestions : (draft?.candidates || []);
    const latestAnswer = String(turns[turns.length - 1]?.assistant || '');
    const latestTurn = turns[turns.length - 1];
    const proposal = latestTurn && latestTurn.mode !== 'chat' && !Array.isArray(latestTurn.proposals) && !/人设\s*[12]\s*[·:：]/.test(latestAnswer) ? this.assistantProposalText(suggestions) : '';
    const history = turns.length ? '<div class="ytps-ai-history">' + turns.map((turn, index) => this.assistantRound(turn, index + 1, index === turns.length - 1 ? proposal : '')).join('') + '</div>' : '<div class="ytps-empty ytps-ai-empty">还没有片场对话。写下你想让 User 进入故事的感觉，Milo 会给你两条可以开拍的路。</div>';
    return '<div class="ytps-ai-shell ytps-ai-modern"><section class="ytps-panel ytps-ai-chat-panel"><div class="ytps-panel-title"><i class="fa-solid fa-wand-magic-sparkles"></i><b>Milo</b><span>砚台片场搭档</span><button class="ytps-icon-btn" data-action="assistant-info" title="使用说明"><i class="fa-solid fa-circle-info"></i></button></div><p class="ytps-muted">请和 Milo 描述一下你想要的人设感觉，无论是几个词、一两句描述，还是大段的设定都可以～我会帮你分析生成。</p><div class="ytps-checks ytps-ai-sources"><span class="ytps-ai-sources-label">本轮资料</span><label title="发送当前角色卡摘要，以及当前生效人设的姓名、备注和描述"><input type="checkbox" data-field="includeCard" ' + (this.state.includeCard !== false ? 'checked' : '') + '> 角色卡摘要</label><label title="如果当前酒馆版本提供了活动世界书，就发送截取后的资料"><input type="checkbox" data-field="includeWorld" ' + (this.state.includeWorld === true ? 'checked' : '') + '> 相关世界书</label><label title="发送当前存档最近几条消息的短摘录"><input type="checkbox" data-field="includeChat" ' + (this.state.includeChat === true ? 'checked' : '') + '> 当前存档片段</label></div>' + history + (this.state.aiBusy ? '<div class="ytps-ai-thinking"><span></span><span></span><span></span><em>Milo 正在看剧本…</em></div>' : '') + '<div class="ytps-ai-composer"><textarea class="ytps-textarea ytps-ai-input" data-field="aiPrompt" placeholder="请和 Milo 描述一下你想要的人设感觉……">' + esc(this.state.aiPrompt || '') + '</textarea><div class="ytps-ai-compose-row"><small>Ctrl/⌘ + Enter 发送</small><div class="ytps-ai-quick-actions"><button class="ytps-btn ytps-quiet" data-action="new-assistant">新开一段</button><button class="ytps-btn ytps-quiet" data-action="clear-assistant">清空记录</button></div><button class="ytps-btn ytps-primary ytps-ai-send" data-action="assistant-send" ' + (this.state.aiBusy ? 'disabled' : '') + '><i class="fa-solid fa-paper-plane"></i> 发送</button></div></div></section></div>';
  }
  async onClick(event) {
    const el = event.target.closest('[data-action]'); if (!el || !this.root.contains(el)) return;
    event.preventDefault();
    event.stopPropagation();
    const action = el.dataset.action;
    if (action === 'close') return this.call('close');
    if (action === 'rename-persona-group') {
      const id = String(el.dataset.id || '');
      const group = this.personaGroups().find(item => String(item.id) === id);
      if (!group) return;
      const name = globalThis.prompt?.('重命名分组', group.name);
      if (name === null || name === undefined) return;
      try { await this.call('renamePersonaGroup', id, name); } catch (error) { this.options.report?.(error.message || String(error), 'error'); }
      return;
    }
    if (action === 'delete-persona-group') {
      const id = String(el.dataset.id || '');
      const group = this.personaGroups().find(item => String(item.id) === id);
      if (!group) return;
      const message = '删除分组“' + group.name + '”？其中的人设会移动到“默认”。';
      if (typeof globalThis.confirm === 'function' && !globalThis.confirm(message)) return;
      try { await this.call('deletePersonaGroup', id); } catch (error) { this.options.report?.(error.message || String(error), 'error'); }
      return;
    }
    if (action === 'create-persona-group') {
      const name = globalThis.prompt?.('新建分组', '未命名分组');
      if (!String(name || '').trim()) return;
      try { await this.call('createPersonaGroup', name); } catch (error) { this.options.report?.(error.message || String(error), 'error'); }
      return;
    }
    if (action === 'tab') {
      this.state.activeTab = el.dataset.tab;
      this.setLocalUi({ tab: this.state.activeTab });
      this.state.creatingPersona = this.state.activeTab === 'create';
      if (this.state.creatingPersona) { this.state.editorDraft = { id: '', name: '', note: '', description: '', lorebook: '' }; this.state.recentCreatedPersona = null; }
      this.render();
      if (this.state.creatingPersona) await this.call('startNewPersona'); else await this.call('setTab', el.dataset.tab);
      return;
    }
    if (action === 'gallery-sheet') { this.state.gallerySheet = el.dataset.sheet === 'cards' ? 'cards' : 'avatars'; this.setLocalUi({ gallerySheet: this.state.gallerySheet }); this.state.assetQuery = ''; this.render(); await this.call('setGallerySheet', this.state.gallerySheet); return; }
    if (action === 'import-assets') { if (!this.fileInput) { this.fileInput = document.createElement('input'); this.fileInput.type = 'file'; this.fileInput.multiple = true; this.fileInput.addEventListener('change', () => this.importFiles(this.fileInput.files)); } this.fileInput.accept = this.state.gallerySheet === 'cards' ? 'image/*,.json' : 'image/*'; this.fileInput.click(); return; }
    if (action === 'remove-asset') return this.call('removeGalleryAsset', el.dataset.id);
    if (action === 'select-asset') { this.state.selectedAssetId = el.dataset.id || ''; this.setLocalUi({ selectedAssetId: this.state.selectedAssetId }); this.render(); return this.call('selectGalleryAsset', el.dataset.id); }
    if (action === 'upload-gallery-avatar') {
      try {
        const result = await this.call('uploadGalleryAvatar', el.dataset.id, this.state.editingPersonaId || '');
        if (!result?.cancelled) {
          this.state.selectedAssetId = '';
          this.state.activeTab = 'editor';
          await this.call('setTab', 'editor');
          this.render();
        }
        return result;
      } catch (error) {
        // Remote gallery assets can fail to load (for example after a device
        // switch). Keep the gallery open and surface the actionable error
        // instead of leaving the click handler as an unhandled rejection.
        this.options.report?.(error.message || String(error), 'error');
        return;
      }
    }
    if (action === 'preview-asset') { this.previewAsset(el.dataset.url, el.dataset.name || '图库预览', el.dataset.fallback || ''); return; }
    if (action === 'lightbox-close') { el.closest('.ytps-lightbox')?.remove?.(); return; }
    if (action === 'edit-persona' || action === 'open-editor') {
      this.state.creatingPersona = false;
      this.state.editingPersonaId = el.dataset.id || '';
      this.setLocalUi({ tab: 'editor', editingPersonaId: this.state.editingPersonaId });
      this.state.editorDraft = null;
      this.state.activeTab = 'editor';
      // `setEditingPersona()` persists the shared state and triggers a full
      // refresh. Keep the persisted tab in sync before that refresh or the
      // saved `current` tab immediately overwrites this local editor view.
      this.state.ui = { ...(this.state.ui || {}), tab: 'editor', editingPersonaId: this.state.editingPersonaId };
      this.render();
      try { await this.call('setEditingPersona', this.state.editingPersonaId); } catch (error) { this.options.report?.(error.message || String(error), 'error'); }
      return;
    }
    if (action === 'editor-back') { this.state.activeTab = 'current'; this.setLocalUi({ tab: 'current', editingPersonaId: '' }); this.render(); await this.call('setTab', 'current'); return; }
    if (action === 'new-persona-form') { this.state.activeTab = 'create'; this.setLocalUi({ tab: 'create', editingPersonaId: '' }); this.state.creatingPersona = true; this.state.editorDraft = { id: '', name: '', note: '', description: '', lorebook: '' }; this.state.recentCreatedPersona = null; this.render(); await this.call('startNewPersona'); return; }
    if (action === 'continue-new-persona') { this.state.recentCreatedPersona = null; this.state.editorDraft = { id: '', name: '', note: '', description: '', lorebook: '' }; this.render(); this.root?.querySelector('[data-field="editorName"]')?.focus(); return; }
    if (action === 'editor-avatar-gallery') { this.state.activeTab = 'gallery'; this.setLocalUi({ tab: 'gallery', gallerySheet: 'avatars' }); this.state.gallerySheet = 'avatars'; this.render(); await this.call('setGallerySheet', 'avatars'); await this.call('setTab', 'gallery'); return; }
    if (action === 'gallery-back-editor') { this.state.activeTab = 'editor'; this.setLocalUi({ tab: 'editor' }); this.render(); await this.call('setTab', 'editor'); return; }
    if (action === 'editor-use') { await this.call('usePersona', el.dataset.id); this.state.activeTab = 'editor'; this.render(); return; }
    if (action === 'editor-bind') { await this.call('setBinding', el.dataset.scope, 'bind', el.dataset.id); this.render(); return; }
    if (action === 'editor-unbind') { for (const scope of ['chat', 'card', 'global']) await this.call('setBinding', scope, 'none', null); this.render(); return; }
    if (action === 'choose-lorebook') {
      const id = el.dataset.id || this.editorPersona()?.id;
      const result = await this.call('choosePersonaLorebook', id);
      if (result && !result.cancelled) {
        const persona = this.editorPersona();
        const draft = this.state.editorDraft || { id: persona.id || id };
        draft.lorebook = String(result.lorebook || '');
        this.state.editorDraft = draft;
        this.render();
      }
      return;
    }
    if (action === 'save-editor') {
      const draft = this.state.editorDraft;
      if (!draft || !el.dataset.id) return;
      try { await this.call('updatePersona', el.dataset.id, { name: draft.name, note: draft.note, description: draft.description, lorebook: draft.lorebook }); this.options.report?.('人设资料已保存。', 'success'); this.state.editorDraft = null; this.render(); } catch (error) { this.options.report?.(error.message || String(error), 'error'); }
      return;
    }
    if (action === 'save-new-persona') {
      const draft = this.state.editorDraft || {};
      if (!String(draft.name || '').trim()) { this.options.report?.('请先填写人设名称。', 'info'); return; }
      try {
        const created = await this.call('createPersona', { name: draft.name, title: draft.note, description: draft.description });
        if (!created?.id) throw new Error('酒馆没有返回新建人设的编号，请检查人设档案。');
        this.state.creatingPersona = true;
        this.state.activeTab = 'create';
        this.state.editorDraft = { id: '', name: '', note: '', description: '', lorebook: '' };
        this.state.recentCreatedPersona = { id: created.id, name: created.name || String(draft.name).trim() };
        this.render();
        this.options.report?.('人设已创建，并已加入人设档案。', 'success');
      } catch (error) { this.options.report?.(error.message || String(error), 'error'); }
      return;
    }
    if (action === 'export-persona') {
      const p = this.state.personas.find(item => String(item.id) === String(el.dataset.id)) || this.editorPersona();
      const payload = { version: 1, exportedAt: new Date().toISOString(), persona: { id: p.id, name: p.name, title: p.title || '', description: p.description || '', avatar: p.avatarRef || '', lorebook: p.lorebook || '' } };
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }); const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = (p.name || 'yantai-persona') + '.json'; a.click(); setTimeout(() => URL.revokeObjectURL(url), 500); return;
    }
    if (action === 'native-create') return this.call('openNativeCreate');
    if (action === 'use' || action === 'copy-persona' || action === 'delete-persona') {
      try { return await this.call(action === 'use' ? 'usePersona' : action === 'copy-persona' ? 'copyPersona' : 'deletePersona', el.dataset.id); }
      catch (error) { this.options.report?.(error.message || String(error), 'error'); return; }
    }
    if (action === 'default' || action === 'set-default-current') return this.call('setDefault', el.dataset.id);
    if (action === 'set-default') return this.call('setBinding', 'global', 'bind', el.dataset.id);
    if (action === 'edit' || action === 'open-edit' || action === 'open-native-edit') return this.call('openNativeEdit', el.dataset.id);
    if (action === 'bind-current') { const currentId = this.state.current?.persona?.id; if (currentId) return this.call('setBinding', el.dataset.scope, el.dataset.mode || 'bind', currentId); this.options.report?.('先在“人设档案”里选择一份人设。', 'info'); return; }
    if (action === 'assistant-info') { this.options.report?.('Milo 使用酒馆当前主 API 生成回复，需要一点时间，通常约 30 秒到 1 分钟，具体取决于模型和网速。请耐心等待；失败的请求不会保存到助手记录。', 'info'); return; }
    if (action === 'new-assistant') { this.state.aiSessionFresh = true; this.state.aiPrompt = ''; this.state.suggestions = []; const thread = await this.call('newAssistantThread'); if (thread?.activeThreadKey) this.state.assistantActiveThreadKey = thread.activeThreadKey; this.state.aiSessionFresh = false; this.render(); return; }
    if (action === 'clear-assistant') { this.state.aiSessionFresh = true; this.state.suggestions = []; this.state.aiPrompt = ''; await this.call('clearAssistantThread'); this.state.aiSessionFresh = false; this.render(); return; }
    if (action === 'assistant-send') {
      const request = String(this.state.aiPrompt || '').trim();
      if (!request) { this.options.report?.('先写下你想和 Milo 讨论的内容。', 'info'); return; }
      // The first message is a proposal (two usable directions); later
      // messages continue the same thread as a normal conversation. A new
      // thread therefore naturally starts with a fresh pair of directions.
      const hasHistory = this.assistantTurns().length > 0;
      this.state.aiBusy = true;
      this.render();
      try {
        const actionName = hasHistory ? 'assistantChat' : 'createDraft';
        const result = await this.call(actionName, { request, includeCard: this.state.includeCard !== false, includeWorld: this.state.includeWorld === true, includeChat: this.state.includeChat === true });
        if (!result?.__yantaiStale) this.state.aiPrompt = '';
        if (!result?.__yantaiStale && result?.candidates?.length) this.state.suggestions = result.candidates.slice(0, 2);
        if (!result?.__yantaiStale && result?.draft?.candidates?.length) this.state.suggestions = result.draft.candidates.slice(0, 2);
      } catch (error) { this.options.report?.(error.message || String(error), 'error'); }
      this.state.aiBusy = false;
      this.render();
      return;
    }
    if (action === 'generate-ai') { this.state.aiBusy = true; this.state.aiSessionFresh = false; this.render(); try { const result = await this.call('createDraft', { request: this.state.aiPrompt || '', includeCard: this.state.includeCard !== false, includeWorld: this.state.includeWorld === true, includeChat: this.state.includeChat === true }); if (!result?.__yantaiStale) this.state.suggestions = result?.draft?.candidates || result?.candidates || []; } catch (error) { this.options.report?.(error.message || String(error), 'error'); } this.state.aiBusy = false; this.render(); return; }
    if (action === 'assistant-chat') { const request = String(this.state.aiPrompt || '').trim(); if (!request) { this.options.report?.('先写下你想和 Milo 讨论的内容。', 'info'); return; } this.state.aiBusy = true; this.render(); try { const result = await this.call('assistantChat', { request, includeCard: this.state.includeCard !== false, includeWorld: this.state.includeWorld === true, includeChat: this.state.includeChat === true }); if (!result?.__yantaiStale) { this.state.aiPrompt = ''; if (result?.candidates?.length) this.state.suggestions = result.candidates.slice(0, 2); } } catch (error) { this.options.report?.(error.message || String(error), 'error'); } this.state.aiBusy = false; this.render(); return; }
    if (action === 'save-candidate') { const candidate = (this.state.suggestions || [])[Number(el.dataset.index)]; const draft = (this.state.drafts || []).find(item => item?.targetKey === this.currentTargetKey()); if (candidate && draft) return this.call('saveCandidate', draft.id, candidate); }
    if (action === 'revise') { const instruction = globalThis.prompt?.('告诉 AI 要怎么调整这个方向', '保留核心感觉，写得更具体一些'); if (!instruction) return; this.state.aiBusy = true; this.render(); try { const result = await this.call('reviseDraft', (this.state.drafts || []).find(item => item?.targetKey === this.currentTargetKey())?.id, instruction); this.state.suggestions = result?.draft?.candidates || result?.candidates || []; } finally { this.state.aiBusy = false; this.render(); } }
  }
  onInput(event) {
    const field = event.target.dataset?.field; if (!field) return;
    this.state[field] = event.target.value;
    if (field.startsWith('editor')) {
      const map = { editorName: 'name', editorNote: 'note', editorDescription: 'description', editorLorebook: 'lorebook' };
      const key = map[field];
      if (key) {
        const persona = this.editorPersona();
        const draft = this.state.editorDraft && String(this.state.editorDraft.id || '') === String(persona.id || '') ? this.state.editorDraft : { id: persona.id || '' };
        draft[key] = event.target.value;
        this.state.editorDraft = draft;
      }
      return;
    }
    if (field !== 'query' && field !== 'assetQuery') return;
    // Filtering replaces the list markup. Restore the active input and caret
    // so a fast search does not lose focus after the first character.
    const start = event.target.selectionStart;
    const end = event.target.selectionEnd;
    this.render();
    const next = this.root?.querySelector('[data-field="' + field + '"]');
    if (next) {
      next.focus();
      if (typeof start === 'number' && typeof end === 'number') next.setSelectionRange(start, end);
    }
  }
  onChange(event) {
    const field = event.target.dataset?.field; if (!field) return;
    const value = event.target.type === 'checkbox' ? event.target.checked : event.target.value;
    if (field === 'libraryGroup') {
      this.state.libraryGroup = String(value || 'all');
      this.state.ui = { ...(this.state.ui || {}), libraryGroup: this.state.libraryGroup };
      this.render();
      this.call('setLibraryGroup', this.state.libraryGroup).catch(() => {});
      return;
    }
    if (field === 'personaGroup') {
      this.call('setPersonaGroupForPersona', event.target.dataset.id, String(value || UNCATEGORIZED_GROUP)).catch(error => this.options.report?.(error.message || String(error), 'error'));
      return;
    }
    this.state[field] = value;
    if (field.startsWith('editor')) {
      const map = { editorName: 'name', editorNote: 'note', editorDescription: 'description', editorLorebook: 'lorebook' };
      const key = map[field]; if (key) { const persona = this.editorPersona(); const draft = this.state.editorDraft || { id: persona.id || '' }; draft[key] = value; this.state.editorDraft = draft; }
    }
  }
  onKeyDown(event) {
    if (event.target?.dataset?.field !== 'aiPrompt') return;
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      const send = this.root?.querySelector('[data-action="assistant-send"]');
      if (send && !send.disabled) send.click();
    }
  }
}

export function createApp(options = {}) { return new App(options); }
export { TABS };

