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
 * (Putzmittel, Papier, Pflege) und eine andere Haltbarkeitslogik. Eine eigene
 * Tabelle hält beide Weltteile sauber getrennt; nichts wandert zwischen den
 * Modulen hin und her.
 *
 * EIN DATENSATZ = EIN BATCH. Es gibt bewusst kein UNIQUE(name): wer drei
 * Flaschen Shampoo mit drei verschiedenen MHDs kauft, legt drei Zeilen an und
 * jede führt Menge und Datum selbst. Ein zusammengefasster Datensatz könnte
 * nicht mehr sagen, welche Flasche zuerst weg muss (FEFO), und genau das ist
 * bei Haushaltswaren die einzige Frage, die eine Liste beantworten muss.
 *
 * Kein Eigentümer-Gate: wie der Küchen-Vorrat Haushaltsbesitz, nicht
 * Privatbesitz. `created_by` bleibt als Herkunftsnachweis erhalten.
 *
 * Routen-Reihenfolge: statische Pfade vor dynamischen (/:itemId).
 */

import express from 'express';
import * as db from '../db.js';
import { createLogger } from '../logger.js';
import {
  str, num, date as dateField, collectErrors, MAX_TITLE, MAX_TEXT,
} from '../middleware/validate.js';
import {
  HOME_INVENTORY_CATEGORIES,
  HOME_INVENTORY_UNITS,
  DEFAULT_HOME_CATEGORY,
  DEFAULT_HOME_UNIT,
  isValidHomeCategory,
  isValidHomeUnit,
  isValidHomeDateKey,
  normalizeHomeQuantity,
  homeCategoryOrder,
  compareHomeBatches,
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
 * Anzeigereihenfolge: Taxonomie-Kategorien (kanonisch, "其他" zuletzt), darin
 * nach Name und — bei mehreren Batches desselben Artikels — nach MHD aufsteigend.
 * Dieselbe Reihenfolge rendert die Seite; der Client muss nichts nachsortieren.
 */
function loadItems() {
  const rows = db.get().prepare('SELECT * FROM home_inventory_items').all();
  return rows.sort((a, b) => {
    const ca = homeCategoryOrder(a.category);
    const cb = homeCategoryOrder(b.category);
    if (ca !== cb) return ca - cb;
    return compareHomeBatches(a, b);
  });
}

/**
 * Validiert die Felder eines Artikels. `partial: true` lässt fehlende Felder
 * unangetastet (PATCH für den Mengen-Stepper).
 *
 * Pflichtfelder beim Anlegen/Ersetzen: name, quantity, unit, category.
 * Die Menge ist bewusst Pflicht — vorher rutschte ein leeres Feld still auf 1
 * und die Liste behauptete einen Bestand, den niemand eingetragen hatte.
 * @returns {{ values: object|null, errors: string[] }}
 */
function validateItemFields(body, { partial = false, current = null } = {}) {
  const values = {};
  const results = [];

  if (!partial || body.name !== undefined) {
    const vName = str(body.name, '名称', { max: MAX_TITLE });
    results.push(vName);
    values.name = vName.value;
  }

  if (!partial || body.quantity !== undefined) {
    const vQty = num(body.quantity, '数量', { required: !partial });
    results.push(vQty);
    if (vQty.value !== null && vQty.value < 0) {
      results.push({ error: '数量不能为负数。' });
    }
    if (vQty.value === null) {
      // Kein stiller Fallback mehr: fehlt die Menge, gilt der Request als
      // ungültig (siehe required oben) — der Wert hier ist nur ein Platzhalter,
      // damit der Aufrufer bei Fehlern nicht in ein NOT-NULL-Feld schreibt.
      values.quantity = partial ? normalizeHomeQuantity(current?.quantity ?? 0, { fallback: 0 }) : 0;
    } else {
      values.quantity = normalizeHomeQuantity(vQty.value, { fallback: 0 });
    }
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

  // 有效期：可选，但一旦填写就必须是真实存在的 YYYY-MM-DD。
  // dateField() prüft nur das Format, isValidHomeDateKey() zusätzlich den
  // Kalender (2026-02-30 wäre sonst ein gültiger Lagerwert).
  if (!partial || body.expires_on !== undefined) {
    const raw = body.expires_on === null || body.expires_on === '' ? null : body.expires_on;
    const vDate = dateField(raw, '有效期');
    results.push(vDate);
    if (vDate.value !== null && !isValidHomeDateKey(vDate.value)) {
      results.push({ error: '有效期不是有效的日期。' });
    }
    values.expires_on = vDate.value;
  }

  if (!partial || body.location !== undefined) {
    const vLocation = str(body.location, '存放位置', { max: MAX_TITLE, required: false });
    results.push(vLocation);
    values.location = vLocation.value ?? '';
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
    values.notes = vNotes.value ?? '';
  }

  return { values, errors: collectErrors(results) };
}

// --------------------------------------------------------
// GET /api/v1/home-inventory
// Alle Batches in Kategorie-/Namens-/MHD-Reihenfolge.
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
// Client sie nicht hart kodieren muss.
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
// Body: { name, quantity, unit, category, expires_on?, location?, min_quantity?, notes? }
// Ein POST = ein Batch. Gleicher Name mit anderem MHD ist ein zweiter Batch.
// Response: { data: HomeInventoryItem }
// --------------------------------------------------------
router.post('/', (req, res) => {
  try {
    const { values, errors } = validateItemFields(req.body);
    if (errors.length) return res.status(400).json({ error: errors[0], code: 400 });

    const result = db.get().prepare(`
      INSERT INTO home_inventory_items
        (name, category, quantity, unit, expires_on, location, min_quantity, notes, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      values.name, values.category, values.quantity, values.unit,
      values.expires_on, values.location, values.min_quantity, values.notes,
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
// Body: wie POST. Ersetzt alle Felder (ein Batch bleibt ein Batch: ein neues
// MHD ist ein neuer Datensatz, kein Überschreiben der Historie).
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
      SET name = ?, category = ?, quantity = ?, unit = ?, expires_on = ?, location = ?,
          min_quantity = ?, notes = ?,
          updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
      WHERE id = ?
    `).run(
      values.name, values.category, values.quantity, values.unit,
      values.expires_on, values.location, values.min_quantity, values.notes, item.id
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
