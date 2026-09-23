/**
 * Modul: Emby-Integration (service)
 * Zweck: Anbindung an einen Emby/Jellyfin-Server:
 *   1) Watched-State-Sync: "gespielt / am Schauen" aus Emby in die
 *      Medienbibliothek uebernehmen. Status-Upgrades (wish < doing < finished)
 *      werden uebernommen; meldet Emby explizit "nicht gesehen", wird ein
 *      lokales finished/doing auf wish zurueckgesetzt (Downgrade).
 *   2) Fotobibliotheken: Durchsuchen der Foto-Views ueber denselben Server.
 * Konfiguration liegt in system_media_config (emby_url / emby_api_key /
 * emby_user_id) — niemals im Frontend.
 *
 * Emby-REST: Auth via Header "X-Emby-Token: <key>". Jellyfin akzeptiert
 * denselben Header (X-Emby-Token ist dort der empfohlene Legacy-Alias).
 */

import { searchTmdb } from './media-metadata.js';
import * as db from '../db.js';
import { createHmac } from 'crypto';
import { createLogger } from '../logger.js';

const log = createLogger('Emby');
const DEFAULT_TIMEOUT = 12000;

function normalizeTitle(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[\s·・:：,，.。!！?？'"""''（）()\[\]【】_-]+/g, '')
    .trim();
}

function trimUrl(url) {
  return String(url || '').replace(/\/+$/, '');
}

function getConfig(db) {
  let row = db.prepare('SELECT * FROM system_media_config ORDER BY id DESC LIMIT 1').get();
  if (!row) {
    const info = db.prepare('INSERT INTO system_media_config (openlibrary_enable) VALUES (1)').run();
    row = db.prepare('SELECT * FROM system_media_config WHERE id = ?').get(info.lastInsertRowid);
  }
  return row;
}

function isConfigured(cfg) {
  return !!(cfg && cfg.emby_url && cfg.emby_api_key);
}

async function embyFetch(cfg, path, { query = {}, timeoutMs = DEFAULT_TIMEOUT } = {}) {
  const url = new URL(trimUrl(cfg.emby_url) + path);
  for (const [k, v] of Object.entries(query)) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url.href, {
      headers: { 'X-Emby-Token': cfg.emby_api_key, Accept: 'application/json' },
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      const err = new Error(`Emby ${res.status}: ${body.slice(0, 200)}`);
      err.status = res.status;
      throw err;
    }
    return res.json();
  } finally {
    clearTimeout(timer);
  }
}

async function resolveUserId(cfg) {
  if (cfg.emby_user_id) return cfg.emby_user_id;
  const users = await embyFetch(cfg, '/Users');
  if (!Array.isArray(users) || !users.length) {
    throw new Error('Emby: keine Benutzer gefunden — emby_user_id konfigurieren');
  }
  // Erst-Admin ist der übliche Familien-Account.
  const admin = users.find((u) => u?.Policy?.IsAdministrator) || users[0];
  return admin.Id;
}

// ------------------------------------------------------------
// 1) Verbindungstest
// ------------------------------------------------------------
export async function testConnection(cfg) {
  const info = await embyFetch(cfg, '/System/Info');
  const users = await embyFetch(cfg, '/Users').catch(() => []);
  const userId = cfg.emby_user_id || (Array.isArray(users) ? (users.find((u) => u?.Policy?.IsAdministrator) || users[0])?.Id : null) || null;
  return {
    serverName: info?.ServerName || 'Emby',
    version: info?.Version || '',
    userId,
    users: (Array.isArray(users) ? users : []).slice(0, 20).map((u) => ({ id: u.Id, name: u.Name })),
  };
}

// ------------------------------------------------------------
// 2) Watched-State-Sync
// ------------------------------------------------------------
async function fetchEmbyVideoItems(cfg, userId) {
  const out = [];
  const startIndex = 0;
  const limit = 500;
  for (let page = 0; page < 10; page++) {
    // WICHTIG: Parameter muessen in options.query liegen — embyFetch liest
    // nur `query`, Top-Level-Keys werden stillschweigend ignoriert.
    const data = await embyFetch(cfg, `/Users/${userId}/Items`, {
      query: {
        IncludeItemTypes: 'Movie,Series',
        Recursive: 'true',
        Fields: 'UserData,ProductionYear',
        SortBy: 'SortName',
        StartIndex: startIndex + page * limit,
        Limit: limit,
      },
    });
    const items = Array.isArray(data?.Items) ? data.Items : [];
    out.push(...items);
    if (items.length < limit) break;
  }
  return out;
}

function embyStatusOf(item) {
  const ud = item.UserData || {};
  if (ud.Played) return 'finished';
  if (item.Type === 'Series' && ud.UnplayedItemCount === 0 && (ud.PlayedItemCount || 0) > 0) return 'finished';
  if ((ud.PlayedPercentage || 0) > 0 || (ud.PlayedItemCount || 0) > 0) return 'doing';
  // Emby meldet explizit "nicht gesehen" -> downgrade (wish) bei Sync.
  if (ud.Played === false) return 'unplayed';
  return null;
}

/**
 * Synchronisiert Emby-Watched-States in media_item.
 * Matching: normalisierter Titel (+ Jahr ±1, wenn beide bekannt).
 * Nur Status-Upgrades: wish→doing→finished; ein lokales 'finished' bleibt.
 */
export async function syncWatched(db, cfg) {
  const userId = await resolveUserId(cfg);
  const items = await fetchEmbyVideoItems(cfg, userId);

  const byTitle = new Map();
  for (const it of items) {
    const key = normalizeTitle(it.Name);
    if (!key) continue;
    const status = embyStatusOf(it);
    if (!status) continue;
    const entry = { title: it.Name, year: it.ProductionYear || null, status };
    if (!byTitle.has(key)) byTitle.set(key, []);
    byTitle.get(key).push(entry);
  }

  const localRows = db
    .prepare("SELECT id, title, status, metadata_json FROM media_item WHERE media_type = 'movie'")
    .all();
  const totalRows = db.prepare('SELECT COUNT(*) AS n FROM media_item').get().n;

  let matched = 0;
  let updated = 0;
  let downgraded = 0;
  const updatedSamples = [];
  const downgradedSamples = [];
  const unmatched = [];
  const rank = { wish: 0, doing: 1, finished: 2 };
  const upd = db.prepare("UPDATE media_item SET status = ?, watch_date = COALESCE(watch_date, strftime('%Y-%m-%d','now')), updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id = ?");
  const down = db.prepare("UPDATE media_item SET status = 'wish', progress = NULL, watch_date = NULL, updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id = ?");

  for (const row of localRows) {
    const key = normalizeTitle(row.title);
    const candidates = byTitle.get(key) || [];
    let hit = null;
    if (candidates.length === 1) {
      hit = candidates[0];
    } else if (candidates.length > 1) {
      // Mehrere Kandidaten: Jahr aus lokalen Metadaten versuchen (±1 Toleranz).
      let localYear = null;
      try {
        const meta = row.metadata_json ? JSON.parse(row.metadata_json) : null;
        const y = meta?.year || meta?.releaseDate || meta?.publishDate;
        localYear = y ? parseInt(String(y).slice(0, 4), 10) : null;
      } catch { /* ignore */ }
      hit =
        (localYear && candidates.find((c) => c.year && Math.abs(c.year - localYear) <= 1)) ||
        candidates.find((c) => c.status === 'finished') ||
        candidates[0];
    }
    if (!hit) {
      if (candidates.length === 0) unmatched.push(row.title);
      continue;
    }
    matched++;
    // Emby meldet explizit "nicht gesehen" -> Downgrade (wish), nur wenn aktuell higher.
    if (hit.status === 'unplayed') {
      if (row.status === 'finished' || row.status === 'doing') {
        down.run(row.id);
        downgraded++;
        if (downgradedSamples.length < 10) downgradedSamples.push({ title: row.title, from: row.status, to: 'wish' });
      }
    } else if (rank[hit.status] > rank[row.status] && row.status !== 'finished') {
      upd.run(hit.status, row.id);
      updated++;
      if (updatedSamples.length < 10) updatedSamples.push({ title: row.title, from: row.status, to: hit.status });
    }
  }

  return {
    embyItems: items.length,
    localItems: totalRows,
    matched,
    updated,
    downgraded,
    updatedSamples,
    downgradedSamples,
    unmatchedSample: unmatched.slice(0, 10),
    unmatchedCount: unmatched.length,
  };
}

/**
 * Importiert den Emby-Wiedergabeverlauf als neue media_item-Eintraege.
 * Status-Mapping: Played -> finished; PlayedPercentage/PlayedItemCount > 0
 * -> doing; ohne Status wird uebersprungen. Dedup-Key ist der normalisierte
 * Titel + media_type ('movie' fuer Movie, 'tv' fuer Series) — bereits
 * vorhandene Eintraege werden uebersprungen, es wird nur ergaenzt.
 * cover_url bleibt leer; Jahr/Quelle landen in metadata_json.
 */
export async function importHistory(db, cfg, creatorUid) {
  const userId = await resolveUserId(cfg);
  const limit = 500;
  const items = [];
  for (let page = 0; page < 20; page++) {
    const data = await embyFetch(cfg, `/Users/${userId}/Items`, {
      query: {
        IncludeItemTypes: 'Movie,Series',
        Recursive: 'true',
        Fields: 'UserData,ProductionYear,ImageTags',
        SortBy: 'SortName',
        StartIndex: page * limit,
        Limit: limit,
      },
    });
    const arr = Array.isArray(data?.Items) ? data.Items : [];
    items.push(...arr);
    if (arr.length < limit) break;
  }

  const existingKeys = new Set(
    db
      .prepare("SELECT title, media_type FROM media_item WHERE media_type IN ('movie', 'tv')")
      .all()
      .map((r) => normalizeTitle(r.title) + '|' + r.media_type)
  );

  // 1) Sammeln, was eingefuegt wuerde (Cover-Suche folgt gebuendelt danach).
  const pending = [];
  let skipped = 0;
  for (const it of items) {
    const ud = it.UserData || {};
    let status = null;
    if (ud.Played) status = 'finished';
    else if ((ud.PlayedPercentage || 0) > 0 || (ud.PlayedItemCount || 0) > 0) status = 'doing';
    if (!status) {
      skipped++;
      continue;
    }
    const mediaType = it.Type === 'Series' ? 'tv' : 'movie';
    const key = normalizeTitle(it.Name) + '|' + mediaType;
    if (!normalizeTitle(it.Name) || existingKeys.has(key)) {
      skipped++;
      continue;
    }
    existingKeys.add(key);
    pending.push({
      mediaType,
      title: it.Name,
      status,
      watchDate: status === 'finished' ? (ud.LastPlayedDate || null) : null,
      year: it.ProductionYear || null,
      embyId: it.Id || null,
    });
  }

  // 2) TMDB-Cover gebuendelt suchen (Konsequenz 5, Fehler -> NULL wie gehabt).
  let covers = 0;
  if (cfg.tmdb_api_key && pending.length) {
    const results = await mapLimit(pending, 5, (p) => tmdbCoverFor(cfg, p.title, p.year, p.mediaType));
    pending.forEach((p, i) => {
      const hit = results[i];
      if (hit && hit.posterUrl) {
        p.coverUrl = hit.posterUrl;
        p.tmdbId = hit.externalId || null;
        covers++;
      }
    });
  }

  // 3) Einfuegen (better-sqlite3 ist synchron).
  const ins = db.prepare(
    `INSERT INTO media_item
       (media_type, title, cover_url, status, rating, comment, metadata_json, is_private, watch_date, tags, creator_uid)
     VALUES (?, ?, ?, ?, NULL, NULL, ?, 0, ?, NULL, ?)`
  );
  for (const p of pending) {
    const meta = JSON.stringify({ year: p.year, source: 'emby', emby_id: p.embyId, tmdb_id: p.tmdbId || null });
    ins.run(p.mediaType, p.title, p.coverUrl || null, p.status, meta, p.watchDate, creatorUid);
  }
  return { imported: pending.length, skipped, total: items.length, covers };
}

/**
 * TMDB-Cover fuer einen Emby-Titel suchen (Kind + Titel/Originaltitel- oder
 * Jahres-Match, sonst bestes Element der richtigen Art). Fehler -> null.
 */
async function tmdbCoverFor(cfg, title, year, mediaType) {
  try {
    const results = await searchTmdb(title, { apiKey: cfg.tmdb_api_key, proxyUrl: cfg.tmdb_proxy_url });
    const sameKind = results.filter((r) => r.kind === mediaType && r.posterUrl);
    if (!sameKind.length) return null;
    const key = normalizeTitle(title);
    const y = year ? parseInt(String(year), 10) : null;
    const hit =
      sameKind.find((r) => normalizeTitle(r.title) === key || normalizeTitle(r.originalTitle) === key) ||
      (y
        ? sameKind.find(
            (r) => r.releaseDate && Math.abs(parseInt(String(r.releaseDate).slice(0, 4), 10) - y) <= 1
          )
        : null) ||
      sameKind[0];
    return hit ? { posterUrl: hit.posterUrl, externalId: hit.externalId } : null;
  } catch {
    return null;
  }
}

/** Kleine Concurrency-Hilfe (Promise-Pool ohne Abhaengigkeiten). */
async function mapLimit(arr, n, fn) {
  const out = new Array(arr.length);
  let i = 0;
  async function worker() {
    while (i < arr.length) {
      const idx = i++;
      out[idx] = await fn(arr[idx], idx);
    }
  }
  await Promise.all(Array.from({ length: Math.min(n, arr.length || 1) }, worker));
  return out;
}

/**
 * Aggregiert den Watching-Status einer Serie aus Emby (fuer Episode-Webhooks).
 * Zaehlt gesehene/ungesehene Episoden und liefert 'finished' | 'doing' | 'wish'.
 * Gibt null zurueck, wenn keine Episoden abrufbar sind (kein Aggregate moeglich).
 */
async function aggregateSeriesStatus(cfg, seriesId) {
  const userId = await resolveUserId(cfg);
  const data = await embyFetch(cfg, `/Shows/${seriesId}/Episodes`, {
    query: { userId, Fields: 'UserData', Recursive: 'true', IncludeItemTypes: 'Episode', Limit: 1000 },
  });
  const eps = Array.isArray(data?.Items) ? data.Items : [];
  if (!eps.length) return null;
  let played = 0;
  for (const e of eps) {
    const ud = e.UserData || {};
    if (ud.Played) played++;
  }
  if (played === eps.length) return 'finished';
  if (played === 0) return 'wish';
  return 'doing';
}

// ------------------------------------------------------------
// 3) Real-time Webhook (Emby -> Juju, push)
//    Oeffentlicher Endpunkt /webhook/emby (siehe server/index.js).
// ------------------------------------------------------------

function parseWebhookPayload(req) {
  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { return null; }
  }
  if (body && typeof body === 'object' && typeof body.data === 'string') {
    try { body = JSON.parse(body.data); } catch { /* unveraendert */ }
  }
  return body && typeof body === 'object' ? body : null;
}

function verifyWebhookSignature(req, secret) {
  if (!secret) return true; // kein Secret konfiguriert -> alles erlaubt (nur Intranet)
  const sig = req.headers['x-emby-signature'] || req.headers['X-Emby-Signature'];
  if (sig && req.rawBody && req.rawBody.length) {
    const exp = (sig.startsWith('sha256=') ? sig.slice(7) : sig).toLowerCase();
    const act = createHmac('sha256', secret).update(req.rawBody).digest('hex');
    if (act === exp) return true;
  }
  const q = req.query && req.query.secret;
  if (q && q === secret) return true;
  return false;
}

function ticksToPercent(posTicks, runTicks) {
  const p = Number(posTicks || 0);
  const r = Number(runTicks || 0);
  if (!r) return null;
  return Math.min(100, Math.max(0, Math.round((p / r) * 100)));
}

const WEBHOOK_STATUS_RANK = { wish: 0, doing: 1, finished: 2 };

/**
 * Behandelt eingehende Emby-Webhook-Events und aktualisiert media_item
 * live (Status + Fortschritt). Erstellt neue Eintraege nur bei "fertig
 * gesehen" (vermeidet Spam bei blossen "start"-Events).
 */
export async function handleEmbyWebhook(req, res) {
  const cfg = getConfig(db.get());
  if (!isConfigured(cfg)) {
    return res.status(400).json({ error: 'Emby nicht konfiguriert', code: 400 });
  }
  if (!verifyWebhookSignature(req, cfg.emby_webhook_secret)) {
    return res.status(401).json({ error: 'Ungueltiges Webhook-Geheimnis', code: 401 });
  }
  const payload = parseWebhookPayload(req);
  if (!payload) return res.status(400).json({ error: 'Ungueltige Payload', code: 400 });

  // Letzten Webhook-Empfang vermerken (Einstellungen-Anzeige). Nicht fatal.
  try {
    db.get()
      .prepare("UPDATE system_media_config SET emby_webhook_last_received = strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id = ?")
      .run(cfg.id);
  } catch { /* non-fatal */ }

  const event = String(payload.Event || '').toLowerCase();
  const item = payload.Item || {};
  const user = payload.User || {};
  if (cfg.emby_user_id && user.Id && String(user.Id) !== String(cfg.emby_user_id)) {
    return res.json({ ok: true, ignored: 'other-user' });
  }

  const itemType = String(item.Type || '');
  const isEpisode = itemType === 'Episode';
  const isSeries = itemType === 'Series';
  const mediaType = isSeries || isEpisode ? 'tv' : 'movie';
  // Bei Episoden auf Serien-Ebene aggregieren (SeriesName = Serientitel).
  let title = String(item.Name || '').trim();
  if (isEpisode) {
    const seriesName = String(item.SeriesName || '').trim();
    if (seriesName) title = seriesName;
  }
  const year = item.ProductionYear || item.Year || null;
  const providerTmdb =
    (item.ProviderIds && (item.ProviderIds.Tmdb || item.ProviderIds.tmdb)) || null;

  const progress = ticksToPercent(payload.PlaybackPositionTicks, item.RunTimeTicks);
  const ud = item.UserData || null;
  const udPlayed = !!(ud && ud.Played);
  const udUnplayed = !!(ud && ud.Played === false); // explizit "nicht gesehen"
  const finished =
    udPlayed ||
    event === 'userdata.played' ||
    (event === 'playback.stop' && progress !== null && progress >= 90);

  let status;
  if (finished) status = 'finished';
  else if (udUnplayed || event === 'userdata.unplayed') status = 'wish';
  else if (event === 'playback.start' || event === 'playback.progress' || event === 'playback.stop') status = 'doing';
  else status = null;

  if (!status) {
    // Nicht zutreffendes Event: nur debug (Lärm reduzieren).
    log.debug('emby webhook ignored', { event, title, type: itemType || null, hasUD: !!ud });
    return res.json({ ok: true, ignored: 'event' });
  }
  log.info('emby webhook', {
    event,
    title,
    type: itemType || null,
    hasUD: !!ud,
    played: ud ? ud.Played : null,
    pct: progress,
    status,
  });

  // Episode -> Serien-Status aggregieren (nur bei klaren Statuswechseln,
  // um Emby nicht bei jedem Progress-Event zu befragen).
  let applyStatus = status;
  if (isEpisode && item.SeriesId && (status === 'finished' || status === 'wish')) {
    try {
      const agg = await aggregateSeriesStatus(cfg, String(item.SeriesId));
      if (agg) applyStatus = agg;
    } catch { /* Emby nicht erreichbar -> Event-Status beibehalten */ }
  }

  const database = db.get();
  let existing = null;
  // Bei Episoden stimmen die ProviderIds i.d.R. auf die Folge, nicht die Serie ->
  // nur Titel-Match (SeriesName) verwenden.
  if (!isEpisode && providerTmdb) {
    const rows = database
      .prepare("SELECT id, status, metadata_json FROM media_item WHERE media_type = ? AND metadata_json LIKE ?")
      .all(mediaType, '%"tmdb_id":"' + String(providerTmdb).replace(/"/g, '') + '"%');
    if (rows.length) existing = rows[0];
  }
  if (!existing && title) {
    const rows = database
      .prepare('SELECT id, status, metadata_json FROM media_item WHERE media_type = ? AND title = ?')
      .all(mediaType, title);
    if (rows.length) existing = rows[0];
  }

  if (existing) {
    const cur = existing.status;
    if (applyStatus === 'wish') {
      database
        .prepare(
          "UPDATE media_item SET status='wish', progress=NULL, watch_date=NULL, updated_at=strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id=?"
        )
        .run(existing.id);
    } else if (WEBHOOK_STATUS_RANK[applyStatus] > WEBHOOK_STATUS_RANK[cur]) {
      const watchDate =
        applyStatus === 'finished'
          ? (item.UserData && item.UserData.LastPlayedDate
              ? String(item.UserData.LastPlayedDate).slice(0, 10)
              : new Date().toISOString().slice(0, 10))
          : existing.watch_date;
      database
        .prepare(
          "UPDATE media_item SET status=?, progress=?, watch_date=COALESCE(watch_date,?), updated_at=strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id=?"
        )
        .run(applyStatus, progress, watchDate, existing.id);
    } else {
      database
        .prepare(
          "UPDATE media_item SET progress=?, updated_at=strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id=?"
        )
        .run(progress, existing.id);
    }
    return res.json({ ok: true, updated: existing.id, status: applyStatus });
  }

  // Nicht gefunden: bei "fertig gesehen" / "abgehakt" neu anlegen; bei Serien
  // auch "doing" (aggregierter Stand), damit der Serien-Eintrag den Emby-Stand
  // vollstaendig spiegelt. Reines "doing" bei Film/Einzel-Episode wird NICHT
  // angelegt (kein Spam).
  const canCreate =
    applyStatus === 'finished' ||
    applyStatus === 'wish' ||
    ((isSeries || isEpisode) && applyStatus === 'doing');
  if (!canCreate) {
    return res.json({ ok: true, ignored: 'not-found-not-eligible' });
  }
  let coverUrl = null;
  let tmdbId = null;
  if (cfg.tmdb_api_key && title) {
    const cover = await tmdbCoverFor(cfg, title, year, mediaType);
    if (cover) {
      coverUrl = cover.posterUrl;
      tmdbId = cover.externalId || null;
    }
  }
  const watchDate = applyStatus === 'finished'
    ? (item.UserData && item.UserData.LastPlayedDate
        ? String(item.UserData.LastPlayedDate).slice(0, 10)
        : new Date().toISOString().slice(0, 10))
    : null;
  const finalProgress = applyStatus === 'wish' ? null : progress;
  const meta = JSON.stringify({
    year: year || null,
    source: 'emby-webhook',
    emby_id: item.Id || null,
    emby_series_id: item.SeriesId || null,
    tmdb_id: tmdbId || providerTmdb || null,
  });
  const creatorRow = database.prepare('SELECT id FROM users ORDER BY id ASC LIMIT 1').get();
  const creatorUid = creatorRow ? creatorRow.id : 1;
  const ins = database.prepare(
    `INSERT INTO media_item
       (media_type, title, cover_url, status, rating, comment, metadata_json, is_private, watch_date, tags, creator_uid, progress)
     VALUES (?, ?, ?, ?, NULL, NULL, ?, 0, ?, NULL, ?, ?)`
  );
  const info = ins.run(mediaType, title, coverUrl || null, applyStatus, meta, watchDate, creatorUid, finalProgress);
  return res.json({ ok: true, created: info.lastInsertRowid, status: applyStatus });
}

export { getConfig, isConfigured, trimUrl };
