/**
 * Geteilte Zutaten-Zeile (Kitchen-Grammatik)
 * Eine Implementierung für Mahlzeiten- und Rezept-Modals — vorher dupliziert als
 * meals.js#ingredientRowHTML (Template) und recipes.js#buildIngredientRow (DOM-API).
 * Markup + Klassen (.ingredient-row*) sind global in layout.css gestylt, da Modals
 * im geteilten Overlay rendern (nicht im modul-spezifischen Seiten-Stylesheet).
 */

import { t } from '/i18n.js';
import { esc } from '/utils/html.js';
import { DEFAULT_CATEGORY_NAME, categoryLabel } from '/utils/shopping-categories.js';

/**
 * @param {object} opts
 * @param {string} [opts.name]       Zutatenname
 * @param {string} [opts.quantity]   Menge
 * @param {number|string|null} [opts.id]  Bestehende Zutaten-ID (für Update-Sync)
 * @param {string} [opts.category]   Wunsch-Kategorie
 * @param {Array<{name:string}>} [opts.categories]  Verfügbare Kategorien (bereits gefiltert)
 * @returns {string} HTML-String einer `.ingredient-row`
 */
export function ingredientRowHTML({
  name = '',
  quantity = '',
  id = null,
  category = DEFAULT_CATEGORY_NAME,
  categories = [],
} = {}) {
  const resolvedCategory = categories.some((c) => c.name === category)
    ? category
    : (categories[0]?.name ?? DEFAULT_CATEGORY_NAME);

  const catOptions = categories.length
    ? categories.map((c) =>
        `<option value="${esc(c.name)}" ${c.name === resolvedCategory ? 'selected' : ''}>${esc(categoryLabel(c.name))}</option>`
      ).join('')
    : `<option value="${DEFAULT_CATEGORY_NAME}" selected>${t('meals.ingredientCategoryDefault')}</option>`;

  return `
    <div class="ingredient-row" data-ing-id="${id ?? ''}">
      <input type="text" class="form-input ingredient-row__name" placeholder="${t('meals.ingredientNamePlaceholder')}" value="${esc(name)}">
      <input type="text" class="form-input ingredient-row__qty" placeholder="${t('meals.ingredientQtyPlaceholder')}" value="${esc(quantity)}">
      <select class="form-input ingredient-row__cat" aria-label="${t('meals.ingredientCategoryLabel')}">${catOptions}</select>
      <button class="ingredient-row__remove" data-action="remove-ingredient" type="button" aria-label="${t('meals.removeIngredient')}">
        <i data-lucide="x" class="icon-sm" aria-hidden="true"></i>
      </button>
    </div>
  `;
}
