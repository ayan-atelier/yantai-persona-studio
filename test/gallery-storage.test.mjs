import test from 'node:test';
import assert from 'node:assert/strict';
import { createStorage } from '../storage.js';

test('same-file re-import resets stale hosted metadata until upload succeeds', () => {
  const storage = createStorage();
  const old = { id: 'asset_gallery-regression', remoteUrl: '/user/images/old.png', url: '/user/images/old.png', updatedAt: 1 };
  const fresh = { id: old.id, remoteUrl: '', url: 'blob:http://localhost/new', updatedAt: 2 };
  const local = storage.mergeGallery([old], [fresh])[0];
  assert.equal(local.remoteUrl, '');
  assert.equal(local.url, fresh.url);
  assert.ok(local.remoteResetAt >= fresh.updatedAt);

  const sharedCandidate = { ...local, url: undefined };
  const hostMerged = storage.mergeGallery([sharedCandidate], [old])[0];
  assert.equal(hostMerged.remoteUrl, '');
  assert.equal(hostMerged.remoteResetAt, local.remoteResetAt);

  const hosted = storage.mergeGallery([local], [{ ...local, remoteUrl: '/user/images/new.png', url: '/user/images/new.png' }])[0];
  assert.equal(hosted.remoteUrl, '/user/images/new.png');
  assert.equal(hosted.remoteResetAt, 0);
});