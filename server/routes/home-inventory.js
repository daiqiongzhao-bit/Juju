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
  normalizeHomeBarcode,
  isValidHomeBarcode,
  homeDaysLeft,
  localDateKey,
} from '../../public/utils/home-inventory-taxonomy.js';

const log = createLogger('HomeInventory');
const router = express.Router();

// --------------------------------------------------------
// Hilfsfunktionen
// --------------------------------------------------------

function getItem(itemId) {
  return db.get().prepare('SELECT * FROM home_inventory_items WHERE id = ?').get(itemId);
}

const userIdOf = (req) => req.authUserId || req.session?.userId || null;

// --------------------------------------------------------
// Bestandsbuch (v173)
//
// Bis v172 war die Menge nur ein Zustand: der Stepper schrieb eine Zahl, die
// vorherige war danach weg. Damit ließ sich nicht sagen, wer wann etwas
// entnommen hat, und erst recht nicht, wie schnell ein Artikel zur Neige geht.
// Jede Mengenänderung schreibt deshalb eine Zeile — Name als Momentaufnahme
// mitgespeichert, damit ein gelöschter Batch seine Geschichte nicht verliert.
// --------------------------------------------------------

/**
 * @param {number} itemId
 * @param {string} itemName
 * @param {number} delta Differenz (negativ = entnommen)
 * @param {number} quantityAfter Bestand nach der Buchung
 * @param {'create'|'edit'|'adjust'|'shopping'|'restock'} reason
 * @param {number|null} userId
 */
function recordLog(itemId, itemName, delta, quantityAfter, reason, userId) {
  if (!Number.isFinite(delta) || delta === 0) return;
  try {
    db.get().prepare(`
      INSERT INTO home_inventory_logs (item_id, item_name, delta, quantity_after, reason, user_id)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(itemId, String(itemName ?? ''), delta, quantityAfter, reason, userId ?? null);
  } catch (err) {
    // Das Buch darf einen erfolgreichen Schreibvorgang nie scheitern lassen.
    log.warn('Bestandsbuch konnte nicht geschrieben werden:', err.message);
  }
}

/**
 * Verbrauch je Artikelname aus den Logs: wie viel pro Tag ging in den letzten
 * 90 Tagen weg? Grundlage für "noch ~N Tage" und für die Sortierung nach
 * Dringlichkeit.
 *
 * Gerechnet wird über den TATSÄCHLICHEN Beobachtungszeitraum (erster bis
 * letzter Eintrag der Gruppe), nicht pauschal über 90 Tage: ein Artikel, der
 * seit drei Tagen geführt wird, hätte sonst eine 30-mal zu kleine Rate.
 * @returns {Map<string, number>} key = Name in Kleinschreibung → Menge/Tag
 */
function consumptionRates() {
  const rows = db.get().prepare(`
    SELECT LOWER(TRIM(item_name)) AS key,
           SUM(CASE WHEN delta < 0 THEN -delta ELSE 0 END) AS consumed,
           MIN(substr(created_at, 1, 10)) AS first_day,
           MAX(substr(created_at, 1, 10)) AS last_day
      FROM home_inventory_logs
     WHERE created_at >= strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '-90 day')
     GROUP BY LOWER(TRIM(item_name))
  `).all();

  const today = Date.parse(`${localDateKey()}T00:00:00Z`);
  const rates = new Map();
  for (const row of rows) {
    const consumed = Number(row.consumed) || 0;
    if (consumed <= 0) continue;
    const first = Date.parse(`${row.first_day}T00:00:00Z`);
    const last = Date.parse(`${row.last_day}T00:00:00Z`);
    // Mindestens ein Tag Beobachtung — sonst teilte man durch 0 und jede
    // Entnahme wäre "unendlich schnell".
    const days = Math.max(1, Math.round(((Number.isFinite(last) ? last : today) - first) / 86_400_000) + 1);
    rates.set(row.key, consumed / days);
  }
  return rates;
}

/**
 * Verfügbarkeit als Objekt an jeden Batch hängen, damit die Seite nicht selbst
 * rechnen muss: `per_day` (Verbrauch/Tag) und `days_left` (Resttage bei
 * gleichbleibendem Verbrauch). Beides bezieht sich auf den ARTIKEL (alle
 * Batches zusammen), nicht auf den einzelnen Batch — sonst stünde an jeder
 * Flasche die halbe Wahrheit.
 */
function withUsage(rows) {
  const rates = consumptionRates();
  const totals = new Map();
  for (const row of rows) {
    const key = String(row.name ?? '').trim().toLowerCase();
    totals.set(key, (totals.get(key) ?? 0) + (Number(row.quantity) || 0));
  }
  return rows.map((row) => {
    const key = String(row.name ?? '').trim().toLowerCase();
    const perDay = rates.get(key) ?? null;
    return {
      ...row,
      per_day: perDay,
      days_left: perDay === null ? null : homeDaysLeft(totals.get(key) ?? 0, perDay),
    };
  });
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
  rows.sort((a, b) => {
    const ca = order.get(a.category) ?? fallback;
    const cb = order.get(b.category) ?? fallback;
    if (ca !== cb) return ca - cb;
    return compareHomeBatches(a, b);
  });
  return withUsage(rows);
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

  // 条码：可选。扫描枪/摄像头给出的值直接存，下次扫同一件商品即可命中。
  // Ungültige Formen sind ein Fehler (ein versehentlich gescannter Kassenzettel
  // soll nicht als "Code" in der Datenbank landen).
  if (!partial || body.barcode !== undefined) {
    const raw = body.barcode === null || body.barcode === '' ? '' : String(body.barcode).trim();
    if (raw && !isValidHomeBarcode(raw)) {
      results.push({ error: '条码格式不正确（4–64 位字母、数字或连字符）。' });
    }
    values.barcode = raw ? normalizeHomeBarcode(raw) : null;
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
        (name, category, quantity, unit, expires_on, location, min_quantity, notes, barcode, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      values.name, values.category, values.quantity, values.unit,
      values.expires_on, values.location, values.min_quantity, values.notes,
      values.barcode, userIdOf(req)
    );
    // Anfangsbestand buchen: ohne diese Zeile begänne die Verbrauchsrechnung
    // erst beim ersten Stepper-Klick und läge damit dauerhaft zu niedrig.
    recordLog(result.lastInsertRowid, values.name, Number(values.quantity) || 0,
      Number(values.quantity) || 0, 'create', userIdOf(req));
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
          min_quantity = ?, notes = ?, barcode = ?,
          updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
      WHERE id = ?
    `).run(
      values.name, values.category, values.quantity, values.unit,
      values.expires_on, values.location, values.min_quantity, values.notes,
      values.barcode, item.id
    );
    // Auch das Bearbeiten kann eine Menge ändern (Korrektur nach dem Einkauf) —
    // die Differenz gehört ins Buch, sonst fehlt sie in der Verbrauchsrechnung.
    recordLog(item.id, values.name, (Number(values.quantity) || 0) - (Number(item.quantity) || 0),
      Number(values.quantity) || 0, 'edit', userIdOf(req));
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
    `    ).run(...fields.map((f) => values[f]), item.id);
    recordLog(item.id, values.name ?? item.name,
      (Number(values.quantity ?? item.quantity) || 0) - (Number(item.quantity) || 0),
      Number(values.quantity ?? item.quantity) || 0, 'adjust', userIdOf(req));
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

// --------------------------------------------------------
// GET /api/v1/home-inventory/:itemId/history?limit=20
// Bestandsbuch eines Batches, neueste zuerst, plus die 90-Tage-Summe.
// Response: { data: { logs: [...], consumed90, unit } }
// --------------------------------------------------------
router.get('/:itemId/history', (req, res) => {
  try {
    const item = getItem(req.params.itemId);
    if (!item) return res.status(404).json({ error: '物品不存在。', code: 404 });
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 20));

    const logs = db.get().prepare(`
      SELECT l.id, l.delta, l.quantity_after, l.reason, l.created_at,
             COALESCE(u.display_name, u.username, '') AS user_name
        FROM home_inventory_logs l
        LEFT JOIN users u ON u.id = l.user_id
       WHERE l.item_id = ?
       ORDER BY l.created_at DESC, l.id DESC
       LIMIT ?
    `).all(item.id, limit);

    const consumed = db.get().prepare(`
      SELECT COALESCE(SUM(CASE WHEN delta < 0 THEN -delta ELSE 0 END), 0) AS c
        FROM home_inventory_logs
       WHERE item_id = ?
         AND created_at >= strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '-90 day')
    `).get(item.id).c;

    res.json({ data: { logs, consumed90: consumed, unit: item.unit } });
  } catch (err) {
    log.error('GET /:itemId/history error:', err);
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});

// --------------------------------------------------------
// GET /api/v1/home-inventory/barcode/:code
// Für den Scanner: gibt es zu diesem Code schon einen Artikel, kennt das
// Formular Name/Kategorie/Einheit/Lagerort bereits.
// Response: { data: HomeInventoryItem } | 404
// --------------------------------------------------------
router.get('/barcode/:code', (req, res) => {
  try {
    const code = normalizeHomeBarcode(req.params.code);
    if (!code) return res.status(400).json({ error: '条码格式不正确。', code: 400 });
    const row = db.get().prepare(`
      SELECT * FROM home_inventory_items WHERE barcode = ?
       ORDER BY updated_at DESC, id DESC LIMIT 1
    `).get(code);
    if (!row) return res.status(404).json({ error: '没有用过这个条码的物品。', code: 404 });
    res.json({ data: row });
  } catch (err) {
    log.error('GET /barcode/:code error:', err);
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});

// --------------------------------------------------------
// POST /api/v1/home-inventory/restock
// Überträgt Artikel in eine Einkaufsliste — der Weg von "leer" zu "gekauft".
// Body: { ids?: number[], scope?: 'restock'|'all', list_id?: number }
// Response: { data: { list_id, list_name, added, skipped, ids } }
//
// Der Übertrag ist idempotent genug für den Alltag: ein Artikel, der in dieser
// Liste schon offen liegt, wird nicht doppelt eingetragen (sonst stünde nach
// drei Klicks dreimal "洗衣液" auf dem Zettel).
// --------------------------------------------------------
router.post('/restock', (req, res) => {
  try {
    const body = req.body ?? {};
    const ids = Array.isArray(body.ids)
      ? [...new Set(body.ids.map(Number).filter(Number.isInteger))]
      : [];

    let targets;
    if (ids.length) {
      const marks = ids.map(() => '?').join(',');
      targets = db.get().prepare(
        `SELECT * FROM home_inventory_items WHERE id IN (${marks})`
      ).all(...ids);
    } else if (body.scope === 'all') {
      targets = db.get().prepare('SELECT * FROM home_inventory_items').all();
    } else {
      // Standard: alles, was als "需要补货" markiert ist (leer oder unter Schwelle).
      targets = db.get().prepare(`
        SELECT * FROM home_inventory_items
         WHERE quantity <= 0
            OR (min_quantity IS NOT NULL AND quantity <= min_quantity)
      `).all();
    }
    if (!targets.length) {
      return res.status(400).json({ error: '没有需要补货的物品。', code: 400 });
    }

    const list = body.list_id
      ? db.get().prepare('SELECT id, name FROM shopping_lists WHERE id = ?').get(body.list_id)
      : db.get().prepare('SELECT id, name FROM shopping_lists ORDER BY id ASC LIMIT 1').get();
    if (!list) {
      return res.status(400).json({ error: '还没有购物清单，请先在「购物」里新建一个。', code: 400 });
    }

    const fallbackCategory = db.get()
      .prepare("SELECT name FROM shopping_categories ORDER BY sort_order ASC, id ASC LIMIT 1")
      .get()?.name ?? 'Sonstiges';
    // Kategorie der Einkaufsliste übernehmen, wenn es sie gibt — sonst die erste.
    const shoppingCats = db.get().prepare('SELECT name FROM shopping_categories').all()
      .map((c) => c.name);

    const exists = db.get().prepare(`
      SELECT 1 FROM shopping_items
       WHERE list_id = ? AND is_checked = 0 AND home_inventory_item_id = ?
    `);
    const insert = db.get().prepare(`
      INSERT INTO shopping_items (list_id, name, quantity, category, home_inventory_item_id)
      VALUES (?, ?, ?, ?, ?)
    `);

    let added = 0;
    let skipped = 0;
    const createdIds = [];

    db.get().transaction(() => {
      for (const item of targets) {
        if (exists.get(list.id, item.id)) {
          skipped += 1;
          continue;
        }
        // Menge: bis zur Schwelle auffüllen, mindestens 1. Bei "leer" ist die
        // Schwelle die beste Schätzung dessen, was wieder ins Haus soll.
        const need = Math.max(1, Math.ceil(Number(item.min_quantity) || 1));
        const category = shoppingCats.includes(item.category)
          ? item.category
          : fallbackCategory;
        const info = insert.run(list.id, item.name, String(need), category, item.id);
        createdIds.push(info.lastInsertRowid);
        added += 1;
      }
    })();

    res.status(added ? 201 : 200).json({
      data: { list_id: list.id, list_name: list.name, added, skipped, ids: createdIds },
    });
  } catch (err) {
    log.error('POST /restock error:', err);
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});

export default router;
