import { t } from '/i18n.js';

export const DEFAULT_CATEGORY_NAME = 'Sonstiges';

export const DEFAULT_CATEGORY_I18N = {
  'Obst & Gemüse':   'shopping.catFruitVeg',
  'Backwaren':       'shopping.catBakery',
  'Milchprodukte':   'shopping.catDairy',
  'Fleisch & Fisch': 'shopping.catMeatFish',
  'Tiefkühl':        'shopping.catFrozen',
  'Getränke':        'shopping.catDrinks',
  'Haushalt':        'shopping.catHousehold',
  'Drogerie':        'shopping.catDrugstore',
  'Sonstiges':       'shopping.catMisc',
};

export function categoryLabel(name) {
  const key = DEFAULT_CATEGORY_I18N[name];
  return key ? t(key) : name;
}
