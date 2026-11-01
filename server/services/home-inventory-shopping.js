/**
 * Modul: 家庭库存 ↔ 购物清单 回写（Home Inventory ↔ Shopping）
 * Zweck: Wird ein aus dem Vorrat übertragener Einkaufsartikel abgehakt, wächst
 *        der Bestand des verknüpften Batches wieder — der Kauf soll nicht
 *        zweimal eingetragen werden müssen (einmal auf dem Zettel, einmal im
 *        Vorrat).
 * Abhängigkeiten: server/db.js
 *
 * Bewusst hier und nicht im Home-Inventory-Router: ausgelöst wird die Buchung
 * im Shopping-Modul (PATCH /shopping/items/:id). Eine Abhängigkeit von
 * shopping.js auf home-inventory.js wäre die falsche Richtung — beide Module
 * bleiben über diese schmale Funktion verbunden.
 */

import * as db from '../db.js';
import { createLogger } from '../logger.js';

const log = createLogger('HomeInventoryShopping');

/** Menge aus dem Freitext der Einkaufsliste lesen ("2", "2 瓶", "1,5 kg"). */
export function parseShoppingQuantity(text) {
  const match = String(text ?? '').match(/(\d+(?:[.,]\d+)?)/);
  if (!match) return 1;
  const value = Number(match[1].replace(',', '.'));
  return Number.isFinite(value) && value > 0 ? Math.min(value, 999) : 1;
}

/**
 * Bucht einen abgehakten Einkaufsartikel in den verknüpften Vorrat.
 * Idempotent insofern, als nur der Übergang offen → abgehakt bucht (der
 * Aufrufer prüft das); mehrfaches Speichern eines bereits abgehakten Artikels
 * erhöht den Bestand nicht erneut.
 *
 * @param {number} shoppingItemId
 * @param {number|null} [userId]
 * @returns {{ itemId: number, quantity: number, added: number }|null}
 *          null, wenn keine Verknüpfung (mehr) besteht
 */
export function restockFromShopping(shoppingItemId, userId = null) {
  try {
    const row = db.get().prepare(`
      SELECT id, name, quantity, home_inventory_item_id
        FROM shopping_items WHERE id = ?
    `).get(shoppingItemId);
    if (!row?.home_inventory_item_id) return null;

    const target = db.get().prepare(`
      SELECT id, name, quantity FROM home_inventory_items WHERE id = ?
    `).get(row.home_inventory_item_id);
    if (!target) {
      // Der Batch wurde inzwischen gelöscht — die Verknüpfung ist dann nur noch
      // ein toter Verweis und darf das Abhaken nicht stören.
      return null;
    }

    const added = parseShoppingQuantity(row.quantity);
    const next = Math.round(((Number(target.quantity) || 0) + added) * 100) / 100;

    db.get().transaction(() => {
      db.get().prepare(`
        UPDATE home_inventory_items
           SET quantity = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
         WHERE id = ?
      `).run(next, target.id);
      db.get().prepare(`
        INSERT INTO home_inventory_logs (item_id, item_name, delta, quantity_after, reason, user_id)
        VALUES (?, ?, ?, ?, 'shopping', ?)
      `).run(target.id, target.name, added, next, userId ?? null);
    })();

    return { itemId: target.id, quantity: next, added };
  } catch (err) {
    // Nie den Einkauf scheitern lassen, weil der Vorrat klemmt.
    log.warn('Rückbuchung aus der Einkaufsliste fehlgeschlagen:', err.message);
    return null;
  }
}

export default { restockFromShopping, parseShoppingQuantity };
