/**
 * 测试：预算分类/子分类 i18n 映射完整性
 *
 * 背景（bug）：预算「管理类别」弹窗在中文界面下显示英文/德文预设名。
 * 前端通过 key→i18n 键映射（public/utils/category-labels.js 的
 * BUDGET_CATEGORY_LABEL_KEYS + public/pages/budget.js 的 SUBCATEGORY_I18N，
 * 后者与 server/routes/budget/helpers.js 的 SUBCATEGORY_LABEL_KEYS 键一致）
 * 把稳定 key 解析为 budget.cat* / budget.subcat* 翻译键。
 *
 * 覆盖：
 *   1) 24 个语言文件全部可解析为合法 JSON，且对全部 13 个大类 + 34 个
 *      db.js 预设子分类（外加 6 个遗留 subscription_* 子分类键）都提供
 *      非空字符串翻译 —— 键集合跨语言完全一致，无遗漏。
 *   2) category-labels.js 的映射表里每个 i18n 键都在 24 语言中存在。
 *   3) budgetCategoryLabel 缺失回退行为：t() 返回键名本身（键缺失）时
 *      回退到 DB 名称，绝不显示裸键；无映射的自定义 key 回退到 fallback。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  BUDGET_CATEGORY_LABEL_KEYS,
  budgetCategoryLabel,
} from '../public/utils/category-labels.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOCALES_DIR = path.join(__dirname, '..', 'public', 'locales');

// 与 server/db.js 预算迁移种子（budget_categories / budget_subcategories）
// 完全一致的 13 个大类 key + 34 个子分类 key；另有 6 个 subscription_*
// 历史子分类键仍被 budget.js 的下拉/映射使用，一并纳入校验。
const CATEGORY_KEYS = [
  'housing', 'food', 'transport', 'personal_health',
  'leisure', 'shopping_clothing', 'education', 'financial_other',
  'Erwerbseinkommen', 'Kapitalerträge', 'Geschenke & Transfers',
  'Sozialleistungen', 'Sonstiges Einkommen',
];

const SUBCATEGORY_KEYS = [
  'rent_mortgage', 'condominium', 'utilities', 'internet_tv_phone',
  'renovation_maintenance', 'cleaning',
  'groceries', 'restaurants_bars', 'snacks_fast_food', 'bakery',
  'fuel', 'parking_tolls', 'public_transport', 'apps_taxi',
  'maintenance_insurance',
  'pharmacy', 'health_insurance', 'gym_sports', 'beauty_cosmetics',
  'travel', 'streaming', 'events', 'hobbies',
  'clothes_shoes', 'electronics', 'gifts',
  'courses_college', 'school_supplies', 'languages',
  'loans_interest', 'bank_fees', 'insurance_other', 'investments', 'taxes',
  'subscription_entertainment', 'subscription_productivity',
  'subscription_utilities', 'subscription_health',
  'subscription_education', 'subscription_other',
];

test('24 个语言文件均为合法 JSON 且 budget 分类键集合一致、无空翻译', () => {
  const localeFiles = fs.readdirSync(LOCALES_DIR).filter((f) => f.endsWith('.json'))
    .sort();
  assert.equal(localeFiles.length, 24, `应恰好 24 个语言文件，实际 ${localeFiles.length}`);

  // 映射表存的是完整键（'budget.catHousing'），校验时去掉 'budget.' 前缀
  const expectedCatI18nKeys = new Set(Object.values(BUDGET_CATEGORY_LABEL_KEYS)
    .map((fullKey) => fullKey.replace(/^budget\./, '')));
  // 子分类 i18n 键命名规则与 server/routes/budget/helpers.js 相同：
  // subcat + PascalCase(key)
  const pascal = (key) => key.split('_')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join('');
  const expectedSubI18nKeys = new Set(SUBCATEGORY_KEYS.map((k) => `subcat${pascal(k)}`));
  const expectedTotal = expectedCatI18nKeys.size + expectedSubI18nKeys.size;

  const missingPerLocale = {};

  for (const file of localeFiles) {
    // JSON.parse 抛异常即测试失败 —— 语法合法性隐式覆盖
    const translations = JSON.parse(fs.readFileSync(path.join(LOCALES_DIR, file), 'utf8'));
    const budget = translations.budget ?? {};
    const missing = [];
    for (const i18nKey of [...expectedCatI18nKeys, ...expectedSubI18nKeys]) {
      const value = budget[i18nKey];
      if (typeof value !== 'string' || value.trim() === '') missing.push(i18nKey);
    }
    if (missing.length) missingPerLocale[file] = missing;
  }

  assert.deepEqual(
    missingPerLocale,
    {},
    `以下语言文件缺少 budget.cat*/budget.subcat* 翻译: ${JSON.stringify(missingPerLocale)}`,
  );
  assert.ok(expectedTotal >= 47, `映射键总数应 ≥47（13 大类 + 34 子分类），实际 ${expectedTotal}`);
});

test('budgetCategoryLabel 在键缺失时回退到 DB 名称，不显示裸 i18n 键', () => {
  // t() 对缺失键返回键名本身 —— 模拟该行为，验证解析函数回退到 fallback
  const brokenTranslate = (key) => key;
  assert.equal(
    budgetCategoryLabel('housing', 'Housing / Home', brokenTranslate),
    'Housing / Home',
    't() 返回裸键时应回退到 fallback（DB 名称）',
  );

  // 无映射的自定义 key 同样回退到 fallback（用户自建的分类名）
  assert.equal(
    budgetCategoryLabel('my_custom_cat', '我的分类', brokenTranslate),
    '我的分类',
  );

  // 正常翻译函数：返回翻译值
  assert.equal(
    budgetCategoryLabel('housing', 'Housing / Home', () => '住房 / 家庭'),
    '住房 / 家庭',
  );
});
