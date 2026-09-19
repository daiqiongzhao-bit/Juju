/**
 * Modul: In-App-Benachrichtigungen (Postfach)
 * Zweck: Liefert die ueber notify-fanout geschriebenen In-App-Meldungen
 *   fuer den angemeldeten Nutzer zurueck (Liste, Ungelesen-Zaehler, Lesen).
 * Bewusst ein eigener Router: routes/notifications.js ist komplett Admin-only.
 *
 * Abhaengigkeiten: express, services/notify-fanout.js
 */
import express from 'express';
import { createLogger } from '../logger.js';
import { listInApp, unreadCount, markRead } from '../services/notify-fanout.js';

const log = createLogger('InAppNotifications');
const router = express.Router();

const uid = (req) => req.authUserId ?? req.user?.id ?? req.user?.uid ?? req.session?.userId ?? 0;

// GET /api/v1/in-app-notifications?limit=30&unreadOnly=1
router.get('/', (req, res) => {
  try {
    const me = uid(req);
    if (!me) return res.status(401).json({ error: 'Nicht angemeldet', code: 401 });
    const limit = parseInt(req.query.limit, 10) || 30;
    const unreadOnly = ['1', 'true', 'yes'].includes(String(req.query.unreadOnly || '').toLowerCase());
    res.json({ data: listInApp(me, { limit, unreadOnly }) });
  } catch (err) {
    log.error('GET /', err);
    res.status(500).json({ error: 'Interner Fehler', code: 500 });
  }
});

// GET /api/v1/in-app-notifications/unread-count
router.get('/unread-count', (req, res) => {
  try {
    const me = uid(req);
    if (!me) return res.status(401).json({ error: 'Nicht angemeldet', code: 401 });
    res.json({ data: { count: unreadCount(me) } });
  } catch (err) {
    log.error('GET /unread-count', err);
    res.status(500).json({ error: 'Interner Fehler', code: 500 });
  }
});

// POST /api/v1/in-app-notifications/read  { id?: number }  (ohne id = alles lesen)
router.post('/read', (req, res) => {
  try {
    const me = uid(req);
    if (!me) return res.status(401).json({ error: 'Nicht angemeldet', code: 401 });
    const id = req.body?.id != null ? parseInt(req.body.id, 10) : null;
    const ok = markRead(me, Number.isInteger(id) ? id : null);
    res.json({ data: { ok } });
  } catch (err) {
    log.error('POST /read', err);
    res.status(500).json({ error: 'Interner Fehler', code: 500 });
  }
});

export default router;
