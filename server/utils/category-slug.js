/**
 * Modul: Kategorie-Slug-Helfer
 * Zweck: Stabile, kollisionsfreie Keys für benutzerdefinierte Kategorien erzeugen
 *        (geteilt von Tasks- und Contacts-Routen; analog zur privaten Budget-Variante).
 */

/** Freitext in einen ASCII-Slug (a–z0–9_) überführen; Fallback 'category'. */
export function slugify(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 48) || 'category';
}

/**
 * Eindeutigen Key für `table` (Spalte `key`) aus `base` ableiten.
 * Bei Kollision wird _2, _3, … angehängt.
 */
export function uniqueKey(database, table, base) {
  const normalized = slugify(base);
  let key = normalized;
  let i = 2;
  const exists = database.prepare(`SELECT 1 FROM ${table} WHERE key = ?`);
  while (exists.get(key)) {
    key = `${normalized}_${i}`;
    i += 1;
  }
  return key;
}
