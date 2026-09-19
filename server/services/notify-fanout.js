/**
 * Notify-Fanout — schreibt In-App-Benachrichtigungen und verteilt sie
 * best-effort an die BESTEHENDEN Kanäle (Web-Push, E-Mail, Gotify/ntfy).
 *
 * Es werden keine neuen Provider erfunden: verwendet werden pushService,
 * emailService und der Channel-Store aus services/notifications.js.
 * Fehler in einzelnen Kanälen dürfen den auslösenden Request nie brechen.
 */
import * as db from '../db.js';
import { createLogger } from '../logger.js';
import { pushService } from './push.js';
import { emailService } from './email.js';
import { notificationService } from './notifications.js';

const log = createLogger('NotifyFanout');

function userEmail(userId) {
  try {
    const row = db.get().prepare('SELECT email FROM users WHERE id = ?').get(userId);
    return row?.email || null;
  } catch {
    return null;
  }
}

export function actorName(userId) {
  try {
    const row = db.get()
      .prepare("SELECT COALESCE(display_name, username, '?') AS name FROM users WHERE id = ?")
      .get(userId);
    return row?.name || 'Jemand';
  } catch {
    return 'Jemand';
  }
}

/**
 * Benachrichtigt mehrere Nutzer.
 * @returns {Promise<{delivered:number, targets:number[]}>}
 */
export async function notifyUsers({
  userIds = [],
  type = 'system',
  title,
  body = '',
  link = null,
  entityType = null,
  entityId = null,
  actorId = null,
  skipUserIds = [],
} = {}) {
  const targets = [...new Set((userIds || []).map(Number).filter(Number.isFinite))]
    .filter((id) => !skipUserIds.map(Number).includes(id));
  if (!targets.length || !title) return { delivered: 0, targets: [] };

  let delivered = 0;
  try {
    const insert = db.get().prepare(`
      INSERT INTO in_app_notifications
        (user_id, type, title, body, link, entity_type, entity_id, actor_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const userId of targets) {
      try {
        insert.run(userId, type, title, body || null, link || null, entityType || null, entityId ?? null, actorId ?? null);
        delivered += 1;
      } catch (err) {
        log.error('in_app insert failed for user', userId, err?.message);
      }
    }
  } catch (err) {
    log.error('in_app table unavailable', err?.message);
  }

  const payload = {
    title,
    body: body || '',
    url: link || '/',
    tag: type,
    data: { type, entityType, entityId },
  };

  await Promise.all(targets.map(async (userId) => {
    try {
      await pushService.sendPushToUser(userId, payload);
    } catch (err) {
      log.warn('push failed', userId, err?.message);
    }

    try {
      const channels = notificationService?.channelStore?.listEnabledChannelsForUser?.(userId) || [];
      for (const ch of channels) {
        try {
          const provider = notificationService?.providers?.[ch?.provider];
          if (provider?.send) await provider.send(ch, { title, message: body || '', url: link });
        } catch (err) {
          log.warn('channel send failed', ch?.provider, err?.message);
        }
      }
    } catch (err) {
      log.warn('channel lookup failed', userId, err?.message);
    }

    try {
      if (emailService?.isConfigured?.()) {
        const to = userEmail(userId);
        if (to) {
          await emailService.sendMail({
            to,
            subject: title,
            text: body || '',
            html: `<p>${String(body || '').replace(/[<>&]/g, '')}</p>`,
          });
        }
      }
    } catch (err) {
      log.warn('email failed', userId, err?.message);
    }
  }));

  return { delivered, targets };
}

export function listInApp(userId, { limit = 30, unreadOnly = false } = {}) {
  try {
    const max = Math.min(Math.max(parseInt(limit, 10) || 30, 1), 100);
    const sql = `
      SELECT * FROM in_app_notifications
      WHERE user_id = ?${unreadOnly ? ' AND read_at IS NULL' : ''}
      ORDER BY created_at DESC, id DESC
      LIMIT ?
    `;
    return db.get().prepare(sql).all(userId, max);
  } catch (err) {
    log.error('listInApp failed', err?.message);
    return [];
  }
}

export function unreadCount(userId) {
  try {
    const row = db.get()
      .prepare('SELECT COUNT(*) AS n FROM in_app_notifications WHERE user_id = ? AND read_at IS NULL')
      .get(userId);
    return row?.n || 0;
  } catch {
    return 0;
  }
}

export function markRead(userId, id = null) {
  try {
    if (id) {
      db.get()
        .prepare("UPDATE in_app_notifications SET read_at = strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE user_id = ? AND id = ?")
        .run(userId, id);
    } else {
      db.get()
        .prepare("UPDATE in_app_notifications SET read_at = strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE user_id = ? AND read_at IS NULL")
        .run(userId);
    }
    return true;
  } catch (err) {
    log.error('markRead failed', err?.message);
    return false;
  }
}

export default { notifyUsers, listInApp, unreadCount, markRead, actorName };
