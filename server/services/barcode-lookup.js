/**
 * Modul: Waren-Barcode-Abfrage (mxnzp)
 * Zweck: 69er-Strichcode → Produktname/Hersteller/Marke. Wird im Medizinschrank
 *        benutzt: Code eingeben/scannen → Produktname → über drug-catalog.js /
 *        KI den Beipackzettel nachziehen.
 *
 * Datenquelle: mxnzp.com (https://www.mxnzp.com/doc?id=barcode) - kostenloser
 * Kontingentzugang, Admin trägt app_id/app_secret unter Einstellungen →
 * Administration → AI ein (dort sitzen die externen Zugangsdaten). OHNE Key
 * bleibt der Strichcode reines Speicherfeld; die UI sagt das deutlich.
 *
 * Feldnamen der API sind historisch gewachsen: mehrere plausible Schlüssel
 * werden probiert (goodsName/name/goods_name, supplier/manufacturer/producer,
 * brand/trademark), damit kleine Dokumentänderungen nicht gleich brechen.
 */

import * as db from '../db.js';
import { createLogger } from '../logger.js';

const log = createLogger('BarcodeLookup');

const API_URL = 'https://www.mxnzp.com/api/barcode/goods/details';
const TIMEOUT_MS = 10000;

/** Liest die Einzeil-Konfiguration; Secret bleibt verschleiert draußen. */
export function getConfig() {
  try {
    const row = db.get().prepare('SELECT * FROM barcode_api_config WHERE id = 1').get();
    return {
      configured: Boolean(row?.app_id && row?.app_secret),
      appId: row?.app_id || '',
      hasSecret: Boolean(row?.app_secret),
      enabled: row ? Number(row.enabled) === 1 : true,
      updatedAt: row?.updated_at || null,
      updatedBy: row?.updated_by ?? null,
    };
  } catch (err) {
    log.error('Reading barcode config failed:', err?.message || err);
    return { configured: false, appId: '', hasSecret: false, enabled: true, updatedAt: null, updatedBy: null };
  }
}

export function saveConfig({ appId, appSecret, enabled }, userId = null) {
  const row = db.get().prepare('SELECT app_secret FROM barcode_api_config WHERE id = 1').get();
  const keepSecret = row?.app_secret || null;
  const nextSecret = appSecret ? String(appSecret).trim() : keepSecret; // leer = unverändert
  db.get().prepare(`
    INSERT INTO barcode_api_config (id, app_id, app_secret, enabled, updated_at, updated_by)
    VALUES (1, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%SZ', 'now'), ?)
    ON CONFLICT(id) DO UPDATE SET
      app_id = excluded.app_id,
      app_secret = excluded.app_secret,
      enabled = excluded.enabled,
      updated_at = excluded.updated_at,
      updated_by = excluded.updated_by
  `).run(
    String(appId || '').trim() || null,
    nextSecret,
    enabled === false ? 0 : 1,
    userId,
  );
  return getConfig();
}

function pick(obj, keys) {
  for (const k of keys) {
    const v = obj?.[k];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return null;
}

// 内存缓存：免费 mxnzp 账户限 1 QPS，重复扫同一盒药会频繁撞限。
// 命中缓存既省额度又消除“查询太频繁”。成功与“未收录”都缓存（TTL 10 分钟），
// 仅“未配置/参数错/网络/超时”不缓存——这些需要实时重试。
const CACHE_TTL_MS = 10 * 60 * 1000;
const _cache = new Map(); // code -> { ts, result }

function cacheGet(code) {
  const hit = _cache.get(code);
  if (!hit) return null;
  if (Date.now() - hit.ts > CACHE_TTL_MS) { _cache.delete(code); return null; }
  return hit.result;
}

function cachePut(code, result) {
  // 只缓存有结论的结果，避免把瞬时故障也记成“长期结果”。
  const cacheable = result.ok || result.code === 'not-found' || result.code === 'rate-limited';
  if (cacheable) _cache.set(code, { ts: Date.now(), result });
}

/**
 * Fragt den Produktstamm ab. Nie throw: { ok:false, code, message } bei allen
 * Fehlern (nicht konfiguriert / Netz / API-Quote / Code nicht gefunden).
 * @param {string} code - EAN-13/8, UPC-A, Drug-Traceability-Code (Ziffernfolge)
 */
export async function lookupBarcode(code) {
  const clean = String(code || '').replace(/\s|-/g, '').trim();
  if (!/^\d{6,32}$/.test(clean)) {
    return { ok: false, code: 'bad-code', message: 'Barcode must be 6-32 digits.' };
  }

  // 命中缓存直接返回（省 QPS，消除 1 QPS 下的“查询太频繁”）。
  const cached = cacheGet(clean);
  if (cached) return { ...cached, fromCache: true };

  const cfg = getConfig();
  if (!cfg.enabled || !cfg.configured) {
    return { ok: false, code: 'not-configured', message: 'Barcode lookup is not configured.' };
  }

  // app_secret verlässt die Datenbank nur in diesem einen Request-Query.
  const secret = db.get().prepare('SELECT app_secret FROM barcode_api_config WHERE id = 1').get()?.app_secret || '';
  const realUrl = `${API_URL}?barcode=${encodeURIComponent(clean)}&app_id=${encodeURIComponent(cfg.appId)}&app_secret=${encodeURIComponent(secret)}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(realUrl, { signal: controller.signal, headers: { Accept: 'application/json' } });
    if (!response.ok) {
      log.warn('Barcode API HTTP', response.status);
      return { ok: false, code: 'http', message: `Barcode API returned ${response.status}.` };
    }
    const payload = await response.json().catch(() => null);
    // mxnzp: code 1 = ok, 0 = Fehler (Quota/Code unbekannt)
    if (!payload || Number(payload.code) !== 1) {
      const msg = payload?.msg || payload?.message || 'not found';
      // 免费账户 QPS=1，超额时把原始报错翻译成人话（前端据此只提示不报错）。
      const isRateLimit = /频繁|频率|qps|限额|超限|过快|限流|too many|rate/i.test(String(msg));
      if (isRateLimit) {
        const r = { ok: false, code: 'rate-limited', message: '查询过于频繁，请稍候 1 秒再试（免费账户限 1 次/秒）。' };
        cachePut(clean, r); // 限流是瞬时态，但 10 分钟内同码不再撞限，体验更顺。
        return r;
      }
      const isMissing = /不存在|未收录|查询不到|无结果/.test(String(msg));
      const r = { ok: false, code: isMissing ? 'not-found' : 'api', message: String(msg).slice(0, 160) };
      cachePut(clean, r);
      return r;
    }
    const d = payload.data || {};
    const name = pick(d, ['goodsName', 'name', 'goods_name', 'productName']);
    if (!name) {
      const r = { ok: false, code: 'not-found', message: 'Barcode exists but has no product name.' };
      cachePut(clean, r);
      return r;
    }
    const r = {
      ok: true,
      data: {
        name,
        barcode: clean,
        brand: pick(d, ['brand', 'trademark']),
        manufacturer: pick(d, ['supplier', 'manufacturer', 'producer', 'vendor']),
        spec: pick(d, ['spec', 'specification', 'standard']),
        raw_source: 'mxnzp',
      },
    };
    cachePut(clean, r);
    return r;
  } catch (err) {
    const aborted = err?.name === 'AbortError' || String(err?.message ?? '').includes('aborted');
    return { ok: false, code: aborted ? 'timeout' : 'network', message: aborted ? 'Barcode API timed out.' : 'Network error.' };
  } finally {
    clearTimeout(timer);
  }
}
