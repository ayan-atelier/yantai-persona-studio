import test from 'node:test';
import assert from 'node:assert/strict';

import { updateNativePersona } from '../adapter.js';

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
