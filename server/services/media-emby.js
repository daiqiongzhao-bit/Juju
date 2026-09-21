/**
 * Modul: Emby-Integration (service)
 * Zweck: Anbindung an einen Emby/Jellyfin-Server:
 *   1) Watched-State-Sync: "gespielt / am Schauen" aus Emby in die
 *      Medienbibliothek uebernehmen (nur Status-Upgrades, nie Downgrades).
 *   2) Fotobibliotheken: Durchsuchen der Foto-Views ueber denselben Server.
 * Konfiguration liegt in system_media_config (emby_url / emby_api_key /
 * emby_user_id) — niemals im Frontend.
 *
 * Emby-REST: Auth via Header "X-Emby-Token: <key>". Jellyfin akzeptiert
 * denselben Header (X-Emby-Token ist dort der empfohlene Legacy-Alias).
 */

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
    const data = await embyFetch(cfg, `/Users/${userId}/Items`, {
      IncludeItemTypes: 'Movie,Series',
      Recursive: 'true',
      Fields: 'UserData,ProductionYear',
      SortBy: 'SortName',
      StartIndex: startIndex + page * limit,
      Limit: limit,
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
  const updatedSamples = [];
  const unmatched = [];
  const rank = { wish: 0, doing: 1, finished: 2 };
  const upd = db.prepare("UPDATE media_item SET status = ?, watch_date = COALESCE(watch_date, strftime('%Y-%m-%d','now')), updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id = ?");

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
    if (rank[hit.status] > rank[row.status] && row.status !== 'finished') {
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
    updatedSamples,
    unmatchedSample: unmatched.slice(0, 10),
    unmatchedCount: unmatched.length,
  };
}

export { getConfig, isConfigured, trimUrl };
