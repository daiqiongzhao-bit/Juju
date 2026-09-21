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

const log = createLogger('GiftLedger');
const router = express.Router();

const LEDGER_TYPES = ['red', 'white'];

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
  };
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
    if (q) {
      where.push('(event_name LIKE ? OR giver LIKE ? OR relationship LIKE ? OR note LIKE ?)');
      const like = `%${q}%`;
      params.push(like, like, like, like);
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
    const vName = str(req.body.event_name || req.body.eventName, 'Anlass', { max: MAX_TITLE, required: true });
    const vDate = date(req.body.event_date || req.body.eventDate, 'Datum', false);
    const vGiver = str(req.body.giver, 'Schenker', { max: MAX_SHORT, required: false });
    const vAmount = num(req.body.amount, 'Betrag', { required: false });
    const vRel = str(req.body.relationship, 'Verhältnis', { max: MAX_SHORT, required: false });
    const vNote = str(req.body.note, 'Notiz', { max: MAX_TEXT, required: false });
    const vPrivate = req.body.is_private !== undefined ? bool(req.body.is_private, 'Privat') : null;
    const errors = collectErrors([vType, vName, vDate, vGiver, vAmount, vRel, vNote, vPrivate].filter(Boolean));
    if (errors.length) return res.status(400).json({ error: errors.join(' '), code: 400 });

    const info = db
      .get()
      .prepare(
        `INSERT INTO gift_ledger (type, event_name, event_date, giver, amount, relationship, note, is_private, creator_uid)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        vType.value,
        vName.value,
        vDate.value || null,
        vGiver.value || null,
        vAmount.value,
        vRel.value || null,
        vNote.value || null,
        vPrivate && vPrivate.value ? 1 : 0,
        me
      );
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
    const vName = req.body.event_name !== undefined || req.body.eventName !== undefined
      ? str(req.body.event_name || req.body.eventName, 'Anlass', { max: MAX_TITLE, required: true })
      : null;
    const vDate = req.body.event_date !== undefined || req.body.eventDate !== undefined
      ? date(req.body.event_date || req.body.eventDate, 'Datum', false)
      : null;
    const vGiver = req.body.giver !== undefined ? str(req.body.giver, 'Schenker', { max: MAX_SHORT, required: false }) : null;
    const vAmount = req.body.amount !== undefined ? num(req.body.amount, 'Betrag', { required: false }) : null;
    const vRel = req.body.relationship !== undefined ? str(req.body.relationship, 'Verhältnis', { max: MAX_SHORT, required: false }) : null;
    const vNote = req.body.note !== undefined ? str(req.body.note, 'Notiz', { max: MAX_TEXT, required: false }) : null;
    const vPrivate = req.body.is_private !== undefined ? bool(req.body.is_private, 'Privat') : null;
    const errors = collectErrors([vType, vName, vDate, vGiver, vAmount, vRel, vNote, vPrivate].filter(Boolean));
    if (errors.length) return res.status(400).json({ error: errors.join(' '), code: 400 });

    db.get()
      .prepare(
        `UPDATE gift_ledger SET
           type         = COALESCE(?, type),
           event_name   = COALESCE(?, event_name),
           event_date   = ?,
           giver        = ?,
           amount       = ?,
           relationship = ?,
           note         = ?,
           is_private   = ?,
           updated_at   = strftime('%Y-%m-%dT%H:%M:%SZ','now')
         WHERE id = ?`
      )
      .run(
        vType ? vType.value : null,
        vName ? vName.value : null,
        vDate ? vDate.value || null : row.event_date,
        vGiver ? vGiver.value || null : row.giver,
        vAmount ? vAmount.value : row.amount,
        vRel ? vRel.value || null : row.relationship,
        vNote ? vNote.value || null : row.note,
        vPrivate ? (vPrivate.value ? 1 : 0) : row.is_private,
        id
      );
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
