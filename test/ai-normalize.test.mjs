import test from 'node:test';
import assert from 'node:assert/strict';
import { normalize } from '../ai.js';

test('assistant normalization keeps common reply field aliases visible', () => {
  const result = normalize({ mode: 'chat', answer: '卡片上下文里仍然可以继续对话。' }, 'chat');
  assert.equal(result.reply, '卡片上下文里仍然可以继续对话。');
  assert.equal(result.summary, '卡片上下文里仍然可以继续对话。');
});

test('assistant normalization preserves structured proposal replies', () => {
  const result = normalize({ reply: '先从一个小入口开始。', candidates: [{ title: '方向一', persona: '完整人设正文' }] }, 'propose');
  assert.equal(result.reply, '先从一个小入口开始。');
  assert.equal(result.summary, '');
  assert.equal(result.candidates[0].persona, '完整人设正文');
});
