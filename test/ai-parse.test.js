/**
 * 测试：AI 菜谱解析层（server/services/ai-recipe-parse.js）
 *
 * 覆盖：端点拼接、JSON 提取（代码围栏 / 前后废话 / 数组包裹 / 字符串里的花括号）、
 *       数值吸取、食材归一（对象/字符串/数量在后）、完整菜谱收敛与「没标题就降级」。
 *
 * 说明：这一层刻意不 import 数据库，所以在 Node 20 上同样全量运行 ——
 *       和 test/import-csv.test.js 一样属于「纯函数层测试」。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  endpointUrl,
  extractJsonObject,
  toPositiveInt,
  toStringArray,
  normalizeIngredient,
  normalizeAiRecipe,
} from '../server/services/ai-recipe-parse.js';

test('endpointUrl: 自动补 /chat/completions，重复后缀不再拼接', () => {
  assert.equal(endpointUrl('https://api.openai.com/v1'), 'https://api.openai.com/v1/chat/completions');
  assert.equal(endpointUrl('https://x.dev/v1/'), 'https://x.dev/v1/chat/completions');
  assert.equal(
    endpointUrl('https://x.dev/v1/chat/completions'),
    'https://x.dev/v1/chat/completions',
  );
  assert.equal(endpointUrl(''), null);
  assert.equal(endpointUrl(null), null);
});

test('extractJsonObject: 提取裸 JSON 对象', () => {
  const parsed = extractJsonObject('{"title":"Suppe","servings":2}');
  assert.deepEqual(parsed, { title: 'Suppe', servings: 2 });
});

test('extractJsonObject: 剥掉 ```json 代码围栏', () => {
  const parsed = extractJsonObject('```json\n{"title":"Suppe"}\n```');
  assert.deepEqual(parsed, { title: 'Suppe' });
});

test('extractJsonObject: 前后夹带自然语言时也能挖出来', () => {
  const text = 'Klar! Hier ist ein Rezept:\n{"title":"Curry","steps":["a","b"]}\nGuten Appetit.';
  assert.deepEqual(extractJsonObject(text), { title: 'Curry', steps: ['a', 'b'] });
});

test('extractJsonObject: 顶层是数组时取第一个对象', () => {
  assert.deepEqual(extractJsonObject('[{"title":"A"},{"title":"B"}]'), { title: 'A' });
});

test('extractJsonObject: 字符串里的花括号不干扰配对扫描', () => {
  const text = '{"title":"Rezept {neu}","servings":1}';
  assert.deepEqual(extractJsonObject(text), { title: 'Rezept {neu}', servings: 1 });
});

test('extractJsonObject: 没有 JSON / 花括号不成对时返回 null', () => {
  assert.equal(extractJsonObject('Ich bin ein Text ohne JSON.'), null);
  assert.equal(extractJsonObject('{"title":"kaputt"'), null);
  assert.equal(extractJsonObject(''), null);
  assert.equal(extractJsonObject(null), null);
});

test('toPositiveInt: 数字、带单位文本、空值与负数的四种结果', () => {
  assert.equal(toPositiveInt(3), 3);
  assert.equal(toPositiveInt('30 分钟'), 30);
  assert.equal(toPositiveInt('about 25 mins'), 25);
  assert.equal(toPositiveInt(''), null);
  assert.equal(toPositiveInt(null), null);
  assert.equal(toPositiveInt(-5), null);
  assert.equal(toPositiveInt('unbekannt'), null);
});

test('toStringArray: 数组原样收敛，字符串按逗号/顿号/分号切', () => {
  assert.deepEqual(toStringArray(['快', '素食']), ['快', '素食']);
  assert.deepEqual(toStringArray('vegetarisch, schnell'), ['vegetarisch', 'schnell']);
  assert.deepEqual(toStringArray('快手菜、素食'), ['快手菜', '素食']);
  assert.deepEqual(toStringArray(''), []);
});

test('normalizeIngredient: 对象写法与字符串写法都能归一', () => {
  assert.deepEqual(
    normalizeIngredient({ name: 'Ei', quantity: '2 Stück', category: 'Sonstiges' }),
    { name: 'Ei', quantity: '2 Stück', category: 'Sonstiges' },
  );
  assert.deepEqual(normalizeIngredient('Milch'), { name: 'Milch', quantity: null, category: 'Sonstiges' });
  // 数量写在名字后面（口语常见）
  assert.deepEqual(normalizeIngredient('Reis 200 g'), { name: 'Reis', quantity: '200 g', category: 'Sonstiges' });
  assert.equal(normalizeIngredient('   '), null);
  assert.equal(normalizeIngredient(null), null);
});

test('normalizeAiRecipe: 完整对象 → 可落库形状（步骤自动编号）', () => {
  const recipe = normalizeAiRecipe({
    title: 'Tomatensuppe',
    servings: 2,
    duration_minutes: 25,
    tags: ['schnell', 'vegetarisch'],
    ingredients: [{ name: 'Tomate', quantity: '4 Stück', category: 'Gemüse' }, 'Salz'],
    steps: ['Zwiebel anschwitzen', 'Tomaten dazu'],
  });

  assert.equal(recipe.title, 'Tomatensuppe');
  assert.equal(recipe.servings, 2);
  assert.equal(recipe.durationMinutes, 25);
  assert.deepEqual(recipe.tags, ['schnell', 'vegetarisch']);
  assert.equal(recipe.ingredients.length, 2);
  assert.deepEqual(recipe.ingredients[0], { name: 'Tomate', quantity: '4 Stück', category: 'Gemüse' });
  assert.deepEqual(recipe.ingredients[1], { name: 'Salz', quantity: null, category: 'Sonstiges' });
  assert.equal(recipe.notes, '1. Zwiebel anschwitzen\n2. Tomaten dazu');
});

test('normalizeAiRecipe: 中文字段名（steps/食材/份量）也能识别', () => {
  const recipe = normalizeAiRecipe({
    菜名: '番茄炒蛋',
    份量: '3',
    时长: '15分钟',
    食材: ['鸡蛋', '番茄'],
    步骤: ['打蛋', '下锅'],
  });
  assert.equal(recipe.title, '番茄炒蛋');
  assert.equal(recipe.servings, 3);
  assert.equal(recipe.durationMinutes, 15);
  assert.equal(recipe.ingredients.length, 2);
  assert.equal(recipe.notes, '1. 打蛋\n2. 下锅');
});

test('normalizeAiRecipe: 已经是编号的步骤不重复编号', () => {
  const recipe = normalizeAiRecipe({ title: 'X', steps: ['1. Aufwärmen', '2. Servieren'] });
  assert.equal(recipe.notes, '1. Aufwärmen\n2. Servieren');
});

test('normalizeAiRecipe: 缺标题返回 null（触发前端纯文本降级）', () => {
  assert.equal(normalizeAiRecipe({ steps: ['irgendwas'] }), null);
  assert.equal(normalizeAiRecipe({}), null);
  assert.equal(normalizeAiRecipe(null), null);
});

test('normalizeAiRecipe: instructions/notes/instructions 三种备注来源都有兜底', () => {
  assert.equal(normalizeAiRecipe({ title: 'A', instructions: 'Rühren' }).notes, 'Rühren');
  assert.equal(normalizeAiRecipe({ title: 'A', notes: 'Notiz' }).notes, 'Notiz');
  assert.equal(normalizeAiRecipe({ title: 'A' }).notes, null);
});
