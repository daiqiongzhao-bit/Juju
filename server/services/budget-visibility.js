// --------------------------------------------------------
// Owner-basierte Sichtbarkeit für Budget-Objekte (Einträge/Loans/Subscriptions).
//
// Lean-Modell (#476/#505). Anders als services/visibility.js (assignment-basiert,
// mehrere Zugewiesene pro Objekt) hat jedes Budget-Objekt genau eine:n
// Eigentümer:in (owner_id, fix = Ersteller:in). Es gibt KEINEN Admin-Bypass —
// auch Admins sehen/bearbeiten keine fremden privaten Objekte (konsistent mit
// #474). Privatsphäre wird allein über visibility='private' + owner-Enforcement
// geschützt, nicht über Rollen.
//
// Zwei Achsen:
//   visibility ('private' | 'shared')  – wer darf das Objekt SEHEN
//   Ansichts-Scope ('mine' | 'household') – reiner Anzeige-Filter im Personal-Modus
//
// Der Haushalts-Modus (budget_mode: 'shared' | 'personal') entscheidet, ob die
// Sichtbarkeit überhaupt greift: im 'shared'-Modus sehen alle alles (Altverhalten).
// --------------------------------------------------------

export const BUDGET_VISIBILITY_VALUES = ['private', 'shared'];

/**
 * Liest den Haushalts-Budget-Modus aus sync_config. DB wird injiziert, damit
 * dieses Modul DB-frei/testbar bleibt und alle Call-Sites (budget.js,
 * subscriptions.js, dashboard.js) denselben Wert ohne Drift nutzen (#476/#505).
 * @param {{ prepare: Function }} database  better-sqlite3/node:sqlite-Instanz
 * @returns {'shared'|'personal'}
 */
export function resolveBudgetMode(database) {
  const row = database.prepare("SELECT value FROM sync_config WHERE key = 'budget_mode'").get();
  return row && row.value === 'personal' ? 'personal' : 'shared';
}

/** Normalisiert einen eingehenden Wert auf eine gültige Stufe. */
export function normalizeBudgetVisibility(value, fallback = 'shared') {
  return BUDGET_VISIBILITY_VALUES.includes(value) ? value : fallback;
}

/**
 * WHERE-Fragment für die Lese-Durchsetzung (ohne führendes AND). KEIN Admin-Bypass.
 *
 * @param {string} alias   Tabellen-Alias des Budget-Objekts (z. B. 'b')
 * @param {string} meBind  Platzhalter der betrachtenden User-ID (z. B. '@me')
 * @param {object} opts    { mode: 'shared' | 'personal' }
 * @returns {string} SQL-Fragment
 */
export function budgetVisibilityWhere(alias, meBind, { mode } = {}) {
  if (mode !== 'personal') return '1=1'; // 'shared'/undefined: Altverhalten, alle sehen alles
  return `(${alias}.visibility = 'shared' OR ${alias}.owner_id = ${meBind})`;
}

/**
 * Ansichts-Filter (Mein Budget vs. Haushalt). Reiner Filter, additiv zur
 * Sichtbarkeit.
 *   'mine'      → owner_id = me       (meine privaten + meine geteilten)
 *   'household' → visibility='shared' (der gemeinsame Topf)
 *
 * @param {string} scope  'mine' | 'household'
 * @param {string} alias  Tabellen-Alias
 * @param {string} meBind Platzhalter der betrachtenden User-ID
 * @returns {string} SQL-Fragment (ohne führendes AND)
 */
export function budgetScopeWhere(scope, alias, meBind) {
  if (scope === 'mine') return `${alias}.owner_id = ${meBind}`;
  return `${alias}.visibility = 'shared'`;
}

/**
 * Schreib-Berechtigung für PUT/DELETE (KEIN Admin-Bypass).
 * @param {{ owner_id?: number, created_by?: number } | null} entry
 * @param {{ id: number }} user
 */
export function canEditEntry(entry, user) {
  if (!entry || !user) return false;
  return entry.owner_id === user.id || entry.created_by === user.id;
}
