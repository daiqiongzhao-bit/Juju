/**
 * Modul: Aufgaben (Tasks)
 * Zweck: REST-API-Routen für Aufgaben und Teilaufgaben (max. 2 Ebenen)
 * Abhängigkeiten: express, server/db.js
 */

import { createLogger } from '../logger.js';
import express from 'express';
import * as db from '../db.js';
import { documentVisibleSql } from '../services/document-access.js';
import { nextDueAfterCompletion } from '../services/recurrence.js';
import { syncTaskRewards } from '../services/rewards.js';
import { normalizeVisibility, visibilityWhere } from '../services/visibility.js';
import {
  flushOutbound, markTodoOutbound, queueTodoDeletion,
} from '../services/caldav-todo-outbound.js';
import { uniqueKey } from '../utils/category-slug.js';
import { serverTimeZone, utcToWall } from '../utils/timezone.js';
import {
  allTags, applyTagChanges, loadTags, loadTagsFor, normalizeTags,
  removeTagEverywhere, renameTag, setTags, tagKey, tagsKey, taskIdsWithTag,
} from '../utils/task-tags.js';
import * as v from '../middleware/validate.js';

const log = createLogger('Tasks');

/**
 * Ausgehende Arbeit an einem CalDAV-Spiegel anstoßen (#617). Bewusst nach der
 * Antwort und ohne await: der Server-Aufruf darf die Antwort weder verzögern
 * noch scheitern lassen. Schlägt er fehl, bleibt die Vormerkung liegen und der
 * nächste Sync-Lauf holt sie nach.
 */
function pushToCalDAV(what) {
  flushOutbound().catch((err) => log.warn(`${what} vorgemerkt, Sofortversuch fehlgeschlagen:`, err.message));
}

const router = express.Router();

// --------------------------------------------------------
// Konstanten
// --------------------------------------------------------

const VALID_PRIORITIES = ['none', 'low', 'medium', 'high', 'urgent'];

// Die drei Zustände, die eine Aufgabe im Lauf durchläuft. Mehr steht nicht im
// Statusfeld.
const REAL_STATUSES = ['open', 'in_progress', 'done'];

// 'archived' war bis v1.86.2 ein vierter Statuswert und ist seit #688 eine eigene
// Achse (tasks.archived_at). Als Eingabe bleibt es erlaubt: Bestandsclients, die
// MCP-Schnittstelle und der Filterchip der Oberfläche sprechen weiter so darüber,
// und für sie bedeutet es unverändert „ablegen" bzw. „das Archiv zeigen". Was es
// nicht mehr tut: den Status überschreiben.
const ARCHIVE_STATUS = 'archived';
const VALID_STATUSES = [...REAL_STATUSES, ARCHIVE_STATUS];

const MAX_POINTS = 10000;
const FALLBACK_CATEGORY = 'misc';

/** Zeitstempel im Format der übrigen Spalten (UTC, sekundengenau). */
function nowStamp() {
  return new Date().toISOString().slice(0, 19) + 'Z';
}

/**
 * Eine Aufgabe ablegen oder zurückholen (#688). Rührt den Status nicht an: was
 * erledigt war, bleibt erledigt, was offen war, bleibt offen.
 * Rückgabe: der neue archived_at-Wert (null = zurückgeholt).
 */
function setArchived(taskId, archived) {
  const value = archived ? nowStamp() : null;
  db.get().prepare('UPDATE tasks SET archived_at = ? WHERE id = ?').run(value, taskId);
  return value;
}

/** Verwaltbare Kategorien aus der DB (nach sort_order). */
function loadTaskCategories() {
  return db.get().prepare(
    'SELECT key, name, label_key, sort_order FROM task_categories ORDER BY sort_order ASC, key ASC'
  ).all();
}

/** Nur die Keys — für die dynamische category-Validierung. */
function validTaskCategoryKeys() {
  return loadTaskCategories().map((c) => c.key);
}

/** Anzahl Aufgaben, die eine Kategorie referenzieren (Guard vor dem Löschen). */
function taskCategoryInUseCount(key) {
  return db.get().prepare('SELECT COUNT(*) AS n FROM tasks WHERE category = ?').get(key).n;
}

/**
 * Der heutige Tag in der Zone des Haushalts (YYYY-MM-DD).
 *
 * Wichtig für die Serienrechnung (#658): "an dem Tag, an dem ich sie erledigt
 * habe" ist eine Wanduhr-Aussage. Wer um 00:30 in Berlin abhakt, hat es am
 * neuen Tag getan, auch wenn in UTC noch der Vortag läuft - eine wöchentliche
 * Aufgabe wäre sonst sechs statt sieben Tage später fällig. Dieselbe Zone
 * begrenzt auch das Aufholen der fälligkeitsverankerten Serien, damit die
 * Folgeinstanz nicht in einem Zeitzonen-Saum als überfällig entsteht;
 * `due_date` ist ohnehin ein reiner Wanduhr-Wert (siehe utils/timezone.js).
 */
function todayInHouseholdZone() {
  return utcToWall(new Date().toISOString(), serverTimeZone())?.date
    ?? new Date().toISOString().slice(0, 10);
}

/** Punktewert einer Aufgabe auf eine nichtnegative Ganzzahl normalisieren. */
function clampPoints(val) {
  const n = Math.trunc(Number(val));
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(n, MAX_POINTS);
}

/**
 * Haushaltweiter Standard-Punktwert für neue Aufgaben (#578). 0 = kein Standard.
 * Liegt in sync_config, damit die Einstellung im selben Speicher wie die
 * übrigen Haushalt-Präferenzen liegt (siehe server/routes/preferences.js).
 */
function defaultTaskPoints() {
  const row = db.get().prepare("SELECT value FROM sync_config WHERE key = 'tasks_default_points'").get();
  return clampPoints(row?.value);
}

// Erledigte Aufgaben dürfen nicht umbepunktet werden: genau für 'done' hält der
// reward_ledger eine earn-Buchung über den damaligen Punktwert
// (awardForCompletion in server/services/rewards.js); ein nachträglicher Wechsel
// ließe Aufgabenwert und Gutschrift auseinanderlaufen.
// Alle übrigen Status sind buchungsfrei. Sie mitzuziehen verhindert, dass eine
// später reaktivierte Aufgabe einen veralteten Wert auszahlt.
// Das Archiv spielt hier bewusst keine Rolle: es sagt nichts über eine Buchung
// aus. Eine abgelegte erledigte Aufgabe steht auf 'done' und ist damit ohnehin
// ausgenommen; eine abgelegte offene ist buchungsfrei wie jede andere offene.
const REBASE_EXCLUDED_STATUS = 'done';

/** Nicht erledigte Hauptaufgaben, die exakt auf einem Punktwert stehen. */
function countRebasableTasks(points) {
  return db.get().prepare(`
    SELECT COUNT(*) AS n FROM tasks
    WHERE points = ? AND parent_task_id IS NULL AND status != ?
  `).get(points, REBASE_EXCLUDED_STATUS).n;
}

// --------------------------------------------------------
// Hilfsfunktionen
// --------------------------------------------------------

const ASSIGNED_USERS_SQL = `(
  SELECT json_group_array(json_object(
    'id', u.id, 'display_name', u.display_name, 'color', u.avatar_color,
    'avatar_data', u.avatar_data
  ))
  FROM task_assignments ta JOIN users u ON u.id = ta.user_id
  WHERE ta.task_id = t.id
) AS assigned_users_json`;

function addAssignedUsers(task) {
  task.assigned_users = task.assigned_users_json ? JSON.parse(task.assigned_users_json) : [];
  delete task.assigned_users_json;
  return task;
}

/**
 * Hängt jedem Task die Anzahl der für die Person sichtbaren, verknüpften
 * Dokumente an (document_count, #503). Eine einzige gruppierte Abfrage statt
 * pro-Task, damit die Listen-Route günstig bleibt.
 */
function attachDocumentCounts(tasks, me) {
  if (!tasks.length) return tasks;
  const counts = db.get().prepare(`
    SELECT td.task_id AS id, COUNT(*) AS n
    FROM task_documents td
    JOIN family_documents d ON d.id = td.document_id
    WHERE d.status != 'archived' AND ${DOC_VISIBLE_SQL}
    GROUP BY td.task_id
  `).all({ me });
  const map = new Map(counts.map((r) => [r.id, r.n]));
  for (const task of tasks) task.document_count = map.get(task.id) ?? 0;
  return tasks;
}

/**
 * Hängt jeder Aufgabe ihre Tags an (#586). Eine Abfrage für die ganze Liste,
 * aus demselben Grund wie attachDocumentCounts.
 */
function attachTags(tasks) {
  if (!tasks.length) return tasks;
  const map = loadTagsFor(db.get(), tasks.map((t) => t.id));
  for (const task of tasks) task.tags = map.get(task.id) ?? [];
  return tasks;
}

function parseAssignedTo(val) {
  if (Array.isArray(val)) return val.map(Number).filter(Boolean);
  if (val !== null && val !== undefined && val !== '') return [Number(val)].filter(Boolean);
  return [];
}

function setAssignments(d, taskId, userIds) {
  d.prepare('DELETE FROM task_assignments WHERE task_id = ?').run(taskId);
  const ins = d.prepare('INSERT OR IGNORE INTO task_assignments (task_id, user_id) VALUES (?, ?)');
  for (const uid of userIds) ins.run(taskId, uid);
}

function syncHousekeepingPaymentStatus(d, taskId, status) {
  const table = d.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'housekeeping_work_sessions'").get();
  if (!table) return;
  d.prepare(`
    UPDATE housekeeping_work_sessions
    SET paid_at = CASE
      WHEN ? = 'done' THEN COALESCE(paid_at, strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
      ELSE NULL
    END
    WHERE payment_task_id = ?
  `).run(status, taskId);
}

/** Alle Subtasks einer Aufgabe laden (eine Ebene tief). */
function loadSubtasks(taskId, me) {
  // Eine Unteraufgabe trägt eine eigene Sichtbarkeit (POST nimmt das Feld
  // entgegen). Sie hing hier noch nie an der Regel: unter einer geteilten
  // Elternaufgabe wurde eine private Unteraufgabe samt Titel ausgeliefert.
  // Mit den Tags käme deren Freitext dazu.
  const rows = db.get().prepare(`
    SELECT t.*, u.display_name AS assigned_name, u.avatar_color AS assigned_color,
      u.avatar_data AS assigned_avatar, ${ASSIGNED_USERS_SQL}
    FROM tasks t
    LEFT JOIN users u ON t.assigned_to = u.id
    WHERE t.parent_task_id = ?
      AND ${visibilityWhere('t', 'task_assignments', 'task_id', '@me')}
    ORDER BY t.created_at ASC
  `).all(taskId, { me }).map(addAssignedUsers);
  // Unteraufgaben sind Aufgaben und können Tags tragen - über den CalDAV-Spiegel
  // bekommen sie welche, ohne dass jemand sie hier vergibt. Ohne das Anhängen
  // wären sie in der Antwort einfach nicht da, und ein PUT auf Basis dieser
  // Zeile schriebe sie still weg.
  return attachTags(rows);
}

/**
 * Tags dürfen fehlen oder ein Array/kommaseparierter String sein. Zahl und Länge
 * begrenzt normalizeTags still - abgelehnt wird nur, was gar keine Tag-Liste ist,
 * damit ein Tippfehler im Client nicht als leere Liste durchgeht und die
 * vorhandenen Tags löscht.
 */
function validateTags(value) {
  if (value === undefined || value === null) return {};
  if (Array.isArray(value) || typeof value === 'string') return {};
  return { error: 'tags must be an array or a comma-separated string.' };
}

/** Eingabe-Validierung für Task-Felder (zentralisiert über validate.js). */
function validateTaskInput(body, isCreate = true) {
  return v.collectErrors([
    v.str(body.title,       'title',       { required: isCreate }),
    v.str(body.description, 'description', { required: false, max: v.MAX_TEXT }),
    v.oneOf(body.priority,  VALID_PRIORITIES, 'priority'),
    v.oneOf(body.status,    VALID_STATUSES,   'status'),
    v.oneOf(body.category,  validTaskCategoryKeys(), 'category'),
    v.date(body.start_date, 'start_date'),
    v.date(body.due_date,   'due_date'),
    v.time(body.due_time,   'due_time'),
    v.rrule(body.recurrence_rule, 'recurrence_rule'),
    v.num(body.points,      'points'),
    validateTags(body.tags),
  ]);
}

// --------------------------------------------------------
// Kategorie-Verwaltung (#494, #357)
// Statische /categories-Pfade MÜSSEN vor den dynamischen /:id-Routen stehen,
// sonst matcht Express „categories" als :id.
// --------------------------------------------------------

// GET /api/v1/tasks/categories → { data: TaskCategory[] }
router.get('/categories', (_req, res) => {
  try {
    res.json({ data: loadTaskCategories() });
  } catch (err) {
    log.error('GET /categories error:', err);
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});

// GET /api/v1/tasks/tags → { data: [{ tag, count }] }
// Die sichtbaren Tags für Filterleiste und Vorschläge (#586). Anders als
// Kategorien gibt es keine Registry - die Liste ergibt sich aus dem Bestand,
// und zwar aus dem Teil davon, den die fragende Person sehen darf: ein Tag ist
// Freitext und verriete sonst den Inhalt einer privaten Aufgabe (#474).
// Muss wie /categories vor den /:id-Routen stehen, sonst matcht „tags" als :id.
router.get('/tags', (req, res) => {
  try {
    res.json({ data: allTags(db.get(), req.authUserId || req.session.userId) });
  } catch (err) {
    log.error('GET /tags error:', err);
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});

/**
 * Merkt geänderte Aufgaben für den CalDAV-Push vor und stößt ihn an (#586).
 * Die Tags reisen als kanonischer Schlüssel mit: sie liegen in task_tags, der
 * Feldvergleich in markTodoOutbound sieht aber nur die Zeile selbst.
 */
function pushTagChanges(changed, what) {
  if (!changed.length) return;
  const rows = db.get().prepare(
    `SELECT * FROM tasks WHERE id IN (${changed.map(() => '?').join(',')})`
  ).all(...changed.map((c) => c.id));
  const byId = new Map(rows.map((r) => [r.id, r]));

  let pending = 0;
  for (const { id, before, after } of changed) {
    const row = byId.get(id);
    if (!row) continue;
    if (markTodoOutbound('tasks',
      { ...row, tags_key: tagsKey(before) },
      { ...row, tags_key: tagsKey(after) })) pending++;
  }
  if (pending) pushToCalDAV(what);
}

/** Aus einer Liste von IDs die, die `me` sehen darf. */
function visibleTaskIds(ids, me) {
  if (!ids.length) return [];
  const placeholders = ids.map(() => '?').join(',');
  return db.get().prepare(`
    SELECT t.id AS id FROM tasks t
    WHERE t.id IN (${placeholders})
      AND ${visibilityWhere('t', 'task_assignments', 'task_id', '@me')}
  `).all(...ids, { me }).map((r) => r.id);
}

// Obergrenze für eine Bulk-Vergabe. Die Auswahl entsteht per Hand in der Liste,
// alles darüber ist ein Skript - und ein Skript soll die Aufgaben einzeln
// anfassen statt einen Sync-Lauf mit einem Schlag zu füllen.
const MAX_BULK_TASKS = 500;

// POST /api/v1/tasks/tags/apply  Body: { ids, add?, remove? }
// Vergibt oder entfernt Tags an mehreren Aufgaben auf einmal (#586). Eigener
// Endpunkt statt einer Schleife über PUT /:id im Client: zum Anhängen müsste der
// Client jede Aufgabe erst lesen, die Liste mischen und die ganze Aufgabe
// zurückschreiben - und überschriebe dabei jede parallele Änderung.
router.post('/tags/apply', (req, res) => {
  try {
    const ids = Array.isArray(req.body.ids) ? req.body.ids.map(Number).filter(Number.isInteger) : [];
    if (!ids.length)
      return res.status(400).json({ error: 'ids must be a non-empty array of task IDs.', code: 400 });
    if (ids.length > MAX_BULK_TASKS)
      return res.status(400).json({ error: `At most ${MAX_BULK_TASKS} tasks at a time.`, code: 400 });

    const errors = v.collectErrors([validateTags(req.body.add), validateTags(req.body.remove)]);
    if (errors.length) return res.status(400).json({ error: errors.join(' '), code: 400 });

    const add    = normalizeTags(req.body.add ?? []);
    const remove = normalizeTags(req.body.remove ?? []);
    if (!add.length && !remove.length)
      return res.status(400).json({ error: 'Nothing to add or remove.', code: 400 });

    const me = req.authUserId || req.session.userId;
    const changed = db.get().transaction(() =>
      applyTagChanges(db.get(), { taskIds: visibleTaskIds(ids, me), add, remove }))();

    res.json({ data: { updated: changed.length, tags: allTags(db.get(), me) } });
    pushTagChanges(changed, 'Tag-Vergabe');
  } catch (err) {
    log.error('POST /tags/apply error:', err);
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});

// PUT /api/v1/tasks/tags/:tag  Body: { name }
// Benennt einen Tag auf allen sichtbaren Aufgaben um. Zielt der neue Name auf
// einen vorhandenen Tag, führt das die beiden zusammen - das ist gewollt und der
// übliche Weg, ein versehentliches Duplikat einzusammeln.
router.put('/tags/:tag', (req, res) => {
  try {
    // Als Array-Element, nicht als String: die String-Form von normalizeTags
    // trennt am Komma, und ein Umbenennen auf "Haus, Hof" behielte nur "Haus" -
    // bei gemeldetem Erfolg. Denselben Fehler hatte der Filter eine Funktion
    // weiter oben.
    const [to] = normalizeTags([req.body.name ?? '']);
    if (!to) return res.status(400).json({ error: 'name must be a non-empty tag.', code: 400 });

    const me = req.authUserId || req.session.userId;
    if (!taskIdsWithTag(db.get(), req.params.tag, me).length)
      return res.status(404).json({ error: 'Tag not found.', code: 404 });

    const changed = db.get().transaction(() =>
      renameTag(db.get(), { from: req.params.tag, to, me }))();

    res.json({ data: { updated: changed.length, tag: to, tags: allTags(db.get(), me) } });
    pushTagChanges(changed, 'Tag-Umbenennung');
  } catch (err) {
    log.error('PUT /tags/:tag error:', err);
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});

// DELETE /api/v1/tasks/tags/:tag
// Nimmt den Tag von allen sichtbaren Aufgaben. Anders als bei Kategorien gibt es
// keine 409-Sperre "noch in Benutzung": ein Tag IST nur seine Verwendungen, und
// ihn zu löschen heißt genau, sie zu lösen. Die Aufgaben selbst bleiben.
router.delete('/tags/:tag', (req, res) => {
  try {
    const me = req.authUserId || req.session.userId;
    if (!taskIdsWithTag(db.get(), req.params.tag, me).length)
      return res.status(404).json({ error: 'Tag not found.', code: 404 });

    const changed = db.get().transaction(() =>
      removeTagEverywhere(db.get(), { tag: req.params.tag, me }))();

    res.json({ data: { updated: changed.length, tags: allTags(db.get(), me) } });
    pushTagChanges(changed, 'Tag-Löschung');
  } catch (err) {
    log.error('DELETE /tags/:tag error:', err);
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});

// POST /api/v1/tasks/categories  Body: { name } → { data: TaskCategory }
router.post('/categories', (req, res) => {
  try {
    const vName = v.str(req.body.name, 'Name', { max: v.MAX_SHORT });
    if (vName.error) return res.status(400).json({ error: vName.error, code: 400 });

    const conflict = db.get().prepare(`
      SELECT key FROM task_categories WHERE COALESCE(name, key) = ? COLLATE NOCASE
    `).get(vName.value);
    if (conflict) return res.status(409).json({ error: 'Category already exists.', code: 409, reason: 'category_exists' });

    const maxOrder = db.get().prepare('SELECT COALESCE(MAX(sort_order), -1) AS m FROM task_categories').get().m;
    const key = uniqueKey(db.get(), 'task_categories', vName.value);
    db.get().prepare(
      'INSERT INTO task_categories (key, name, label_key, sort_order) VALUES (?, ?, NULL, ?)'
    ).run(key, vName.value, maxOrder + 1);

    const cat = db.get().prepare('SELECT key, name, label_key, sort_order FROM task_categories WHERE key = ?').get(key);
    res.status(201).json({ data: cat });
  } catch (err) {
    log.error('POST /categories error:', err);
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});

// PATCH /api/v1/tasks/categories/reorder  Body: { order: string[] }
router.patch('/categories/reorder', (req, res) => {
  try {
    const order = Array.isArray(req.body.order) ? req.body.order : [];
    const update = db.get().prepare('UPDATE task_categories SET sort_order = ? WHERE key = ?');
    db.get().transaction(() => order.forEach((key, i) => update.run(i, key)))();
    res.json({ data: loadTaskCategories() });
  } catch (err) {
    log.error('PATCH /categories/reorder error:', err);
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});

// PUT /api/v1/tasks/categories/:key  Body: { name } → benennt um (Key bleibt stabil,
// label_key wird gelöscht → der Custom-Name gilt fortan).
router.put('/categories/:key', (req, res) => {
  try {
    const cat = db.get().prepare('SELECT * FROM task_categories WHERE key = ?').get(req.params.key);
    if (!cat) return res.status(404).json({ error: 'Category not found.', code: 404 });

    const vName = v.str(req.body.name, 'Name', { max: v.MAX_SHORT });
    if (vName.error) return res.status(400).json({ error: vName.error, code: 400 });

    const conflict = db.get().prepare(`
      SELECT key FROM task_categories WHERE COALESCE(name, key) = ? COLLATE NOCASE AND key != ?
    `).get(vName.value, cat.key);
    if (conflict) return res.status(409).json({ error: 'Category already exists.', code: 409, reason: 'category_exists' });

    db.get().prepare('UPDATE task_categories SET name = ?, label_key = NULL WHERE key = ?').run(vName.value, cat.key);
    const updated = db.get().prepare('SELECT key, name, label_key, sort_order FROM task_categories WHERE key = ?').get(cat.key);
    res.json({ data: updated });
  } catch (err) {
    log.error('PUT /categories/:key error:', err);
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});

// DELETE /api/v1/tasks/categories/:key → 409 wenn in Benutzung oder letzte Kategorie.
router.delete('/categories/:key', (req, res) => {
  try {
    const cat = db.get().prepare('SELECT * FROM task_categories WHERE key = ?').get(req.params.key);
    if (!cat) return res.status(404).json({ error: 'Category not found.', code: 404 });

    const inUse = taskCategoryInUseCount(cat.key);
    if (inUse > 0) {
      return res.status(409).json({ error: `Category is in use by ${inUse} task${inUse === 1 ? '' : 's'}.`, code: 409, count: inUse, reason: 'category_in_use' });
    }
    const total = db.get().prepare('SELECT COUNT(*) AS n FROM task_categories').get().n;
    if (total <= 1) return res.status(409).json({ error: 'Cannot delete the last category.', code: 409, reason: 'category_last' });

    db.get().prepare('DELETE FROM task_categories WHERE key = ?').run(cat.key);
    res.status(204).end();
  } catch (err) {
    log.error('DELETE /categories/:key error:', err);
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});

// --------------------------------------------------------
// GET /api/v1/tasks
// Listet Top-Level-Aufgaben mit optionalen Filtern.
// Query-Parameter: status, priority, assigned_to, category, archived
// Response: { data: Task[] }  (jede Task enthält subtask_progress)
// --------------------------------------------------------
router.get('/', (req, res) => {
  try {
    const { status, priority, assigned_to, category, tag, include_future, archived } = req.query;

    let sql = `
      SELECT
        t.*,
        u.display_name AS assigned_name,
        u.avatar_color AS assigned_color,
        u.avatar_data AS assigned_avatar,
        ${ASSIGNED_USERS_SQL},
        (SELECT COUNT(*) FROM tasks s WHERE s.parent_task_id = t.id)                           AS subtask_total,
        (SELECT COUNT(*) FROM tasks s WHERE s.parent_task_id = t.id AND s.status = 'done')     AS subtask_done,
        (SELECT json_group_array(json_object('id', s.id, 'title', s.title, 'status', s.status))
           FROM (SELECT id, title, status FROM tasks WHERE parent_task_id = t.id ORDER BY created_at ASC) s) AS subtasks
      FROM tasks t
      LEFT JOIN users u ON t.assigned_to = u.id
      WHERE t.parent_task_id IS NULL
    `;
    const params = [];

    if (!include_future) {
      sql += ` AND (t.start_date IS NULL OR t.start_date <= date('now'))`;
    }

    // Status, Priorität und Person nehmen mehrere Werte entgegen und verknüpfen
    // sie ODER (#671). Anders als bei den Tags unten ist das keine Geschmacks-
    // frage: eine Aufgabe trägt genau EINE Priorität, ein UND über zwei Werte
    // wäre also garantiert leer. Gemeldet wurde genau das - "medium und high
    // zugleich" ging nicht, weil jede Reihe nur einen Wert zuließ.
    // Zwischen den Gruppen bleibt es UND: jede Reihe engt weiter ein.
    // Ein einzelner Wert kommt weiterhin als String an (API-Token, Bookmarks).
    const asList = (v) => (v === undefined ? [] : [v].flat().filter((x) => x !== ''));

    // Archiv (#688): eine eigene Achse, kein Status. Ohne Zutun bleibt es
    // ausgeblendet - eine abgelegte Aufgabe soll sich wie gelöscht anfühlen und
    // nicht mit ihrem Status („offen") durch jede Liste wandern.
    //   ?archived=1     - zusätzlich zeigen (Kanban: die Ablage ist dort eine Spalte)
    //   ?archived=only  - nur das Archiv
    //   ?status=archived - für Bestandsclients und den Filterchip: das Archiv ist
    //                      dort ein Wert neben den Status. Es bleibt deshalb auch
    //                      ODER-verknüpft wie jeder andere Wert dieser Achse -
    //                      „offen und archiviert" muss beides zeigen, nicht den
    //                      Schnitt aus beidem.
    const rawStatuses  = asList(status);
    const statuses     = rawStatuses.filter((s) => s !== ARCHIVE_STATUS);
    const statusArchiv = rawStatuses.includes(ARCHIVE_STATUS);
    const archiveQuery = archived === 'only' ? 'only'
      : (archived === '1' || archived === 'true' ? 'include' : null);

    if (statuses.length && statusArchiv) {
      sql += ` AND (t.status IN (${statuses.map(() => '?').join(', ')}) OR t.archived_at IS NOT NULL)`;
      params.push(...statuses);
    } else {
      if (statuses.length) {
        sql += ` AND t.status IN (${statuses.map(() => '?').join(', ')})`;
        params.push(...statuses);
      }
      if (statusArchiv || archiveQuery === 'only') sql += ' AND t.archived_at IS NOT NULL';
      else if (!archiveQuery)                      sql += ' AND t.archived_at IS NULL';
    }

    const priorities = asList(priority);
    if (priorities.length) {
      sql += ` AND t.priority IN (${priorities.map(() => '?').join(', ')})`;
      params.push(...priorities);
    }

    const assignees = asList(assigned_to).map(Number).filter(Number.isInteger);
    if (assignees.length) {
      sql += ` AND EXISTS (SELECT 1 FROM task_assignments ta WHERE ta.task_id = t.id
                             AND ta.user_id IN (${assignees.map(() => '?').join(', ')}))`;
      params.push(...assignees);
    }
    if (category)    { sql += ' AND t.category = ?';    params.push(category); }
    // Tag-Filter ohne Rücksicht auf Groß-/Kleinschreibung: die Werte kommen von
    // fremden Servern, dort ist „Garten" und „garten" dasselbe Etikett.
    //
    // Mehrere Tags verbinden sich mit UND, nicht mit ODER: jeder weitere Filter
    // in dieser Leiste engt ein (Status UND Priorität UND Person), und ein Tag,
    // der die Liste plötzlich wachsen ließe, wäre in derselben Reihe ein Bruch.
    // Jedes `tag`-Vorkommen ist genau EIN Tag, nie eine kommaseparierte Liste.
    // Der frühere CSV-Komfort war ein Fehler: Express liefert bei einem einzigen
    // `?tag=` einen String statt eines Arrays, und "Haus, Hof" - ein Tag, den
    // CATEGORIES ausdrücklich erlaubt - zerfiel dabei in zwei, sodass die Suche
    // nach ihm garantiert leer ausging.
    const tagFilters = normalizeTags(tag === undefined ? [] : [tag].flat());
    for (const value of tagFilters) {
      sql += ' AND EXISTS (SELECT 1 FROM task_tags tt WHERE tt.task_id = t.id AND tt.tag_key = ?)';
      params.push(tagKey(value));
    }

    // Sichtbarkeit (#474): eigene + für alle sichtbare + zugewiesene-sichtbare.
    const me = req.authUserId || req.session.userId;
    sql += ` AND ${visibilityWhere('t', 'task_assignments', 'task_id')}`;
    params.push(me, me);

    sql += `
      ORDER BY
        CASE t.status WHEN 'done' THEN 1 ELSE 0 END,
        CASE t.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1
                        WHEN 'medium' THEN 2 WHEN 'low' THEN 3 ELSE 4 END,
        t.due_date ASC NULLS LAST,
        t.created_at DESC
    `;

    const rows = db.get().prepare(sql).all(...params).map(task => ({ ...task, subtasks: JSON.parse(task.subtasks || '[]') })).map(addAssignedUsers);
    res.json({ data: attachTags(attachDocumentCounts(rows, me)) });
  } catch (err) {
    log.error('GET / error:', err);
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});

// --------------------------------------------------------
// GET /api/v1/tasks/:id
// Einzelne Aufgabe mit Subtasks.
// Response: { data: Task & { subtasks: Task[] } }
// --------------------------------------------------------
router.get('/:id', (req, res) => {
  try {
    const me = req.authUserId || req.session.userId;
    const task = db.get().prepare(`
      SELECT t.*, u.display_name AS assigned_name, u.avatar_color AS assigned_color,
        u.avatar_data AS assigned_avatar, ${ASSIGNED_USERS_SQL}
      FROM tasks t
      LEFT JOIN users u ON t.assigned_to = u.id
      WHERE t.id = ? AND t.parent_task_id IS NULL
        AND ${visibilityWhere('t', 'task_assignments', 'task_id')}
    `).get(req.params.id, me, me);

    if (!task) return res.status(404).json({ error: 'Task not found.', code: 404 });

    addAssignedUsers(task);
    task.subtasks = loadSubtasks(task.id, me);
    attachDocumentCounts([task], me);
    attachTags([task]);
    res.json({ data: task });
  } catch (err) {
    log.error('GET /:id error:', err);
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});

// --------------------------------------------------------
// POST /api/v1/tasks
// Neue Aufgabe erstellen.
// Body: { title, description?, category?, tags?, priority?, due_date?, due_time?,
//         assigned_to?, parent_task_id? }
// Response: { data: Task }
// --------------------------------------------------------
router.post('/', (req, res) => {
  try {
    const errors = validateTaskInput(req.body, true);
    if (errors.length) return res.status(400).json({ error: errors.join(' '), code: 400 });

    const {
      title,
      description     = null,
      category        = FALLBACK_CATEGORY,
      priority        = 'none',
      start_date      = null,
      due_date        = null,
      due_time        = null,
      parent_task_id  = null,
      is_recurring    = 0,
      recurrence_rule = null,
      recurrence_from_completion = 0,
    } = req.body;
    // Ohne expliziten Wert greift der Haushalt-Standard (#578) — aber nur für
    // Hauptaufgaben: Subtasks sind Checklisten-Punkte der Elternaufgabe und
    // würden den Punktewert sonst vervielfachen. Eine ausdrückliche 0 bleibt 0.
    const points = req.body.points === undefined && !parent_task_id
      ? defaultTaskPoints()
      : clampPoints(req.body.points);
    const visibility = normalizeVisibility(req.body.visibility);

    const userIds  = parseAssignedTo(req.body.assigned_to);
    const firstUid = userIds[0] ?? null;

    // Tiefe begrenzen: Subtasks dürfen keine eigenen Subtasks haben (max. 2 Ebenen)
    if (parent_task_id) {
      const parent = db.get().prepare('SELECT parent_task_id FROM tasks WHERE id = ?')
        .get(parent_task_id);
      if (!parent) return res.status(404).json({ error: 'Parent task not found.', code: 404 });
      if (parent.parent_task_id)
        return res.status(400).json({ error: 'Maximal 2 Verschachtelungsebenen erlaubt.', code: 400 });
    }

    const taskId = db.get().transaction(() => {
      const result = db.get().prepare(`
        INSERT INTO tasks
          (title, description, category, priority, start_date, due_date, due_time,
           assigned_to, created_by, parent_task_id, is_recurring, recurrence_rule,
           recurrence_from_completion, points, visibility)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        title.trim(), description, category, priority,
        start_date, due_date, due_time, firstUid, req.authUserId || req.session.userId, parent_task_id,
        is_recurring ? 1 : 0, recurrence_rule, recurrence_from_completion ? 1 : 0, points, visibility
      );
      setAssignments(db.get(), result.lastInsertRowid, userIds);
      if (req.body.tags !== undefined) setTags(db.get(), result.lastInsertRowid, req.body.tags);
      return result.lastInsertRowid;
    })();

    const task = db.get().prepare(`
      SELECT t.*, u.display_name AS assigned_name, u.avatar_color AS assigned_color,
        u.avatar_data AS assigned_avatar, ${ASSIGNED_USERS_SQL}
      FROM tasks t LEFT JOIN users u ON t.assigned_to = u.id
      WHERE t.id = ?
    `).get(taskId);

    addAssignedUsers(task);
    attachTags([task]);
    res.status(201).json({ data: task });
  } catch (err) {
    log.error('POST / error:', err);
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});

// --------------------------------------------------------
// PUT /api/v1/tasks/:id
// Aufgabe vollständig aktualisieren.
// Body: { title, description?, category?, tags?, priority?, status?,
//         due_date?, due_time?, assigned_to? }
// Response: { data: Task }
// tags fehlt → bleiben unangetastet; tags: [] → alle entfernt.
// --------------------------------------------------------
router.put('/:id', (req, res) => {
  try {
    const task = db.get().prepare('SELECT * FROM tasks WHERE id = ?').get(req.params.id);
    if (!task) return res.status(404).json({ error: 'Task not found.', code: 404 });

    const errors = validateTaskInput(req.body, false);
    if (errors.length) return res.status(400).json({ error: errors.join(' '), code: 400 });

    const {
      title           = task.title,
      description     = task.description,
      category        = task.category,
      priority        = task.priority,
      start_date      = task.start_date,
      due_date        = task.due_date,
      due_time        = task.due_time,
      is_recurring    = task.is_recurring,
      recurrence_rule = task.recurrence_rule,
      recurrence_from_completion = task.recurrence_from_completion,
    } = req.body;
    const points = req.body.points !== undefined ? clampPoints(req.body.points) : task.points;
    const visibility = req.body.visibility !== undefined
      ? normalizeVisibility(req.body.visibility, task.visibility)
      : task.visibility;

    // `status: 'archived'` aus einem Bestandsclient legt ab, statt den Status zu
    // überschreiben (#688). Das Statusfeld selbst kennt den Wert nicht mehr.
    const archiveRequested = req.body.status === ARCHIVE_STATUS;
    const status = (req.body.status === undefined || archiveRequested)
      ? task.status
      : req.body.status;

    const userIds  = req.body.assigned_to !== undefined
      ? parseAssignedTo(req.body.assigned_to)
      : db.get().prepare('SELECT user_id FROM task_assignments WHERE task_id = ?')
          .all(task.id).map((r) => r.user_id);
    const firstUid = userIds[0] ?? null;

    // Vor dem Update festhalten: die Rückrichtung vergleicht damit, ob sich die
    // Tags wirklich geändert haben (#586).
    const tagsBefore = loadTags(db.get(), task.id);

    // Wie in PATCH umfasst die Transaktion auch die Serien-Bewegung: eine
    // gespeicherte Aufgabe ohne die Folgeinstanz, die zu ihr gehört, wäre
    // derselbe stille Serienabbruch, den dieser Weg gerade erst verloren hat.
    let pending = false;
    let undone  = 0;
    let updated;
    db.get().transaction(() => {
      db.get().prepare(`
        UPDATE tasks SET
          title = ?, description = ?, category = ?, priority = ?,
          status = ?, start_date = ?, due_date = ?, due_time = ?, assigned_to = ?,
          is_recurring = ?, recurrence_rule = ?, recurrence_from_completion = ?,
          points = ?, visibility = ?
        WHERE id = ?
      `).run(title.trim(), description, category, priority,
             status, start_date, due_date, due_time, firstUid,
             is_recurring ? 1 : 0, recurrence_rule, recurrence_from_completion ? 1 : 0,
             points, visibility, req.params.id);
      setAssignments(db.get(), task.id, userIds);
      if (req.body.tags !== undefined) setTags(db.get(), task.id, req.body.tags);
      if (archiveRequested && !task.archived_at) setArchived(task.id, true);
      syncHousekeepingPaymentStatus(db.get(), req.params.id, status);
      // Punkte erst nach setAssignments: die Zuständigen werden daraus abgeleitet.
      syncTaskRewards(db.get(), task.id, task.status, status, req.authUserId || req.session.userId);

      // Auch über das Bearbeiten-Formular lässt sich ein Abhaken zurücknehmen -
      // die Folgeinstanz muss dann genauso verschwinden wie beim Klick auf die
      // Checkbox (#650).
      if (task.status === 'done' && status !== 'done') {
        undone = discardRecurrenceFollowup(task.id);
      }

      // Nur was die Schreibarbeit unten braucht, liegt in der Transaktion: die
      // frische Zeile und ihre Tags (der Feldvergleich kennt tags_key). Das
      // Ausschmücken für die Antwort wartet draußen, damit die Schreibsperre
      // nicht über Lesearbeit gehalten wird.
      updated = db.get().prepare(`
        SELECT t.*, u.display_name AS assigned_name, u.avatar_color AS assigned_color,
          u.avatar_data AS assigned_avatar, ${ASSIGNED_USERS_SQL}
        FROM tasks t LEFT JOIN users u ON t.assigned_to = u.id
        WHERE t.id = ?
      `).get(req.params.id);
      attachTags([updated]);

      // Änderung an einer gespiegelten Aufgabe auf dem CalDAV-Server nachziehen (#617).
      // Die Tags reisen als kanonischer Schlüssel mit, weil sie in einer eigenen
      // Tabelle liegen und der Feldvergleich nur die Zeile selbst sieht (#586).
      pending = markTodoOutbound(
        'tasks',
        { ...task,    tags_key: tagsKey(tagsBefore) },
        { ...updated, tags_key: tagsKey(updated.tags) },
      );

      // Das Status-Dropdown im Bearbeiten-Formular hakt genauso ab wie die Checkbox -
      // also muss es die Serie genauso weiterschreiben. Grundlage ist die frisch
      // gelesene Zeile, damit im selben Zug geänderte Regel/Fälligkeit schon zählen.
      if (status === 'done' && task.status !== 'done') spawnRecurrenceFollowup(updated);
    })();

    addAssignedUsers(updated);
    updated.subtasks = loadSubtasks(updated.id, req.authUserId || req.session.userId);

    res.json({ data: updated });

    if (pending || undone) pushToCalDAV('Änderung');
  } catch (err) {
    log.error('PUT /:id error:', err);
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});

/**
 * Die Folgeinstanz, die beim Erledigen dieser Aufgabe entstanden ist (#650) -
 * oder null. Es gibt höchstens eine: der Spawn legt nur an, wenn hier nichts
 * steht.
 */
function recurrenceFollowupOf(taskId) {
  return db.get().prepare(
    'SELECT * FROM tasks WHERE recurrence_origin_id = ? ORDER BY id LIMIT 1'
  ).get(taskId) ?? null;
}

/**
 * Nimmt die Folgeinstanz zurück, wenn ein Abhaken rückgängig gemacht wird (#650).
 * Nur unangetastete Instanzen verschwinden: hat jemand sie selbst erledigt (und
 * damit die Serie weitergeschrieben) oder ihr Unteraufgaben gegeben, steckt dort
 * Arbeit, die ein Klick auf die Vorgängerin nicht wegwerfen darf.
 * Rückgabe: Anzahl vorgemerkter CalDAV-Löschungen.
 */
function discardRecurrenceFollowup(taskId) {
  const followup = recurrenceFollowupOf(taskId);
  if (!followup || followup.status !== 'open') return 0;

  const touched = db.get().prepare(
    'SELECT 1 FROM tasks WHERE parent_task_id = ? LIMIT 1'
  ).get(followup.id);
  if (touched || recurrenceFollowupOf(followup.id)) return 0;

  // Vor dem DELETE vormerken, wie in DELETE /:id: danach sind UID und Objekt-URL
  // weg. Lokal erzeugte Folgeinstanzen sind nicht gespiegelt, dann ist das ein No-op.
  const queued = queueTodoDeletion('tasks', followup) ? 1 : 0;
  db.get().prepare('DELETE FROM tasks WHERE id = ?').run(followup.id);
  return queued;
}

/**
 * Der Vorlauf gehört zum Durchlauf, nicht zum Kalender: beginnt eine Aufgabe
 * drei Tage vor ihrer Fälligkeit, tut sie das auch beim nächsten Mal.
 *
 * Ohne Start- oder Fälligkeitsdatum gibt es nichts zu verschieben (NULL). Der
 * zweite Fall ist erreichbar: eine erledigungsverankerte Serie (#658) läuft
 * auch ohne Fälligkeitsdatum weiter, und dann fehlt der Bezugspunkt, an dem ein
 * Vorlauf gemessen wäre.
 */
function shiftedStartDate(startDate, dueDate, nextDue) {
  if (!startDate || !dueDate) return null;
  const lead = Date.parse(`${dueDate}T00:00:00Z`) - Date.parse(`${startDate}T00:00:00Z`);
  if (!Number.isFinite(lead)) return null;
  return new Date(Date.parse(`${nextDue}T00:00:00Z`) - lead).toISOString().slice(0, 10);
}

/**
 * Schreibt die Serie weiter: nächste Instanz anlegen, wenn eine wiederkehrende
 * Aufgabe erledigt wurde. Erwartet die bereits auf 'done' gesetzte Zeile.
 *
 * Beide Wege zum Haken müssen hier durch - die Checkbox (PATCH /:id/status) und
 * das Status-Dropdown im Bearbeiten-Dialog (PUT /:id). Lag der Spawn nur im
 * einen, beendete der andere die Serie lautlos.
 *
 * Ohne Rückgabewert, anders als discardRecurrenceFollowup: die Folgeinstanz
 * entsteht ohne external_uid/external_source, markTodoOutbound lässt sie
 * deshalb liegen. Es gibt nichts zu pushen.
 *
 * Beide Aufrufer halten bereits eine Transaktion, die eigene läuft darin als
 * Savepoint. Sie bleibt trotzdem stehen: sie hält Aufgabe, Zuweisungen und Tags
 * auch dann zusammen, wenn später jemand von außerhalb einer Transaktion ruft.
 */
function spawnRecurrenceFollowup(task) {
  if (!task?.is_recurring || !task.recurrence_rule || task.parent_task_id) return;
  // Höchstens eine Folgeinstanz je Erledigung - sonst legt doppeltes Abhaken nach.
  if (recurrenceFollowupOf(task.id)) return;

  // Zwei Verankerungen, die Aufgabe entscheidet (#658): ab Fälligkeit
  // (Vorgabe, holt übersprungene Vorkommen auf, damit die nächste Instanz
  // nicht selbst überfällig entsteht) oder ab dem Tag des Abhakens.
  const completedOn = todayInHouseholdZone();
  const nextDate = nextDueAfterCompletion({
    anchorDate: task.due_date,
    rule: task.recurrence_rule,
    completedOn,
    fromCompletion: !!task.recurrence_from_completion,
  });
  if (!nextDate) return;

  const existingAssignments = db.get()
    .prepare('SELECT user_id FROM task_assignments WHERE task_id = ?')
    .all(task.id).map((r) => r.user_id);
  // Die Tags gehören zur Aufgabe, nicht zum einzelnen Durchlauf (#586).
  // Ohne das Mitnehmen verlöre eine wöchentliche Aufgabe ihre Etiketten
  // beim ersten Abhaken - und zwar lautlos, weil die Folgeinstanz sonst
  // vollständig aussieht.
  const existingTags = loadTags(db.get(), task.id);
  db.get().transaction(() => {
    const newTask = db.get().prepare(`
      INSERT INTO tasks (title, description, category, priority, status,
        start_date, due_date, due_time, assigned_to, created_by, is_recurring, recurrence_rule,
        points, visibility, recurrence_from_completion, recurrence_origin_id)
      VALUES (?, ?, ?, ?, 'open', ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)
    `).run(
      task.title, task.description, task.category, task.priority,
      shiftedStartDate(task.start_date, task.due_date, nextDate),
      nextDate, task.due_time, task.assigned_to, task.created_by,
      task.recurrence_rule, task.points, task.visibility,
      // Ohne das Mitnehmen fiele die Serie ab der zweiten Instanz auf die
      // Fälligkeitsrechnung zurück - lautlos, weil die Folgeinstanz sonst
      // vollständig aussieht (wie bei den Tags oben).
      task.recurrence_from_completion ? 1 : 0,
      task.id
    );
    setAssignments(db.get(), newTask.lastInsertRowid, existingAssignments);
    setTags(db.get(), newTask.lastInsertRowid, existingTags);
  })();
}

// --------------------------------------------------------
// PATCH /api/v1/tasks/:id/status
// Status einer Aufgabe schnell wechseln (z.B. Swipe-Geste / Checkbox).
// Body: { status: 'open' | 'in_progress' | 'done' | 'archived' }
// Response: { data: { id, status, archived_at } }
// 'archived' legt die Aufgabe ab, ohne ihren Status anzufassen (#688).
// --------------------------------------------------------
router.patch('/:id/status', (req, res) => {
  try {
    const { status } = req.body;
    if (!VALID_STATUSES.includes(status))
      return res.status(400).json({ error: `Invalid status. Allowed: ${VALID_STATUSES.join(', ')}`, code: 400 });

    // Ganze Zeile, nicht nur der Status: die Rückrichtung (#617) braucht die
    // externen Kennungen, um den Statuswechsel dem CalDAV-Objekt zuzuordnen.
    const prev = db.get().prepare('SELECT * FROM tasks WHERE id = ?').get(req.params.id);
    if (!prev)
      return res.status(404).json({ error: 'Task not found.', code: 404 });

    // Ablegen ist kein Statuswechsel: kein Punkte-Storno, keine Serien-Bewegung,
    // kein CalDAV-Push. Genau daran hing #688 - die Ablage überschrieb das 'done'
    // und syncTaskRewards nahm die Gutschrift dafür wieder zurück.
    if (status === ARCHIVE_STATUS) {
      const archivedAt = setArchived(req.params.id, true);
      return res.json({ data: { id: Number(req.params.id), status: prev.status, archived_at: archivedAt } });
    }

    // Statuswechsel und die Serien-Bewegung, die daraus folgt, sind eine Einheit:
    // scheitert das Nachlegen oder das Zurücknehmen der Folgeinstanz, darf die
    // Aufgabe nicht trotzdem umgeschaltet zurückbleiben. Sonst endete die Serie
    // still (kein Nachfolger) oder stünde doppelt da - genau die beiden Fehler,
    // gegen die dieser Block gebaut ist. Der Outbound-Marker gehört mit hinein:
    // ohne Statuswechsel gibt es auch nichts zu pushen.
    let pending = false;
    let undone  = 0;
    db.get().transaction(() => {
      db.get().prepare('UPDATE tasks SET status = ? WHERE id = ?').run(status, req.params.id);
      pending = markTodoOutbound('tasks', prev, { ...prev, status });

      syncHousekeepingPaymentStatus(db.get(), req.params.id, status);
      // Punkte-Gutschrift/Storno an den Aufgaben-Statuswechsel koppeln.
      syncTaskRewards(db.get(), Number(req.params.id), prev.status, status, req.authUserId || req.session.userId);

      // Zurückgenommenes Abhaken macht auch die Folgeinstanz rückgängig (#650).
      // Sonst stünde die beim Erledigen erzeugte nächste Instanz neben der wieder
      // geöffneten Aufgabe - die Serie sähe doppelt aus.
      if (prev.status === 'done' && status !== 'done') {
        undone = discardRecurrenceFollowup(Number(req.params.id));
      }

      // Wiederkehrende Aufgabe: nächste Instanz erstellen wenn erledigt
      if (status === 'done' && prev.status !== 'done') {
        spawnRecurrenceFollowup(db.get().prepare('SELECT * FROM tasks WHERE id = ?').get(req.params.id));
      }
    })();

    res.json({ data: { id: Number(req.params.id), status, archived_at: prev.archived_at } });

    if (pending || undone) pushToCalDAV('Statuswechsel');
  } catch (err) {
    log.error('PATCH /:id/status error:', err);
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});

// --------------------------------------------------------
// PATCH /api/v1/tasks/:id/archive
// Aufgabe ablegen oder zurückholen (#688).
// Body: { archived: boolean }  (fehlt/true = ablegen, wie bei den Dokumenten)
// Response: { data: { id, status, archived_at } }
// --------------------------------------------------------
router.patch('/:id/archive', (req, res) => {
  try {
    const task = db.get().prepare('SELECT id, status FROM tasks WHERE id = ?').get(req.params.id);
    if (!task) return res.status(404).json({ error: 'Task not found.', code: 404 });

    if (req.body.archived !== undefined && typeof req.body.archived !== 'boolean')
      return res.status(400).json({ error: 'archived must be a boolean.', code: 400 });

    // Der Status bleibt unangetastet - eine zurückgeholte Aufgabe steht wieder
    // genau dort, wo sie beim Ablegen stand.
    const archivedAt = setArchived(task.id, req.body.archived !== false);
    res.json({ data: { id: task.id, status: task.status, archived_at: archivedAt } });
  } catch (err) {
    log.error('PATCH /:id/archive error:', err);
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});

// --------------------------------------------------------
// DELETE /api/v1/tasks/:id
// Aufgabe löschen (Subtasks werden per CASCADE mitgelöscht).
// Response: { ok: true }
// --------------------------------------------------------
router.delete('/:id', (req, res) => {
  try {
    // Vor dem DELETE vormerken (#617): danach sind UID und Objekt-URL weg. Die
    // per CASCADE mitgelöschten Unteraufgaben gehören dazu - eine gespiegelte
    // Aufgabe kann lokal welche bekommen haben, und die stammen dann selbst aus
    // keiner Liste, aber der Fall kostet nichts.
    const doomed = db.get().prepare(
      `SELECT * FROM tasks WHERE (id = ? OR parent_task_id = ?) AND external_source = 'caldav'`
    ).all(req.params.id, req.params.id);
    const queued = doomed.reduce((n, row) => n + (queueTodoDeletion('tasks', row) ? 1 : 0), 0);

    const result = db.get().prepare('DELETE FROM tasks WHERE id = ?').run(req.params.id);
    if (result.changes === 0)
      return res.status(404).json({ error: 'Task not found.', code: 404 });
    res.json({ ok: true });

    if (queued) pushToCalDAV('Löschung');
  } catch (err) {
    log.error('DELETE /:id error:', err);
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});

// --------------------------------------------------------
// Verknüpfte Dokumente (#503)
// Dokumente aus dem Dokumente-Modul können optional mit einer Aufgabe
// verbunden werden. Die Sichtbarkeit spiegelt documents.js: sichtbar ist ein
// Dokument nur für Ersteller:in, bei visibility='family' oder über einen
// expliziten Freigabe-Eintrag (family_document_access).
// --------------------------------------------------------

// Sichtbarkeits-Fragment für ein Dokument (Alias `d`, benannter Bind @me).
const DOC_VISIBLE_SQL = documentVisibleSql('d', 'me');

/** Aufgabe nur zurückgeben, wenn sie für die betrachtende Person sichtbar ist. */
function findVisibleTask(id, me) {
  return db.get().prepare(`
    SELECT t.id FROM tasks t
    WHERE t.id = ? AND ${visibilityWhere('t', 'task_assignments', 'task_id')}
  `).get(id, me, me);
}

/** Für die Person sichtbare, mit der Aufgabe verknüpfte Dokumente. */
function loadTaskDocuments(taskId, me) {
  return db.get().prepare(`
    SELECT d.id, d.name, d.category, d.original_name, d.mime_type, d.file_size,
           d.storage_backend, td.created_at AS linked_at
    FROM task_documents td
    JOIN family_documents d ON d.id = td.document_id
    WHERE td.task_id = @taskId AND d.status != 'archived' AND ${DOC_VISIBLE_SQL}
    ORDER BY d.name COLLATE NOCASE ASC
  `).all({ taskId, me });
}

// GET /api/v1/tasks/:id/documents → { data: LinkedDocument[] }
router.get('/:id/documents', (req, res) => {
  try {
    const me = req.authUserId || req.session.userId;
    const task = findVisibleTask(req.params.id, me);
    if (!task) return res.status(404).json({ error: 'Task not found.', code: 404 });
    res.json({ data: loadTaskDocuments(task.id, me) });
  } catch (err) {
    log.error('GET /:id/documents error:', err);
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});

// PUT /api/v1/tasks/:id/documents  Body: { document_ids: number[] }
// Replace-Set: setzt die Verknüpfungen neu. Es werden nur für die Person
// sichtbare Dokumente verknüpft; ebenso werden nur sichtbare Alt-Verknüpfungen
// ersetzt — unsichtbare (z.B. private Dokumente anderer) bleiben unberührt.
router.put('/:id/documents', (req, res) => {
  try {
    const me = req.authUserId || req.session.userId;
    const task = findVisibleTask(req.params.id, me);
    if (!task) return res.status(404).json({ error: 'Task not found.', code: 404 });

    const requested = Array.isArray(req.body.document_ids)
      ? [...new Set(req.body.document_ids.map(Number).filter((n) => Number.isInteger(n) && n > 0))]
      : [];

    const canSee = db.get().prepare(`SELECT 1 FROM family_documents d WHERE d.id = @id AND ${DOC_VISIBLE_SQL}`);
    const visibleIds = requested.filter((id) => canSee.get({ id, me }));

    db.get().transaction(() => {
      // Nur die für diese Person sichtbaren Alt-Verknüpfungen entfernen.
      db.get().prepare(`
        DELETE FROM task_documents
        WHERE task_id = @taskId AND document_id IN (
          SELECT d.id FROM family_documents d WHERE ${DOC_VISIBLE_SQL}
        )
      `).run({ taskId: task.id, me });
      const ins = db.get().prepare(
        'INSERT OR IGNORE INTO task_documents (task_id, document_id, created_by) VALUES (?, ?, ?)'
      );
      for (const id of visibleIds) ins.run(task.id, id, me);
    })();

    res.json({ data: loadTaskDocuments(task.id, me) });
  } catch (err) {
    log.error('PUT /:id/documents error:', err);
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});

// --------------------------------------------------------
// GET /api/v1/tasks/meta/options
// Liefert Filteroptionen: alle User + gültige Werte für Dropdowns.
// Response: { users, priorities, statuses, categories, tags }
// --------------------------------------------------------
router.get('/meta/options', (req, res) => {
  try {
    const users = db.get().prepare(
      `SELECT id, display_name, avatar_color FROM users u
       WHERE NOT EXISTS (SELECT 1 FROM housekeeping_workers hw WHERE hw.user_id = u.id)
       ORDER BY display_name`
    ).all();
    res.json({
      users,
      priorities: VALID_PRIORITIES,
      statuses: VALID_STATUSES,
      categories: loadTaskCategories(),
      // Sichtbare Tags für Filterleiste und Vorschläge - beim Seitenaufbau
      // mitgeliefert, damit dafür kein zweiter Aufruf nötig ist (#586).
      tags: allTags(db.get(), req.authUserId || req.session.userId),
      default_points: defaultTaskPoints(),
    });
  } catch (err) {
    log.error('GET /meta/options error:', err);
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});

// --------------------------------------------------------
// Standard-Punkte nachziehen (#578)
// Zweisegmentige Pfade — kollidieren nicht mit der /:id-Route.
// --------------------------------------------------------

// GET /api/v1/tasks/points/affected?points=N
// Wie viele nicht erledigte Hauptaufgaben stehen exakt auf diesem Punktwert?
// Vorschau für die Einstellungsseite, bevor sie den Wechsel anbietet — deshalb
// dasselbe Admin-Gate wie beim Setzen des Standards und beim Nachziehen.
router.get('/points/affected', (req, res) => {
  try {
    if (req.authRole !== 'admin') {
      return res.status(403).json({ error: 'Admin access required.', code: 403 });
    }
    const points = Number(req.query.points);
    if (!Number.isInteger(points) || points < 0 || points > MAX_POINTS) {
      return res.status(400).json({ error: `points must be an integer between 0 and ${MAX_POINTS}`, code: 400 });
    }
    res.json({ data: { count: countRebasableTasks(points) } });
  } catch (err) {
    log.error('GET /points/affected error:', err);
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});

// POST /api/v1/tasks/points/rebase  Body: { from, to } → { data: { updated } }
// Hebt alle nicht erledigten Hauptaufgaben, die auf dem alten Standard stehen,
// auf den neuen. „Steht noch auf dem Standard" wird bewusst über den Zahlenwert
// bestimmt statt über ein verstecktes Flag: eine Aufgabe, der jemand von Hand
// exakt den alten Standardwert gegeben hat, wandert deshalb mit. Die Anzahl
// steht vorab im Bestätigungsdialog, der Wechsel ist also nie verdeckt.
router.post('/points/rebase', (req, res) => {
  try {
    if (req.authRole !== 'admin') {
      return res.status(403).json({ error: 'Admin access required.', code: 403 });
    }
    const from = Number(req.body.from);
    const to   = Number(req.body.to);
    const inRange = (n) => Number.isInteger(n) && n >= 0 && n <= MAX_POINTS;
    if (!inRange(from) || !inRange(to)) {
      return res.status(400).json({ error: `from and to must be integers between 0 and ${MAX_POINTS}`, code: 400 });
    }
    // 0 als Quelle würde jede punktelose Aufgabe erfassen — das ist kein
    // „nutzt noch den Standard", sondern schlicht „hat keine Punkte".
    if (from === 0) {
      return res.status(400).json({ error: 'from must be greater than 0.', code: 400 });
    }
    if (from === to) return res.json({ data: { updated: 0 } });

    const result = db.get().prepare(`
      UPDATE tasks SET points = ?
      WHERE points = ? AND parent_task_id IS NULL AND status != ?
    `).run(to, from, REBASE_EXCLUDED_STATUS);

    res.json({ data: { updated: result.changes } });
  } catch (err) {
    log.error('POST /points/rebase error:', err);
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});

export default router;
