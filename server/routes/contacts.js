/**
 * Modul: Kontakte (Contacts)
 * Zweck: REST-API-Routen für wichtige Familienkontakte
 * Abhängigkeiten: express, server/db.js, server/auth.js
 *
 * R3/R4 (rnw 补差, T04a):
 *   - phone/address/vehicle_plate 及 contact_phones.value/value_e164、
 *     contact_addresses.street 为 SM4 密文列（v149）：写路径 encryptField，
 *     读路径 decryptField 回显；`q` 文本搜索因此不再覆盖手机号（PRD 预期），
 *     精确检索请用 `?phone=`（phone_hash 等值，v149）。
 *   - birthday_lunar/zodiac/constellation 为服务端派生字段（v147/T02）：
 *     applyLunarFields 裁决；spouse_note/priority_intro 为普通 Profile 字段。
 *   - 读路径叠加 R4 可见性过滤（visibilityFilter，v150 contact_node_acl）。
 */

import { createLogger } from '../logger.js';
import express from 'express';
import * as db from '../db.js';
import { str, oneOf, date, collectErrors, MAX_TITLE, MAX_TEXT, MAX_SHORT } from '../middleware/validate.js';
import { uniqueKey } from '../utils/category-slug.js';
import { composeDisplayName, normalizeNameParts } from '../../public/utils/contact-name.js';
import { toE164, defaultCountryFromConfig } from '../utils/phone.js';
import { applyLunarFields, ZODIACS, CONSTELLATIONS } from '../services/lunar-fields.js';
import { encryptField, decryptField, phoneHash } from '../services/sm4.js';
import { visibilityFilter } from '../services/contact-visibility.js';

const log = createLogger('Contacts');

const router  = express.Router();

const FALLBACK_CATEGORY = 'misc';

/**
 * Liest die strukturierten Namensteile aus einem Request-Body (#535) und leitet
 * den Anzeigenamen daraus ab. Ein mitgesendetes `name` gilt nur, solange keine
 * Komponenten vorliegen - sonst wäre die Anzeige wieder quellenabhängig.
 * @param {Object} body - Request-Body
 * @returns {{parts: Object, provided: boolean, displayName: string|null}}
 */
function readNameParts(body) {
  const parts = normalizeNameParts({
    firstName:  body.firstName,
    lastName:   body.lastName,
    middleName:  body.middleName,
    namePrefix: body.namePrefix,
    nameSuffix: body.nameSuffix,
  });
  const provided = ['firstName', 'lastName', 'middleName', 'namePrefix', 'nameSuffix']
    .some((k) => body[k] !== undefined);
  return { parts, provided, displayName: composeDisplayName(parts) };
}

/** Längen-Validierung der Namensteile (gleiche Grenze wie der Anzeigename). */
function namePartChecks(parts) {
  return [
    str(parts.firstName,  'Vorname',   { max: MAX_TITLE, required: false }),
    str(parts.lastName,   'Nachname',  { max: MAX_TITLE, required: false }),
    str(parts.middleName, 'Zweitname', { max: MAX_TITLE, required: false }),
    str(parts.namePrefix, 'Namenszusatz', { max: MAX_SHORT, required: false }),
    str(parts.nameSuffix, 'Namenssuffix', { max: MAX_SHORT, required: false }),
  ];
}

/**
 * R4: priorityIntro 校验——布尔值（传了才校验；null 视作「清除」）。
 * @param {*} val 请求值
 * @returns {{value: boolean|null, error: string|null}}
 */
function priorityIntroCheck(val) {
  if (val === undefined || val === null) return { value: null, error: null };
  if (typeof val !== 'boolean') return { value: null, error: 'Priority intro must be a boolean.' };
  return { value: val, error: null };
}

/**
 * R3: 联系人敏感标量列解密回显（读路径宽容——非密文原样返回，不抛错）。
 * phone_hash 是内部盲指纹（v149），不属于 API 契约——响应中剔除。
 * @param {Object|null} row contacts 行（SELECT *）
 * @returns {Object|null} 解密后的浅拷贝
 */
function presentContact(row) {
  if (!row) return row;
  const { phone_hash: _phoneHash, ...rest } = row;
  return {
    ...rest,
    phone: decryptField(row.phone),
    address: decryptField(row.address),
    vehicle_plate: decryptField(row.vehicle_plate),
  };
}

/** Verwaltbare Kontakt-Kategorien aus der DB (nach sort_order). */
function loadContactCategories() {
  return db.get().prepare(
    'SELECT key, name, label_key, icon, sort_order FROM contact_categories ORDER BY sort_order ASC, key ASC'
  ).all();
}

/** Nur die Keys — für die dynamische Kategorie-Validierung. */
function validContactCategoryKeys() {
  return loadContactCategories().map((c) => c.key);
}

/** Anzahl Kontakte, die eine Kategorie referenzieren (Guard vor dem Löschen). */
function contactCategoryInUseCount(key) {
  return db.get().prepare('SELECT COUNT(*) AS n FROM contacts WHERE category = ?').get(key).n;
}

/**
 * Loads multi-value fields (phones, emails, addresses) for a contact.
 * R3: phones.value/value_e164、addresses.street、vehicle_plate 为密文列——
 * 此处统一 decryptField 回显，调用方拿到的即是明文。
 * @param {number} contactId - Contact ID
 * @returns {{ phones: Array, emails: Array, addresses: Array }}
 */
function loadMultiValueFields(contactId) {
  const phones = db.get().prepare(`
    SELECT id, label, value, value_e164, is_primary FROM contact_phones
    WHERE contact_id = ?
    ORDER BY is_primary DESC, id ASC
  `).all(contactId).map(p => ({
    id: p.id,
    label: p.label,
    value: decryptField(p.value),
    valueE164: decryptField(p.value_e164),
    isPrimary: p.is_primary === 1
  }));

  const emails = db.get().prepare(`
    SELECT id, label, value, is_primary FROM contact_emails
    WHERE contact_id = ?
    ORDER BY is_primary DESC, id ASC
  `).all(contactId).map(e => ({
    id: e.id,
    label: e.label,
    value: e.value,
    isPrimary: e.is_primary === 1
  }));

  const addresses = db.get().prepare(`
    SELECT id, label, street, city, state, postal_code, country, is_primary
    FROM contact_addresses
    WHERE contact_id = ?
    ORDER BY is_primary DESC, id ASC
  `).all(contactId).map(a => ({
    id: a.id,
    label: a.label,
    street: decryptField(a.street),
    city: a.city,
    state: a.state,
    postalCode: a.postal_code,
    country: a.country,
    isPrimary: a.is_primary === 1
  }));

  const extras = db.get().prepare(`
    SELECT vehicle_plate, school, custom_tags, gender, hometown, wechat, douyin, qq, contact_groups, call_them, call_me, hidden,
           birthday_lunar, zodiac, constellation, spouse_note, priority_intro
    FROM contacts WHERE id = ?
  `).get(contactId) || {};
  return {
    phones, emails, addresses,
    vehiclePlate: decryptField(extras.vehicle_plate),
    school: extras.school ?? null,
    customTags: extras.custom_tags ?? null,
    gender: extras.gender ?? null,
    hometown: extras.hometown ?? null,
    wechat: extras.wechat ?? null,
    douyin: extras.douyin ?? null,
    qq: extras.qq ?? null,
    contactGroups: extras.contact_groups ?? null,
    callThem: extras.call_them ?? null,
    callMe: extras.call_me ?? null,
    // R4-Profilefelder (v147) — camelCase-Aliase wie die übrigen Multi-Value-Felder.
    birthdayLunar: extras.birthday_lunar ?? null,
    zodiac: extras.zodiac ?? null,
    constellation: extras.constellation ?? null,
    spouseNote: extras.spouse_note ?? null,
    priorityIntro: extras.priority_intro === 1,
    hidden: extras.hidden === 1,
  };
}

/**
 * Validates phones array for multi-value contact fields.
 * @param {Array} phones - Array of { label, value, isPrimary? }
 * @returns {{ valid: boolean, error?: string }}
 */
function validatePhones(phones) {
  if (!Array.isArray(phones)) return { valid: false, error: 'Phones must be an array' };
  if (phones.length > 20) return { valid: false, error: 'Too many phone entries (max 20)' };
  for (const p of phones) {
    if (!p || typeof p !== 'object') return { valid: false, error: 'Phone entry must be an object' };
    if (!p.label || !p.value) return { valid: false, error: 'Phone requires label and value' };
    if (typeof p.label !== 'string' || p.label.trim().length === 0 || p.label.length > 50) {
      return { valid: false, error: 'Phone label invalid or too long' };
    }
    if (typeof p.value !== 'string' || p.value.trim().length === 0 || p.value.length > 50) {
      return { valid: false, error: 'Phone value invalid or too long' };
    }
    if (p.isPrimary !== undefined && typeof p.isPrimary !== 'boolean') {
      return { valid: false, error: 'Phone isPrimary must be boolean' };
    }
  }
  return { valid: true };
}

/**
 * Validates emails array for multi-value contact fields.
 * @param {Array} emails - Array of { label, value, isPrimary? }
 * @returns {{ valid: boolean, error?: string }}
 */
function validateEmails(emails) {
  if (!Array.isArray(emails)) return { valid: false, error: 'Emails must be an array' };
  if (emails.length > 20) return { valid: false, error: 'Too many email entries (max 20)' };
  for (const e of emails) {
    if (!e || typeof e !== 'object') return { valid: false, error: 'Email entry must be an object' };
    if (!e.label || !e.value) return { valid: false, error: 'Email requires label and value' };
    if (typeof e.label !== 'string' || e.label.trim().length === 0 || e.label.length > 50) {
      return { valid: false, error: 'Email label invalid or too long' };
    }
    if (typeof e.value !== 'string' || e.value.trim().length === 0 || e.value.length > 255) {
      return { valid: false, error: 'Email value invalid or too long' };
    }
    if (!/^.+@.+$/.test(e.value)) {
      return { valid: false, error: 'Email value must be a valid email address' };
    }
    if (e.isPrimary !== undefined && typeof e.isPrimary !== 'boolean') {
      return { valid: false, error: 'Email isPrimary must be boolean' };
    }
  }
  return { valid: true };
}

/**
 * Validates addresses array for multi-value contact fields.
 * @param {Array} addresses - Array of { label, street?, city?, state?, postalCode?, country?, isPrimary? }
 * @returns {{ valid: boolean, error?: string }}
 */
function validateAddresses(addresses) {
  if (!Array.isArray(addresses)) return { valid: false, error: 'Addresses must be an array' };
  if (addresses.length > 20) return { valid: false, error: 'Too many address entries (max 20)' };
  for (const a of addresses) {
    if (!a || typeof a !== 'object') return { valid: false, error: 'Address entry must be an object' };
    if (!a.label) return { valid: false, error: 'Address requires label' };
    if (typeof a.label !== 'string' || a.label.trim().length === 0 || a.label.length > 50) {
      return { valid: false, error: 'Address label invalid or too long' };
    }
    if (a.street !== undefined && (typeof a.street !== 'string' || a.street.length > 255)) {
      return { valid: false, error: 'Address street invalid or too long' };
    }
    if (a.city !== undefined && (typeof a.city !== 'string' || a.city.length > 255)) {
      return { valid: false, error: 'Address city invalid or too long' };
    }
    if (a.state !== undefined && (typeof a.state !== 'string' || a.state.length > 255)) {
      return { valid: false, error: 'Address state invalid or too long' };
    }
    if (a.postalCode !== undefined && (typeof a.postalCode !== 'string' || a.postalCode.length > 255)) {
      return { valid: false, error: 'Address postalCode invalid or too long' };
    }
    if (a.country !== undefined && (typeof a.country !== 'string' || a.country.length > 255)) {
      return { valid: false, error: 'Address country invalid or too long' };
    }
    if (a.isPrimary !== undefined && typeof a.isPrimary !== 'boolean') {
      return { valid: false, error: 'Address isPrimary must be boolean' };
    }
  }
  return { valid: true };
}

/**
 * R4: 派生字段最终裁决（POST/PUT 共用）。
 *
 * applyLunarFields(body, current) 覆盖「生日语境」四情形（T02，current 为 DB
 * 现行行——契约参数）；此处补齐唯一不在其裁决范围内的组合——未传 birthday 但
 * 显式传了派生字段（手动修正无需动生日）。显式值（含 null 清除）永远优先于
 * 自动换算结果。
 *
 * @param {Object} body 请求体
 * @param {Object|null} [current] DB 现行行（PUT 时传入）
 * @returns {{birthdayLunar: *, zodiac: *, constellation: *}} 仅含需写入的键
 */
function resolveLunarPatch(body, current = null) {
  const patch = applyLunarFields(body, current);
  if (body.birthdayLunar !== undefined) patch.birthdayLunar = body.birthdayLunar;
  if (body.zodiac !== undefined) patch.zodiac = body.zodiac;
  if (body.constellation !== undefined) patch.constellation = body.constellation;
  return patch;
}

// --------------------------------------------------------
// Kategorie-Verwaltung (#357)
// Statische /categories-Pfade MÜSSEN vor den dynamischen /:id-Routen stehen.
// --------------------------------------------------------

// GET /api/v1/contacts/categories → { data: ContactCategory[] }
router.get('/categories', (_req, res) => {
  try {
    res.json({ data: loadContactCategories() });
  } catch (err) {
    log.error('GET /categories error:', err);
    res.status(500).json({ error: 'Interner Fehler', code: 500 });
  }
});

// POST /api/v1/contacts/categories  Body: { name } → { data: ContactCategory }
router.post('/categories', (req, res) => {
  try {
    const vName = str(req.body.name, 'Name', { max: MAX_SHORT });
    if (vName.error) return res.status(400).json({ error: vName.error, code: 400 });

    const conflict = db.get().prepare(`
      SELECT key FROM contact_categories WHERE COALESCE(name, key) = ? COLLATE NOCASE
    `).get(vName.value);
    if (conflict) return res.status(409).json({ error: 'Category already exists.', code: 409, reason: 'category_exists' });

    const maxOrder = db.get().prepare('SELECT COALESCE(MAX(sort_order), -1) AS m FROM contact_categories').get().m;
    const key = uniqueKey(db.get(), 'contact_categories', vName.value);
    db.get().prepare(
      "INSERT INTO contact_categories (key, name, label_key, icon, sort_order) VALUES (?, ?, NULL, 'tag', ?)"
    ).run(key, vName.value, maxOrder + 1);

    const cat = db.get().prepare('SELECT key, name, label_key, icon, sort_order FROM contact_categories WHERE key = ?').get(key);
    res.status(201).json({ data: cat });
  } catch (err) {
    log.error('POST /categories error:', err);
    res.status(500).json({ error: 'Interner Fehler', code: 500 });
  }
});

// PATCH /api/v1/contacts/categories/reorder  Body: { order: string[] }
router.patch('/categories/reorder', (req, res) => {
  try {
    const order = Array.isArray(req.body.order) ? req.body.order : [];
    const update = db.get().prepare('UPDATE contact_categories SET sort_order = ? WHERE key = ?');
    db.get().transaction(() => order.forEach((key, i) => update.run(i, key)))();
    res.json({ data: loadContactCategories() });
  } catch (err) {
    log.error('PATCH /categories/reorder error:', err);
    res.status(500).json({ error: 'Interner Fehler', code: 500 });
  }
});

// PUT /api/v1/contacts/categories/:key  Body: { name } → umbenennen (Key bleibt stabil).
router.put('/categories/:key', (req, res) => {
  try {
    const cat = db.get().prepare('SELECT * FROM contact_categories WHERE key = ?').get(req.params.key);
    if (!cat) return res.status(404).json({ error: 'Category not found.', code: 404 });

    const vName = str(req.body.name, 'Name', { max: MAX_SHORT });
    if (vName.error) return res.status(400).json({ error: vName.error, code: 400 });

    const conflict = db.get().prepare(`
      SELECT key FROM contact_categories WHERE COALESCE(name, key) = ? COLLATE NOCASE AND key != ?
    `).get(vName.value, cat.key);
    if (conflict) return res.status(409).json({ error: 'Category already exists.', code: 409, reason: 'category_exists' });

    db.get().prepare('UPDATE contact_categories SET name = ?, label_key = NULL WHERE key = ?').run(vName.value, cat.key);
    const updated = db.get().prepare('SELECT key, name, label_key, icon, sort_order FROM contact_categories WHERE key = ?').get(cat.key);
    res.json({ data: updated });
  } catch (err) {
    log.error('PUT /categories/:key error:', err);
    res.status(500).json({ error: 'Interner Fehler', code: 500 });
  }
});

// DELETE /api/v1/contacts/categories/:key → 409 wenn in Benutzung oder letzte Kategorie.
router.delete('/categories/:key', (req, res) => {
  try {
    const cat = db.get().prepare('SELECT * FROM contact_categories WHERE key = ?').get(req.params.key);
    if (!cat) return res.status(404).json({ error: 'Category not found.', code: 404 });

    const inUse = contactCategoryInUseCount(cat.key);
    if (inUse > 0) {
      return res.status(409).json({ error: `Category is in use by ${inUse} contact${inUse === 1 ? '' : 's'}.`, code: 409, count: inUse, reason: 'category_in_use' });
    }
    const total = db.get().prepare('SELECT COUNT(*) AS n FROM contact_categories').get().n;
    if (total <= 1) return res.status(409).json({ error: 'Cannot delete the last category.', code: 409, reason: 'category_last' });

    db.get().prepare('DELETE FROM contact_categories WHERE key = ?').run(cat.key);
    res.status(204).end();
  } catch (err) {
    log.error('DELETE /categories/:key error:', err);
    res.status(500).json({ error: 'Interner Fehler', code: 500 });
  }
});

/**
 * GET /api/v1/contacts
 * Alle Kontakte, optional nach Kategorie gefiltert und nach Name gesucht.
 * Query: ?category=<cat>&q=<search>&phone=<exact>
 * Response: { data: Contact[] }
 *
 * R3 注意：phone/address 已 SM4 加密，`q` 的 LIKE 明文匹配对手机号**永久失效**
 * （PRD 明确的预期行为）——`q` 只覆盖 name/email 等明文列；手机号精确检索
 * 请用 `?phone=`（phone_hash 等值，v149）。
 */
router.get('/', (req, res) => {
  try {
    let sql    = 'SELECT * FROM contacts';
    const params = [];
    const where  = ['NOT EXISTS (SELECT 1 FROM housekeeping_workers hw WHERE hw.user_id = contacts.family_user_id)'];

    if (req.query.category && validContactCategoryKeys().includes(req.query.category)) {
      where.push('category = ?');
      params.push(req.query.category);
    }

    if (req.query.q) {
      // R3: phone LIKE 已随密文存储下线（见上方说明）——q 仅搜 name/email。
      where.push('(name LIKE ? OR email LIKE ?)');
      const like = `%${req.query.q}%`;
      params.push(like, like);
    }

    // R3: 手机号精确检索走 phone_hash 盲指纹等值（密文列不可 LIKE/排序）。
    if (req.query.phone) {
      const hash = phoneHash(String(req.query.phone).trim());
      if (hash) {
        where.push('phone_hash = ?');
        params.push(hash);
      }
    }

    if (where.length) sql += ' WHERE ' + where.join(' AND ');
    // R4: 协作者可见性（hidden + contact_node_acl）；admin 返回空片段（不过滤）。
    const vis = visibilityFilter(req, 'contacts');
    sql += vis.sql;
    params.push(...vis.params);
    // Sortiert nach Nachname, wo er bekannt ist; sonst nach dem Anzeigenamen (#535).
    sql += ' ORDER BY category ASC, COALESCE(NULLIF(last_name, \'\'), name) COLLATE NOCASE ASC, name COLLATE NOCASE ASC';

    const contacts = db.get().prepare(sql).all(...params).map(presentContact);
    res.json({ data: contacts });
  } catch (err) {
    log.error('', err);
    res.status(500).json({ error: 'Interner Fehler' });
  }
});

/**
 * POST /api/v1/contacts
 * Neuen Kontakt anlegen.
 * Body: { name, category?, phone?, email?, address?, notes?, birthday?,
 *         birthdayLunar?, zodiac?, constellation?, spouseNote?, priorityIntro?,
 *         phones?, emails?, addresses? }
 * Response: { data: Contact }
 *
 * R3: phone/address/vehiclePlate 及 phones/addresses 子表敏感列写入前加密；
 * phone 同步 phone_hash。R4: 生日自动换算农历/生肖/星座（applyLunarFields）。
 */
router.post('/', (req, res) => {
  try {
    // Strukturierte Namensteile haben Vorrang vor einem mitgesendeten `name` (#535).
    const nameParts = readNameParts(req.body);
    const vName    = str(nameParts.displayName ?? req.body.name, 'Name', { max: MAX_TITLE });
    const vCat     = oneOf(req.body.category || FALLBACK_CATEGORY, validContactCategoryKeys(), 'Kategorie');
    const vPhone   = str(req.body.phone,   'Telefon', { max: MAX_SHORT, required: false });
    const vEmail   = str(req.body.email,   'E-Mail',  { max: MAX_TITLE, required: false });
    const vAddress = str(req.body.address, 'Adresse', { max: MAX_TEXT,  required: false });
    const vNotes   = str(req.body.notes,   'Notizen', { max: MAX_TEXT,  required: false });
    // Geburtstag (ISO YYYY-MM-DD, optional) - u. a. aus vCard-BDAY beim Import.
    // Speist den bestehenden #518-Geburtstags-Import (GET /birthdays/import/candidates).
    const vBirthday = date(req.body.birthday, 'Geburtstag', false);
    const vGender   = str(req.body.gender, 'Gender', { max: MAX_SHORT, required: false });
    const vHometown = str(req.body.hometown, 'Hometown', { max: MAX_TITLE, required: false });
    const vWechat   = str(req.body.wechat, 'WeChat', { max: MAX_SHORT, required: false });
    const vDouyin   = str(req.body.douyin, 'Douyin', { max: MAX_SHORT, required: false });
    const vQq       = str(req.body.qq, 'QQ', { max: MAX_SHORT, required: false });
    const vGroups   = str(req.body.contactGroups, 'Groups', { max: MAX_TEXT, required: false });
    const vCallThem = str(req.body.callThem, 'Call them', { max: MAX_SHORT, required: false });
    const vCallMe   = str(req.body.callMe, 'Call me', { max: MAX_SHORT, required: false });
    // R4-Profilefelder (v147): 派生三件套 + spouse_note + priority_intro。
    const vBirthdayLunar = str(req.body.birthdayLunar, 'Birthday lunar', { max: MAX_SHORT, required: false });
    const vZodiac        = oneOf(req.body.zodiac, ZODIACS, 'Zodiac');
    const vConstellation = oneOf(req.body.constellation, CONSTELLATIONS, 'Constellation');
    const vSpouseNote    = str(req.body.spouseNote, 'Spouse note', { max: MAX_TEXT, required: false });
    const vPriorityIntro = priorityIntroCheck(req.body.priorityIntro);
    const errors   = collectErrors([vName, vCat, vPhone, vEmail, vAddress, vNotes, vBirthday,
                                    vGender, vHometown, vWechat, vDouyin, vQq, vGroups, vCallThem, vCallMe,
                                    vBirthdayLunar, vZodiac, vConstellation, vSpouseNote, vPriorityIntro,
                                    ...namePartChecks(nameParts.parts)]);
    if (errors.length) return res.status(400).json({ error: errors.join(' '), code: 400 });

    // Validate multi-value fields if provided
    if (req.body.phones !== undefined) {
      const phonesValidation = validatePhones(req.body.phones);
      if (!phonesValidation.valid) {
        return res.status(400).json({ error: phonesValidation.error, code: 400 });
      }
    }

    if (req.body.emails !== undefined) {
      const emailsValidation = validateEmails(req.body.emails);
      if (!emailsValidation.valid) {
        return res.status(400).json({ error: emailsValidation.error, code: 400 });
      }
    }

    if (req.body.addresses !== undefined) {
      const addressesValidation = validateAddresses(req.body.addresses);
      if (!addressesValidation.valid) {
        return res.status(400).json({ error: addressesValidation.error, code: 400 });
      }
    }

    // R4: 派生字段裁决——生日自动换算农历/生肖/星座；显式修正优先（resolveLunarPatch）。
    const lunar = resolveLunarPatch(req.body, null);
    const birthdayLunar  = lunar.birthdayLunar  !== undefined ? lunar.birthdayLunar  : (vBirthdayLunar.value ?? null);
    const zodiac         = lunar.zodiac         !== undefined ? lunar.zodiac         : (vZodiac.value ?? null);
    const constellation  = lunar.constellation  !== undefined ? lunar.constellation  : (vConstellation.value ?? null);

    // Insert contact and multi-value fields in a transaction
    const transaction = db.get().transaction(() => {
      const result = db.get().prepare(`
        INSERT INTO contacts (name, category, phone, phone_hash, email, address, notes, birthday,
                              first_name, last_name, middle_name, name_prefix, name_suffix,
                              vehicle_plate, school, custom_tags,
                              gender, hometown, wechat, douyin, qq, contact_groups, call_them, call_me,
                              birthday_lunar, zodiac, constellation, spouse_note, priority_intro)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(vName.value, vCat.value || FALLBACK_CATEGORY,
             // R3: 敏感列加密落库；phone 同步盲指纹（phone_hash = HMAC(明文)）。
             encryptField(vPhone.value), phoneHash(vPhone.value), vEmail.value,
             encryptField(vAddress.value), vNotes.value, vBirthday.value,
             nameParts.parts.firstName, nameParts.parts.lastName, nameParts.parts.middleName,
             nameParts.parts.namePrefix, nameParts.parts.nameSuffix,
             encryptField(req.body.vehiclePlate || null), req.body.school || null, req.body.customTags || null,
             vGender.value ?? null, vHometown.value ?? null, vWechat.value ?? null, vDouyin.value ?? null,
             vQq.value ?? null, vGroups.value ?? null, vCallThem.value ?? null, vCallMe.value ?? null,
             birthdayLunar, zodiac, constellation, vSpouseNote.value ?? null,
             vPriorityIntro.value ? 1 : 0);

      const contactId = result.lastInsertRowid;

      // Insert phones. value_e164 ist additiv (Phase 2): der rohe value bleibt die
      // Wahrheit; value_e164 wird nur gesetzt, wo parsebar (sonst NULL).
      // R3: toE164 先在明文上算完，再与 value 一并加密。
      if (req.body.phones && Array.isArray(req.body.phones)) {
        const defaultCountry = defaultCountryFromConfig(db.get());
        const insertPhone = db.get().prepare(`
          INSERT INTO contact_phones (contact_id, label, value, is_primary, value_e164)
          VALUES (?, ?, ?, ?, ?)
        `);
        for (const phone of req.body.phones) {
          insertPhone.run(contactId, phone.label, encryptField(phone.value), phone.isPrimary ? 1 : 0,
                          encryptField(toE164(phone.value, defaultCountry)));
        }
      }

      // Insert emails
      if (req.body.emails && Array.isArray(req.body.emails)) {
        const insertEmail = db.get().prepare(`
          INSERT INTO contact_emails (contact_id, label, value, is_primary)
          VALUES (?, ?, ?, ?)
        `);
        for (const email of req.body.emails) {
          insertEmail.run(contactId, email.label, email.value, email.isPrimary ? 1 : 0);
        }
      }

      // Insert addresses. R3: street 加密落库（city/state/postal_code/country 明文）。
      if (req.body.addresses && Array.isArray(req.body.addresses)) {
        const insertAddress = db.get().prepare(`
          INSERT INTO contact_addresses (contact_id, label, street, city, state, postal_code, country, is_primary)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `);
        for (const address of req.body.addresses) {
          insertAddress.run(
            contactId,
            address.label,
            encryptField(address.street || null),
            address.city || null,
            address.state || null,
            address.postalCode || null,
            address.country || null,
            address.isPrimary ? 1 : 0
          );
        }
      }

      return contactId;
    });

    const contactId = transaction();

    // Query the created contact with multi-value fields (R3: 解密回显)
    const contact = db.get().prepare('SELECT * FROM contacts WHERE id = ?').get(contactId);
    const multiValueFields = loadMultiValueFields(contactId);

    res.status(201).json({
      data: {
        ...presentContact(contact),
        ...multiValueFields
      }
    });
  } catch (err) {
    log.error('', err);
    res.status(500).json({ error: 'Interner Fehler' });
  }
});

/**
 * PUT /api/v1/contacts/:id
 * Kontakt bearbeiten.
 * Body: alle Felder optional, phones/emails/addresses mit Replacement-Semantik
 * Response: { data: Contact }
 *
 * R3: phone/address/vehiclePlate **仅当 body 传了才**加密回写——未传绝不触碰
 * （防二次加密/误清；contact 现值原样保留）。phone 传了则 phone_hash 同步。
 * R4: 派生字段仅在生日变更或显式传了时才重算（resolveLunarPatch）。
 */
router.put('/:id', (req, res) => {
  try {
    const id      = parseInt(req.params.id, 10);
    const contact = db.get().prepare('SELECT * FROM contacts WHERE id = ?').get(id);
    if (!contact) return res.status(404).json({ error: 'Kontakt nicht gefunden', code: 404 });

    // Namensteile (#535): sobald welche mitkommen, ersetzen sie die gespeicherten
    // und der Anzeigename wird neu daraus abgeleitet.
    const nameParts = readNameParts(req.body);
    const derivedName = nameParts.provided ? nameParts.displayName : null;

    const checks = [];
    if (nameParts.provided)              checks.push(...namePartChecks(nameParts.parts));
    if (req.body.name     !== undefined) checks.push(str(req.body.name,     'Name',    { max: MAX_TITLE, required: false }));
    if (req.body.category !== undefined) checks.push(oneOf(req.body.category, validContactCategoryKeys(), 'Kategorie'));
    if (req.body.phone    !== undefined) checks.push(str(req.body.phone,    'Telefon', { max: MAX_SHORT, required: false }));
    if (req.body.email    !== undefined) checks.push(str(req.body.email,    'E-Mail',  { max: MAX_TITLE, required: false }));
    if (req.body.address  !== undefined) checks.push(str(req.body.address,  'Adresse', { max: MAX_TEXT,  required: false }));
    if (req.body.notes    !== undefined) checks.push(str(req.body.notes,    'Notizen', { max: MAX_TEXT,  required: false }));
    if (req.body.birthday !== undefined) checks.push(date(req.body.birthday, 'Geburtstag', false));
    if (req.body.gender   !== undefined) checks.push(str(req.body.gender,   'Gender',   { max: MAX_SHORT, required: false }));
    if (req.body.hometown !== undefined) checks.push(str(req.body.hometown, 'Hometown', { max: MAX_TITLE, required: false }));
    if (req.body.wechat   !== undefined) checks.push(str(req.body.wechat,   'WeChat',   { max: MAX_SHORT, required: false }));
    if (req.body.douyin   !== undefined) checks.push(str(req.body.douyin,   'Douyin',   { max: MAX_SHORT, required: false }));
    if (req.body.qq       !== undefined) checks.push(str(req.body.qq,       'QQ',       { max: MAX_SHORT, required: false }));
    if (req.body.contactGroups !== undefined) checks.push(str(req.body.contactGroups, 'Groups', { max: MAX_TEXT, required: false }));
    if (req.body.callThem !== undefined) checks.push(str(req.body.callThem, 'Call them', { max: MAX_SHORT, required: false }));
    if (req.body.callMe   !== undefined) checks.push(str(req.body.callMe,   'Call me',   { max: MAX_SHORT, required: false }));
    // R4-Profilefelder (v147) — 仅传了才校验/才动。
    if (req.body.birthdayLunar !== undefined) checks.push(str(req.body.birthdayLunar, 'Birthday lunar', { max: MAX_SHORT, required: false }));
    if (req.body.zodiac        !== undefined) checks.push(oneOf(req.body.zodiac, ZODIACS, 'Zodiac'));
    if (req.body.constellation !== undefined) checks.push(oneOf(req.body.constellation, CONSTELLATIONS, 'Constellation'));
    if (req.body.spouseNote    !== undefined) checks.push(str(req.body.spouseNote, 'Spouse note', { max: MAX_TEXT, required: false }));
    if (req.body.priorityIntro !== undefined) checks.push(priorityIntroCheck(req.body.priorityIntro));
    const errors = collectErrors(checks);
    if (errors.length) return res.status(400).json({ error: errors.join(' '), code: 400 });

    // Validate multi-value fields if provided
    if (req.body.phones !== undefined) {
      const phonesValidation = validatePhones(req.body.phones);
      if (!phonesValidation.valid) {
        return res.status(400).json({ error: phonesValidation.error, code: 400 });
      }
    }

    if (req.body.emails !== undefined) {
      const emailsValidation = validateEmails(req.body.emails);
      if (!emailsValidation.valid) {
        return res.status(400).json({ error: emailsValidation.error, code: 400 });
      }
    }

    if (req.body.addresses !== undefined) {
      const addressesValidation = validateAddresses(req.body.addresses);
      if (!addressesValidation.valid) {
        return res.status(400).json({ error: addressesValidation.error, code: 400 });
      }
    }

    // R4: 派生字段 patch（生日变更/显式修正才含键；否则为空 → 下方原值兜底）。
    const lunar = resolveLunarPatch(req.body, contact);

    // Update contact and multi-value fields in a transaction
    const transaction = db.get().transaction(() => {
      // Update scalar fields
      db.get().prepare(`
        UPDATE contacts
        SET name        = COALESCE(?, name),
            category    = COALESCE(?, category),
            phone       = ?,
            phone_hash  = ?,
            email       = ?,
            address     = ?,
            notes       = ?,
            birthday    = ?,
            first_name  = ?,
            last_name   = ?,
            middle_name = ?,
            name_prefix = ?,
            name_suffix = ?,
            vehicle_plate = ?,
            school = ?,
            custom_tags = ?,
            gender = ?,
            hometown = ?,
            wechat = ?,
            douyin = ?,
            qq = ?,
            contact_groups = ?,
            call_them = ?,
            call_me = ?,
            birthday_lunar = ?,
            zodiac = ?,
            constellation = ?,
            spouse_note = ?,
            priority_intro = ?
        WHERE id = ?
      `).run(
        derivedName ?? req.body.name?.trim() ?? null,
        req.body.category ?? null,
        // R3: 仅传了才加密回写；未传 → 原密文值原样保留（防二次加密/误清）。
        req.body.phone   !== undefined ? encryptField(req.body.phone?.trim()   || null) : contact.phone,
        req.body.phone   !== undefined ? phoneHash(req.body.phone?.trim()      || null) : contact.phone_hash,
        req.body.email   !== undefined ? (req.body.email?.trim()   || null) : contact.email,
        req.body.address !== undefined ? encryptField(req.body.address?.trim() || null) : contact.address,
        req.body.notes   !== undefined ? (req.body.notes?.trim()   || null) : contact.notes,
        req.body.birthday !== undefined ? (req.body.birthday || null) : contact.birthday,
        nameParts.provided ? nameParts.parts.firstName  : contact.first_name,
        nameParts.provided ? nameParts.parts.lastName   : contact.last_name,
        nameParts.provided ? nameParts.parts.middleName : contact.middle_name,
        nameParts.provided ? nameParts.parts.namePrefix : contact.name_prefix,
        nameParts.provided ? nameParts.parts.nameSuffix : contact.name_suffix,
        req.body.vehiclePlate !== undefined ? encryptField(req.body.vehiclePlate?.trim() || null) : contact.vehicle_plate,
        req.body.school !== undefined ? (req.body.school?.trim() || null) : contact.school,
        req.body.customTags !== undefined ? (req.body.customTags ?? null) : contact.custom_tags,
        req.body.gender !== undefined ? (req.body.gender?.trim() || null) : contact.gender,
        req.body.hometown !== undefined ? (req.body.hometown?.trim() || null) : contact.hometown,
        req.body.wechat !== undefined ? (req.body.wechat?.trim() || null) : contact.wechat,
        req.body.douyin !== undefined ? (req.body.douyin?.trim() || null) : contact.douyin,
        req.body.qq !== undefined ? (req.body.qq?.trim() || null) : contact.qq,
        req.body.contactGroups !== undefined ? (req.body.contactGroups?.trim() || null) : contact.contact_groups,
        req.body.callThem !== undefined ? (req.body.callThem?.trim() || null) : contact.call_them,
        req.body.callMe !== undefined ? (req.body.callMe?.trim() || null) : contact.call_me,
        // R4: 派生字段仅在 patch 含键时写，否则保留 DB 现值。
        lunar.birthdayLunar !== undefined ? lunar.birthdayLunar : contact.birthday_lunar,
        lunar.zodiac        !== undefined ? lunar.zodiac        : contact.zodiac,
        lunar.constellation !== undefined ? lunar.constellation : contact.constellation,
        req.body.spouseNote !== undefined ? (req.body.spouseNote?.trim() || null) : contact.spouse_note,
        req.body.priorityIntro !== undefined ? (req.body.priorityIntro ? 1 : 0) : contact.priority_intro,
        id
      );

      // Replace phones (delete all, insert new). value_e164 additiv mitberechnen
      // (Phase 2), value bleibt der rohe Eingabewert. R3: toE164 在明文上算完后
      // value/value_e164 一并加密写入。
      if (req.body.phones !== undefined && Array.isArray(req.body.phones)) {
        db.get().prepare('DELETE FROM contact_phones WHERE contact_id = ?').run(id);

        const defaultCountry = defaultCountryFromConfig(db.get());
        const insertPhone = db.get().prepare(`
          INSERT INTO contact_phones (contact_id, label, value, is_primary, value_e164)
          VALUES (?, ?, ?, ?, ?)
        `);
        for (const phone of req.body.phones) {
          insertPhone.run(id, phone.label, encryptField(phone.value), phone.isPrimary ? 1 : 0,
                          encryptField(toE164(phone.value, defaultCountry)));
        }
      }

      // Replace emails (delete all, insert new)
      if (req.body.emails !== undefined && Array.isArray(req.body.emails)) {
        db.get().prepare('DELETE FROM contact_emails WHERE contact_id = ?').run(id);

        const insertEmail = db.get().prepare(`
          INSERT INTO contact_emails (contact_id, label, value, is_primary)
          VALUES (?, ?, ?, ?)
        `);
        for (const email of req.body.emails) {
          insertEmail.run(id, email.label, email.value, email.isPrimary ? 1 : 0);
        }
      }

      // Replace addresses (delete all, insert new). R3: street 加密写入。
      if (req.body.addresses !== undefined && Array.isArray(req.body.addresses)) {
        db.get().prepare('DELETE FROM contact_addresses WHERE contact_id = ?').run(id);

        const insertAddress = db.get().prepare(`
          INSERT INTO contact_addresses (contact_id, label, street, city, state, postal_code, country, is_primary)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `);
        for (const address of req.body.addresses) {
          insertAddress.run(
            id,
            address.label,
            encryptField(address.street || null),
            address.city || null,
            address.state || null,
            address.postalCode || null,
            address.country || null,
            address.isPrimary ? 1 : 0
          );
        }
      }
    });

    transaction();

    // Query the updated contact with multi-value fields (R3: 解密回显)
    const updated = db.get().prepare('SELECT * FROM contacts WHERE id = ?').get(id);
    const multiValueFields = loadMultiValueFields(id);

    res.json({
      data: {
        ...presentContact(updated),
        ...multiValueFields
      }
    });
  } catch (err) {
    log.error('', err);
    res.status(500).json({ error: 'Interner Fehler' });
  }
});

/**
 * DELETE /api/v1/contacts/:id
 * Kontakt löschen.
 * Response: 204 No Content
 */
router.delete('/:id', (req, res) => {
  try {
    const id     = parseInt(req.params.id, 10);
    const contact = db.get().prepare('SELECT family_user_id FROM contacts WHERE id = ?').get(id);
    if (!contact) return res.status(404).json({ error: 'Kontakt nicht gefunden', code: 404 });

    if (contact.family_user_id) {
      return res.status(403).json({ error: 'Familienmitglieder können nicht aus der Kontaktliste gelöscht werden.', code: 403 });
    }

    const result = db.get().prepare('DELETE FROM contacts WHERE id = ?').run(id);
    if (result.changes === 0)
      return res.status(404).json({ error: 'Kontakt nicht gefunden', code: 404 });
    res.status(204).end();
  } catch (err) {
    log.error('', err);
    res.status(500).json({ error: 'Interner Fehler' });
  }
});

/**
 * GET /api/v1/contacts/meta
 * Kategorien-Liste für Dropdowns + R4 生肖/星座枚举（单一数据源：lunar-fields.js）。
 * Response: { data: { categories, zodiacs, constellations } }
 */
router.get('/meta', (_req, res) => {
  try {
    res.json({
      data: {
        categories: loadContactCategories(),
        zodiacs: ZODIACS,
        constellations: CONSTELLATIONS,
      },
    });
  } catch (err) {
    log.error('', err);
    res.status(500).json({ error: 'Interner Fehler' });
  }
});

/**
 * GET /api/v1/contacts/:id
 * Einzelnen Kontakt abrufen mit Multi-Value Fields (phones, emails, addresses).
 * R4: 非 admin 不可见（hidden 或 ACL 屏蔽）→ 404（不泄露存在性）。
 * Response: { data: Contact }
 */
router.get('/:id', (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    // R4: 可见性直接叠进 WHERE——过滤掉的联系人与「不存在」同响应（404）。
    const vis = visibilityFilter(req, 'contacts');
    const contact = db.get().prepare(`SELECT * FROM contacts WHERE id = ?${vis.sql}`).get(id, ...vis.params);
    if (!contact) return res.status(404).json({ error: 'Kontakt nicht gefunden', code: 404 });

    // Load multi-value fields (R3: 内部已解密回显)
    const multiValueFields = loadMultiValueFields(id);

    res.json({
      data: {
        ...presentContact(contact),
        ...multiValueFields
      }
    });
  } catch (err) {
    log.error('', err);
    res.status(500).json({ error: 'Interner Fehler' });
  }
});

/**
 * vCard 3.0 Block für einen Kontakt (明文：phone/address 先解密)。
 * 单导出与批量导出共用。
 */
function vcardBlockFor(contact) {
  const phone   = decryptField(contact.phone);
  const address = decryptField(contact.address);

  const esc = (v) => String(v || '').replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/,/g, '\\,').replace(/;/g, '\\;');

  const lines = [
    'BEGIN:VCARD',
    'VERSION:3.0',
    `FN:${esc(contact.name)}`,
    // Strukturierte Komponenten exportieren, wo bekannt (#535); sonst trägt
    // das Familiennamen-Feld weiterhin den Anzeigenamen als Ganzes.
      (contact.first_name || contact.last_name)
        ? `N:${esc(contact.last_name)};${esc(contact.first_name)};${esc(contact.middle_name)};${esc(contact.name_prefix)};${esc(contact.name_suffix)}`
        : `N:${esc(contact.name)};;;;`,
    ];
    if (phone)   lines.push(`TEL;TYPE=VOICE:${esc(phone)}`);
    if (contact.email)   lines.push(`EMAIL:${esc(contact.email)}`);
    if (address) lines.push(`ADR;TYPE=HOME:;;${esc(address)};;;;`);
    if (contact.notes)   lines.push(`NOTE:${esc(contact.notes)}`);
    if (contact.birthday) lines.push(`BDAY:${esc(contact.birthday)}`);
    if (contact.category) lines.push(`CATEGORIES:${esc(contact.category)}`);
    lines.push('END:VCARD');

    return lines.join('\r\n');
}

/**
 * GET /api/v1/contacts/export/vcard?ids=1,2,3
 * 批量导出：多个联系人合并为一个多 vCard 文件（.vcf）。
 * - 带 ids：仅导出所选（不可见的 ID 被静默跳过，与单导出一致）
 * - 不带 ids：导出全部可见联系人（上限 1000，防止超大响应）
 * 与 GET /:id 同样的可见性门。
 */
router.get('/export/vcard', (req, res) => {
  try {
    const vis = visibilityFilter(req, 'contacts');
    const idsParam = (req.query.ids || '').toString().trim();
    let rows;
    if (idsParam) {
      const ids = idsParam
        .split(',')
        .map((s) => parseInt(s.trim(), 10))
        .filter((n) => Number.isFinite(n) && n > 0);
      if (!ids.length) return res.status(400).json({ error: 'Keine gültigen IDs', code: 400 });
      const marks = ids.map(() => '?').join(',');
      rows = db.get().prepare(`SELECT * FROM contacts WHERE id IN (${marks})${vis.sql}`).all(...ids, ...vis.params);
    } else {
      rows = db.get().prepare(`SELECT * FROM contacts WHERE 1=1${vis.sql} LIMIT 1000`).all(...vis.params);
    }
    if (!rows.length) return res.status(404).json({ error: 'Keine Kontakte gefunden', code: 404 });

    const vcf = rows.map(vcardBlockFor).join('\r\n');

    res.setHeader('Content-Type', 'text/vcard; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="contacts-${rows.length}.vcf"`);
    res.send(vcf);
  } catch (err) {
    log.error('', err);
    res.status(500).json({ error: 'Interner Fehler' });
  }
});

/**
 * GET /api/v1/contacts/:id/vcard
 * Kontakt als vCard 3.0 (.vcf) exportieren (Einzelkontakt).
 * R4: 与 GET /:id 同样的可见性门（不可见 → 404）。
 * Response: text/vcard Dateidownload
 */
router.get('/:id/vcard', (req, res) => {
  try {
    const id      = parseInt(req.params.id, 10);
    const vis = visibilityFilter(req, 'contacts');
    const contact = db.get().prepare(`SELECT * FROM contacts WHERE id = ?${vis.sql}`).get(id, ...vis.params);
    if (!contact) return res.status(404).json({ error: 'Kontakt nicht gefunden', code: 404 });

    const vcf      = vcardBlockFor(contact);
    const filename = encodeURIComponent(contact.name.replace(/[^a-zA-Z0-9-_ ]/g, '_')) + '.vcf';

    res.setHeader('Content-Type', 'text/vcard; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(vcf);
  } catch (err) {
    log.error('', err);
    res.status(500).json({ error: 'Interner Fehler' });
  }
});

export default router;
export { validatePhones, validateEmails, validateAddresses };
