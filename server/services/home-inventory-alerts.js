/**
 * Modul: 家庭库存提醒（Home Inventory Alerts）
 * Zweck: 每天把「需要补货 / 临期 / 已过期」聚合成一条提醒，推到既有的
 *        通知通道（站内信箱 + Web Push + E-Mail/Gotify，由 notify-fanout 决定）。
 * Abhängigkeiten: server/db.js, services/notify-fanout.js,
 *                 public/utils/home-inventory-taxonomy.js (isomorph)
 *
 * Warum ein eigener Scheduler: bis v172  waren die Badges nur beim Öffnen der
 * Seite sichtbar — wer nicht nachschaut, erfährt nie, dass das Waschmittel
 * leer ist. Das ist genau die Information, für die ein Vorrat geführt wird.
 *
 * Bewusst EINE Nachricht pro Tag und nicht eine pro Artikel: fünf Push-Nachrichten
 * am Morgen erzieht dazu, alle fünf wegzuwischen.
 */

import * as db from '../db.js';
import { createLogger } from '../logger.js';
import { notifyUsers } from './notify-fanout.js';
import { homeItemStatus, localDateKey } from '../../public/utils/home-inventory-taxonomy.js';

const log = createLogger('HomeInventoryAlerts');

/** Tägliche Prüfung ab dieser lokalen Stunde (vorher schläft das Haus noch). */
const EARLY_HOUR = 8;

// --------------------------------------------------------
// Zustand: "heute schon gemeldet?" — eine Zeile, ein Schlüssel.
// --------------------------------------------------------
function lastRunDay() {
  try {
    const row = db.get()
      .prepare("SELECT value FROM home_inventory_alert_state WHERE key = 'last_run'")
      .get();
    return row?.value ?? null;
  } catch {
    return null;
  }
}

function markRun(dayKey) {
  try {
    db.get().prepare(`
      INSERT INTO home_inventory_alert_state (key, value, updated_at)
      VALUES ('last_run', ?, strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `).run(dayKey);
  } catch (err) {
    log.warn('提醒状态写入失败:', err.message);
  }
}

/**
 * Was ist heute meldenswert?
 * @param {string} [today] YYYY-MM-DD
 * @returns {{ out: object[], low: object[], expired: object[], soon: object[] }}
 */
export function collectAlerts(today = localDateKey()) {
  const rows = db.get().prepare('SELECT * FROM home_inventory_items').all();
  const buckets = { out: [], low: [], expired: [], soon: [] };
  for (const row of rows) {
    const status = homeItemStatus(row, today);
    if (status.out) buckets.out.push(row);
    else if (status.low) buckets.low.push(row);
    if (status.expiry === 'expired') buckets.expired.push(row);
    else if (status.expiry === 'soon') buckets.soon.push(row);
  }
  return buckets;
}

/** Namen für den Nachrichtentext: höchstens drei, sonst "等 N 件". */
function nameList(items, max = 3) {
  const names = [...new Set(items.map((i) => String(i.name).trim()).filter(Boolean))];
  if (names.length <= max) return names.join('、');
  return `${names.slice(0, max).join('、')} 等 ${names.length} 件`;
}

/**
 * Baut Titel/Text aus den Funden. Gibt null zurück, wenn nichts zu melden ist.
 * @param {ReturnType<typeof collectAlerts>} buckets
 */
export function buildMessage(buckets) {
  const parts = [];
  const restock = [...buckets.out, ...buckets.low];
  if (restock.length) parts.push(`${restock.length} 件待补货：${nameList(restock)}`);
  if (buckets.expired.length) parts.push(`${buckets.expired.length} 件已过期：${nameList(buckets.expired)}`);
  if (buckets.soon.length) parts.push(`${buckets.soon.length} 件临期：${nameList(buckets.soon)}`);
  if (!parts.length) return null;

  return {
    title: restock.length
      ? `家庭库存：${restock.length} 件需要补货`
      : `家庭库存：${buckets.expired.length + buckets.soon.length} 件需要留意效期`,
    body: parts.join('\n'),
    link: '/family-inventory',
  };
}

/**
 * Führt die Prüfung aus und stellt die Nachricht zu.
 * @param {{ force?: boolean, now?: Date }} [opts] force = auch ohne Tages-Sperre
 * @returns {Promise<{ skipped: boolean, reason?: string, delivered?: number }>}
 */
export async function runAlerts({ force = false, now = new Date() } = {}) {
  const today = localDateKey(now);
  if (!force && lastRunDay() === today) return { skipped: true, reason: 'already-today' };

  const buckets = collectAlerts(today);
  const message = buildMessage(buckets);
  if (!message) {
    // Nichts zu melden: Tag trotzdem merken, damit nicht jede Stunde neu gerechnet
    // wird. Kein Schreiben von "leeren" Nachrichten ins Postfach.
    if (!force) markRun(today);
    return { skipped: true, reason: 'nothing-to-report' };
  }

  const users = db.get().prepare('SELECT id FROM users').all().map((u) => u.id);
  if (!users.length) return { skipped: true, reason: 'no-users' };

  const result = await notifyUsers({
    userIds: users,
    type: 'home_inventory',
    title: message.title,
    body: message.body,
    link: message.link,
    entityType: 'home_inventory',
    entityId: null,
  });

  if (!force) markRun(today);
  log.info(`库存提醒已发送: ${message.title} (${result.delivered}/${users.length})`);
  return { skipped: false, delivered: result.delivered };
}

/**
 * Startet die tägliche Prüfung: kurz nach dem Start einmal, danach stündlich.
 * Der Stunden-Takt ist kein Spam-Risiko — die Tages-Sperre greift davor —, sondern
 * sorgt dafür, dass ein Container, der um 03:00 neu startet, um 08:00 meldet.
 */
export function startScheduler() {
  const tick = () => {
    const hour = new Date().getHours();
    if (hour < EARLY_HOUR) return;
    runAlerts().catch((err) => log.error('提醒任务失败:', err?.message || err));
  };
  setTimeout(tick, 30_000).unref();
  setInterval(tick, 60 * 60 * 1000).unref();
  log.info(`家庭库存提醒已启用（每天 ${EARLY_HOUR}:00 之后首次触发）。`);
}

export default { collectAlerts, buildMessage, runAlerts, startScheduler };
