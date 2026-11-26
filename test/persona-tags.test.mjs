import test from 'node:test';
import assert from 'node:assert/strict';

import {
  PERSONA_TAG_PALETTE,
  contrastTagTextColor,
  normalizePersonaTagCatalog,
  normalizePersonaTagList,
  normalizeTagColor,
  readExternalPersonaTags,
} from '../adapter.js';
import { createApp } from '../ui.js';

test('normalizePersonaTagList cleans whitespace, strips #, deduplicates case-insensitively and splits commas', () => {
  assert.deepEqual(
    normalizePersonaTagList(' #女大， 现代, 女大、男高 ; 现代 '),
    ['女大', '现代', '男高'],
  );
  assert.deepEqual(normalizePersonaTagList(['  甜妹 ', '甜妹', '', null, '冷面']), ['甜妹', '冷面']);
});

test('contrastTagTextColor chooses dark ink on pastel colors and light ink on deep Morandi colors', () => {
  assert.equal(contrastTagTextColor('#f5e6b3'), '#1e1c1a');
  assert.equal(contrastTagTextColor('rgb(240, 220, 200)'), '#1e1c1a');
  assert.equal(contrastTagTextColor('#8b6f8e'), '#f8f6f2');
  assert.equal(contrastTagTextColor('#5f7f96'), '#f8f6f2');
  assert.equal(normalizeTagColor('javascript:alert(1)', '女大'), normalizeTagColor('', '女大'));
  assert.ok(PERSONA_TAG_PALETTE.includes(normalizeTagColor('', '女大')));
});

test('readExternalPersonaTags reads XiaoBai20001212/persona-tags (extensionSettings.personaTags.tagMap) seamlessly', () => {
  const ctx = {
    extensionSettings: {
      personaTags: {
        tagMap: {
          'user_a.png': ['女大', '现代'],
          'user_b.png': ['男高', '校园'],
        },
        tagOrder: ['女大', '男高', '现代', '校园'],
      },
    },
  };
  const ext = readExternalPersonaTags(ctx, null);
  assert.deepEqual(
    ext.byPersonaId['user_a.png'].map(t => t.name),
    ['女大', '现代'],
  );
  assert.deepEqual(
    ext.byPersonaId['user_b.png'].map(t => t.name),
    ['男高', '校园'],
  );
  assert.equal(ext.byPersonaId['user_a.png'][0].source, 'persona-tags');
  assert.ok(PERSONA_TAG_PALETTE.includes(ext.byPersonaId['user_a.png'][0].color));
  assert.deepEqual(ext.catalog.map(t => t.name), ['女大', '男高', '现代', '校园']);
});

test('readExternalPersonaTags reads both PersonaTools and Samueras/PersonaTags non-destructively with original colors', () => {
  const ctx = {
    extensionSettings: {
      PersonaTools: {
        persona_tags: [
          { id: 't1', name: '女大', color: '#9c6fa0' },
          { id: 't2', name: '现代', color: '#c48a47' },
        ],
        persona_tag_map: {
          'p1.png': ['t1', 't2'],
        },
      },
    },
  };
  const scriptMod = {
    settings: {
      persona_tags: [
        { id: 's1', name: '男高', color: '#a86762' },
        { id: 's2', name: '女大', color: '#9c6fa0' },
      ],
      persona_tag_map: {
        'p1.png': ['s2'],
        'p2.png': ['s1'],
      },
    },
  };

  const ext = readExternalPersonaTags(ctx, scriptMod);
  assert.deepEqual(
    ext.byPersonaId['p1.png'].map(t => [t.name, t.color]),
    [['女大', '#9c6fa0'], ['现代', '#c48a47']],
  );
  assert.deepEqual(
    ext.byPersonaId['p2.png'].map(t => [t.name, t.color]),
    [['男高', '#a86762']],
  );
  assert.equal(ext.catalog.length, 3);
});

test('Persona Studio library hides all tag chrome when no persona is tagged and renders pills + filters when tagged', () => {
  const app = createApp({ actions: {}, report: () => {} });

  // 1. Untagged state: zero tag rows and zero filter bar (clean for users who never tag)
  app.update({
    state: { personaMeta: {}, personaGroups: [], personaTags: [] },
    personas: [
      { id: 'u1.png', name: '清砚', title: '日常', description: '喜欢极简界面', isCurrent: true },
    ],
    externalTags: { byPersonaId: {}, catalog: [] },
  });
  const untaggedHtml = app.library();
  assert.equal(untaggedHtml.includes('ytps-row-tags'), false, '无标签人设不渲染卡片标签区');
  assert.equal(untaggedHtml.includes('ytps-tag-filter-bar'), false, '全局无标签时不渲染标签筛选条');
  assert.equal(app.current().includes('ytps-current-tags'), false, '当前人设无标签时不渲染标签区');

  // 2. Mixed state: p1 has external PersonaTags, p2 has native Persona Studio tags, p3 has no tags
  app.update({
    state: {
      personaMeta: {
        'p2.png': { tags: ['男高', '现代'], tagsUpdatedAt: 100 },
        'p3.png': { tags: [], tagsUpdatedAt: 100 }, // explicitly cleared override beats external tags
      },
      personaGroups: [],
      personaTags: normalizePersonaTagCatalog([{ name: '男高', color: '#a86762', updatedAt: 100 }]),
    },
    personas: [
      { id: 'p1.png', name: '林晚', title: '校园', description: '大二摄影系', isCurrent: true },
      { id: 'p2.png', name: '周砚', title: '现代', description: '高中篮球队', isCurrent: false },
      { id: 'p3.png', name: '无标签', title: '留白', description: '极简展示', isCurrent: false },
    ],
    current: { persona: { id: 'p1.png', name: '林晚', description: '大二摄影系' }, scope: 'global' },
    externalTags: {
      byPersonaId: {
        'p1.png': [{ name: '女大', color: '#8b6f8e', source: 'PersonaTags' }],
        'p3.png': [{ name: '旧标签', color: '#6e8577', source: 'PersonaTags' }],
      },
      catalog: [{ name: '女大', color: '#8b6f8e', source: 'PersonaTags' }],
    },
  });

  const mixedHtml = app.library();
  assert.ok(mixedHtml.includes('ytps-tag-filter-bar'), '存在标签时渲染顶部标签筛选条');
  assert.ok(mixedHtml.includes('女大'), '兼容显示外部插件旧标签');
  assert.ok(mixedHtml.includes('#8b6f8e'), '保留外部标签原色');
  assert.ok(mixedHtml.includes('男高'), '显示人设馆原生标签');
  assert.equal(mixedHtml.includes('旧标签'), false, '在人设馆显式清空标签后不再回显旧外部标签');
  assert.equal(app.personaRow(app.state.personas[2]).includes('ytps-row-tags'), false, '单张无标签卡仍不渲染标签行');
  assert.ok(app.current().includes('ytps-current-tags'), '当前生效人设有标签时在当前页展示');

  // 3. Tag filtering (AND logic) & search by tag name
  app.state.libraryTags = ['男高'];
  const filteredHtml = app.library();
  assert.ok(filteredHtml.includes('周砚'));
  assert.equal(filteredHtml.includes('林晚'), false);
  assert.ok(filteredHtml.includes('data-action="clear-tag-filter"'));

  app.state.libraryTags = [];
  app.state.query = '女大';
  const searchHtml = app.library();
  assert.ok(searchHtml.includes('林晚'), '搜索框可直接搜到标签名');
  assert.equal(searchHtml.includes('周砚'), false);

  // 4. Editor pre-populates external tags so users can seamlessly edit/recolor them
  app.state.query = '';
  app.state.activeTab = 'editor';
  app.state.editingPersonaId = 'p1.png';
  app.state.editorDraft = null;
  const editorHtml = app.editor();
  assert.ok(editorHtml.includes('ytps-tag-editor'), '编辑页呈现标签编辑器');
  assert.ok(editorHtml.includes('女大'), '编辑页自动预填外部旧标签');
  assert.ok(editorHtml.includes('男高'), '编辑页推荐栏显示其他已有常用标签');
});
