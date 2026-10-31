/**
 * Modul: 家庭库存管理（一级导航）
 * Zweck: 家庭级库存入口——与厨房 Tab「库存」(/pantry) 共用同一份数据
 *        (/api/v1/pantry)，但作为「家庭」分组下的一级页面独立呈现，
 *        不带厨房四步循环的 Tab 栏。
 * Datenstruktur: pantry_items 已为后续「根据库存推荐菜谱」预留
 *        ingredient_key（归一化食材名，Migration 169），菜谱匹配时与
 *        recipe_ingredients.name 做同规则归一化后对比即可。
 * Abhängigkeiten: /pages/pantry.js（复用其 render）
 */

import { render as renderPantry } from '/pages/pantry.js';

export async function render(container) {
  return renderPantry(container, { titleKey: 'nav.familyInventory' });
}
