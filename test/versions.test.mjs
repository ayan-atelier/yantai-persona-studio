import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { PERSONA_VERSION, createVersionManager, releaseCatalog } from '../versions.js';

test('shipped versions.json matches manifest.json, PERSONA_VERSION, and passes legacy v1.0.x~v1.1.1 strict branch validation', () => {
  const manifest = JSON.parse(fs.readFileSync(new URL('../manifest.json', import.meta.url), 'utf8'));
  const rawCatalog = JSON.parse(fs.readFileSync(new URL('../versions.json', import.meta.url), 'utf8'));
  assert.equal(manifest.version, PERSONA_VERSION);
  assert.equal(rawCatalog.latest, PERSONA_VERSION);

  const parsed = releaseCatalog(rawCatalog);
  assert.equal(parsed.latest, PERSONA_VERSION);

  // Legacy v1.0.8~v1.1.1 clients strictly required `release.branch === "v" + release.version`
  // and `releases.length <= 100`, throwing "版本清单不完整或包含重复版本" otherwise.
  assert.ok(rawCatalog.releases.length <= 100);
  for (const entry of rawCatalog.releases) {
    assert.equal(entry.branch, `v${entry.version}`, `legacy branch field mismatch on ${entry.version}`);
  }
});

test('releaseCatalog accepts main-branch releases alongside legacy version records', () => {
  const parsed = releaseCatalog({
    schema: 1,
    extension: 'yantai-persona-studio',
    latest: '1.1.2',
    releases: [
      { version: '1.1.2', branch: 'main', settings_schema: 3, minimum_client_version: '1.16.0', notes: 'main release' },
      { version: '1.1.1', branch: 'v1.1.1', settings_schema: 3, minimum_client_version: '1.16.0', notes: 'legacy' },
    ],
  });
  assert.equal(parsed.latest, '1.1.2');
  assert.equal(parsed.releases[0].branch, 'main');
});

test('createVersionManager migrates legacy frozen branch back to origin/main and pulls latest', async () => {
  const calls = [];
  let currentBranch = 'v1.0.12';
  const settingsObj = { personaGroups: [{ id: 'g1', name: '测试组' }] };
  const manager = createVersionManager({
    settings: () => settingsObj,
    save: async () => {},
    flush: async () => {},
    context: () => ({ getRequestHeaders: () => ({}) }),
    moduleURL: 'http://127.0.0.1:8000/scripts/extensions/third-party/yantai-persona-studio/index.js',
    apiRoot: new URL('http://127.0.0.1:8000/'),
    currentVersion: '1.0.12',
    fetcher: async (url, options = {}) => {
      calls.push({ url, method: options.method || 'GET', body: options.body ? JSON.parse(options.body) : null });
      const respond = data => ({ ok: true, status: 200, text: async () => JSON.stringify(data) });
      if (url.endsWith('/api/extensions/discover')) {
        return respond([{ name: 'third-party/yantai-persona-studio', type: 'local' }]);
      }
      if (url.endsWith('/api/extensions/version')) {
        return respond({
          currentBranchName: currentBranch,
          currentCommitHash: '6860a7f962b111f159daac09e784704bb593806d',
          isUpToDate: currentBranch !== 'main',
          remoteUrl: 'https://github.com/ayan-atelier/yantai-persona-studio.git',
        });
      }
      if (url.endsWith('/version')) {
        return respond({ pkgVersion: '1.19.0' });
      }
      if (url.endsWith('/main/versions.json')) {
        return respond({
          schema: 1,
          extension: 'yantai-persona-studio',
          latest: PERSONA_VERSION,
          releases: [
            { version: PERSONA_VERSION, branch: 'main', settings_schema: 3, minimum_client_version: '1.16.0', notes: 'Single main' },
          ],
        });
      }
      if (url.endsWith('/api/extensions/branches')) {
        return respond([{ name: 'origin/main', commit: 'abc1234' }]);
      }
      if (url.endsWith('/api/extensions/switch')) {
        assert.equal(JSON.parse(options.body).branch, 'origin/main');
        currentBranch = 'main';
        return { ok: true, status: 204, text: async () => '' };
      }
      if (url.endsWith('/api/extensions/update')) {
        return respond({ shortCommitHash: 'abc1234', isUpToDate: true });
      }
      if (url.endsWith('/manifest.json')) {
        return respond({ version: PERSONA_VERSION });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    },
  });

  const checked = await manager.check();
  assert.equal(checked.needsMainSwitch, true);
  assert.equal(checked.latest?.version, PERSONA_VERSION);
  assert.equal(checked.latest?.branch, 'main');

  const updated = await manager.apply(checked);
  assert.equal(updated, PERSONA_VERSION);
  assert.equal(currentBranch, 'main');
  assert.equal(Boolean(settingsObj.versionBackup), true);
  assert.equal(calls.some(item => item.url.endsWith('/api/extensions/switch') && item.body?.branch === 'origin/main'), true);
  assert.equal(calls.some(item => item.url.endsWith('/api/extensions/update')), true);
});
