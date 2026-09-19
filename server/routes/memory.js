/**
 * Modul: Familienerinnerungen (Family Memory)
 *
 * Sammelt gemeinsame Familieninhalte: gemeinsame Medien, Reisen, Lebenereignisse.
 * Kann automatisch aus dem Medienmodul befüllt werden (media -> link-media / Sync).
 *
 * Eingehängt unter /api/v1/memory (requireAuth + CSRF aus index.js).
 */

import { createLogger } from '../logger.js';
import express from 'express';
import * as db from '../db.js';
import { str, oneOf, collectErrors, MAX_TITLE, MAX_TEXT, MAX_SHORT } from '../middleware/validate.js';
import { getAdapter } from '../services/dms/index.js';

const log = createLogger('Memory');
const router = express.Router();

const MEMORY_TYPES = ['commonMedia', 'travel', 'lifeEvent'];

const uid = (req) => (req.user && (req.user.id ?? req.user.uid)) || 0;
const isAdmin = (req) =>
  !!(req.user && (req.user.role === 'admin' || req.user.isAdmin === 1 || req.user.is_admin === 1));

function parseJsonArray(s) {
  if (!s) return [];
  try {
    const a = JSON.parse(s);
    return Array.isArray(a) ? a : [];
  } catch {
    return [];
  }
}

function loadMembers(memoryId) {
  return db
    .get()
    .prepare(
      `SELECT m.member_uid AS uid, COALESCE(u.display_name, u.username, '?') AS name
       FROM memory_member_rel m JOIN users u ON u.id = m.member_uid
       WHERE m.memory_id = ? ORDER BY m.id ASC`
    )
    .all(memoryId)
    .map((r) => ({ uid: r.uid, name: r.name }));
}

function getItem(id) {
  const row = db.get().prepare('SELECT * FROM memory_item WHERE id = ?').get(id);
  if (!row) return null;
  return {
    ...row,
    is_locked: row.is_locked === 1,
    photo_refs: parseJsonArray(row.photo_refs),
    tags: parseJsonArray(row.tags),
    members: loadMembers(id),
  };
}

// GET /api/v1/memory/list (Zeitleiste)
router.get('/list', (req, res) => {
  try {
    const me = uid(req);
    const admin = isAdmin(req);
    const type = req.query.type;
    const member = req.query.member ? parseInt(req.query.member, 10) : null;
    const tag = req.query.tag;
    const q = req.query.q;
    const from = req.query.from;
    const to = req.query.to;
    const page = Math.max(1, parseInt(req.query.page || '1', 10));
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit || '50', 10)));
    const offset = (page - 1) * limit;

    const where = [];
    const params = [];
    where.push('(is_locked = 0 OR creator_uid = ?' + (admin ? ' OR 1=1' : '') + ')');
    params.push(me);
    if (type && MEMORY_TYPES.includes(type)) {
      where.push('type = ?');
      params.push(type);
    }
    if (member) {
      where.push('id IN (SELECT memory_id FROM memory_member_rel WHERE member_uid = ?)');
      params.push(member);
    }
    if (tag) {
      where.push('tags LIKE ?');
      params.push(`%${tag}%`);
    }
    if (q) {
      where.push('(title LIKE ? OR description LIKE ? OR location LIKE ?)');
      params.push(`%${q}%`, `%${q}%`, `%${q}%`);
    }
    if (from) {
      where.push('event_time >= ?');
      params.push(from);
    }
    if (to) {
      where.push('event_time <= ?');
      params.push(to);
    }
    const whereSql = where.length ? ' WHERE ' + where.join(' AND ') : '';
    const total = db.get().prepare(`SELECT COUNT(*) AS n FROM memory_item${whereSql}`).get(...params).n;
    const rows = db
      .get()
      .prepare(
        `SELECT * FROM memory_item${whereSql} ORDER BY
           CASE WHEN event_time IS NULL OR event_time = '' THEN 1 ELSE 0 END,
           event_time DESC LIMIT ? OFFSET ?`
      )
      .all(...params, limit, offset);

    const items = rows.map((r) => ({
      ...r,
      is_locked: r.is_locked === 1,
      photo_refs: parseJsonArray(r.photo_refs),
      tags: parseJsonArray(r.tags),
      members: loadMembers(r.id),
    }));
    res.json({ data: items, pagination: { page, limit, total, pages: Math.ceil(total / limit) } });
  } catch (err) {
    log.error('GET /list', err);
    res.status(500).json({ error: 'Interner Fehler', code: 500 });
  }
});

// GET /api/v1/memory/export  (vor /:id!)
router.get('/export', (req, res) => {
  try {
    const me = uid(req);
    const admin = isAdmin(req);
    const rows = db
      .get()
      .prepare('SELECT * FROM memory_item WHERE (is_locked = 0 OR creator_uid = ? OR ?)')
      .all(me, admin ? 1 : 0);
    const out = rows.map((r) => ({
      ...r,
      photo_refs: parseJsonArray(r.photo_refs),
      tags: parseJsonArray(r.tags),
      members: loadMembers(r.id),
    }));
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', 'attachment; filename="memory-export.json"');
    res.send(JSON.stringify({ exportedAt: new Date().toISOString(), count: out.length, items: out }, null, 2));
  } catch (err) {
    log.error('GET /export', err);
    res.status(500).json({ error: 'Interner Fehler', code: 500 });
  }
});

// GET /api/v1/memory/photo?accountId=1&dmsId=42
// Proxy fuer Vorschaubilder aus dem DMS. Bewusst NICHT admin-only (wie
// routes/dms.js), damit alle Familienmitglieder Erinnerungsfotos sehen koennen;
// es wird nur ein konkretes, bereits referenziertes Dokument durchgereicht.
const THUMBNAIL_MIME = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
const normalizeMime = (v) => String(v || '').split(';')[0].trim().toLowerCase();

router.get('/photo', async (req, res) => {
  try {
    const accountId = Number(req.query.accountId ?? req.query.account_id);
    const dmsId = String(req.query.dmsId ?? req.query.dms_document_id ?? '').trim();
    if (!Number.isInteger(accountId) || accountId <= 0) {
      return res.status(400).json({ error: 'accountId ist erforderlich', code: 400 });
    }
    if (!dmsId) return res.status(400).json({ error: 'dmsId ist erforderlich', code: 400 });

    const account = db.get().prepare('SELECT * FROM dms_accounts WHERE id = ?').get(accountId);
    if (!account) return res.status(404).json({ error: 'DMS-Konto nicht gefunden', code: 404 });

    const adapter = getAdapter(account);
    let buf = null;
    let mime = '';
    if (typeof adapter.fetchThumbnail === 'function') {
      try {
        const thumb = await adapter.fetchThumbnail(dmsId);
        const m = normalizeMime(thumb?.mime);
        if (thumb?.buffer?.length && THUMBNAIL_MIME.has(m)) { buf = thumb.buffer; mime = m; }
      } catch { /* Fallback auf den Originalinhalt */ }
    }
    if (!buf && typeof adapter.fetchContent === 'function') {
      const content = await adapter.fetchContent(dmsId);
      const m = normalizeMime(content?.mime);
      if (content?.buffer?.length && THUMBNAIL_MIME.has(m)) { buf = content.buffer; mime = m; }
    }
    if (!buf) return res.status(415).json({ error: 'Vorschau nicht verfügbar', code: 415 });

    res.setHeader('Content-Type', mime);
    res.setHeader('Content-Length', String(buf.length));
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'private, max-age=300');
    res.setHeader('Content-Security-Policy', "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'");
    res.end(buf);
  } catch (err) {
    if (err?.status === 404) return res.status(404).json({ error: 'DMS-Dokument nicht gefunden', code: 404 });
    log.error('GET /photo', err);
    res.status(502).json({ error: 'Vorschau konnte nicht geladen werden', code: 502 });
  }
});

// GET /api/v1/memory/:id  (nach statischen Routen)
router.get('/:id', (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const item = getItem(id);
    if (!item) return res.status(404).json({ error: 'Erinnerung nicht gefunden', code: 404 });
    if (item.is_locked && item.creator_uid !== uid(req) && !isAdmin(req)) {
      return res.status(403).json({ error: 'Keine Berechtigung', code: 403 });
    }
    res.json({ data: item });
  } catch (err) {
    log.error('GET /:id', err);
    res.status(500).json({ error: 'Interner Fehler', code: 500 });
  }
});

function createFromMedia(mediaId, { locked = false } = {}) {
  const item = db.get().prepare('SELECT * FROM media_item WHERE id = ?').get(mediaId);
  if (!item) return null;
  const members = db
    .get()
    .prepare('SELECT member_uid FROM media_member_rel WHERE media_id = ?')
    .all(mediaId)
    .map((r) => r.member_uid);
  if (members.length < 2) return null;

  const info = db
    .get()
    .prepare(
      `INSERT INTO memory_item (type, title, event_time, description, photo_refs, tags, creator_uid, source_media_id, is_locked, created_at, updated_at)
       VALUES ('commonMedia', ?, ?, ?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%SZ','now'), strftime('%Y-%m-%dT%H:%M:%SZ','now'))`
    )
    .run(
      item.title,
      item.watch_date || item.updated_at,
      (item.comment || '').slice(0, 2000),
      item.cover_url ? JSON.stringify([item.cover_url]) : null,
      item.tags,
      item.creator_uid,
      mediaId,
      locked ? 1 : 0
    );
  const memoryId = info.lastInsertRowid;
  const ins = db.get().prepare('INSERT OR IGNORE INTO memory_member_rel (memory_id, member_uid) VALUES (?, ?)');
  for (const m of members) ins.run(memoryId, m);
  return memoryId;
}

// POST /api/v1/memory/link-media
router.post('/link-media', (req, res) => {
  try {
    const mediaId = parseInt(req.body.mediaId || req.body.media_id, 10);
    if (!mediaId) return res.status(400).json({ error: 'mediaId erforderlich', code: 400 });
    const locked = req.body.locked === true || req.body.is_locked === true;
    const memoryId = createFromMedia(mediaId, { locked });
    if (!memoryId) {
      return res.status(409).json({
        error: 'Medium hat weniger als 2 teilnehmende Mitglieder – keine gemeinsame Erinnerung.',
        code: 409,
      });
    }
    res.status(201).json({ data: getItem(memoryId) });
  } catch (err) {
    log.error('POST /link-media', err);
    res.status(500).json({ error: 'Interner Fehler', code: 500 });
  }
});

// POST /api/v1/memory/add
router.post('/add', (req, res) => {
  try {
    const me = uid(req);
    const vType = oneOf(req.body.type || 'lifeEvent', MEMORY_TYPES, 'Typ');
    const vTitle = str(req.body.title, 'Titel', { max: MAX_TITLE, required: true });
    const vDesc = str(req.body.description, 'Beschreibung', { max: MAX_TEXT, required: false });
    const vLoc = str(req.body.location, 'Ort', { max: MAX_SHORT, required: false });
    const errors = collectErrors([vType, vTitle, vDesc, vLoc]);
    if (errors.length) return res.status(400).json({ error: errors.join(' '), code: 400 });

    const photos = Array.isArray(req.body.photo_refs)
      ? req.body.photo_refs.filter((x) => typeof x === 'string').slice(0, 30)
      : [];
    const tags = Array.isArray(req.body.tags)
      ? req.body.tags.filter((x) => typeof x === 'string').slice(0, 30)
      : [];
    const members = Array.isArray(req.body.members)
      ? req.body.members.map(Number).filter((n) => Number.isFinite(n))
      : [];

    let newId;
    const tx = db.get().transaction(() => {
      const info = db
        .get()
        .prepare(
          `INSERT INTO memory_item (type, title, event_time, location, description, photo_refs, tags, is_locked, creator_uid)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          vType.value,
          vTitle.value,
          req.body.event_time || req.body.eventTime || null,
          vLoc.value || null,
          vDesc.value || null,
          JSON.stringify(photos),
          JSON.stringify(tags),
          req.body.is_locked || req.body.locked ? 1 : 0,
          me
        );
      newId = info.lastInsertRowid;
      const ins = db
        .get()
        .prepare('INSERT OR IGNORE INTO memory_member_rel (memory_id, member_uid) VALUES (?, ?)');
      for (const m of members) ins.run(newId, m);
    });
    tx();
    res.status(201).json({ data: getItem(newId) });
  } catch (err) {
    log.error('POST /add', err);
    res.status(500).json({ error: 'Interner Fehler', code: 500 });
  }
});

// PUT /api/v1/memory/:id
router.put('/:id', (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const item = db.get().prepare('SELECT * FROM memory_item WHERE id = ?').get(id);
    if (!item) return res.status(404).json({ error: 'Erinnerung nicht gefunden', code: 404 });
    if (item.creator_uid !== uid(req) && !isAdmin(req)) {
      return res.status(403).json({ error: 'Keine Berechtigung', code: 403 });
    }
    const vType = req.body.type !== undefined ? oneOf(req.body.type, MEMORY_TYPES, 'Typ') : null;
    const vTitle = req.body.title !== undefined ? str(req.body.title, 'Titel', { max: MAX_TITLE, required: true }) : null;
    const vDesc = req.body.description !== undefined ? str(req.body.description, 'Beschreibung', { max: MAX_TEXT, required: false }) : null;
    const vLoc = req.body.location !== undefined ? str(req.body.location, 'Ort', { max: MAX_SHORT, required: false }) : null;
    const errors = collectErrors([vType, vTitle, vDesc, vLoc].filter(Boolean));
    if (errors.length) return res.status(400).json({ error: errors.join(' '), code: 400 });

    db.get()
      .prepare(
        `UPDATE memory_item SET
           type        = COALESCE(?, type),
           title       = COALESCE(?, title),
           event_time  = ?,
           location    = COALESCE(?, location),
           description = ?,
           photo_refs  = ?,
           tags        = ?,
           is_locked   = ?,
           updated_at  = strftime('%Y-%m-%dT%H:%M:%SZ','now')
         WHERE id = ?`
      )
      .run(
        vType ? vType.value : null,
        vTitle ? vTitle.value : null,
        req.body.event_time !== undefined ? (req.body.event_time || null) : item.event_time,
        vLoc ? vLoc.value || null : null,
        vDesc ? vDesc.value || null : item.description,
        req.body.photo_refs !== undefined ? JSON.stringify(req.body.photo_refs || []) : item.photo_refs,
        req.body.tags !== undefined ? JSON.stringify(req.body.tags || []) : item.tags,
        req.body.is_locked !== undefined ? (req.body.is_locked ? 1 : 0) : item.is_locked,
        id
      );

    if (req.body.members !== undefined) {
      const members = Array.isArray(req.body.members)
        ? req.body.members.map(Number).filter((n) => Number.isFinite(n))
        : [];
      db.get().transaction(() => {
        db.get().prepare('DELETE FROM memory_member_rel WHERE memory_id = ?').run(id);
        const ins = db.get().prepare('INSERT OR IGNORE INTO memory_member_rel (memory_id, member_uid) VALUES (?, ?)');
        for (const m of members) ins.run(id, m);
      })();
    }
    res.json({ data: getItem(id) });
  } catch (err) {
    log.error('PUT /:id', err);
    res.status(500).json({ error: 'Interner Fehler', code: 500 });
  }
});

// DELETE /api/v1/memory/:id
router.delete('/:id', (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const item = db.get().prepare('SELECT * FROM memory_item WHERE id = ?').get(id);
    if (!item) return res.status(404).json({ error: 'Erinnerung nicht gefunden', code: 404 });
    if (item.creator_uid !== uid(req) && !isAdmin(req)) {
      return res.status(403).json({ error: 'Keine Berechtigung', code: 403 });
    }
    db.get().prepare('DELETE FROM memory_item WHERE id = ?').run(id);
    res.status(204).end();
  } catch (err) {
    log.error('DELETE /:id', err);
    res.status(500).json({ error: 'Interner Fehler', code: 500 });
  }
});

export default router;
