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
 * KATEGORIEN/EINHEITEN (v172): feste Basisliste in der isomorphen Taxonomie +
 * benutzerdefinierte Ergänzungen in `home_inventory_options`. Der Name eines
 * eigenen Eintrags ist zugleich der Speicherwert in items.category/unit (er hat
 * keinen i18n-Key). Löschen ist nur erlaubt, solange kein Artikel den Eintrag
 * benutzt — sonst entstünden Zeilen mit einer Kategorie, die die Oberfläche
 * nicht mehr auflösen kann. Umbenennen zieht die Artikelzeilen mit.
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
  HOME_INVENTORY_LOCATIONS,
  DEFAULT_HOME_CATEGORY,
  DEFAULT_HOME_UNIT,
  HOME_CUSTOM_CATEGORY_ICON,
  isValidHomeCategory,
  isValidHomeUnit,
  isValidHomeLocation,
  isValidHomeDateKey,
  normalizeHomeQuantity,
  normalizeHomeOptionName,
  checkHomeOptionName,
  homeOptionMaxLength,
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

/** Eigene Kategorien/Einheiten/Lagerorte in Anlagereihenfolge. */
function loadOptions(kind) {
  return db.get().prepare(
    'SELECT id, name, icon FROM home_inventory_options WHERE kind = ? ORDER BY sort_order ASC, id ASC'
  ).all(kind);
}

/** Gibt es diesen eigenen Eintrag schon? (name-Spalte ist COLLATE NOCASE) */
function optionExists(kind, name) {
  return !!db.get().prepare(
    'SELECT 1 FROM home_inventory_options WHERE kind = ? AND name = ?'
  ).get(kind, name);
}

function categoryExists(name) {
  return isValidHomeCategory(name) || optionExists('category', name);
}

function unitExists(name) {
  return isValidHomeUnit(name) || optionExists('unit', name);
}

function locationExists(name) {
  return isValidHomeLocation(name) || optionExists('location', name);
}

/**
 * Lagerort beim Speichern eines Artikels übernehmen. Ein fester Schlüssel oder
 * ein bereits eigener Ort bleibt unverändert; alles andere (Freitext aus der Zeit
 * vor dem Auswahlfeld) wird als eigener Ort angelegt, damit derselbe Ort beim
 * nächsten Mal in der Liste steht und nicht erneut getippt werden muss.
 * @param {string} name bereits normalisierter Wert
 * @returns {string} der zu speichernde Wert ('' = kein Ort)
 */
function ensureLocationOption(name) {
  if (!name) return '';
  if (locationExists(name)) return name;
  if (checkHomeOptionName(name, 'location') !== 'ok') return '';
  const next = db.get().prepare(
    'SELECT COALESCE(MAX(sort_order), -1) AS m FROM home_inventory_options WHERE kind = ?'
  ).get('location').m + 1;
  try {
    db.get().prepare(
      'INSERT INTO home_inventory_options (kind, name, icon, sort_order) VALUES (?, ?, ?, ?)'
    ).run('location', name, '', next);
  } catch {
    // UNIQUE(kind, name): paralleler Request hat den Ort schon angelegt — kein Fehler.
  }
  return name;
}

/**
 * Vollständige Anzeigereihenfolge der Kategorien: feste Liste (ohne "其他"),
 * eigene Einträge, "其他" zuletzt. Die Seite baut dieselbe Reihenfolge
 * (buildCategoryList) — Liste und Chips sortieren damit identisch, ohne dass
 * der Client nachsortiert.
 * @returns {Map<string, number>}
 */
function categoryOrderMap() {
  const builtin = HOME_INVENTORY_CATEGORIES.map((c) => c.key).filter((k) => k !== 'other');
  const custom = loadOptions('category').map((o) => o.name);
  return new Map([...builtin, ...custom, 'other'].map((key, i) => [key, i]));
}

/**
 * Anzeigereihenfolge: Kategorien in Taxonomie-Reihenfolge ("其他" und eigene
 * zuletzt), darin nach Name und — bei mehreren Batches desselben Artikels —
 * nach MHD aufsteigend. Dieselbe Reihenfolge rendert die Seite.
 */
function loadItems() {
  const order = categoryOrderMap();
  const fallback = order.size + 1;
  const rows = db.get().prepare('SELECT * FROM home_inventory_items').all();
  return rows.sort((a, b) => {
    const ca = order.get(a.category) ?? fallback;
    const cb = order.get(b.category) ?? fallback;
    if (ca !== cb) return ca - cb;
    return compareHomeBatches(a, b);
  });
}

function resolveCategoryIcon(raw) {
  const icon = String(raw ?? '').trim();
  return /^[a-z0-9-]{2,32}$/.test(icon) ? icon : HOME_CUSTOM_CATEGORY_ICON;
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

  // Einheit/Kategorie gegen Basisliste + eigene Einträge prüfen. Unbekannte
  // Werte sind ein Fehler statt stiller Fallback — sonst entwertet ein Tippfehler
  // im Formular unbemerkt die Menge bzw. rutscht der Artikel in eine Kategorie,
  // die die Oberfläche nicht auflösen kann.
  if (!partial || body.unit !== undefined) {
    const fallback = current?.unit ?? DEFAULT_HOME_UNIT;
    const requested = String(body.unit ?? fallback).trim() || fallback;
    if (!unitExists(requested)) {
      results.push({ error: '未知的单位。' });
    }
    values.unit = requested;
  }

  if (!partial || body.category !== undefined) {
    const fallback = current?.category ?? DEFAULT_HOME_CATEGORY;
    const requested = String(body.category ?? fallback).trim() || fallback;
    if (!categoryExists(requested)) {
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

  // 存放位置：可选。Wert ist ein fester Lagerort-Schlüssel oder der Name eines
  // eigenen Ortes. Unbekannter Freitext (Altdaten aus der Zeit vor dem
  // Auswahlfeld) wird beim Speichern zu einem eigenen Ort — siehe
  // ensureLocationOption() im Handler.
  if (!partial || body.location !== undefined) {
    const raw = normalizeHomeOptionName(body.location);
    if (raw.length > homeOptionMaxLength('location')) {
      results.push({ error: `存放位置最多 ${homeOptionMaxLength('location')} 个字符。` });
    }
    values.location = raw;
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

/** Bezeichnung je Optionstyp — für Fehlermeldungen und Spaltenzuordnung. */
const OPTION_KINDS = Object.freeze({
  category: { label: '类别', column: 'category' },
  unit: { label: '单位', column: 'unit' },
  location: { label: '存放位置', column: 'location' },
});

/**
 * Gemeinsame Prüfung für POST/PUT von /categories, /units und /locations.
 * @returns {{ name: string|null, error: { code: number, message: string }|null }}
 */
function validateOptionName(body, kind) {
  const label = OPTION_KINDS[kind]?.label ?? '名称';
  const name = normalizeHomeOptionName(body?.name);
  const check = checkHomeOptionName(name, kind);
  if (check === 'required') {
    return { name: null, error: { code: 400, message: `请填写${label}名称。` } };
  }
  if (check === 'too-long') {
    const max = homeOptionMaxLength(kind);
    return {
      name: null,
      error: { code: 400, message: `${label}名称最多 ${max} 个字符。` },
    };
  }
  if (check === 'reserved') {
    return { name: null, error: { code: 409, message: '该名称已被内置选项占用。' } };
  }
  if (optionExists(kind, name)) {
    return { name: null, error: { code: 409, message: `该${label}已存在。` } };
  }
  return { name, error: null };
}

/** Anzahl Artikel, die einen eigenen Eintrag benutzen (Löschsperre). */
function usageCount(kind, name) {
  const column = OPTION_KINDS[kind]?.column ?? 'category';
  return db.get().prepare(
    `SELECT COUNT(*) AS c FROM home_inventory_items WHERE ${column} = ?`
  ).get(name).c;
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
// Basisliste + eigene Einträge (Reihenfolge = Anzeigereihenfolge), damit der
// Client nichts hart kodieren muss.
// Response: { data: { categories, categoryIcons, units, locations, customCategories,
//                     customUnits, customLocations, defaults } }
// --------------------------------------------------------
router.get('/taxonomy', (_req, res) => {
  try {
    res.json({
      data: {
        categories: HOME_INVENTORY_CATEGORIES.map((c) => c.key),
        categoryIcons: Object.fromEntries(HOME_INVENTORY_CATEGORIES.map((c) => [c.key, c.icon])),
        units: [...HOME_INVENTORY_UNITS],
        locations: [...HOME_INVENTORY_LOCATIONS],
        customCategories: loadOptions('category').map((o) => ({ id: o.id, name: o.name, icon: o.icon })),
        customUnits: loadOptions('unit').map((o) => ({ id: o.id, name: o.name })),
        customLocations: loadOptions('location').map((o) => ({ id: o.id, name: o.name })),
        defaults: { category: DEFAULT_HOME_CATEGORY, unit: DEFAULT_HOME_UNIT },
      },
    });
  } catch (err) {
    log.error('GET /taxonomy error:', err);
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});

// --------------------------------------------------------
// Eigene Optionen: Kategorien, Einheiten, Lagerorte
//
// Alle drei liegen in derselben Tabelle (home_inventory_options, unterschieden
// über `kind`) und unterscheiden sich nur in der Artikel-Spalte und im
// Anzeigenamen. Ein gemeinsamer Handler-Satz statt dreimal derselbe Code:
//   POST   /<pfad>            Body: { name, icon? } → { data: { id, name, icon? } }
//   PUT    /<pfad>/:optionId  Body: { name, icon? } → benennt um, zieht Artikel mit
//   DELETE /<pfad>/:optionId  nur ohne Verwendung   → 204
// --------------------------------------------------------
function registerOptionRoutes(kind, path) {
  const { label, column } = OPTION_KINDS[kind];

  router.post(`/${path}`, (req, res) => {
    try {
      const { name, error } = validateOptionName(req.body, kind);
      if (error) return res.status(error.code).json({ error: error.message, code: error.code });

      const icon = kind === 'category' ? resolveCategoryIcon(req.body?.icon) : '';
      const next = db.get().prepare(
        'SELECT COALESCE(MAX(sort_order), -1) AS m FROM home_inventory_options WHERE kind = ?'
      ).get(kind).m + 1;
      const info = db.get().prepare(
        'INSERT INTO home_inventory_options (kind, name, icon, sort_order) VALUES (?, ?, ?, ?)'
      ).run(kind, name, icon, next);

      res.status(201).json({
        data: kind === 'category'
          ? { id: info.lastInsertRowid, name, icon }
          : { id: info.lastInsertRowid, name },
      });
    } catch (err) {
      log.error(`POST /${path} error:`, err);
      res.status(500).json({ error: 'Internal server error.', code: 500 });
    }
  });

  router.put(`/${path}/:optionId`, (req, res) => {
    try {
      const opt = db.get().prepare(
        'SELECT * FROM home_inventory_options WHERE id = ? AND kind = ?'
      ).get(req.params.optionId, kind);
      if (!opt) return res.status(404).json({ error: `该${label}不存在。`, code: 404 });

      const requested = normalizeHomeOptionName(req.body?.name);
      const check = checkHomeOptionName(requested, kind);
      if (check === 'required') {
        return res.status(400).json({ error: `请填写${label}名称。`, code: 400 });
      }
      if (check === 'too-long') {
        return res.status(400).json({
          error: `${label}名称最多 ${homeOptionMaxLength(kind)} 个字符。`, code: 400,
        });
      }
      if (check === 'reserved') {
        return res.status(409).json({ error: '该名称已被内置选项占用。', code: 409 });
      }
      const clash = db.get().prepare(
        'SELECT id FROM home_inventory_options WHERE kind = ? AND name = ? AND id != ?'
      ).get(kind, requested, opt.id);
      if (clash) return res.status(409).json({ error: `该${label}已存在。`, code: 409 });

      const icon = kind !== 'category'
        ? ''
        : req.body?.icon === undefined ? opt.icon : resolveCategoryIcon(req.body.icon);

      // Umbenennen zieht die Artikel mit — sonst zeigt eine Zeile auf einen
      // Namen, den es nicht mehr gibt.
      const tx = db.get().transaction(() => {
        db.get().prepare(
          `UPDATE home_inventory_items SET ${column} = ?,
             updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE ${column} = ?`
        ).run(requested, opt.name);
        db.get().prepare('UPDATE home_inventory_options SET name = ?, icon = ? WHERE id = ?')
          .run(requested, icon, opt.id);
      });
      tx();

      res.json({
        data: kind === 'category'
          ? { id: opt.id, name: requested, icon }
          : { id: opt.id, name: requested },
      });
    } catch (err) {
      log.error(`PUT /${path}/:optionId error:`, err);
      res.status(500).json({ error: 'Internal server error.', code: 500 });
    }
  });

  router.delete(`/${path}/:optionId`, (req, res) => {
    try {
      const opt = db.get().prepare(
        'SELECT * FROM home_inventory_options WHERE id = ? AND kind = ?'
      ).get(req.params.optionId, kind);
      if (!opt) return res.status(404).json({ error: `该${label}不存在。`, code: 404 });

      const used = usageCount(kind, opt.name);
      if (used > 0) {
        return res.status(409).json({
          error: `还有 ${used} 件物品使用该${label}，请先改成其他${label}再删除。`, code: 409,
        });
      }
      db.get().prepare('DELETE FROM home_inventory_options WHERE id = ?').run(opt.id);
      res.status(204).end();
    } catch (err) {
      log.error(`DELETE /${path}/:optionId error:`, err);
      res.status(500).json({ error: 'Internal server error.', code: 500 });
    }
  });
}

registerOptionRoutes('category', 'categories');
registerOptionRoutes('unit', 'units');
registerOptionRoutes('location', 'locations');

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
    values.location = ensureLocationOption(values.location);

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
    values.location = ensureLocationOption(values.location);

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
