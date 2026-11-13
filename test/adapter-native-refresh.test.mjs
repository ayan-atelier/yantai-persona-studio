import test from 'node:test';
import assert from 'node:assert/strict';

import {
  updateNativePersona,
  uploadNativeAvatar,
  bustPersonaAvatarCache,
  getPersonaAvatarCacheBust,
  clearPersonaAvatarCacheBustForTest,
  isElementVisible,
  isNativePersonaPanelOpen,
  setNativeTakeover,
  setNativeEditMode,
  listNativePersonas,
  syncNativePersonasFromServer,
  isPlaceholderPersonaName,
  isPlaceholderPersonaBody,
  isPlaceholderPersonaRecord,
  mergeNativePersonasFromPayload,
  markPersonaDeletedLocally,
  markPersonaModifiedLocally,
  isPersonaModifiedLocally,
  hasRecentLocalPersonaMutation,
  clearLocalPersonaModificationsForTest,
  syncActivePersonaUserName,
} from '../adapter.js';
import { createApp } from '../ui.js';

function contextFor({ current = 'persona-a' } = {}) {
  const events = [];
  let saves = 0;
  const context = {
    powerUserSettings: {
      user_avatar: current,
      persona_description: 'old description',
      personas: { 'persona-a': '清砚' },
      persona_descriptions: { 'persona-a': { description: 'old description', title: '' } },
    },
    saveSettingsDebounced() { saves += 1; },
    eventSource: { emit(type, payload) { events.push({ type, payload }); } },
  };
  return { context, events, get saves() { return saves; } };
}

test('native persona updates repaint the selected editor and avatar list', async () => {
  const state = contextFor();
  const calls = [];
  const api = {
    user_avatar: 'persona-a',
    setPersonaDescription() { calls.push(['setPersonaDescription']); },
    getUserAvatars(...args) { calls.push(['getUserAvatars', ...args]); },
  };

  assert.equal(await updateNativePersona('persona-a', { description: 'new description' }, state.context, api), true);
  assert.equal(state.context.powerUserSettings.persona_descriptions['persona-a'].description, 'new description');
  assert.equal(state.context.powerUserSettings.persona_description, 'new description');
  assert.equal(state.saves, 1);
  assert.deepEqual(calls, [['setPersonaDescription'], ['getUserAvatars', true, 'persona-a']]);
  assert.deepEqual(state.events, [{ type: 'PERSONA_UPDATED', payload: 'persona-a' }]);
});

test('native refresh falls back to the old list signature on incompatible clients', async () => {
  const state = contextFor();
  const calls = [];
  const api = {
    user_avatar: 'persona-a',
    getUserAvatars(...args) {
      calls.push(args);
      if (args[0] === true) throw new Error('legacy signature');
    },
  };

  assert.equal(await updateNativePersona('persona-a', { description: 'new description' }, state.context, api), true);
  assert.deepEqual(calls, [[true, 'persona-a'], [false, 'persona-a']]);
});

test('non-current persona updates do not reselect the active persona', async () => {
  const state = contextFor({ current: 'persona-other' });
  state.context.powerUserSettings.personas['persona-other'] = '另一个人设';
  const calls = [];
  const api = {
    user_avatar: 'persona-other',
    setPersonaDescription() { calls.push('set'); },
    getUserAvatars(...args) { calls.push(args); },
  };

  assert.equal(await updateNativePersona('persona-a', { description: 'new description' }, state.context, api), true);
  assert.deepEqual(calls, [[true, 'persona-a']]);
  assert.equal(state.context.powerUserSettings.persona_description, 'old description');
});

test('isNativePersonaPanelOpen detects position:fixed drawers in TauriTavern and pinned layouts where offsetParent is null', () => {
  const prevDoc = globalThis.document;
  const prevStyle = globalThis.getComputedStyle;
  try {
    const fixedDrawer = {
      hidden: false,
      offsetParent: null,
      classList: { contains: name => name === 'openDrawer' },
      getBoundingClientRect: () => ({ width: 390, height: 680 }),
    };
    globalThis.getComputedStyle = () => ({ position: 'fixed', display: 'block', visibility: 'visible' });
    globalThis.document = {
      querySelectorAll: selector => (selector.includes('#PersonaManagement') ? [fixedDrawer] : []),
      querySelector: () => null,
    };
    assert.equal(isElementVisible(fixedDrawer), true);
    assert.equal(isNativePersonaPanelOpen(), true);

    const closedFixedDrawer = {
      hidden: false,
      offsetParent: null,
      classList: { contains: name => name === 'closedDrawer' },
      getBoundingClientRect: () => ({ width: 0, height: 0 }),
    };
    globalThis.getComputedStyle = () => ({ position: 'fixed', display: 'none', visibility: 'visible' });
    globalThis.document = {
      querySelectorAll: selector => (selector.includes('#PersonaManagement') ? [closedFixedDrawer] : []),
      querySelector: () => null,
    };
    assert.equal(isElementVisible(closedFixedDrawer), false);
    assert.equal(isNativePersonaPanelOpen(), false);
  } finally {
    globalThis.document = prevDoc;
    globalThis.getComputedStyle = prevStyle;
  }
});

test('mergeNativePersonasFromPayload preserves cross-device personas and heals [Unnamed Persona] placeholders without downgrading real records', () => {
  assert.equal(isPlaceholderPersonaRecord('[Unnamed Persona]', { description: '', title: '' }), true);
  assert.equal(isPlaceholderPersonaRecord('清砚', { description: '', title: '' }), false);
  assert.equal(isPlaceholderPersonaRecord('[Unnamed Persona]', { description: '有描述正文', title: '' }), false);

  const context = {
    powerUserSettings: {
      user_avatar: '1793732147110-persona.png',
      persona_description: '',
      personas: {
        'persona-existing.png': '清砚',
        '1793732147110-persona.png': '[Unnamed Persona]',
      },
      persona_descriptions: {
        'persona-existing.png': { description: '原本的人设描述', title: '原本备注', depth: 4 },
        '1793732147110-persona.png': { description: '', title: '', depth: 4 },
      },
    },
  };

  const serverPayload = {
    power_user: {
      personas: {
        'persona-existing.png': '[Unnamed Persona]',
        '1793732147110-persona.png': '清砚',
        'persona-phone-new.png': '手机新建人设',
        'persona-deleted.png': '已删除人设',
      },
      persona_descriptions: {
        'persona-existing.png': { description: '', title: '' },
        '1793732147110-persona.png': {
          description: '少数民族的祭品少女，只能听懂部分普通话，常年不出屋导致皮肤很白，一双鹿眼十分有神。',
          title: '',
          position: 0,
          depth: 2,
          role: 0,
          lorebook: '',
        },
        'persona-phone-new.png': { description: '手机端刚写好的设定', title: '手机测试' },
        'persona-deleted.png': { description: '不应被恢复', title: '' },
      },
    },
  };

  markPersonaDeletedLocally('persona-deleted.png');
  const result = mergeNativePersonasFromPayload(serverPayload, { context, preferServer: true });
  assert.equal(result.changed, true);
  assert.deepEqual(result.added, ['persona-phone-new.png']);
  assert.deepEqual(result.updated, ['1793732147110-persona.png']);
  // Real local persona was NOT downgraded by server placeholder
  assert.equal(context.powerUserSettings.personas['persona-existing.png'], '清砚');
  assert.equal(context.powerUserSettings.persona_descriptions['persona-existing.png'].description, '原本的人设描述');
  // Local placeholder WAS healed by server record
  assert.equal(context.powerUserSettings.personas['1793732147110-persona.png'], '清砚');
  assert.equal(
    context.powerUserSettings.persona_descriptions['1793732147110-persona.png'].description,
    '少数民族的祭品少女，只能听懂部分普通话，常年不出屋导致皮肤很白，一双鹿眼十分有神。',
  );
  assert.equal(
    context.powerUserSettings.persona_description,
    '少数民族的祭品少女，只能听懂部分普通话，常年不出屋导致皮肤很白，一双鹿眼十分有神。',
  );
  // Missing phone persona WAS added
  assert.equal(context.powerUserSettings.personas['persona-phone-new.png'], '手机新建人设');
  // Explicitly deleted persona was NOT resurrected
  assert.equal('persona-deleted.png' in context.powerUserSettings.personas, false);
});

test('mergeNativePersonasFromPayload heals partial corruption when description returned but name is still [Unnamed Persona]', () => {
  assert.equal(isPlaceholderPersonaName('[Unnamed Persona]'), true);
  assert.equal(isPlaceholderPersonaName('清砚'), false);
  assert.equal(isPlaceholderPersonaBody({ description: '已有描述', title: '' }), false);

  const context = {
    powerUserSettings: {
      user_avatar: '1793732147110-persona.png',
      personas: {
        '1793732147110-persona.png': '[Unnamed Persona]',
      },
      persona_descriptions: {
        '1793732147110-persona.png': {
          description: '少数民族的祭品成年女子，只能听懂部分普通话，常年不出屋导致皮肤很白，黑色长发，一双鹿眼十分有神。',
          title: '',
        },
      },
    },
  };
  const serverPayload = {
    power_user: {
      personas: {
        '1793732147110-persona.png': '清砚',
      },
      persona_descriptions: {
        '1793732147110-persona.png': {
          description: '少数民族的祭品成年女子，只能听懂部分普通话，常年不出屋导致皮肤很白，黑色长发，一双鹿眼十分有神。',
          title: '',
        },
      },
    },
  };
  const result = mergeNativePersonasFromPayload(serverPayload, { context, preferServer: false });
  assert.equal(result.changed, true);
  assert.deepEqual(result.updated, ['1793732147110-persona.png']);
  assert.equal(context.powerUserSettings.personas['1793732147110-persona.png'], '清砚');
});

test('updateNativePersona and syncActivePersonaUserName sync name1 via setUserName and heal [Unnamed Persona] user chat messages', async () => {
  let activeUserName = '[Unnamed Persona]';
  let chatSaves = 0;
  const context = {
    name1: '[Unnamed Persona]',
    chat: [
      { name: '宋仲庭', is_user: false, mes: '你好' },
      { name: '[Unnamed Persona]', is_user: true, mes: '二哥，你也是祭司吗？' },
    ],
    powerUserSettings: {
      personas: { '1793732147110-persona.png': '清砚' },
      persona_descriptions: { '1793732147110-persona.png': { description: '旧描述', title: '' } },
    },
    setUserName(val) {
      activeUserName = val;
      context.name1 = val;
    },
    saveSettingsDebounced() {},
    saveChatDebounced() { chatSaves += 1; },
    eventSource: { emit() {} },
  };
  const api = {
    user_avatar: '1793732147110-persona.png',
    setPersonaDescription() {},
    getUserAvatars() {},
  };

  assert.equal(await syncActivePersonaUserName(context, api), true);
  assert.equal(activeUserName, '清砚');
  assert.equal(context.name1, '清砚');
  assert.equal(context.chat[1].name, '清砚');
  assert.equal(chatSaves, 1);

  assert.equal(await updateNativePersona('1793732147110-persona.png', { name: '沈清砚', description: '新描述' }, context, api), true);
  assert.equal(activeUserName, '沈清砚');
  assert.equal(context.name1, '沈清砚');
});

test('mergeNativePersonasFromPayload syncs cross-device edits & tombstoned deletions without touching excludeId or unsaved local personas', () => {
  const context = {
    powerUserSettings: {
      user_avatar: 'persona-active.png',
      persona_description: '当前生效人设描述',
      personas: {
        'persona-active.png': '林知夏',
        'persona-editing.png': '苏砚（电脑正在编辑）',
        'persona-phone-edited.png': '旧名字',
        'persona-deleted-on-phone.png': '手机已删人设',
        'persona-local-unsaved.png': '电脑刚新建尚未落盘的人设',
      },
      persona_descriptions: {
        'persona-active.png': { description: '当前生效人设描述', title: '' },
        'persona-editing.png': { description: '电脑刚写了一半的新设定', title: '编辑中' },
        'persona-phone-edited.png': { description: '电脑缓存里的旧描述', title: '旧备注' },
        'persona-deleted-on-phone.png': { description: '不该诈尸回写', title: '' },
        'persona-local-unsaved.png': { description: '刚建好还没存到服务端', title: '' },
      },
    },
  };

  const serverPayload = {
    power_user: {
      personas: {
        'persona-active.png': '林知夏',
        'persona-editing.png': '苏砚（服务器旧名）',
        'persona-phone-edited.png': '手机改后的新名字',
      },
      persona_descriptions: {
        'persona-active.png': { description: '当前生效人设描述', title: '' },
        'persona-editing.png': { description: '服务器上的旧设定', title: '' },
        'persona-phone-edited.png': { description: '手机端刚改完的新描述', title: '新备注' },
      },
    },
    extension_settings: {
      'yantai-persona-studio': {
        personaMeta: {
          'persona-deleted-on-phone.png': { deletedAt: 1794430000000 },
        },
      },
    },
  };

  const result = mergeNativePersonasFromPayload(serverPayload, {
    context,
    preferServer: true,
    excludeId: 'persona-editing.png',
  });

  assert.equal(result.changed, true);
  assert.deepEqual(result.updated, ['persona-phone-edited.png']);
  assert.deepEqual(result.removed, ['persona-deleted-on-phone.png']);
  // Currently edited persona on PC is strictly protected by excludeId
  assert.equal(context.powerUserSettings.personas['persona-editing.png'], '苏砚（电脑正在编辑）');
  assert.equal(context.powerUserSettings.persona_descriptions['persona-editing.png'].description, '电脑刚写了一半的新设定');
  // Other persona edited on phone is updated to latest server version
  assert.equal(context.powerUserSettings.personas['persona-phone-edited.png'], '手机改后的新名字');
  assert.equal(context.powerUserSettings.persona_descriptions['persona-phone-edited.png'].description, '手机端刚改完的新描述');
  // Tombstoned persona deleted on phone is removed from local memory so PC won't resurrect it
  assert.equal('persona-deleted-on-phone.png' in context.powerUserSettings.personas, false);
  // Brand-new local persona without tombstone is NEVER deleted
  assert.equal(context.powerUserSettings.personas['persona-local-unsaved.png'], '电脑刚新建尚未落盘的人设');
});

test('TauriTavern takeover syncs .ytps-drawer-takeover, encodes special avatar filenames, and bounds stalled /api/settings/get fetches', async () => {
  const prevDoc = globalThis.document;
  const prevFetch = globalThis.fetch;
  try {
    const makeClassList = () => {
      const set = new Set();
      return {
        toggle(name, force) {
          const active = force === undefined ? !set.has(name) : Boolean(force);
          if (active) set.add(name); else set.delete(name);
          return active;
        },
        contains(name) { return set.has(name); },
      };
    };
    const drawer = { classList: makeClassList() };
    const block = {
      classList: makeClassList(),
      closest: selector => (selector === '#PersonaManagement' ? drawer : null),
    };
    globalThis.document = {
      querySelectorAll: selector => (selector === '#persona-management-block' ? [block] : []),
      querySelector: () => null,
    };

    assert.equal(setNativeTakeover(true), true);
    assert.equal(block.classList.contains('ytps-takeover'), true);
    assert.equal(drawer.classList.contains('ytps-drawer-takeover'), true);

    assert.equal(setNativeEditMode(true), true);
    assert.equal(block.classList.contains('ytps-takeover'), false);
    assert.equal(block.classList.contains('ytps-native-edit'), true);
    assert.equal(drawer.classList.contains('ytps-drawer-takeover'), false);

    const personas = listNativePersonas(
      {
        powerUserSettings: {
          user_avatar: '清砚 #1?.png',
          personas: { '清砚 #1?.png': '清砚' },
          persona_descriptions: {},
        },
      },
      { getUserAvatar: id => `User Avatars/${id}` },
    );
    assert.equal(personas.length, 1);
    assert.equal(personas[0].avatarRef, '/User Avatars/' + encodeURIComponent('清砚 #1?.png'));

    globalThis.fetch = () => new Promise(() => {});
    const timedOut = await syncNativePersonasFromServer({ timeoutMs: 25 });
    assert.equal(timedOut.ok, false);
    assert.equal(timedOut.changed, false);
  } finally {
    globalThis.document = prevDoc;
    globalThis.fetch = prevFetch;
  }
});

test('local persona edits are never reverted by un-flushed stale /api/settings/get reads during SillyTavern 1s debounce window', async () => {
  const prevFetch = globalThis.fetch;
  clearLocalPersonaModificationsForTest();
  try {
    // Server still holds the OLD persona because saveSettingsDebounced() delays 1000ms before writing disk.
    const staleServerSettings = {
      user_avatar: 'persona-user.png',
      power_user: {
        personas: {
          'persona-user.png': '修改前的旧名字',
          'persona-other.png': '旁观人设（远端新版）',
        },
        persona_descriptions: {
          'persona-user.png': { description: '修改前的旧人设内容', title: '旧备注', depth: 4 },
          'persona-other.png': { description: '另一台设备已落盘的新描述', title: '' },
        },
      },
    };
    globalThis.fetch = async url => {
      if (String(url).includes('/api/settings/get')) {
        return {
          ok: true,
          json: async () => ({ settings: JSON.stringify(staleServerSettings) }),
        };
      }
      throw new Error(`unexpected url: ${url}`);
    };

    const context = {
      powerUserSettings: {
        user_avatar: 'persona-user.png',
        persona_description: '修改前的旧人设内容',
        personas: {
          'persona-user.png': '修改前的旧名字',
          'persona-other.png': '旁观人设（本地旧版）',
        },
        persona_descriptions: {
          'persona-user.png': { description: '修改前的旧人设内容', title: '旧备注', depth: 4 },
          'persona-other.png': { description: '本地缓存旧描述', title: '' },
        },
      },
      saveSettingsDebounced() {
        // Simulates SillyTavern's 1000ms debounced save: does NOT update staleServerSettings yet!
      },
      eventSource: { emit() {} },
    };
    const api = {
      user_avatar: 'persona-user.png',
      setPersonaDescription() {},
      getUserAvatars() {},
    };

    const updated = await updateNativePersona(
      'persona-user.png',
      { name: '修改后的新名字', description: '修改后的全新人设设定正文', title: '新备注' },
      context,
      api,
    );
    assert.equal(updated, true);
    assert.equal(isPersonaModifiedLocally('persona-user.png'), true);
    assert.equal(hasRecentLocalPersonaMutation(), true);

    // Immediately afterwards (5ms later), even if a sync runs with preferServer: true against stale disk settings:
    const syncResult = await syncNativePersonasFromServer({ context, api, preferServer: true });
    assert.equal(syncResult.ok, true);
    // Locally edited persona MUST NOT be reverted to stale server values!
    assert.equal(context.powerUserSettings.personas['persona-user.png'], '修改后的新名字');
    assert.equal(context.powerUserSettings.persona_descriptions['persona-user.png'].description, '修改后的全新人设设定正文');
    assert.equal(context.powerUserSettings.persona_descriptions['persona-user.png'].title, '新备注');
    assert.equal(context.powerUserSettings.persona_description, '修改后的全新人设设定正文');
    // Unedited persona can still receive genuine cross-device updates when preferServer: true
    assert.equal(context.powerUserSettings.personas['persona-other.png'], '旁观人设（远端新版）');

    // Also simulate editing directly in SillyTavern's native #persona_description textarea:
    const now = Date.now();
    markPersonaModifiedLocally('persona-native-edit.png', now);
    context.powerUserSettings.personas['persona-native-edit.png'] = '原生面板刚改的名字';
    context.powerUserSettings.persona_descriptions['persona-native-edit.png'] = { description: '原生面板刚敲入的新设定', title: '' };
    mergeNativePersonasFromPayload({
      power_user: {
        personas: { 'persona-native-edit.png': '磁盘旧名字' },
        persona_descriptions: { 'persona-native-edit.png': { description: '磁盘未落盘旧设定', title: '' } },
      },
    }, { context, preferServer: true });
    assert.equal(context.powerUserSettings.personas['persona-native-edit.png'], '原生面板刚改的名字');
    assert.equal(context.powerUserSettings.persona_descriptions['persona-native-edit.png'].description, '原生面板刚敲入的新设定');

    // Once the 15s local edit guard expires, genuine cross-device edits from another device merge normally:
    markPersonaModifiedLocally('persona-native-edit.png', now - 20000);
    assert.equal(isPersonaModifiedLocally('persona-native-edit.png', now), false);
    mergeNativePersonasFromPayload({
      power_user: {
        personas: { 'persona-native-edit.png': '手机端20秒后改的新名字' },
        persona_descriptions: { 'persona-native-edit.png': { description: '手机端20秒后改的新设定', title: '' } },
      },
    }, { context, preferServer: true });
    assert.equal(context.powerUserSettings.personas['persona-native-edit.png'], '手机端20秒后改的新名字');
    assert.equal(context.powerUserSettings.persona_descriptions['persona-native-edit.png'].description, '手机端20秒后改的新设定');
  } finally {
    clearLocalPersonaModificationsForTest();
    globalThis.fetch = prevFetch;
  }
});

test('overwriting an existing persona avatar busts WebView image cache and updates chat/drawer DOM thumbnails', async () => {
  const prevFetch = globalThis.fetch;
  const prevDoc = globalThis.document;
  clearPersonaAvatarCacheBustForTest();
  clearLocalPersonaModificationsForTest();
  try {
    const uploadedForms = [];
    const drawerImg = { src: '/thumbnail?type=persona&file=persona-a.png' };
    const chatUserImg = { src: '/thumbnail?type=persona&file=persona-a.png' };
    globalThis.document = {
      querySelectorAll(selector) {
        if (selector === '#user_avatar_block .avatar-container') {
          return [{
            getAttribute: name => (name === 'data-avatar-id' ? 'persona-a.png' : null),
            querySelector: tag => (tag === 'img' ? drawerImg : null),
          }];
        }
        if (selector === '.mes[is_user="true"]:not([force_avatar="true"]) .avatar img') {
          return [chatUserImg];
        }
        return [];
      },
      querySelector: () => null,
    };
    globalThis.fetch = async (url, options = {}) => {
      if (String(url).startsWith('/api/avatars/upload')) {
        uploadedForms.push({ url, body: options.body });
        return {
          ok: true,
          json: async () => ({ path: 'persona-a.png' }),
        };
      }
      return { ok: true, json: async () => ({}) };
    };

    const events = [];
    const context = {
      user_avatar: 'persona-a.png',
      powerUserSettings: {
        user_avatar: 'persona-a.png',
        personas: {
          'persona-a.png': '清砚',
          'persona-b.png': '未换头像的人设',
        },
        persona_descriptions: {
          'persona-a.png': { description: '描述A', title: '' },
          'persona-b.png': { description: '描述B', title: '' },
        },
      },
      eventSource: { emit(type, payload) { events.push({ type, payload }); } },
    };

    const beforeList = listNativePersonas(context, { getUserAvatar: id => `User Avatars/${id}` });
    assert.equal(beforeList.find(p => p.id === 'persona-a.png')?.avatarRef, '/User Avatars/persona-a.png');

    const fakeBlob = new Blob([new Uint8Array([137, 80, 78, 71])], { type: 'image/png' });
    const res = await uploadNativeAvatar(fakeBlob, {
      resizePrompt: false,
      overwriteName: 'persona-a.png',
      createPersona: false,
      context,
    });

    assert.equal(res.avatarId, 'persona-a.png');
    assert.equal(res.created, false);
    assert.ok(res.bust > 0);
    assert.equal(getPersonaAvatarCacheBust('persona-a.png'), res.bust);

    const afterList = listNativePersonas(context, { getUserAvatar: id => `User Avatars/${id}` });
    assert.equal(afterList.find(p => p.id === 'persona-a.png')?.avatarRef, `/User Avatars/persona-a.png?v=${res.bust}`);
    assert.equal(afterList.find(p => p.id === 'persona-b.png')?.avatarRef, '/User Avatars/persona-b.png');
    assert.equal(drawerImg.src, `/thumbnail?type=persona&file=persona-a.png&v=${res.bust}`);
    assert.equal(chatUserImg.src, `/thumbnail?type=persona&file=persona-a.png&v=${res.bust}`);
    assert.deepEqual(events, [{ type: 'PERSONA_UPDATED', payload: 'persona-a.png' }]);

    // Monotonic bump if user replaces avatar twice within the same millisecond:
    const secondBust = bustPersonaAvatarCache('persona-a.png', res.bust);
    assert.ok(secondBust > res.bust);
  } finally {
    clearPersonaAvatarCacheBustForTest();
    clearLocalPersonaModificationsForTest();
    globalThis.fetch = prevFetch;
    globalThis.document = prevDoc;
  }
});

test('gallery view resolves active editor persona even when entered from top Editor tab without explicit editingPersonaId', () => {
  const ui = createApp({});
  ui.setLocalUi({ tab: 'gallery', gallerySheet: 'avatars', selectedAssetId: 'asset-1', editingPersonaId: '' });
  ui.update({
    personas: [{ id: 'persona-cur.png', name: '清砚', description: '当前人设', avatarRef: '/User Avatars/persona-cur.png?v=123' }],
    current: { scope: 'global', persona: { id: 'persona-cur.png', name: '清砚', description: '当前人设', avatarRef: '/User Avatars/persona-cur.png?v=123' } },
    state: {
      gallery: [{ id: 'asset-1', name: '新头像.png', kind: 'avatar', remoteUrl: '/user/images/ytps-asset-1.png' }],
    },
  });

  assert.equal(ui.galleryTargetPersona()?.id, 'persona-cur.png');
  const html = ui.gallery();
  assert.match(html, /data-action="upload-gallery-avatar"/);
  assert.match(html, /设为头像/);
  assert.match(html, /取消并返回编辑/);
});


