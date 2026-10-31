/**
 * Modul: vCard 批量导入解析（server/services/vcard-import.js）
 * Zweck: 把 vCard 3.0/4.0（含 2.1 的 Quoted-Printable 遗产）文本解析成
 *        通用导入管线的「表头 + 数据行」结构 —— 与 CSV/JSON 同一条
 *        preview → mapping → run 通道（services/import-mapping.js）。
 *
 * 与 public/utils/vcard.js 的关系：联系人页的「通讯录导入」（#518）在浏览器
 * 侧用该纯函数版本做选择式导入；本模块是同一套解析逻辑在服务端的平移
 * （Layer-Boundary：服务器不 import 依赖 DOM 形态假设的前端模块，故独立成文；
 * contact-name.js 为已列入服务端共享白名单的同构模块，直接复用）。
 *
 * Abhängigkeiten: public/utils/contact-name.js（纯函数，无 DOM）
 */

import { composeDisplayName, normalizeNameParts } from '../../public/utils/contact-name.js';
import { getImportModule } from './import-mapping.js';

/**
 * Entpackt vCard-Escapes (`\,` `\;` `\\` `\n`/`\N`) in EINEM Durchlauf.
 * Der Single-Pass ist reihenfolge-sicher: sequenzielle `.replace()`-Ketten
 * lösen `\\` erst am Ende auf und können dabei zuvor freigelegte Backslashes
 * falsch weiterverarbeiten. Verhaltensgleich zu
 * server/services/cardav-sync.js#unescapeVCardValue.
 */
function unescapeVCard(s) {
  return String(s || '').replace(/\\([\\,;nN])/g, (_, ch) =>
    (ch === 'n' || ch === 'N') ? '\n' : ch
  );
}

/**
 * Zerlegt einen strukturierten vCard-Wert an *unescapten* Trennzeichen.
 * @param {string} value
 * @param {string} separator - Einzelzeichen (';' oder ',')
 * @returns {string[]}
 */
function splitUnescaped(value, separator) {
  const parts = [];
  let current = '';
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    if (ch === '\\' && i + 1 < value.length) {
      current += ch + value[i + 1];
      i++;
    } else if (ch === separator) {
      parts.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  parts.push(current);
  return parts;
}

/**
 * Erkennt Quoted-Printable-Transfer-Encoding (vCard 2.1) im Parameter-Teil
 * einer Property-Zeile, z. B. `N;CHARSET=UTF-8;ENCODING=QUOTED-PRINTABLE`.
 */
function isQuotedPrintable(params) {
  return /(?:^|;)ENCODING=(?:QUOTED-PRINTABLE|QP)(?:;|$)/i.test(params || '');
}

/**
 * Liest den CHARSET-Parameter einer Property-Zeile (Default 'utf-8').
 */
function charsetOf(params) {
  const m = /(?:^|;)CHARSET=([^;]+)/i.exec(params || '');
  return (m ? m[1].trim() : '') || 'utf-8';
}

/**
 * Dekodiert einen Quoted-Printable-Wert (RFC 2045, vCard 2.1) in Text.
 * Sammelt `=XX`-Oktette (und literale Bytes) und dekodiert die Byte-Folge als
 * `charset` - nur so werden Mehrbyte-Zeichen korrekt. Soft-Line-Breaks
 * (`=` am Zeilenende) werden zuvor entfernt. Unbekanntes Charset faellt auf
 * UTF-8 zurueck.
 */
function decodeQuotedPrintable(value, charset) {
  const joined = String(value == null ? '' : value).replace(/=\r?\n/g, '');
  const bytes = [];
  for (let i = 0; i < joined.length; i++) {
    const ch = joined[i];
    if (ch === '=' && /^[0-9A-Fa-f]{2}$/.test(joined.substr(i + 1, 2))) {
      bytes.push(parseInt(joined.substr(i + 1, 2), 16));
      i += 2;
    } else {
      bytes.push(ch.charCodeAt(0) & 0xff);
    }
  }
  const octets = Uint8Array.from(bytes);
  try {
    return new TextDecoder(charset || 'utf-8').decode(octets);
  } catch {
    return new TextDecoder('utf-8').decode(octets);
  }
}

/**
 * Entfaltet einen vCard-Text: zuerst Quoted-Printable-Soft-Line-Breaks (vCard
 * 2.1) zusammenziehen - nur bei QP-Property-Zeilen, damit Base64-Folding und
 * normale Werte unberuehrt bleiben -, danach regulaeres Folding (RFC 6350 3.2,
 * Folgezeile beginnt mit Space/Tab).
 */
function unfoldVCard(text) {
  const lines = String(text || '').split(/\r?\n/);
  const merged = [];
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];
    const colon = line.indexOf(':');
    const head = colon === -1 ? line : line.slice(0, colon);
    if (isQuotedPrintable(head)) {
      while (/=[ \t]*$/.test(line) && i + 1 < lines.length) {
        line = line.replace(/=[ \t]*$/, '') + lines[i + 1];
        i++;
      }
    }
    merged.push(line);
  }
  return merged.join('\n').replace(/\r?\n[ \t]/g, '');
}

/**
 * Normalisiert einen vCard-BDAY-Wert auf ISO YYYY-MM-DD.
 * Verhalten muss mit dem CardDAV-Sync und dem Frontend-Parser identisch sein,
 * damit contacts.birthday über alle Importquellen hinweg einheitlich ist.
 * @param {string} value - Roher BDAY-Wert (z. B. "1990-01-01", "19900101", "1990")
 * @returns {string|null} ISO-Datum oder null, wenn nicht verwertbar
 */
export function parseBirthdayValue(value) {
  if (!value) return null;

  // Alle Zeichen ausser Ziffern und Bindestrich entfernen (TZ-Suffixe etc.)
  const cleaned = String(value).replace(/[^\d-]/g, '');

  // ISO (YYYY-MM-DD)
  if (/^\d{4}-\d{2}-\d{2}$/.test(cleaned)) return cleaned;

  // Kompakt (YYYYMMDD)
  if (/^\d{8}$/.test(cleaned)) {
    return `${cleaned.slice(0, 4)}-${cleaned.slice(4, 6)}-${cleaned.slice(6, 8)}`;
  }

  // Nur Jahr
  if (/^\d{4}$/.test(cleaned)) return `${cleaned}-01-01`;

  return null;
}

/**
 * Zerlegt einen vCard-Text in einzelne BEGIN:VCARD..END:VCARD-Bloecke.
 * Ohne Markup wird der Gesamttext als eine Karte behandelt.
 * @param {string} text
 * @returns {string[]}
 */
export function splitVCards(text) {
  const src = String(text || '');
  const matches = src.match(/BEGIN:VCARD[\s\S]*?END:VCARD/gi);
  if (matches && matches.length) return matches;
  return src.trim() ? [src] : [];
}

/**
 * Parst eine einzelne vCard in ein import-pipeline-freundliches Record
 * （键与 CONTACT_FIELDS 的 key 一一对应，snake_case）。
 * @param {string} text - Eine vCard (ein BEGIN..END-Block).
 * @param {{ resolveCategory?: (rawCategories: string) => (string|null), fallbackCategory?: string }} [opts]
 * @returns {Record<string, string|null>} 键：name/category/phone/email/address/
 *          notes/birthday/organization/job_title/nickname（缺失为 null）
 */
export function parseVCard(text, opts = {}) {
  const { resolveCategory, fallbackCategory = 'misc' } = opts;

  // Quoted-Printable-Soft-Line-Breaks (vCard 2.1) + Folding (RFC 6350) entfalten.
  const unfolded = unfoldVCard(text);

  // Liefert { params, value } einer Property-Zeile; params ohne fuehrendes ';'.
  const getField = (prop) => {
    const re = new RegExp(`^${prop}(;[^:]*)?:(.*)$`, 'im');
    const m = re.exec(unfolded);
    if (!m) return null;
    return { params: m[1] ? m[1].slice(1) : '', value: m[2].trim() };
  };

  // Rohwert mit aufgeloestem Transfer-Encoding (Quoted-Printable), aber ohne
  // vCard-Escapes. QP wird nur bei deklariertem ENCODING angewandt, damit
  // literale `=` in normalen Werten (URLs, Notizen) unangetastet bleiben.
  const getRaw = (prop) => {
    const f = getField(prop);
    if (!f) return null;
    return isQuotedPrintable(f.params)
      ? decodeQuotedPrintable(f.value, charsetOf(f.params))
      : f.value;
  };

  const get = (prop) => {
    const raw = getRaw(prop);
    return raw === null ? null : unescapeVCard(raw);
  };

  // Strukturierte N-Komponenten erhalten (#535). An *unescapten* Semikola
  // trennen, damit ein maskiertes `\;` innerhalb einer Komponente bleibt.
  const nRaw = getRaw('N');
  const nParts = nRaw ? splitUnescaped(nRaw, ';').map(unescapeVCard) : [];
  const nameParts = normalizeNameParts({
    lastName:   nParts[0],
    firstName:  nParts[1],
    middleName: nParts[2],
    namePrefix: nParts[3],
    nameSuffix: nParts[4],
  });

  // Anzeigename einheitlich aus N; FN nur als Fallback (#535).
  const name = composeDisplayName(nameParts) || get('FN') || null;
  const phone = get('TEL') || null;
  const email = get('EMAIL') || null;

  // ADR: ;;street;city;region;postal;country
  const adrRaw = get('ADR');
  let address = null;
  if (adrRaw) {
    const parts = adrRaw.split(';').map((p) => p.trim()).filter(Boolean);
    address = parts.join(', ') || null;
  }

  // ORG：第一段为公司/组织，其余（部门层级）不进入导入字段。
  const orgRaw = getRaw('ORG');
  let organization = null;
  if (orgRaw) {
    const first = splitUnescaped(orgRaw, ';').map((p) => unescapeVCard(p).trim()).find(Boolean);
    organization = first || null;
  }

  const notes = get('NOTE') || null;
  const birthday = parseBirthdayValue(get('BDAY'));

  // CATEGORIES：逗号分隔的多值属性——取第一个非空段作为分类值。
  const catRaw = get('CATEGORIES') || '';
  const firstCategory = catRaw.split(',').map((p) => p.trim()).find(Boolean) || '';
  const category = (resolveCategory && resolveCategory(catRaw)) || firstCategory || fallbackCategory;

  return {
    name,
    category,
    phone,
    email,
    address,
    notes,
    birthday,
    organization,
    job_title: get('TITLE') || null,
    nickname: get('NICKNAME') || null,
  };
}

/**
 * Parst alle Kontakte einer (moeglicherweise mehrfachen) vCard-Datei.
 * @param {string} text
 * @param {Parameters<typeof parseVCard>[1]} [opts]
 * @returns {ReturnType<typeof parseVCard>[]}
 */
export function parseVCards(text, opts = {}) {
  return splitVCards(text).map((card) => parseVCard(card, opts));
}

/**
 * vCard 文本 → 通用导入管线表格。
 *
 * 表头恒为 contacts 模块的 CONTACT_FIELDS key（import-mapping.js 单一数据源），
 * 因此 autoMapHeaders 对每个表头 1:1 命中，用户在预览页无需手动重排列。
 * 行内缺失字段为空串（与 CSV 提取行为一致）。
 *
 * @param {string} text vCard 文件内容（可含多张卡）
 * @param {{ resolveCategory?: (rawCategories: string) => (string|null), fallbackCategory?: string }} [opts]
 * @returns {{ headers: string[], rows: string[][] }}
 */
export function vcardToContactTable(text, opts = {}) {
  const module = getImportModule('contacts');
  const headers = module
    ? module.fields.map((field) => field.key)
    : ['name', 'category', 'phone', 'email', 'address', 'notes', 'birthday', 'organization', 'job_title', 'nickname'];

  const cards = parseVCards(text, opts);
  const rows = cards.map((card) => headers.map((key) => {
    const value = card[key];
    return value === null || value === undefined ? '' : String(value);
  }));

  return { headers, rows };
}
