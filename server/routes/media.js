/**
 * Modul: Medienbibliothek (Media Library)
 *
 * Filme/Serien, Musik, Bücher. Optional TMDB / OpenLibrary-Anreicherung.
 * Einträge mit >= 2 teilnehmenden Familienmitgliedern werden automatisch
 * als "gemeinsame Erinnerung" in das Familien-Erinnerungsmodul gespiegelt.
 *
 * Eingehängt unter /api/v1/media (requireAuth + CSRF kommen aus index.js).
 */

import { createLogger } from '../logger.js';
import express from 'express';
import * as db from '../db.js';
import { str, oneOf, collectErrors, MAX_TITLE, MAX_TEXT, MAX_SHORT } from '../middleware/validate.js';
import { searchTmdb, searchOpenLibrary, searchItunes, searchGoogleBooks } from '../services/media-metadata.js';
import * as emby from '../services/media-emby.js';
import { notifyUsers, actorName } from '../services/notify-fanout.js';

const log = createLogger('Media');
const router = express.Router();

const MEDIA_TYPES = ['movie', 'music', 'book'];
const STATUSES = ['wish', 'doing', 'finished'];

const uid = (req) => (req.user && (req.user.id ?? req.user.uid)) || 0;
const isAdmin = (req) =>
  !!(req.user && (req.user.role === 'admin' || req.user.isAdmin === 1 || req.user.is_admin === 1));

function parseTags(s) {
  if (!s) return [];
  try {
    const a = JSON.parse(s);
    return Array.isArray(a) ? a : [];
  } catch {
    return [];
  }
}
function stringifyTags(arr) {
  return JSON.stringify(Array.isArray(arr) ? arr.filter(Boolean).slice(0, 30) : []);
}

function getConfig() {
  let row = db.get().prepare('SELECT * FROM system_media_config ORDER BY id DESC LIMIT 1').get();
  if (!row) {
    const info = db.get().prepare('INSERT INTO system_media_config (openlibrary_enable) VALUES (1)').run();
    row = db.get().prepare('SELECT * FROM system_media_config WHERE id = ?').get(info.lastInsertRowid);
  }
  return row;
}

function loadMembers(mediaId) {
  return db
    .get()
    .prepare(
      `SELECT m.member_uid AS uid,
              COALESCE(u.display_name, u.username, '?') AS name,
              m.is_shared_memory AS shared,
              m.member_status AS member_status
       FROM media_member_rel m
       JOIN users u ON u.id = m.member_uid
       WHERE m.media_id = ?
       ORDER BY m.id ASC`
    )
    .all(mediaId)
    .map((r) => ({
      uid: r.uid,
      name: r.name,
      shared: r.shared === 1,
      memberStatus: STATUSES.includes(r.member_status) ? r.member_status : null,
    }));
}

function getItem(id) {
  const row = db.get().prepare('SELECT * FROM media_item WHERE id = ?').get(id);
  if (!row) return null;
  return {
    ...row,
    rating: row.rating === null ? null : Number(row.rating),
    is_private: row.is_private === 1,
    tags: parseTags(row.tags),
    metadata: row.metadata_json ? safeJson(row.metadata_json, null) : null,
    members: loadMembers(id),
  };
}

function safeJson(s, fallback) {
  try {
    return JSON.parse(s);
  } catch {
    return fallback;
  }
}

// Automatische Synchronisation in das Familien-Erinnerungsmodul.
function syncSharedMemory(mediaId) {
  try {
    const item = db.get().prepare('SELECT * FROM media_item WHERE id = ?').get(mediaId);
    if (!item) return;
    const members = db
      .get()
      .prepare('SELECT member_uid FROM media_member_rel WHERE media_id = ?')
      .all(mediaId)
      .map((r) => r.member_uid);
    const existing = db.get().prepare('SELECT id FROM memory_item WHERE source_media_id = ?').get(mediaId);

    if (members.length >= 2) {
      let memoryId;
      if (!existing) {
        const info = db
          .get()
          .prepare(
            `INSERT INTO memory_item (type, title, event_time, description, photo_refs, tags, creator_uid, source_media_id, created_at, updated_at)
             VALUES ('commonMedia', ?, ?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%SZ','now'), strftime('%Y-%m-%dT%H:%M:%SZ','now'))`
          )
          .run(
            item.title,
            item.watch_date || item.updated_at,
            (item.comment || '').slice(0, 2000),
            item.cover_url ? JSON.stringify([item.cover_url]) : null,
            item.tags,
            item.creator_uid,
            mediaId
          );
        memoryId = info.lastInsertRowid;
      } else {
        memoryId = existing.id;
      }
      db.get().prepare('DELETE FROM memory_member_rel WHERE memory_id = ?').run(memoryId);
      const ins = db
        .get()
        .prepare('INSERT OR IGNORE INTO memory_member_rel (memory_id, member_uid) VALUES (?, ?)');
      for (const m of members) ins.run(memoryId, m);
    } else if (existing) {
      db.get().prepare('DELETE FROM memory_member_rel WHERE memory_id = ?').run(existing.id);
      db.get().prepare('DELETE FROM memory_item WHERE id = ?').run(existing.id);
    }
  } catch (err) {
    log.error('syncSharedMemory', err);
  }
}

// GET /api/v1/media/list
router.get('/list', (req, res) => {
  try {
    const me = uid(req);
    const admin = isAdmin(req);
    const type = req.query.type;
    const status = req.query.status;
    const member = req.query.member ? parseInt(req.query.member, 10) : null;
    const tag = req.query.tag;
    const q = req.query.q;
    const page = Math.max(1, parseInt(req.query.page || '1', 10));
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit || '50', 10)));
    const offset = (page - 1) * limit;

    const where = [];
    const params = [];
    where.push('(is_private = 0 OR creator_uid = ?' + (admin ? ' OR 1=1' : '') + ')');
    params.push(me);
    if (type && MEDIA_TYPES.includes(type)) {
      where.push('media_type = ?');
      params.push(type);
    }
    if (status && STATUSES.includes(status)) {
      where.push('status = ?');
      params.push(status);
    }
    if (tag) {
      where.push('tags LIKE ?');
      params.push(`%${tag}%`);
    }
    if (q) {
      where.push('(title LIKE ? OR comment LIKE ?)');
      params.push(`%${q}%`, `%${q}%`);
    }
    if (member) {
      where.push('id IN (SELECT media_id FROM media_member_rel WHERE member_uid = ?)');
      params.push(member);
    }
    const whereSql = where.length ? ' WHERE ' + where.join(' AND ') : '';
    const total = db.get().prepare(`SELECT COUNT(*) AS n FROM media_item${whereSql}`).get(...params).n;
    const rows = db
      .get()
      .prepare(`SELECT * FROM media_item${whereSql} ORDER BY updated_at DESC LIMIT ? OFFSET ?`)
      .all(...params, limit, offset);

    const items = rows.map((r) => ({
      ...r,
      rating: r.rating === null ? null : Number(r.rating),
      is_private: r.is_private === 1,
      tags: parseTags(r.tags),
      members: loadMembers(r.id),
    }));
    res.json({ data: items, pagination: { page, limit, total, pages: Math.ceil(total / limit) } });
  } catch (err) {
    log.error('GET /list', err);
    res.status(500).json({ error: 'Interner Fehler', code: 500 });
  }
});

// GET /api/v1/media/search/tmdb  (vor /:id!)
router.get('/search/tmdb', async (req, res) => {
  try {
    const cfg = getConfig();
    const q = (req.query.q || '').toString().trim();
    if (!q) return res.json({ data: [] });
    const results = await searchTmdb(q, { apiKey: cfg.tmdb_api_key, proxyUrl: cfg.tmdb_proxy_url });
    res.json({ data: results });
  } catch (err) {
    log.error('search/tmdb', err);
    res.status(500).json({ error: 'Interner Fehler', code: 500 });
  }
});

// GET /api/v1/media/search/openlib  (vor /:id!)
router.get('/search/openlib', async (req, res) => {
  try {
    const q = (req.query.q || '').toString().trim();
    const isbn = (req.query.isbn || '').toString().trim();
    const results = await searchOpenLibrary(q, { isbn });
    res.json({ data: results });
  } catch (err) {
    log.error('search/openlib', err);
    res.status(500).json({ error: 'Interner Fehler', code: 500 });
  }
});

// GET /api/v1/media/search/itunes  (Musik-Alben, ohne Key; vor /:id!)
router.get('/search/itunes', async (req, res) => {
  try {
    const q = (req.query.q || '').toString().trim();
    if (!q) return res.json({ data: [] });
    const results = await searchItunes(q);
    res.json({ data: results });
  } catch (err) {
    log.error('search/itunes', err);
    res.status(500).json({ error: 'Interner Fehler', code: 500 });
  }
});

// GET /api/v1/media/search/gbooks  (Google Books, ohne Key; vor /:id!)
router.get('/search/gbooks', async (req, res) => {
  try {
    const q = (req.query.q || '').toString().trim();
    if (!q) return res.json({ data: [] });
    const results = await searchGoogleBooks(q);
    res.json({ data: results });
  } catch (err) {
    log.error('search/gbooks', err);
    res.status(500).json({ error: 'Interner Fehler', code: 500 });
  }
});

// GET /api/v1/media/img?src=<urlencoded https-URL>   (vor /:id!)
// Serverseitiger Cover-Proxy. TMDB-/OpenLibrary-Bilder liegen auf externen
// Hosts, die in manchen Netzen (z. B. CN) nicht erreichbar sind. Der Server
// holt das Bild und liefert es same-origin aus, damit die Bibliothek ueberall
// Cover zeigt. Nur feste Host-Whitelist, nur https, nur image/*.
const IMG_HOST_WHITELIST = new Set([
  'image.tmdb.org',
  'openlibrary.org',
  'covers.openlibrary.org',
  'books.google.com',
]);
// mzstatic (iTunes-CDN) nutzt viele regionalierte Subdomains -> Suffix-Regel.
const IMG_HOST_SUFFIXES = ['.mzstatic.com'];
const isAllowedImgHost = (hostname) =>
  IMG_HOST_WHITELIST.has(hostname) || IMG_HOST_SUFFIXES.some((sfx) => hostname.endsWith(sfx));
router.get('/img', async (req, res) => {
  try {
    const raw = (req.query.src || '').toString();
    let target;
    try {
      target = new URL(raw);
    } catch {
      return res.status(400).json({ error: 'Ungültige Bild-URL', code: 400 });
    }
    if (target.protocol !== 'https:' || !isAllowedImgHost(target.hostname)) {
      return res.status(400).json({ error: 'Host nicht erlaubt', code: 400 });
    }
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    let upstream;
    try {
      upstream = await fetch(target.href, { signal: ctrl.signal, redirect: 'follow' });
    } finally {
      clearTimeout(timer);
    }
    if (!upstream.ok) return res.status(502).json({ error: 'Bild nicht verfügbar', code: 502 });
    const ctype = (upstream.headers.get('content-type') || 'image/jpeg').split(';')[0].trim();
    if (!ctype.startsWith('image/')) {
      return res.status(415).json({ error: 'Kein Bild', code: 415 });
    }
    const buf = Buffer.from(await upstream.arrayBuffer());
    res.setHeader('Content-Type', ctype);
    // Cover sind unveraenderlich -> aggressiv cachen (Browser + CDN/nginx).
    res.setHeader('Cache-Control', 'public, max-age=604800, immutable');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.end(buf);
  } catch (err) {
    log.error('GET /img', err);
    res.status(502).json({ error: 'Bild-Proxy Fehler', code: 502 });
  }
});

// GET /api/v1/media/config  (kein API-Key im Klartext; vor /:id!)
router.get('/config', (req, res) => {
  try {
    const cfg = getConfig();
    res.json({
      data: {
        tmdbConfigured: !!cfg.tmdb_api_key,
        tmdbProxyUrl: cfg.tmdb_proxy_url || '',
        openlibraryEnable: cfg.openlibrary_enable === 1,
        embyConfigured: !!(cfg.emby_url && cfg.emby_api_key),
        embyUrl: cfg.emby_url || '',
        embyUserId: cfg.emby_user_id || '',
      },
    });
  } catch (err) {
    log.error('GET /config', err);
    res.status(500).json({ error: 'Interner Fehler', code: 500 });
  }
});

// GET /api/v1/media/export  (JSON-Backup; vor /:id!)
router.get('/export', (req, res) => {
  try {
    const me = uid(req);
    const admin = isAdmin(req);
    const rows = db
      .get()
      .prepare('SELECT * FROM media_item WHERE (is_private = 0 OR creator_uid = ? OR ?)')
      .all(me, admin ? 1 : 0);
    const out = rows.map((r) => ({ ...r, members: loadMembers(r.id) }));
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', 'attachment; filename="media-export.json"');
    res.send(JSON.stringify({ exportedAt: new Date().toISOString(), count: out.length, items: out }, null, 2));
  } catch (err) {
    log.error('GET /export', err);
    res.status(500).json({ error: 'Interner Fehler', code: 500 });
  }
});

// PUT /api/v1/media/:id/member-status  { uid, status }
// Per-Mitglied-Watch-Status (Migration 140): jedes Familienmitglied kann
// denselben Eintrag individuell markieren (wish/doing/finished/null=reset).
router.put('/:id/member-status', (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const item = db.get().prepare('SELECT * FROM media_item WHERE id = ?').get(id);
    if (!item) return res.status(404).json({ error: 'Eintrag nicht gefunden', code: 404 });
    const memberUid = Number(req.body.uid);
    if (!Number.isFinite(memberUid)) return res.status(400).json({ error: 'uid fehlt', code: 400 });
    const rel = db
      .get()
      .prepare('SELECT id FROM media_member_rel WHERE media_id = ? AND member_uid = ?')
      .get(id, memberUid);
    if (!rel) return res.status(404).json({ error: 'Mitglied nicht verknüpft', code: 404 });
    const raw = req.body.status;
    if (raw !== null && raw !== undefined && raw !== '' && !STATUSES.includes(raw)) {
      return res.status(400).json({ error: 'Ungültiger Status', code: 400 });
    }
    db.get()
      .prepare('UPDATE media_member_rel SET member_status = ? WHERE media_id = ? AND member_uid = ?')
      .run(raw ? raw : null, id, memberUid);
    res.json({ data: getItem(id) });
  } catch (err) {
    log.error('PUT /:id/member-status', err);
    res.status(500).json({ error: 'Interner Fehler', code: 500 });
  }
});

// ------------------------------------------------------------
// Emby-Integration
// ------------------------------------------------------------

function requireEmbyConfig(req, res) {
  const cfg = emby.getConfig(db.get());
  if (!emby.isConfigured(cfg)) {
    res.status(400).json({ error: 'Emby nicht konfiguriert', code: 400 });
    return null;
  }
  return cfg;
}

// GET /api/v1/media/emby/config  (nur Admin; Key wird nie im Klartext zurückgegeben)
router.get('/emby/config', (req, res) => {
  try {
    if (!isAdmin(req)) return res.status(403).json({ error: 'Keine Berechtigung', code: 403 });
    const cfg = emby.getConfig(db.get());
    res.json({
      data: {
        configured: emby.isConfigured(cfg),
        url: cfg.emby_url || '',
        userId: cfg.emby_user_id || '',
      },
    });
  } catch (err) {
    log.error('GET /emby/config', err);
    res.status(500).json({ error: 'Interner Fehler', code: 500 });
  }
});

// PUT /api/v1/media/emby/config  (nur Admin; leerer Key = bestehenden behalten)
router.put('/emby/config', (req, res) => {
  try {
    if (!isAdmin(req)) return res.status(403).json({ error: 'Keine Berechtigung', code: 403 });
    const cfg = emby.getConfig(db.get());
    const vUrl = String(req.body.url ?? '').trim().replace(/\/+$/, '');
    const vKey = String(req.body.apiKey ?? '').trim();
    const vUser = String(req.body.userId ?? '').trim();
    if (vUrl && !/^https?:\/\//.test(vUrl)) {
      return res.status(400).json({ error: 'URL muss mit http(s):// beginnen', code: 400 });
    }
    const newKey = vKey.length ? vKey : cfg.emby_api_key;
    db.get()
      .prepare(
        `UPDATE system_media_config
         SET emby_url = ?, emby_api_key = ?, emby_user_id = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')
         WHERE id = ?`
      )
      .run(vUrl || null, newKey || null, vUser || null, cfg.id);
    const updated = emby.getConfig(db.get());
    res.json({ data: { configured: emby.isConfigured(updated), url: updated.emby_url || '', userId: updated.emby_user_id || '' } });
  } catch (err) {
    log.error('PUT /emby/config', err);
    res.status(500).json({ error: 'Interner Fehler', code: 500 });
  }
});

// POST /api/v1/media/emby/test  (nur Admin): Verbindung + Benutzerliste
router.post('/emby/test', async (req, res) => {
  try {
    if (!isAdmin(req)) return res.status(403).json({ error: 'Keine Berechtigung', code: 403 });
    const cfg = requireEmbyConfig(req, res);
    if (!cfg) return;
    const info = await emby.testConnection(cfg);
    res.json({ data: info });
  } catch (err) {
    log.error('POST /emby/test', err);
    res.status(502).json({ error: 'Emby nicht erreichbar: ' + (err?.message || ''), code: 502 });
  }
});

// POST /api/v1/media/emby/sync  (nur Admin): Watched-Status übernehmen
router.post('/emby/sync', async (req, res) => {
  try {
    if (!isAdmin(req)) return res.status(403).json({ error: 'Keine Berechtigung', code: 403 });
    const cfg = requireEmbyConfig(req, res);
    if (!cfg) return;
    const result = await emby.syncWatched(db.get(), cfg);
    res.json({ data: result });
  } catch (err) {
    log.error('POST /emby/sync', err);
    res.status(502).json({ error: 'Sync fehlgeschlagen: ' + (err?.message || ''), code: 502 });
  }
});

// GET /api/v1/media/:id  (param route NACH allen statischen Routen)
router.get('/:id', (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const item = getItem(id);
    if (!item) return res.status(404).json({ error: 'Eintrag nicht gefunden', code: 404 });
    if (item.is_private && item.creator_uid !== uid(req) && !isAdmin(req)) {
      return res.status(403).json({ error: 'Keine Berechtigung', code: 403 });
    }
    res.json({ data: item });
  } catch (err) {
    log.error('GET /:id', err);
    res.status(500).json({ error: 'Interner Fehler', code: 500 });
  }
});

// POST /api/v1/media/add
router.post('/add', (req, res) => {
  try {
    const me = uid(req);
    const vType = oneOf(req.body.mediaType || req.body.media_type, MEDIA_TYPES, 'Typ');
    const vTitle = str(req.body.title, 'Titel', { max: MAX_TITLE, required: true });
    const vStatus = oneOf(req.body.status || 'wish', STATUSES, 'Status');
    const vComment = str(req.body.comment, 'Kommentar', { max: MAX_TEXT, required: false });
    const vCover = str(req.body.coverUrl || req.body.cover_url, 'Cover', { max: 2048, required: false });
    const errors = collectErrors([vType, vTitle, vStatus, vComment, vCover]);
    if (errors.length) return res.status(400).json({ error: errors.join(' '), code: 400 });

    const rating = req.body.rating != null ? Number(req.body.rating) : null;
    if (rating != null && (Number.isNaN(rating) || rating < 0 || rating > 5)) {
      return res.status(400).json({ error: 'Bewertung muss zwischen 0 und 5 liegen', code: 400 });
    }
    const members = Array.isArray(req.body.members)
      ? req.body.members.map(Number).filter((n) => Number.isFinite(n))
      : [];

    let newId;
    const tx = db.get().transaction(() => {
      const info = db
        .get()
        .prepare(
          `INSERT INTO media_item (media_type, title, cover_url, status, rating, comment, metadata_json, is_private, watch_date, tags, creator_uid)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          vType.value,
          vTitle.value,
          vCover.value || null,
          vStatus.value,
          rating,
          vComment.value || null,
          req.body.metadata ? JSON.stringify(req.body.metadata) : null,
          req.body.isPrivate ? 1 : 0,
          req.body.watchDate || req.body.watch_date || null,
          stringifyTags(req.body.tags),
          me
        );
      newId = info.lastInsertRowid;
      const ins = db
        .get()
        .prepare('INSERT OR IGNORE INTO media_member_rel (media_id, member_uid, is_shared_memory) VALUES (?, ?, 0)');
      for (const m of members) ins.run(newId, m);
    });
    tx();
    syncSharedMemory(newId);

    // Teilnehmer benachrichtigen (best-effort, bricht den Request nie)
    const targets = members.filter((m) => m !== me);
    if (targets.length) {
      notifyUsers({
        userIds: targets,
        type: 'media_added',
        title: `Neuer Eintrag: ${vTitle.value}`,
        body: `${actorName(me)} hat „${vTitle.value}“ zur Medienbibliothek hinzugefügt.`,
        link: `/media?item=${newId}`,
        entityType: 'media_item',
        entityId: newId,
        actorId: me,
      }).catch((err) => log.warn('notify failed', err?.message));
    }

    res.status(201).json({ data: getItem(newId) });
  } catch (err) {
    log.error('POST /add', err);
    res.status(500).json({ error: 'Interner Fehler', code: 500 });
  }
});

// PUT /api/v1/media/config  (nur Admin; MUSS vor /:id stehen, sonst matcht
// der generische /:id-Handler "config" und antwortet mit 404)
router.put('/config', (req, res) => {
  try {
    if (!isAdmin(req)) return res.status(403).json({ error: 'Keine Berechtigung', code: 403 });
    const cfg = getConfig();
    const vKey = str(req.body.tmdbApiKey ?? req.body.tmdb_api_key, 'TMDB Key', { max: 512, required: false });
    const vProxy = str(req.body.tmdbProxyUrl ?? req.body.tmdb_proxy_url, 'Proxy', { max: 2048, required: false });
    if (vKey.error) return res.status(400).json({ error: vKey.error, code: 400 });
    // Empty key means "keep existing" — only overwrite when a non-empty key is supplied.
    const newTmdbKey = vKey.value && vKey.value.trim().length ? vKey.value : cfg.tmdb_api_key;
    const olEnable = req.body.openlibraryEnable;
    const olValue = olEnable === false || olEnable === 0 ? 0 : 1;
    db.get()
      .prepare(
        `UPDATE system_media_config
         SET tmdb_api_key = ?, tmdb_proxy_url = ?, openlibrary_enable = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')
         WHERE id = ?`
      )
      .run(newTmdbKey || null, vProxy.value || null, olValue, cfg.id);
    res.json({
      data: {
        tmdbConfigured: !!newTmdbKey,
        tmdbProxyUrl: vProxy.value || '',
        openlibraryEnable: olValue === 1,
      },
    });
  } catch (err) {
    log.error('PUT /config', err);
    res.status(500).json({ error: 'Interner Fehler', code: 500 });
  }
});

// PUT /api/v1/media/:id
router.put('/:id', (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const item = db.get().prepare('SELECT * FROM media_item WHERE id = ?').get(id);
    if (!item) return res.status(404).json({ error: 'Eintrag nicht gefunden', code: 404 });
    if (item.creator_uid !== uid(req) && !isAdmin(req)) {
      return res.status(403).json({ error: 'Keine Berechtigung', code: 403 });
    }
    const vType = req.body.mediaType !== undefined ? oneOf(req.body.mediaType, MEDIA_TYPES, 'Typ') : null;
    const vTitle = req.body.title !== undefined ? str(req.body.title, 'Titel', { max: MAX_TITLE, required: true }) : null;
    const vStatus = req.body.status !== undefined ? oneOf(req.body.status, STATUSES, 'Status') : null;
    const vComment = req.body.comment !== undefined ? str(req.body.comment, 'Kommentar', { max: MAX_TEXT, required: false }) : null;
    const vCover = req.body.coverUrl !== undefined ? str(req.body.coverUrl, 'Cover', { max: 2048, required: false }) : null;
    const errors = collectErrors([vType, vTitle, vStatus, vComment, vCover].filter(Boolean));
    if (errors.length) return res.status(400).json({ error: errors.join(' '), code: 400 });

    const rating = req.body.rating != null ? Number(req.body.rating) : null;
    if (rating != null && (Number.isNaN(rating) || rating < 0 || rating > 5)) {
      return res.status(400).json({ error: 'Bewertung muss zwischen 0 und 5 liegen', code: 400 });
    }

    db.get()
      .prepare(
        `UPDATE media_item SET
           media_type = COALESCE(?, media_type),
           title      = COALESCE(?, title),
           cover_url  = COALESCE(?, cover_url),
           status     = COALESCE(?, status),
           rating     = ?,
           comment    = ?,
           metadata_json = ?,
           is_private = ?,
           watch_date = ?,
           tags       = ?,
           updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')
         WHERE id = ?`
      )
      .run(
        vType ? vType.value : null,
        vTitle ? vTitle.value : null,
        vCover ? vCover.value || null : null,
        vStatus ? vStatus.value : null,
        rating,
        vComment ? vComment.value || null : item.comment,
        req.body.metadata !== undefined ? JSON.stringify(req.body.metadata) : item.metadata_json,
        req.body.isPrivate !== undefined ? (req.body.isPrivate ? 1 : 0) : item.is_private,
        req.body.watchDate !== undefined ? (req.body.watchDate || null) : item.watch_date,
        req.body.tags !== undefined ? stringifyTags(req.body.tags) : item.tags,
        id
      );

    const updated = getItem(id);
    const newComment = vComment ? vComment.value || null : null;
    if (vComment && newComment !== (item.comment || null)) {
      const targets = (updated?.members || []).map((m) => m.uid).filter((u) => u !== uid(req));
      if (targets.length) {
        notifyUsers({
          userIds: targets,
          type: 'media_comment',
          title: `Neuer Kommentar zu „${updated.title}“`,
          body: `${actorName(uid(req))}: ${newComment}`,
          link: `/media?item=${id}`,
          entityType: 'media_item',
          entityId: id,
          actorId: uid(req),
        }).catch((err) => log.warn('notify failed', err?.message));
      }
    }

    res.json({ data: updated });
  } catch (err) {
    log.error('PUT /:id', err);
    res.status(500).json({ error: 'Interner Fehler', code: 500 });
  }
});

// POST /api/v1/media/batch-delete  { ids: number[] }  (MUSS vor /:id stehen,
// sonst matcht der generische /:id-Handler "batch-delete" und antwortet mit 404)
// Jede ID wird einzeln auf Existenz + Besitzer-/Admin-Recht geprüft; nicht
// berechtigte oder fehlende IDs werden still übersprungen.
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
        const item = db.get().prepare('SELECT * FROM media_item WHERE id = ?').get(id);
        if (!item) continue;
        if (item.creator_uid !== me && !admin) continue;
        // Rel-Tabelle zuerst: kein FK-CASCADE garantiert, sonst bleiben Waisen.
        db.get().prepare('DELETE FROM media_member_rel WHERE media_id = ?').run(id);
        const existing = db.get().prepare('SELECT id FROM memory_item WHERE source_media_id = ?').get(id);
        if (existing) {
          db.get().prepare('DELETE FROM memory_member_rel WHERE memory_id = ?').run(existing.id);
          db.get().prepare('DELETE FROM memory_item WHERE id = ?').run(existing.id);
        }
        db.get().prepare('DELETE FROM media_item WHERE id = ?').run(id);
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

// DELETE /api/v1/media/:id
router.delete('/:id', (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const item = db.get().prepare('SELECT * FROM media_item WHERE id = ?').get(id);
    if (!item) return res.status(404).json({ error: 'Eintrag nicht gefunden', code: 404 });
    if (item.creator_uid !== uid(req) && !isAdmin(req)) {
      return res.status(403).json({ error: 'Keine Berechtigung', code: 403 });
    }
    db.get().prepare('DELETE FROM media_item WHERE id = ?').run(id);
    res.status(204).end();
  } catch (err) {
    log.error('DELETE /:id', err);
    res.status(500).json({ error: 'Interner Fehler', code: 500 });
  }
});

// POST /api/v1/media/:id/member  -> Mitglieder aktualisieren + Shared-Memory-Sync
router.post('/:id/member', (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const item = db.get().prepare('SELECT * FROM media_item WHERE id = ?').get(id);
    if (!item) return res.status(404).json({ error: 'Eintrag nicht gefunden', code: 404 });
    const members = Array.isArray(req.body.members)
      ? req.body.members.map((m) => (typeof m === 'object' && m !== null ? { uid: Number(m.uid), status: m.status } : { uid: Number(m), status: null })).filter((m) => Number.isFinite(m.uid) && m.uid > 0)
      : [];
    db.get().transaction(() => {
      db.get().prepare('DELETE FROM media_member_rel WHERE media_id = ?').run(id);
      const ins = db
        .get()
        .prepare('INSERT OR IGNORE INTO media_member_rel (media_id, member_uid, is_shared_memory, member_status) VALUES (?, ?, 0, ?)');
      for (const m of members) ins.run(id, m.uid, STATUSES.includes(m.status) ? m.status : null);
    })();
    syncSharedMemory(id);
    res.json({ data: getItem(id) });
  } catch (err) {
    log.error('POST /:id/member', err);
    res.status(500).json({ error: 'Interner Fehler', code: 500 });
  }
});

export default router;
