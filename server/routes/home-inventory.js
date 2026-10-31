/**
 * Modul: 家庭库存（Home Inventory）
 * Zweck: REST-API für den eigenständigen Haushalts-Vorrat (Alltagsartikel
 *        außerhalb der Küche: Waschmittel, Taschentücher, Zahnbürsten, ...)
 * Abhängigkeiten: express, server/db.js,
 *                 public/utils/home-inventory-taxonomy.js (isomorph)
 *
 * Bewusst GETRENNT vom Kitchen-Pantry (#家庭库存): der Vorrat in der Küche
 * (pantry_items) ist food-only — Einheiten, Kategorien und der Einkaufs-Import
 * sind auf Lebensmittel zugeschnitten. Alltagsartikel haben andere Kategorien
 * (Putzmittel, Papier, Pflege), kein MHD und keinen Lagerort-Manager. Ein
 * eigene Tabelle hält beide Weltteile sauber getrennt; nichts wandert zwischen
 * den Modulen hin und her.
 *
 * Kein Eigentümer-Gate: wie der Küchen-Vorrat Haushaltsbesitz, nicht
 * Privatbesitz. `created_by` bleibt als Herkunftsnachweis erhalten.
 *
 * Routen-Reihenfolge: statische Pfade vor dynamischen (/:itemId) — although
 * hier gibt es (noch) keine Unterressourcen, bleibt die Konvention stehen.
 */

import express from 'express';
import * as db from '../db.js';
import { createLogger } from '../logger.js';
import { str, num, id as idParam, collectErrors, MAX_TITLE, MAX_TEXT } from '../middleware/validate.js';
import {
  HOME_INVENTORY_CATEGORIES,
  HOME_INVENTORY_UNITS,
  DEFAULT_HOME_CATEGORY,
  DEFAULT_HOME_UNIT,
  isValidHomeCategory,
  isValidHomeUnit,
  normalizeHomeQuantity,
  homeCategoryOrder,
} from '../../public/utils/home-inventory-taxonomy.js';

const log = createLogger('HomeInventory');
const router = express.Router();

// --------------------------------------------------------
// Hilfsfunktionen
// --------------------------------------------------------

function getItem(itemId) {
  return db.get().prepare('SELECT * FROM home_inventory_items WHERE id = ?').get(itemId);
}

/**
 * Anzeigereihenfolge: nach Taxonomie-Kategorien (die Taxonomie-Reihenfolge ist
 * kanonisch — "其他" zuletzt), innerhalb der Kategorie alphabetisch (NOCASE).
 * Dieselbe Gruppierung rendert die Seite; der Client muss nichts nachsortieren.
 */
function loadItems() {
  const rows = db.get().prepare('SELECT * FROM home_inventory_items').all();
  return rows.sort((a, b) => {
    const ca = homeCategoryOrder(a.category);
    const cb = homeCategoryOrder(b.category);
    if (ca !== cb) return ca - cb;
    const na = String(a.name).toLowerCase();
    const nb = String(b.name).toLowerCase();
    if (na !== nb) return na < nb ? -1 : 1;
    return a.id - b.id;
  });
}

/**
 * Validiert die Felder eines Artikels. `partial: true` lässt fehlende Felder
 * unangetastet (PATCH für den Mengen-Stepper), sonst gelten die Defaults für
 * ein neues Objekt.
 * @returns {{ values: object|null, errors: string[] }}
 */
function validateItemFields(body, { partial = false, current = null } = {}) {
  const values = {};
  const results = [];

  if (!partial || body.name !== undefined) {
    const vName = str(body.name, 'Name', { max: MAX_TITLE });
    results.push(vName);
    values.name = vName.value;
  }

  if (!partial || body.quantity !== undefined) {
    const vQty = num(body.quantity, '数量');
    results.push(vQty);
    if (vQty.value !== null && vQty.value < 0) {
      results.push({ error: '数量不能为负数。' });
    }
    // null/leer explizit abfangen: "ohne Mengenangabe" heißt 1, nicht 0.
    const fallbackQty = partial ? Number(current?.quantity ?? 1) : 1;
    values.quantity = vQty.value === null
      ? normalizeHomeQuantity(fallbackQty, { fallback: 1 })
      : normalizeHomeQuantity(vQty.value, { fallback: 1 });
  }

  // Einheit/Kategorie gegen die feste Taxonomie prüfen. Unbekannte Werte sind
  // ein Fehler statt stiller Fallback — sonst entwertet ein Tippfehler im
  // Formular unbemerkt die Menge bzw. rutscht der Artikel in eine andere
  // Kategorie als die, die der Nutzer gewählt hat.
  if (!partial || body.unit !== undefined) {
    const fallback = current?.unit ?? DEFAULT_HOME_UNIT;
    const requested = String(body.unit ?? fallback).trim() || fallback;
    if (!isValidHomeUnit(requested)) {
      results.push({ error: '未知的单位。' });
    }
    values.unit = requested;
  }

  if (!partial || body.category !== undefined) {
    const fallback = current?.category ?? DEFAULT_HOME_CATEGORY;
    const requested = String(body.category ?? fallback).trim() || fallback;
    if (!isValidHomeCategory(requested)) {
      results.push({ error: '未知的类别。' });
    }
    values.category = requested;
  }

  if (!partial || body.min_quantity !== undefined) {
    if (body.min_quantity === null || body.min_quantity === '' || body.min_quantity === undefined) {
      values.min_quantity = null;
    } else {
      const vMin = num(body.min_quantity, '低量提醒');
      results.push(vMin);
      if (vMin.value !== null && vMin.value < 0) {
        results.push({ error: '低量提醒不能为负数。' });
      }
      values.min_quantity = vMin.value === null ? null : normalizeHomeQuantity(vMin.value, { fallback: 0 });
    }
  }

  if (!partial || body.notes !== undefined) {
    const vNotes = str(body.notes, '备注', { max: MAX_TEXT, required: false });
    results.push(vNotes);
    values.notes = vNotes.value;
  }

  return { values, errors: collectErrors(results) };
}

// --------------------------------------------------------
// GET /api/v1/home-inventory
// Alle Artikel in Kategorie-Anzeigereihenfolge.
// Response: { data: HomeInventoryItem[] }
// --------------------------------------------------------
router.get('/', (_req, res) => {
  try {
    res.json({ data: loadItems() });
  } catch (err) {
    log.error('GET / error:', err);
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});

// --------------------------------------------------------
// GET /api/v1/home-inventory/taxonomy
// Feste Kategorien + Einheiten (Reihenfolge = Anzeigereihenfolge), damit der
// Client sie nicht hart kodieren muss und künftige benutzerverwaltete Listen
 // ohne Frontend-Breaking austauschbar sind.
// Response: { data: { categories: string[], units: string[], defaults: {...} } }
// --------------------------------------------------------
router.get('/taxonomy', (_req, res) => {
  try {
    res.json({
      data: {
        categories: HOME_INVENTORY_CATEGORIES.map((c) => c.key),
        categoryIcons: Object.fromEntries(HOME_INVENTORY_CATEGORIES.map((c) => [c.key, c.icon])),
        units: [...HOME_INVENTORY_UNITS],
        defaults: { category: DEFAULT_HOME_CATEGORY, unit: DEFAULT_HOME_UNIT },
      },
    });
  } catch (err) {
    log.error('GET /taxonomy error:', err);
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});

// --------------------------------------------------------
// POST /api/v1/home-inventory
// Body: { name, quantity?, unit?, category?, min_quantity?, notes? }
// Response: { data: HomeInventoryItem }
// --------------------------------------------------------
router.post('/', (req, res) => {
  try {
    const { values, errors } = validateItemFields(req.body);
    if (errors.length) return res.status(400).json({ error: errors[0], code: 400 });

    const result = db.get().prepare(`
      INSERT INTO home_inventory_items
        (name, category, quantity, unit, min_quantity, notes, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      values.name, values.category, values.quantity, values.unit,
      values.min_quantity, values.notes,
      req.authUserId || req.session.userId
    );
    res.status(201).json({ data: getItem(result.lastInsertRowid) });
  } catch (err) {
    log.error('POST / error:', err);
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});

// --------------------------------------------------------
// PUT /api/v1/home-inventory/:itemId
// Body: wie POST. Ersetzt alle Felder.
// Response: { data: HomeInventoryItem }
// --------------------------------------------------------
router.put('/:itemId', (req, res) => {
  try {
    const item = getItem(req.params.itemId);
    if (!item) return res.status(404).json({ error: '物品不存在。', code: 404 });

    const { values, errors } = validateItemFields(req.body, { current: item });
    if (errors.length) return res.status(400).json({ error: errors[0], code: 400 });

    db.get().prepare(`
      UPDATE home_inventory_items
      SET name = ?, category = ?, quantity = ?, unit = ?, min_quantity = ?, notes = ?,
          updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
      WHERE id = ?
    `).run(
      values.name, values.category, values.quantity, values.unit,
      values.min_quantity, values.notes, item.id
    );
    res.json({ data: getItem(item.id) });
  } catch (err) {
    log.error('PUT /:itemId error:', err);
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});

// --------------------------------------------------------
// PATCH /api/v1/home-inventory/:itemId
// Body: Teilmenge der Felder. Der Mengen-Stepper der Seite nutzt das,
// um +/- ohne Roundtrip-Risiken für die übrigen Felder zu buchen.
// Response: { data: HomeInventoryItem }
// --------------------------------------------------------
router.patch('/:itemId', (req, res) => {
  try {
    const item = getItem(req.params.itemId);
    if (!item) return res.status(404).json({ error: '物品不存在。', code: 404 });

    const { values, errors } = validateItemFields(req.body, { partial: true, current: item });
    if (errors.length) return res.status(400).json({ error: errors[0], code: 400 });

    // Die Spaltennamen stammen aus dem festen Schlüsselvorrat von
    // validateItemFields, nicht aus dem Request-Body - kein Injection-Pfad.
    const fields = Object.keys(values);
    if (!fields.length) return res.json({ data: item });

    const assignments = fields.map((f) => `${f} = ?`).join(', ');
    db.get().prepare(`
      UPDATE home_inventory_items
      SET ${assignments}, updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
      WHERE id = ?
    `).run(...fields.map((f) => values[f]), item.id);
    res.json({ data: getItem(item.id) });
  } catch (err) {
    log.error('PATCH /:itemId error:', err);
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});

// --------------------------------------------------------
// DELETE /api/v1/home-inventory/:itemId
// Response: 204
// --------------------------------------------------------
router.delete('/:itemId', (req, res) => {
  try {
    const info = db.get().prepare('DELETE FROM home_inventory_items WHERE id = ?').run(req.params.itemId);
    if (!info.changes) return res.status(404).json({ error: '物品不存在。', code: 404 });
    res.status(204).end();
  } catch (err) {
    log.error('DELETE /:itemId error:', err);
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});

export default router;
