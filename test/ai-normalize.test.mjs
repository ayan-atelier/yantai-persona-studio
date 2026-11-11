import test from 'node:test';
import assert from 'node:assert/strict';
import { normalize, extractJsonPreview, salvageTruncatedJson, inferCandidateName } from '../ai.js';

test('assistant normalization keeps common reply field aliases visible', () => {
  const result = normalize({ mode: 'chat', answer: '卡片上下文里仍然可以继续对话。' }, 'chat');
  assert.equal(result.reply, '卡片上下文里仍然可以继续对话。');
  assert.equal(result.summary, '卡片上下文里仍然可以继续对话。');
});

test('assistant normalization preserves structured proposal replies', () => {
  const result = normalize({ reply: '先从一个小入口开始。', candidates: [{ name: '林知微', title: '方向一', persona: '完整人设正文' }] }, 'propose');
  assert.equal(result.reply, '先从一个小入口开始。');
  assert.equal(result.summary, '');
  assert.equal(result.candidates[0].name, '林知微');
  assert.equal(result.candidates[0].persona, '完整人设正文');
});

test('auto mode keeps candidates as revision when follow-up turn produces updated personas', () => {
  const withCandidates = normalize({ reply: '按你说的跳板穷学生重写了两版。', candidates: [{ name: '沈禾', title: '港大跳板兼职生', persona: '【基本信息】沈禾，20岁。' }] }, 'auto');
  assert.equal(withCandidates.mode, 'revision');
  assert.equal(withCandidates.candidates.length, 1);

  const pureChat = normalize({ reply: '麦见海在世界书里确实有这个设定。', candidates: [] }, 'auto');
  assert.equal(pureChat.mode, 'chat');
  assert.equal(pureChat.candidates.length, 0);
});

test('extractJsonPreview decodes half-streamed JSON without leaking raw braces', () => {
  const truncatedReply = '{\n  "mode": "chat",\n  "reply": "这个点子太正了！\\n\\n为了保住全额奖学金熬夜刷题，指';
  const preview1 = extractJsonPreview(truncatedReply, 'auto');
  assert.equal(preview1.isJson, true);
  assert.equal(preview1.complete, false);
  assert.equal(preview1.reply, '这个点子太正了！\n\n为了保住全额奖学金熬夜刷题，指');

  const streamingCandidates = '{\n  "mode": "revision",\n  "reply": "给你两版更写实的跳板生。",\n  "candidates": [\n    {"id":"a1","name":"周予安","title":"西环唐楼兼职王","persona":"【姓名】周予安\\n【生计】一日三份工"},\n    {"id":"a2","name":"陈念","title":"实验室夜班助研","persona":"【姓名】陈念\\n【目标】攒够签证费';
  const preview2 = extractJsonPreview(streamingCandidates, 'auto');
  assert.equal(preview2.complete, false);
  assert.equal(preview2.candidates.length, 2);
  assert.equal(preview2.candidates[0].name, '周予安');
  assert.equal(preview2.candidates[1].persona, '【姓名】陈念\n【目标】攒够签证费');
});

test('salvageTruncatedJson recovers partial reply and marks interruption cleanly', () => {
  const truncated = '{\n  "mode": "chat",\n  "reply": "这个点子太正了！Milo 把第二份草稿抽出来摆到桌心，指';
  const salvaged = salvageTruncatedJson(truncated, 'auto');
  assert.equal(salvaged.truncated, true);
  assert.ok(!salvaged.reply.startsWith('{'));
  assert.ok(salvaged.reply.includes('这个点子太正了！'));
  assert.ok(salvaged.reply.includes('接口返回在此处中断'));
});

test('inferCandidateName extracts clean persona name from explicit field or body headings', () => {
  assert.equal(inferCandidateName({ name: '许听澜', title: '跳板过客', persona: '正文' }, 0), '许听澜');
  assert.equal(inferCandidateName({ title: '跳板过客', persona: '【姓名】陆明昭（21岁）\n【身份】港大交换生' }, 0), '陆明昭');
  assert.equal(inferCandidateName({ title: '半山家教兼职生', persona: '一段没有姓名标签的描述' }, 1), '半山家教兼职生');
});

