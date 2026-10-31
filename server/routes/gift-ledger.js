/**
 * Modul: Geschenk-/Geld-Register (Gift Ledger)
 *
 * Erfasst Ein-/Ausgänge bei Familienanlässen — getrennt nach
 *   - 'red'   : 白事 (Trauerfall / Beerdigung)
 *   - 'white' : 红事 (Hochzeit / Geburt / Fest)
 * Je Eintrag: Anlass-Name, Datum, Schenker, Betrag, Verhältnis, Notiz, privat.
 *
 * Sensible Finanzdaten: Beträge werden 1:1 gespeichert und NICHT impertinent
 * aggregiert (keine Summen über fremde/versteckte Zeilen). Private Zeilen sind
 * nur für den Ersteller bzw. Admins sichtbar.
 *
 * Eingehängt unter /api/v1/gift-ledger (requireAuth + CSRF kommen aus index.js).
 */

import { createLogger } from '../logger.js';
import express from 'express';
import * as db from '../db.js';
import { str, oneOf, num, bool, date, collectErrors, MAX_TITLE, MAX_TEXT, MAX_SHORT } from '../middleware/validate.js';
import { syncAnniversaryArtifacts } from '../services/anniversaries.js';

const log = createLogger('GiftLedger');
const router = express.Router();

const LEDGER_TYPES = ['red', 'white'];
// 方向：收礼 (received) / 送礼 (given)。红白事与方向相互独立。
const DIRECTIONS = ['received', 'given'];
// 默认“送礼”：日常记账多是送出去的礼（用户 2026-10-25 指定）。
const DEFAULT_DIRECTION = 'given';

const uid = (req) => (req.user && (req.user.id ?? req.user.uid)) || 0;
const isAdmin = (req) =>
  !!(req.user && (req.user.role === 'admin' || req.user.isAdmin === 1 || req.user.is_admin === 1));

// Mappt eine DB-Zeile auf das API-Objekt (amount als Number bzw. null).
function serialize(row) {
  if (!row) return row;
  return {
    ...row,
    amount: row.amount === null || row.amount === undefined ? null : Number(row.amount),
    is_private: row.is_private === 1,
    returned: row.returned === 1,
  };
}

// Optionale Kontakt-Verknüpfung parsen (#relationships): giver/related contact id.
function parseContactId(v) {
  if (v === undefined || v === null || v === '') return null;
  const n = parseInt(v, 10);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/**
 * Erzeugt einen Jahrestag zu einer Geldzeile (Feedback 2026-10-25).
 * anniversaries verlangt einen Kontakt und ein MM-DD-Datum - deshalb wird nur
 * synchronisiert, wenn ein Kontakt verknüpft ist und ein Datum vorliegt.
 * @returns {number|null} ID des angelegten Jahrestags
 */
function createLinkedAnniversary({ contactId, title, eventDate, notes, userId }) {
  if (!contactId || !eventDate) return null;
  const monthDay = String(eventDate).slice(5, 10);
  if (!/^\d{2}-\d{2}$/.test(monthDay)) return null;
  const inserted = db.get()
    .prepare(
      `INSERT INTO anniversaries (contact_id, title, anniversary_date, notes, created_by)
       VALUES (?, ?, ?, ?, ?)`
    )
    .run(contactId, title, monthDay, notes || null, userId);
  const row = db.get().prepare('SELECT * FROM anniversaries WHERE id = ?').get(inserted.lastInsertRowid);
  db.transaction(() => syncAnniversaryArtifacts(db.get(), row))();
  return row.id;
}

/** Zieht Titel/Datum eines bereits verknüpften Jahrestags nach. */
function updateLinkedAnniversary(anniversaryId, { title, eventDate }) {
  if (!anniversaryId) return;
  const row = db.get().prepare('SELECT * FROM anniversaries WHERE id = ?').get(anniversaryId);
  if (!row) return;
  const monthDay = eventDate ? String(eventDate).slice(5, 10) : null;
  const nextDate = /^\d{2}-\d{2}$/.test(String(monthDay || '')) ? monthDay : row.anniversary_date;
  db.get()
    .prepare('UPDATE anniversaries SET title = ?, anniversary_date = ?, updated_at = strftime(\'%Y-%m-%dT%H:%M:%SZ\',\'now\') WHERE id = ?')
    .run(title || row.title, nextDate, anniversaryId);
  const updated = db.get().prepare('SELECT * FROM anniversaries WHERE id = ?').get(anniversaryId);
  db.transaction(() => syncAnniversaryArtifacts(db.get(), updated))();
}

// WHERE-Klausel für Besitzer-/Privat-Scoping (gleiche Semantik wie Medien).
function privacyClause(req) {
  return '(is_private = 0 OR creator_uid = ?' + (isAdmin(req) ? ' OR 1=1' : '') + ')';
}

// GET /api/v1/gift-ledger/list
router.get('/list', (req, res) => {
  try {
    const me = uid(req);
    const admin = isAdmin(req);
    const type = req.query.type;
    const direction = req.query.direction;
    const q = req.query.q;
    const page = Math.max(1, parseInt(req.query.page || '1', 10));
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit || '50', 10)));
    const offset = (page - 1) * limit;

    const where = [privacyClause(req)];
    const params = [me];
    if (type && LEDGER_TYPES.includes(type)) {
      where.push('type = ?');
      params.push(type);
    }
    if (direction && DIRECTIONS.includes(direction)) {
      where.push('direction = ?');
      params.push(direction);
    }
    if (q) {
      where.push(
        "(event_name LIKE ? ESCAPE '\\' OR giver LIKE ? ESCAPE '\\' OR relationship LIKE ? ESCAPE '\\' OR note LIKE ? ESCAPE '\\')"
      );
      // LIKE-Wildcards im Suchtext neutralisieren: sonst würde ein einzelnes „%"
      // alle Zeilen treffen und „_" pro Zeichen matchen (kein Injection-Risiko,
      // da parametrisiert — aber unerwartetes Filterverhalten).
      const like = `%${String(q).replace(/[\\%_]/g, (m) => '\\' + m)}%`;
      params.push(like, like, like, like);
    }
    if (req.query.contactId) {
      const cid = parseContactId(req.query.contactId);
      if (cid) {
        where.push('(giver_contact_id = ? OR related_contact_id = ?)');
        params.push(cid, cid);
      }
    }
    const whereSql = ' WHERE ' + where.join(' AND ');
    const total = db.get().prepare(`SELECT COUNT(*) AS n FROM gift_ledger${whereSql}`).get(...params).n;
    const rows = db
      .get()
      .prepare(`SELECT * FROM gift_ledger${whereSql} ORDER BY (event_date IS NULL), event_date DESC, created_at DESC LIMIT ? OFFSET ?`)
      .all(...params, limit, offset);

    const items = rows.map(serialize);
    res.json({ data: items, pagination: { page, limit, total, pages: Math.ceil(total / limit) } });
  } catch (err) {
    log.error('GET /list', err);
    res.status(500).json({ error: 'Interner Fehler', code: 500 });
  }
});

// GET /api/v1/gift-ledger/stats  (nur eigene/veröffentlichte Zeilen, keine fremden Privat-Daten)
// Liefert ausschließlich die Anzahl je Typ für die Filteranzeige — KEINE Betragssummen,
// um keine Aggregation über nicht sichtbare Zeilen preiszugeben.
router.get('/stats', (req, res) => {
  try {
    const rows = db
      .get()
      .prepare(
        `SELECT type, COUNT(*) AS n FROM gift_ledger
         WHERE ${privacyClause(req)} GROUP BY type`
      )
      .all(uid(req));
    const stats = { red: 0, white: 0 };
    for (const r of rows) stats[r.type] = r.n;
    res.json({ data: stats });
  } catch (err) {
    log.error('GET /stats', err);
    res.status(500).json({ error: 'Interner Fehler', code: 500 });
  }
});

// GET /api/v1/gift-ledger/summary?year=YYYY|all  (vor /:id!)
// Statistik NUR über die sichtbaren Zeilen (gleiche Privat-Scoping-Regel wie
// /list). `year=all` (Standard der Seite) rechnet über alle Jahre, sonst über
// das gewählte Jahr. Geliefert werden: Monatszeilen (nur im Jahresmodus),
// Summen je Typ, Richtungsbilanz (收礼/送礼/结余), Top-Beziehungen sowie die
// Auswertung je Person (wie viel gegeben bzw. erhalten).
router.get('/summary', (req, res) => {
  try {
    const me = uid(req);
    const now = new Date();
    const raw = String(req.query.year ?? '');
    const allTime = raw === 'all';
    const yearNum = parseInt(raw, 10);
    const y = allTime
      ? null
      : (Number.isFinite(yearNum) && yearNum >= 1970 && yearNum <= 2100 ? yearNum : now.getFullYear());
    const vis = privacyClause(req);

    const scopeSql = `${vis} AND event_date IS NOT NULL` + (allTime ? '' : ' AND substr(event_date, 1, 4) = ?');
    const scopeParams = allTime ? [me] : [me, String(y)];

    // Monatsbalken nur im Jahresmodus - über alle Jahre wären 12 Balken falsch.
    const monthRows = [];
    if (!allTime) {
      const months = db
        .get()
        .prepare(
          `SELECT substr(event_date, 1, 7) AS month, type,
                  COUNT(*) AS count, COALESCE(SUM(amount), 0) AS total
           FROM gift_ledger
           WHERE ${scopeSql}
           GROUP BY month, type ORDER BY month ASC`
        )
        .all(...scopeParams);
      for (let m = 1; m <= 12; m++) {
        const key = `${y}-${String(m).padStart(2, '0')}`;
        const red = months.find((r) => r.month === key && r.type === 'red');
        const white = months.find((r) => r.month === key && r.type === 'white');
        monthRows.push({
          month: key,
          redCount: red?.count || 0,
          redTotal: Number(red?.total || 0),
          whiteCount: white?.count || 0,
          whiteTotal: Number(white?.total || 0),
        });
      }
    }

    const typeRow = db
      .get()
      .prepare(
        `SELECT type, COUNT(*) AS count, COALESCE(SUM(amount), 0) AS total
         FROM gift_ledger WHERE ${scopeSql} GROUP BY type`
      )
      .all(...scopeParams);

    const directionRow = db
      .get()
      .prepare(
        `SELECT direction, COUNT(*) AS count, COALESCE(SUM(amount), 0) AS total
         FROM gift_ledger WHERE ${scopeSql} GROUP BY direction`
      )
      .all(...scopeParams);

    const received = directionRow.find((r) => r.direction === 'received');
    const given = directionRow.find((r) => r.direction === 'given');
    const yearTotals = {
      redCount: typeRow.find((r) => r.type === 'red')?.count || 0,
      redTotal: Number(typeRow.find((r) => r.type === 'red')?.total || 0),
      whiteCount: typeRow.find((r) => r.type === 'white')?.count || 0,
      whiteTotal: Number(typeRow.find((r) => r.type === 'white')?.total || 0),
      receivedCount: received?.count || 0,
      receivedTotal: Number(received?.total || 0),
      givenCount: given?.count || 0,
      givenTotal: Number(given?.total || 0),
    };
    // 结余：收到 - 送出（正数 = 收多于送）。
    yearTotals.net = Math.round((yearTotals.receivedTotal - yearTotals.givenTotal) * 100) / 100;

    // Jahresübergreifende Übersicht (für den Jahreswechsel-Reiter).
    const years = db
      .get()
      .prepare(
        `SELECT substr(event_date, 1, 4) AS year, type,
                COUNT(*) AS count, COALESCE(SUM(amount), 0) AS total
         FROM gift_ledger
         WHERE ${vis} AND event_date IS NOT NULL
         GROUP BY year, type ORDER BY year DESC LIMIT 40`
      )
      .all(me);
    const yearMap = new Map();
    for (const r of years) {
      if (!yearMap.has(r.year)) yearMap.set(r.year, { year: r.year, redCount: 0, redTotal: 0, whiteCount: 0, whiteTotal: 0 });
      const row = yearMap.get(r.year);
      if (r.type === 'red') { row.redCount = r.count; row.redTotal = Number(r.total); }
      else { row.whiteCount = r.count; row.whiteTotal = Number(r.total); }
    }

    const relationships = db
      .get()
      .prepare(
        `SELECT COALESCE(NULLIF(relationship, ''), '?') AS relationship, type,
                COUNT(*) AS count, COALESCE(SUM(amount), 0) AS total
         FROM gift_ledger
         WHERE ${scopeSql}
         GROUP BY relationship, type
         ORDER BY SUM(amount) DESC LIMIT 10`
      )
      .all(...scopeParams)
      .map((r) => ({ ...r, total: Number(r.total) }));

    // Auswertung je Person (Feedback 2026-10-25): pro Name die Summe der
    // erhaltenen und der gegebenen Beträge, damit „dieser Mensch: 收 x / 送 y"
    // direkt ablesbar ist. Gruppiert über den Klartext-Namen, damit auch
    // Altbestand ohne Kontakt-Verknüpfung mitzählt.
    const givers = db
      .get()
      .prepare(
        // 人员优先取家庭成员（v164），其次旧的联系人关联，最后才是自由文本。
        `SELECT COALESCE(NULLIF(u.display_name, ''), NULLIF(c.name, ''), NULLIF(gl.giver, ''), '?') AS giver,
                gl.direction,
                COUNT(*) AS count, COALESCE(SUM(gl.amount), 0) AS total
         FROM gift_ledger gl
         LEFT JOIN users u    ON u.id = gl.giver_user_id
         LEFT JOIN contacts c ON c.id = gl.giver_contact_id
         WHERE ${scopeSql} AND COALESCE(NULLIF(u.display_name, ''), NULLIF(c.name, ''), gl.giver) IS NOT NULL
           AND COALESCE(NULLIF(u.display_name, ''), NULLIF(c.name, ''), gl.giver) <> ''
         GROUP BY COALESCE(NULLIF(u.display_name, ''), NULLIF(c.name, ''), NULLIF(gl.giver, ''), '?'), gl.direction
         ORDER BY SUM(gl.amount) DESC LIMIT 100`
      )
      .all(...scopeParams)
      .map((r) => ({ ...r, total: Number(r.total) }));

    res.json({
      data: {
        year: allTime ? 'all' : y,
        allTime,
        months: monthRows,
        yearTotals,
        years: [...yearMap.values()].slice(0, 10),
        relationships,
        givers,
      },
    });
  } catch (err) {
    log.error('GET /summary', err);
    res.status(500).json({ error: 'Interner Fehler', code: 500 });
  }
});

// GET /api/v1/gift-ledger/:id
router.get('/:id', (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const row = db.get().prepare('SELECT * FROM gift_ledger WHERE id = ?').get(id);
    if (!row) return res.status(404).json({ error: 'Eintrag nicht gefunden', code: 404 });
    if (row.is_private === 1 && row.creator_uid !== uid(req) && !isAdmin(req)) {
      return res.status(403).json({ error: 'Keine Berechtigung', code: 403 });
    }
    res.json({ data: serialize(row) });
  } catch (err) {
    log.error('GET /:id', err);
    res.status(500).json({ error: 'Interner Fehler', code: 500 });
  }
});

// POST /api/v1/gift-ledger/add
router.post('/add', (req, res) => {
  try {
    const me = uid(req);
    const vType = oneOf(req.body.type, LEDGER_TYPES, 'Typ');
    const vDirection = req.body.direction
      ? oneOf(req.body.direction, DIRECTIONS, 'Richtung')
      : { value: DEFAULT_DIRECTION };
    const vName = str(req.body.event_name || req.body.eventName, 'Anlass', { max: MAX_TITLE, required: true });
    const vDate = date(req.body.event_date || req.body.eventDate, 'Datum', false);
    // Pflichtfelder (Feedback 2026-10-25): ein Geschenk ohne Schenker und
    // ohne Betrag ist für die Auswertung wertlos.
    const vGiver = str(req.body.giver, 'Schenker', { max: MAX_SHORT, required: true });
    const vAmount = num(req.body.amount, 'Betrag', { required: true });
    const vRel = str(req.body.relationship, 'Verhältnis', { max: MAX_SHORT, required: false });
    const vNote = str(req.body.note, 'Notiz', { max: MAX_TEXT, required: false });
    const vPrivate = req.body.is_private !== undefined ? bool(req.body.is_private, 'Privat') : null;
    const errors = collectErrors([vType, vDirection, vName, vDate, vGiver, vAmount, vRel, vNote, vPrivate].filter(Boolean));
    if (errors.length) return res.status(400).json({ error: errors.join(' '), code: 400 });

    const giverContactId = parseContactId(req.body.giverContactId);
    const relatedContactId = parseContactId(req.body.relatedContactId);
    // 送礼人/收礼人 = 家庭成员（v164）；giver 文本仍写入，作为姓名快照。
    const giverUserId = parseContactId(req.body.giverUserId);
    const returned = req.body.returned ? 1 : 0;

    const info = db
      .get()
      .prepare(
        `INSERT INTO gift_ledger (type, direction, event_name, event_date, giver, amount, relationship, note, is_private, creator_uid, giver_contact_id, related_contact_id, giver_user_id, returned)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        vType.value,
        vDirection.value || DEFAULT_DIRECTION,
        vName.value,
        vDate.value || null,
        vGiver.value || null,
        vAmount.value,
        vRel.value || null,
        vNote.value || null,
        vPrivate && vPrivate.value ? 1 : 0,
        me,
        giverContactId,
        relatedContactId,
        giverUserId,
        returned
      );
    // Optional: gleiche Zeile als Jahrestag anlegen (Default an, weil ein
    // Anlass mit Datum und Kontakt genau das ist, was man später erinnern will).
    // Fehlt Kontakt oder Datum, wird still übersprungen - der Jahrestag braucht
    // beides (anniversaries.contact_id NOT NULL, MM-DD).
    let anniversaryId = null;
    if (req.body.addToAnniversary !== false) {
      try {
        anniversaryId = createLinkedAnniversary({
          // 纪念日挂在「事件对象」名下（v164 语义调整）
          contactId: relatedContactId || giverContactId,
          title: vName.value,
          eventDate: vDate.value || null,
          notes: null,
          userId: me,
        });
        if (anniversaryId) {
          db.get()
            .prepare('UPDATE gift_ledger SET anniversary_id = ? WHERE id = ?')
            .run(anniversaryId, info.lastInsertRowid);
        }
      } catch (err) {
        // Der Geld-Eintrag ist bereits gespeichert; ein fehlgeschlagener
        // Jahrestag darf ihn nicht scheitern lassen.
        log.warn('Jahrestag konnte nicht angelegt werden:', err);
      }
    }

    res.status(201).json({ data: serialize(db.get().prepare('SELECT * FROM gift_ledger WHERE id = ?').get(info.lastInsertRowid)) });
  } catch (err) {
    log.error('POST /add', err);
    res.status(500).json({ error: 'Interner Fehler', code: 500 });
  }
});

// PUT /api/v1/gift-ledger/:id
router.put('/:id', (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const row = db.get().prepare('SELECT * FROM gift_ledger WHERE id = ?').get(id);
    if (!row) return res.status(404).json({ error: 'Eintrag nicht gefunden', code: 404 });
    if (row.creator_uid !== uid(req) && !isAdmin(req)) {
      return res.status(403).json({ error: 'Keine Berechtigung', code: 403 });
    }
    const vType = req.body.type !== undefined ? oneOf(req.body.type, LEDGER_TYPES, 'Typ') : null;
    const vDirection = req.body.direction !== undefined ? oneOf(req.body.direction, DIRECTIONS, 'Richtung') : null;
    const vName = req.body.event_name !== undefined || req.body.eventName !== undefined
      ? str(req.body.event_name || req.body.eventName, 'Anlass', { max: MAX_TITLE, required: true })
      : null;
    const vDate = req.body.event_date !== undefined || req.body.eventDate !== undefined
      ? date(req.body.event_date || req.body.eventDate, 'Datum', false)
      : null;
    // Beim Update gilt dieselbe Pflicht: wird ein Feld mitgeschickt, muss es
    // gefüllt sein (das Formular sendet immer beide).
    const vGiver = req.body.giver !== undefined ? str(req.body.giver, 'Schenker', { max: MAX_SHORT, required: true }) : null;
    const vAmount = req.body.amount !== undefined ? num(req.body.amount, 'Betrag', { required: true }) : null;
    const vRel = req.body.relationship !== undefined ? str(req.body.relationship, 'Verhältnis', { max: MAX_SHORT, required: false }) : null;
    const vNote = req.body.note !== undefined ? str(req.body.note, 'Notiz', { max: MAX_TEXT, required: false }) : null;
    const vPrivate = req.body.is_private !== undefined ? bool(req.body.is_private, 'Privat') : null;
    const errors = collectErrors([vType, vDirection, vName, vDate, vGiver, vAmount, vRel, vNote, vPrivate].filter(Boolean));
    if (errors.length) return res.status(400).json({ error: errors.join(' '), code: 400 });

    const giverContactId = req.body.giverContactId !== undefined ? parseContactId(req.body.giverContactId) : row.giver_contact_id;
    const giverUserId = req.body.giverUserId !== undefined ? parseContactId(req.body.giverUserId) : row.giver_user_id;
    const relatedContactId = req.body.relatedContactId !== undefined ? parseContactId(req.body.relatedContactId) : row.related_contact_id;
    const returnedVal = req.body.returned !== undefined ? (req.body.returned ? 1 : 0) : row.returned;
    let returnedAt = req.body.returned_at !== undefined ? (req.body.returned_at || null) : row.returned_at;
    if (returnedVal === 1 && !returnedAt) returnedAt = new Date().toISOString();
    if (returnedVal === 0) returnedAt = null;

    db.get()
      .prepare(
        `UPDATE gift_ledger SET
           type         = COALESCE(?, type),
           direction    = COALESCE(?, direction),
           event_name   = COALESCE(?, event_name),
           event_date   = ?,
           giver        = ?,
           amount       = ?,
           relationship = ?,
           note         = ?,
           is_private   = ?,
           giver_contact_id = ?,
           related_contact_id = ?,
           giver_user_id = ?,
           returned = ?,
           returned_at = ?,
           updated_at   = strftime('%Y-%m-%dT%H:%M:%SZ','now')
         WHERE id = ?`
      )
      .run(
        vType ? vType.value : null,
        vDirection ? vDirection.value : null,
        vName ? vName.value : null,
        vDate ? vDate.value || null : row.event_date,
        vGiver ? vGiver.value || null : row.giver,
        vAmount ? vAmount.value : row.amount,
        vRel ? vRel.value || null : row.relationship,
        vNote ? vNote.value || null : row.note,
        vPrivate ? (vPrivate.value ? 1 : 0) : row.is_private,
        giverContactId,
        relatedContactId,
        giverUserId,
        returnedVal,
        returnedAt,
        id
      );
    // Verknüpften Jahrestag nachziehen bzw. bei Bedarf neu anlegen.
    try {
      const fresh = db.get().prepare('SELECT * FROM gift_ledger WHERE id = ?').get(id);
      if (fresh.anniversary_id) {
        updateLinkedAnniversary(fresh.anniversary_id, {
          title: fresh.event_name,
          eventDate: fresh.event_date,
        });
      } else if (req.body.addToAnniversary !== false && fresh.giver_contact_id && fresh.event_date) {
        const newId = createLinkedAnniversary({
          contactId: fresh.related_contact_id || fresh.giver_contact_id,
          title: fresh.event_name,
          eventDate: fresh.event_date,
          notes: null,
          userId: uid(req),
        });
        if (newId) {
          db.get().prepare('UPDATE gift_ledger SET anniversary_id = ? WHERE id = ?').run(newId, id);
        }
      }
    } catch (err) {
      log.warn('Jahrestag konnte nicht aktualisiert werden:', err);
    }

    res.json({ data: serialize(db.get().prepare('SELECT * FROM gift_ledger WHERE id = ?').get(id)) });
  } catch (err) {
    log.error('PUT /:id', err);
    res.status(500).json({ error: 'Interner Fehler', code: 500 });
  }
});

// DELETE /api/v1/gift-ledger/:id
router.delete('/:id', (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const row = db.get().prepare('SELECT * FROM gift_ledger WHERE id = ?').get(id);
    if (!row) return res.status(404).json({ error: 'Eintrag nicht gefunden', code: 404 });
    if (row.creator_uid !== uid(req) && !isAdmin(req)) {
      return res.status(403).json({ error: 'Keine Berechtigung', code: 403 });
    }
    db.get().prepare('DELETE FROM gift_ledger WHERE id = ?').run(id);
    res.status(204).end();
  } catch (err) {
    log.error('DELETE /:id', err);
    res.status(500).json({ error: 'Interner Fehler', code: 500 });
  }
});

// POST /api/v1/gift-ledger/batch-delete  { ids: number[] }
// Jede ID wird einzeln auf Existenz + Besitzer-/Admin-Recht geprüft; nicht
// berechtigte oder fehlende IDs werden still ignoriert (kein partial failure).
router.post('/batch-delete', (req, res) => {
  try {
    const me = uid(req);
    const admin = isAdmin(req);
    const ids = Array.isArray(req.body.ids)
      ? req.body.ids.map(Number).filter((n) => Number.isFinite(n) && n > 0)
      : [];
    if (!ids.length) return res.status(400).json({ error: 'Keine IDs angegeben', code: 400 });

    let deleted = 0;
    const tx = db.get().transaction(() => {
      for (const id of ids) {
        const row = db.get().prepare('SELECT * FROM gift_ledger WHERE id = ?').get(id);
        if (!row) continue;
        if (row.creator_uid !== me && !admin) continue;
        db.get().prepare('DELETE FROM gift_ledger WHERE id = ?').run(id);
        deleted++;
      }
    });
    tx();
    res.json({ data: { requested: ids.length, deleted } });
  } catch (err) {
    log.error('POST /batch-delete', err);
    res.status(500).json({ error: 'Interner Fehler', code: 500 });
  }
});

export default router;
