import test from 'node:test';
import assert from 'node:assert/strict';

import {
  updateNativePersona,
  isElementVisible,
  isNativePersonaPanelOpen,
  isPlaceholderPersonaName,
  isPlaceholderPersonaBody,
  isPlaceholderPersonaRecord,
  mergeNativePersonasFromPayload,
  markPersonaDeletedLocally,
  syncActivePersonaUserName,
} from '../adapter.js';

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
