/**
 * Modul: Gesundheit (Health) - Haushalts-Medizinschrank („药箱")
 * Zweck: Familienweite Schrank-Ansicht über alle Medications-Zeilen, die man
 *        lesen darf (eigene + 'family' + betreute), plus:
 *          - Ablauf-Statistik (abgelaufen / binnen 30 Tagen / nachfüllbedürftig)
 *          - Beipackzettel-Nachschlag (eingebauter Katalog zuerst, sonst KI)
 *          - Foto-Erkennung (KI, Bild als data-URL, wird NICHT gespeichert)
 *          - Erinnerung an das Ablaufdatum über den zentralen reminders-Dienst
 *
 * Schreiben bleibt in medications.js (POST/PATCH/DELETE) - dieser Router liest
 * und ergänzt die neuen Schrank-Felder; die Reminder-Synchronisation hängt an
 * derselben Save-Stelle.
 */

import express from 'express';
import * as db from '../../db.js';
import { log, viewerId, careAwareClause } from './helpers.js';
import { DRUG_CATEGORIES, DRUG_CATEGORY_KEYS, lookupDrug, catalogToLeaflet } from '../../services/drug-catalog.js';
import { aiLeaflet, scanMedicationPhoto } from '../../services/ai-drug.js';
import * as barcodeLookup from '../../services/barcode-lookup.js';

/** Admin 判定：与 media.js 相同的字段优先级（authRole / user.role / session）。 */
function isAdmin(req) {
  return req.authRole === 'admin' || req.user?.role === 'admin' || req.session?.role === 'admin';
}

const router = express.Router();

const EXPIRY_WARN_DAYS = 30;
const MEDICATION_CATEGORIES = ['otc', 'prescription', 'external', 'firstaid', 'children', 'supplement', 'other'];

/**
 * Ablauf-Erinnerung neu aufsetzen (Feedback 2026-10-26 „跟着系统提醒走"):
 * pro Medication genau eine Erinnerung, 30 Tage vor expiry_date. Ohne Datum
 * bzw. bei abgelaufenem Stichtag wird die Erinnerung entfernt.
 * @param {object} row - medications-Zeile
 */
export function syncMedicationExpiryReminder(row) {
  const database = db.get();
  database.prepare("DELETE FROM reminders WHERE entity_type = 'medication' AND entity_id = ?").run(row.id);

  const expiry = String(row.expiry_date || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(expiry)) return;

  const remind = new Date(`${expiry}T09:00:00Z`);
  remind.setUTCDate(remind.getUTCDate() - EXPIRY_WARN_DAYS);
  // Bereits abgelaufen → keine Erinnerung mehr anlegen (Statistik zeigt es ohnehin).
  if (remind.getTime() <= Date.now()) return;

  database
    .prepare(
      `INSERT INTO reminders (entity_type, entity_id, remind_at, created_by)
       VALUES ('medication', ?, ?, ?)`
    )
    .run(row.id, remind.toISOString().replace('T', 'T').slice(0, 19) + 'Z', row.user_id);
}

// GET /cabinet?q=&category=&filter=expiring|expired|low|all
router.get('/cabinet', (req, res) => {
  try {
    const viewer = viewerId(req);
    // Familienansicht: alle sichtbaren Zeilen (ohne personId-Einschränkung).
    const clause = careAwareClause('m', viewer, null);
    const params = [...clause.params];
    let sql = `SELECT m.*, u.display_name AS owner_name
               FROM medications m
               LEFT JOIN users u ON u.id = m.user_id
               WHERE ${clause.sql}`;

    const q = String(req.query.q || '').trim();
    if (q) {
      sql += ' AND (m.name LIKE ? OR m.dosage_text LIKE ? OR m.note LIKE ?)';
      params.push(`%${q}%`, `%${q}%`, `%${q}%`);
    }
    const category = String(req.query.category || '');
    if (category && MEDICATION_CATEGORIES.includes(category)) {
      sql += ' AND COALESCE(m.category, ?) = ?';
      params.push('other', category);
    }
    const filter = String(req.query.filter || 'all');
    const today = new Date().toISOString().slice(0, 10);
    const in30 = new Date(Date.now() + EXPIRY_WARN_DAYS * 86400000).toISOString().slice(0, 10);
    if (filter === 'expiring') {
      sql += ' AND m.expiry_date IS NOT NULL AND m.expiry_date >= ? AND m.expiry_date <= ?';
      params.push(today, in30);
    } else if (filter === 'expired') {
      sql += ' AND m.expiry_date IS NOT NULL AND m.expiry_date < ?';
      params.push(today);
    } else if (filter === 'low') {
      sql += ' AND m.stock_qty IS NOT NULL AND m.refill_threshold IS NOT NULL AND m.stock_qty <= m.refill_threshold';
    }

    sql += ' ORDER BY (m.expiry_date IS NOT NULL AND m.expiry_date < ?) DESC, m.expiry_date ASC, m.name COLLATE NOCASE ASC';
    params.push(today);

    const rows = db.get().prepare(sql).all(...params);

    // Statistik über denselben sichtbaren Bestand (nicht nur die gefilterte Ansicht).
    const statClause = careAwareClause('m', viewer, null);
    const stats = db.get().prepare(`
      SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN m.expiry_date IS NOT NULL AND m.expiry_date < ? THEN 1 ELSE 0 END) AS expired,
        SUM(CASE WHEN m.expiry_date IS NOT NULL AND m.expiry_date >= ? AND m.expiry_date <= ? THEN 1 ELSE 0 END) AS expiring,
        SUM(CASE WHEN m.stock_qty IS NOT NULL AND m.refill_threshold IS NOT NULL AND m.stock_qty <= m.refill_threshold THEN 1 ELSE 0 END) AS low
      FROM medications m WHERE ${statClause.sql}
    `).get(today, today, in30, ...statClause.params);

    res.json({
      data: rows.map((r) => ({ ...r, info_source: r.info_source || 'manual' })),
      stats: {
        total: stats?.total || 0,
        expired: stats?.expired || 0,
        expiring: stats?.expiring || 0,
        low: stats?.low || 0,
        expiryWarnDays: EXPIRY_WARN_DAYS,
      },
      categories: DRUG_CATEGORY_KEYS,
    });
  } catch (err) {
    log.error('Error loading medicine cabinet:', err.message);
    res.status(500).json({ error: 'Internal error.', code: 500 });
  }
});

// GET /cabinet/barcode?code=...  (jeder Benutzer)
// 69er-Code → Warenstamm (mxnzp, Admin-Key) → wenn der Produktname im
// eingebauten Katalog steckt, kommt der Beipackzettel gleich mit.
router.get('/cabinet/barcode', async (req, res) => {
  try {
    const code = String(req.query.code || '').trim();
    if (!code) return res.status(400).json({ error: 'code is required.', code: 400 });

    const result = await barcodeLookup.lookupBarcode(code);
    if (!result.ok) {
      const status = result.code === 'not-configured' || result.code === 'bad-code' ? 400
        : result.code === 'not-found' ? 404 : 502;
      return res.status(status).json({ error: result.message, code: result.code || status });
    }

    const product = result.data;
    // Produktname im Katalog? Dann Beipackzettel mitliefern.
    const hit = lookupDrug(product.name);
    const leaflet = hit ? catalogToLeaflet(hit) : null;
    res.json({ data: { ...product, leaflet, matched: hit?.name || null } });
  } catch (err) {
    log.error('GET /cabinet/barcode', err);
    res.status(500).json({ error: 'Internal error.', code: 500 });
  }
});

// GET /cabinet/barcode-config  (nur Admin) - Zustand, Secret wird nicht ausgegeben.
router.get('/cabinet/barcode-config', (req, res) => {
  try {
    if (!isAdmin(req)) return res.status(403).json({ error: 'Keine Berechtigung', code: 403 });
    res.json({ data: barcodeLookup.getConfig() });
  } catch (err) {
    log.error('GET /cabinet/barcode-config', err);
    res.status(500).json({ error: 'Internal error.', code: 500 });
  }
});

// PUT /cabinet/barcode-config  (nur Admin)  { appId, appSecret?, enabled? }
// appSecret leer lassen = unverändert (gleiche Konvention wie ai_config).
router.put('/cabinet/barcode-config', (req, res) => {
  try {
    if (!isAdmin(req)) return res.status(403).json({ error: 'Keine Berechtigung', code: 403 });
    const b = req.body || {};
    const data = barcodeLookup.saveConfig({
      appId: b.appId,
      appSecret: b.appSecret,
      enabled: b.enabled,
    }, viewerId(req));
    res.json({ data });
  } catch (err) {
    log.error('PUT /cabinet/barcode-config', err);
    res.status(500).json({ error: 'Internal error.', code: 500 });
  }
});

// GET /cabinet/drug-info?name=...  → Katalog zuerst, sonst KI
//   force=ai  → 跳过内置库，直接用 AI 查询（内置可能不对时让用户核对覆盖）。
router.get('/cabinet/drug-info', async (req, res) => {
  try {
    const name = String(req.query.name || '').trim();
    if (!name) return res.status(400).json({ error: 'name is required.', code: 400 });

    const forceAi = String(req.query.force || '').toLowerCase() === 'ai';
    if (!forceAi) {
      const hit = lookupDrug(name);
      if (hit) {
        return res.json({ data: { ...catalogToLeaflet(hit), matched: hit.name } });
      }
    }

    const result = await aiLeaflet(name);
    if (!result.ok) {
      const status = result.code === 'not-configured' ? 400 : 502;
      return res.status(status).json({ error: result.message, code: result.code || status });
    }
    res.json({ data: result.data });
  } catch (err) {
    log.error('Error looking up drug info:', err.message);
    res.status(500).json({ error: 'Internal error.', code: 500 });
  }
});

// POST /cabinet/scan  { image: dataURL }  → KI-Fotoerkennung
router.post('/cabinet/scan', async (req, res) => {
  try {
    const image = String(req.body?.image || '');
    if (!image) return res.status(400).json({ error: 'image is required.', code: 400 });

    const result = await scanMedicationPhoto(image);
    if (!result.ok) {
      const status = result.code === 'not-configured' ? 400 : result.code === 'bad-image' || result.code === 'too-large' ? 400 : 502;
      return res.status(status).json({ error: result.message, code: result.code || status });
    }
    res.json({ data: result.data });
  } catch (err) {
    log.error('Error scanning medication photo:', err.message);
    res.status(500).json({ error: 'Internal error.', code: 500 });
  }
});

export default router;
