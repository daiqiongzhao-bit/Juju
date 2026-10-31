/**
 * Modul: Lizenz-Aktivierung (License key activation).
 *
 * Endpunkte (alles unter /api/v1/license):
 *   GET  /status   → aktueller Lizenzstatus (community / enforced / expired)
 *   POST /activate → Key aktivieren (admin + csrf)
 *
 * Die eigentliche Durchsetzung (402 bei nicht lizenziert) liegt im Guard-
 * Middleware in server/index.js — hier nur Status + Aktivierung.
 */

import express from 'express';
import { requireAuth, requireAdmin } from '../auth.js';
import { csrfMiddleware } from '../middleware/csrf.js';
import * as license from '../services/license.js';

const router = express.Router();

router.get('/status', async (_req, res) => {
  try {
    res.json(await license.status());
  } catch (err) {
    res.status(500).json({ error: 'Internal error.', code: 500 });
  }
});

router.post('/activate', requireAuth, requireAdmin, csrfMiddleware, async (req, res) => {
  try {
    const r = await license.activate(req.body?.key);
    if (!r.ok) {
      const http = r.code === 'no-enforcement' || r.code === 'empty' ? 400 : 422;
      return res.status(http).json({ error: r.message, code: r.code });
    }
    res.json({ ok: true, payload: r.payload });
  } catch (err) {
    res.status(500).json({ error: 'Internal error.', code: 500 });
  }
});

export { router };
