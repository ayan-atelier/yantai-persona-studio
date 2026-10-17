import test from 'node:test';
import assert from 'node:assert/strict';

import { personaTargetKey, threadMatchesTarget } from '../adapter.js';

test('assistant target keys remain portable across card id and fingerprint aliases', () => {
  const target = {
    cardKey: 'card_id_rose.png',
    legacyCardKey: 'card_7f2d',
    chatId: 'chat-42',
  };
  const legacyThread = {
    target: { cardKey: 'card_7f2d', chatId: 'chat-42' },
    turns: [{ user: 'hello', assistant: 'hi' }],
  };

  assert.equal(personaTargetKey(target), 'card_id_rose.png|chat-42');
  assert.equal(threadMatchesTarget(legacyThread, target), true);
  assert.equal(threadMatchesTarget(legacyThread, { ...target, chatId: 'chat-other' }), false);
});

test('assistant target matching does not cross cards that share a chat id', () => {
  const thread = { target: { cardKey: 'card_id_a', chatId: 'chat-42' }, turns: [] };
  assert.equal(threadMatchesTarget(thread, { cardKey: 'card_id_b', chatId: 'chat-42' }), false);
});
