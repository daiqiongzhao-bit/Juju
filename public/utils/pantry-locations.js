import { t } from '/i18n.js';

/**
 * Modul: Vorrats-Lagerorte (Pantry locations)
 * Zweck: Anzeige-Label der Seed-Lagerorte. Spiegelt bewusst das Muster von
 *        utils/shopping-categories.js: in der DB stehen deutsche Klarnamen,
 *        übersetzt wird nur, was unverändert aus dem Seed stammt. Benennt ein
 *        Haushalt "Keller" in "Garage" um, bleibt "Garage" in jeder Sprache
 *        stehen - der eigene Begriff schlägt die Übersetzung.
 */

export const DEFAULT_LOCATION_I18N = {
  'Vorratsschrank': 'pantry.locPantry',
  'Kühlschrank':    'pantry.locFridge',
  'Gefrierschrank': 'pantry.locFreezer',
  'Keller':         'pantry.locCellar',
  'Sonstiges':      'pantry.locOther',
};

export function locationLabel(name) {
  const key = DEFAULT_LOCATION_I18N[name];
  return key ? t(key) : name;
}
