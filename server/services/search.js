/**
 * Modul: Such-Service (FTS5)
 * Zweck: Reine Suchlogik gegen den FTS5-Index `search_index` (Migration 44).
 *        Keine Abhängigkeit auf db.js - die Datenbank wird hereingereicht, damit
 *        die Logik direkt mit node:sqlite getestet werden kann.
 */

export const SEARCH_LIMIT = 5;

/**
 * Erzeugt die ß↔ss-Schreibvarianten eines Tokens. Der FTS-Tokenizer faltet
 * Akzente (unicode61 remove_diacritics 2, Migration 77), aber NICHT das Eszett —
 * „strasse" fände „Straße" sonst nicht (und umgekehrt). Beide Richtungen werden
 * als OR-Zweige gematcht: ss→ß ist mehrdeutig, die überzähligen Varianten treffen
 * aber schlicht nichts (harmlos). Menge dedupliziert; ohne ß/ss bleibt es 1 Token.
 */
function eszettVariants(token) {
  return new Set([
    token,
    token.replace(/ß/g, 'ss').replace(/ẞ/g, 'ss'),
    token.replace(/ss/gi, 'ß'),
  ]);
}

/**
 * Wandelt eine rohe Nutzereingabe in eine sichere FTS5-MATCH-Query um.
 * Jedes Token wird als Phrase in doppelte Anführungszeichen gesetzt (eingebettete
 * Anführungszeichen verdoppelt) und als Präfix (`*`) gematcht, damit Teiltreffer
 * wie bei der alten LIKE-Suche funktionieren. Tokens werden mit AND verknüpft;
 * ß↔ss-Varianten je Token mit OR. Gibt null zurück, wenn nichts Suchbares bleibt.
 */
export function buildMatchQuery(q) {
  const tokens = String(q || '')
    .split(/\s+/)
    .map((t) => t.replace(/[^\p{L}\p{N}_]+/gu, ''))
    .filter(Boolean);
  if (!tokens.length) return null;
  return tokens.map((t) => {
    const clause = [...eszettVariants(t)]
      .map((v) => `"${v.replace(/"/g, '""')}"*`)
      .join(' OR ');
    return clause.includes(' OR ') ? `(${clause})` : clause;
  }).join(' AND ');
}

/**
 * Führt die Suche aus und liefert dieselbe Ergebnis-Form wie zuvor, erweitert
 * um Gesundheitsdaten: { tasks, events, notes, contacts, items, meds, activities }.
 * Pro Entität wird der FTS-Treffer auf die Quelltabelle zurückgejoined,
 * um exakt die alten Felder, Besitzer-Filter und Sortierung zu erhalten.
 * Gesundheitsdaten sind sensibel: nur eigene Zeilen ODER visibility='family'
 * sind sichtbar (spiegelt das Lese-Scoping der Health-List-Routen).
 */
export function runSearch(database, q, userId, isAdmin = false) {
  const match = buildMatchQuery(q);
  if (!match) {
    return { tasks: [], events: [], notes: [], contacts: [], items: [], meds: [], activities: [], gifts: [], media: [], documents: [], recipes: [] };
  }
  const limit = SEARCH_LIMIT;

  const tasks = database.prepare(`
    SELECT t.id, t.title, t.status, t.priority, t.due_date
    FROM search_index s
    JOIN tasks t ON t.id = s.entity_id
    WHERE s.entity = 'task' AND s.search_index MATCH @match
      AND t.parent_task_id IS NULL
      AND (t.created_by = @userId OR t.assigned_to = @userId)
    ORDER BY CASE t.status WHEN 'done' THEN 1 ELSE 0 END,
             t.due_date ASC NULLS LAST
    LIMIT @limit
  `).all({ match, userId, limit });

  // Termine sind Familienbesitz (die Kalenderliste zeigt alle Termine, nicht nur
  // eigene) — daher KEIN created_by-Filter, konsistent mit GET /calendar und der
  // Kalender-Suche (#471). Sonst lieferten globale vs. Kalender-Suche unterschiedliche
  // Treffer fürs gleiche Stichwort.
  const events = database.prepare(`
    SELECT e.id, e.title, e.start_datetime, e.all_day
    FROM search_index s
    JOIN calendar_events e ON e.id = s.entity_id
    WHERE s.entity = 'event' AND s.search_index MATCH @match
    ORDER BY e.start_datetime ASC
    LIMIT @limit
  `).all({ match, limit });

  const notes = database.prepare(`
    SELECT n.id, n.title, n.content
    FROM search_index s
    JOIN notes n ON n.id = s.entity_id
    WHERE s.entity = 'note' AND s.search_index MATCH @match
      AND n.created_by = @userId
    ORDER BY n.pinned DESC, n.updated_at DESC
    LIMIT @limit
  `).all({ match, userId, limit });

  const contacts = database.prepare(`
    SELECT c.id, c.name AS title
    FROM search_index s
    JOIN contacts c ON c.id = s.entity_id
    WHERE s.entity = 'contact' AND s.search_index MATCH @match
    ORDER BY c.name ASC
    LIMIT @limit
  `).all({ match, limit });

  const items = database.prepare(`
    SELECT i.id, i.name AS title, i.list_id
    FROM search_index s
    JOIN shopping_items i ON i.id = s.entity_id
    WHERE s.entity = 'item' AND s.search_index MATCH @match
    ORDER BY i.name ASC
    LIMIT @limit
  `).all({ match, limit });

  // Health: Medikamente — Treffer auf Name/Dosistext, Sichtbarkeits-Scoping.
  const meds = database.prepare(`
    SELECT m.id, m.name AS title, m.dosage_text, m.active
    FROM search_index s
    JOIN medications m ON m.id = s.entity_id
    WHERE s.entity = 'medication' AND s.search_index MATCH @match
      AND (m.user_id = @userId OR m.visibility = 'family')
    ORDER BY m.active DESC, m.name ASC
    LIMIT @limit
  `).all({ match, userId, limit });

  // Health: Aktivitäten — Treffer auf Typ/Notiz, Sichtbarkeits-Scoping.
  const activities = database.prepare(`
    SELECT a.id, a.type AS title, a.note, a.performed_at
    FROM search_index s
    JOIN health_activities a ON a.id = s.entity_id
    WHERE s.entity = 'activity' AND s.search_index MATCH @match
      AND (a.user_id = @userId OR a.visibility = 'family')
    ORDER BY a.performed_at DESC
    LIMIT @limit
  `).all({ match, userId, limit });

  // Geschenkregister: NICHT im FTS-Index (das Modul legt bewusst keinen
  // search_index-Eintrag an), sondern LIKE-Scan auf die sichtbaren Spalten.
  // Privat-Scoping: nur eigene Zeilen — plus alle Zeilen für Admins.
  const giftLike = `%${String(q).replace(/[%_]/g, (m) => '\\' + m)}%`;
  const gifts = database.prepare(`
    SELECT g.id, g.event_name AS title, g.type, g.event_date, g.giver, g.amount, g.relationship
    FROM gift_ledger g
    WHERE (g.is_private = 0 OR g.creator_uid = @userId OR @isAdmin = 1)
      AND (g.event_name LIKE @like ESCAPE '\\' OR g.giver LIKE @like ESCAPE '\\'
           OR g.relationship LIKE @like ESCAPE '\\' OR g.note LIKE @like ESCAPE '\\')
    ORDER BY (g.event_date IS NULL), g.event_date DESC, g.created_at DESC
    LIMIT @limit
  `  ).all({ like: giftLike, userId, limit, isAdmin: isAdmin ? 1 : 0 });

  // Medienbibliothek: LIKE-Scan wie Geschenkregister (kein FTS-Eintrag).
  // Sichtbarkeit wie GET /media/list: private Zeilen nur für Ersteller/Admin.
  const media = database.prepare(`
    SELECT mi.id, mi.title, mi.media_type, mi.cover_url, mi.status
    FROM media_item mi
    WHERE (mi.is_private = 0 OR mi.creator_uid = @userId OR @isAdmin = 1)
      AND (mi.title LIKE @like ESCAPE '\\' OR mi.comment LIKE @like ESCAPE '\\')
    ORDER BY mi.updated_at DESC
    LIMIT @limit
  `).all({ like: giftLike, userId, limit, isAdmin: isAdmin ? 1 : 0 });

  // Familiendokumente: LIKE-Scan auf Name/Beschreibung. Sichtbarkeit wie die
  // Dokumenten-Liste: 'private' nur für Ersteller/Admin, 'restricted' und
  // 'family' für alle angemeldeten Familienmitglieder (Lesen der Metadaten).
  const documents = database.prepare(`
    SELECT fd.id, fd.name AS title, fd.category, fd.original_name, fd.mime_type
    FROM family_documents fd
    WHERE fd.status = 'active'
      AND (fd.visibility != 'private' OR fd.created_by = @userId OR @isAdmin = 1)
      AND (fd.name LIKE @like ESCAPE '\\' OR fd.description LIKE @like ESCAPE '\\'
           OR fd.original_name LIKE @like ESCAPE '\\')
    ORDER BY fd.updated_at DESC
    LIMIT @limit
  `).all({ like: giftLike, userId, limit, isAdmin: isAdmin ? 1 : 0 });

  // Rezepte: Titel + Notizen (Zutaten bewusst nicht durchsucht — zu rauschend).
  const recipes = database.prepare(`
    SELECT r.id, r.title, r.notes
    FROM recipes r
    WHERE r.title LIKE @like ESCAPE '\\' OR r.notes LIKE @like ESCAPE '\\'
    ORDER BY r.updated_at DESC
    LIMIT @limit
  `).all({ like: giftLike, limit });

  return { tasks, events, notes, contacts, items, meds, activities, gifts, media, documents, recipes };
}
