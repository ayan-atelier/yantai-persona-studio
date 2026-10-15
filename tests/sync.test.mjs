import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assistantThreadBaseKey,
  canonicalAssistantThreadKey,
  mergeAssistantThreads,
  mergeExtensionState,
  createAdapter,
  fetchRemoteExtensionState,
  readRecoveryBackup,
  writeRecoveryBackup,
} from '../adapter.js';

function turn(at, user, assistant) {
  return { at, user, assistant, memory: assistant, mode: 'chat', proposals: [] };
}

test('old identity-prefixed assistant keys migrate to one stable key', () => {
  const oldPhone = 'phone-user|card_abc|chat_123||new_phone';
  const oldDesktop = 'desktop-user|card_abc|chat_123||new_desktop';
  assert.equal(canonicalAssistantThreadKey(oldPhone), 'v2|card_abc|chat_123||new_phone');
  assert.equal(canonicalAssistantThreadKey(oldDesktop), 'v2|card_abc|chat_123||new_desktop');
  assert.equal(assistantThreadBaseKey('card_abc', 'chat_123'), 'v2|card_abc|chat_123|');
});

test('thread merge unions turns and deduplicates exact repeats', () => {
  const keyA = 'phone|card_abc|chat_123||new_phone';
  const keyB = 'desktop|card_abc|chat_123||new_desktop';
  const merged = mergeAssistantThreads(
    { [keyA]: { createdAt: 10, updatedAt: 20, turns: [turn(12, '一', '甲')] } },
    { [keyB]: { createdAt: 11, updatedAt: 30, turns: [turn(12, '一', '甲'), turn(25, '二', '乙')] } },
  );
  const values = Object.values(merged);
  assert.equal(values.length, 2, 'separate explicit new sessions remain separate');
  assert.equal(values.find(item => item.id.endsWith('new_desktop')).turns.length, 2);
});

test('extension merge keeps remote persona settings and picks newest active thread', () => {
  const base = assistantThreadBaseKey('card_abc', 'chat_123');
  const phone = `${base}|new_phone`;
  const desktop = `${base}|new_desktop`;
  const merged = mergeExtensionState(
    {
      assistantThreads: { [phone]: { updatedAt: 200, turns: [turn(200, '手机', '昨晚记录')] } },
      assistantActiveThreadKey: phone,
      gallerySync: { updatedAt: 20, assets: [{ id: 'phone', updatedAt: 20 }] },
      personaMeta: { mobile: { note: '手机' } },
    },
    {
      assistantThreads: { [desktop]: { updatedAt: 100, turns: [turn(100, '电脑', '旧记录')] } },
      assistantActiveThreadKey: desktop,
      gallerySync: { updatedAt: 10, assets: [{ id: 'desktop', updatedAt: 10 }] },
      personaMeta: { desktop: { note: '电脑' } },
    },
  );
  assert.equal(merged.assistantActiveThreadKey, phone);
  assert.equal(merged.assistantThreads[phone].turns[0].assistant, '昨晚记录');
  assert.deepEqual(Object.keys(merged.personaMeta).sort(), ['desktop', 'mobile']);
  assert.deepEqual(merged.gallerySync.assets.map(item => item.id).sort(), ['desktop', 'phone']);
});

test('stale empty new-thread key cannot hide phone history without an explicit local action', () => {
  const base = assistantThreadBaseKey('card', 'chat');
  const phone = `${base}|new_phone`;
  const desktop = `${base}|new_desktop`;
  const merged = mergeExtensionState(
    { assistantThreads: { [phone]: { updatedAt: 200, turns: [turn(200, '手机', '记录')] } }, assistantActiveThreadKey: phone },
    { assistantThreads: { [desktop]: { updatedAt: 300, turns: [] } }, assistantActiveThreadKey: desktop },
  );
  assert.equal(merged.assistantActiveThreadKey, phone);
  const deliberate = mergeExtensionState(
    { assistantThreads: { [phone]: { updatedAt: 200, turns: [turn(200, '手机', '记录')] } }, assistantActiveThreadKey: phone },
    { assistantThreads: { [desktop]: { updatedAt: 300, turns: [] } }, assistantActiveThreadKey: desktop, assistantActiveThreadChangedAt: 400 },
  );
  assert.equal(deliberate.assistantActiveThreadKey, desktop);
});

test('an older non-empty desktop thread does not beat newer phone history', () => {
  const base = assistantThreadBaseKey('card', 'chat');
  const desktop = `${base}|new_desktop`;
  const merged = mergeExtensionState(
    { assistantThreads: { [base]: { updatedAt: 200, turns: [turn(200, '手机', '新记录')] } }, assistantActiveThreadKey: base },
    { assistantThreads: { [desktop]: { updatedAt: 100, turns: [turn(100, '电脑', '旧记录')] } }, assistantActiveThreadKey: desktop },
  );
  assert.equal(merged.assistantActiveThreadKey, base);
});

test('remote save reads latest full settings and never calls stale host saver', async () => {
  const oldFetch = globalThis.fetch;
  const oldTavern = globalThis.SillyTavern;
  const oldStorage = globalThis.localStorage;
  const saves = [];
  const context = {
    extensionSettings: { 'yantai-persona-studio': { assistantThreads: {} } },
    powerUserSettings: { personas: { desktop: '旧电脑人设' } },
    getRequestHeaders: () => ({ 'X-Test': '1' }),
    saveSettingsDebounced: () => { throw new Error('stale host saver must not run'); },
  };
  const remote = {
    power_user: { personas: { mobile: '手机昨晚人设' } },
    extension_settings: { 'yantai-persona-studio': { assistantThreads: { old: { updatedAt: 1, turns: [] } } } },
  };
  globalThis.SillyTavern = { getContext: () => context };
  globalThis.localStorage = { setItem() {}, getItem() { return null; } };
  globalThis.fetch = async (url, options) => {
    if (url === '/api/settings/get') return { ok: true, json: async () => ({ settings: JSON.stringify(remote) }) };
    if (url === '/api/settings/save') { saves.push(JSON.parse(options.body)); return { ok: true, json: async () => ({}) }; }
    throw new Error(`unexpected URL ${url}`);
  };
  try {
    const adapter = createAdapter({ namespace: 'yantai-persona-studio' });
    const key = assistantThreadBaseKey('card', 'chat');
    await adapter.saveExtensionState({ assistantThreads: { [key]: { updatedAt: 2, turns: [turn(2, '本机', '新记录')] } }, gallery: [{ id: 'big', updatedAt: 2, data: 'data-url', blob: { bytes: 'blob' } }] });
    assert.equal(saves.length, 1);
    assert.equal(saves[0].power_user.personas.mobile, '手机昨晚人设');
    assert.ok(saves[0].extension_settings['yantai-persona-studio'].assistantThreads[key]);
    assert.equal(context.extensionSettings['yantai-persona-studio'].assistantThreads[key].turns.length, 1);
    assert.equal(saves[0].extension_settings['yantai-persona-studio'].gallery[0].data, undefined);
    assert.equal(saves[0].extension_settings['yantai-persona-studio'].gallery[0].blob, undefined);
  } finally {
    globalThis.fetch = oldFetch;
    globalThis.SillyTavern = oldTavern;
    globalThis.localStorage = oldStorage;
  }
});

test('remote settings reader accepts the raw settings response shape', async () => {
  const oldFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ extension_settings: { 'yantai-persona-studio': { marker: 'raw' } } }) });
  try {
    const value = await fetchRemoteExtensionState({}, 'yantai-persona-studio');
    assert.equal(value.marker, 'raw');
  } finally {
    globalThis.fetch = oldFetch;
  }
});

test('failed remote read refuses the stale host save path', async () => {
  const oldFetch = globalThis.fetch;
  const oldTavern = globalThis.SillyTavern;
  let hostSaveCalls = 0;
  const context = {
    extensionSettings: { 'yantai-persona-studio': { assistantThreads: {} } },
    saveSettingsDebounced: () => { hostSaveCalls += 1; },
  };
  globalThis.SillyTavern = { getContext: () => context };
  globalThis.fetch = async () => ({ ok: false, status: 503, json: async () => ({}) });
  try {
    const adapter = createAdapter({ namespace: 'yantai-persona-studio' });
    await assert.rejects(() => adapter.saveExtensionState({ assistantThreads: {} }), /读取酒馆设置失败/);
    assert.equal(hostSaveCalls, 0);
  } finally {
    globalThis.fetch = oldFetch;
    globalThis.SillyTavern = oldTavern;
  }
});

test('load can recover assistant turns from the previous version snapshot', async () => {
  const oldFetch = globalThis.fetch;
  const oldTavern = globalThis.SillyTavern;
  const context = { extensionSettings: { 'yantai-persona-studio': { assistantThreads: {} } } };
  const key = assistantThreadBaseKey('card', 'chat');
  globalThis.SillyTavern = { getContext: () => context };
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ settings: JSON.stringify({ extension_settings: { 'yantai-persona-studio': { assistantThreads: {}, versionBackup: { settings: { assistantThreads: { [key]: { updatedAt: 100, turns: [turn(100, '手机', '备份记录')] } } } } } } }) }) });
  try {
    const adapter = createAdapter({ namespace: 'yantai-persona-studio' });
    const state = await adapter.loadExtensionState({ assistantThreads: {} });
    assert.equal(state.assistantThreads[key].turns[0].assistant, '备份记录');
  } finally {
    globalThis.fetch = oldFetch;
    globalThis.SillyTavern = oldTavern;
  }
});

test('recovery backup round-trips without image blobs', () => {
  const values = new Map();
  const storage = { setItem(key, value) { values.set(key, value); }, getItem(key) { return values.get(key) || null; } };
  const state = { assistantThreads: { stable: { turns: [turn(1, '你', 'Milo')] } }, gallery: [{ id: 'x', blob: { should: 'omit' }, data: 'huge' }] };
  assert.equal(writeRecoveryBackup(state, { localStorage: storage }), true);
  const backup = readRecoveryBackup({ localStorage: storage });
  assert.equal(backup.state.assistantThreads.stable.turns[0].assistant, 'Milo');
  assert.equal(backup.state.gallery[0].blob, undefined);
  assert.equal(backup.state.gallery[0].data, undefined);
});
