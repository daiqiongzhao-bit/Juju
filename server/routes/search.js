/**
 * Modul: Globale Suche (Search)
 * Zweck: Volltext-Suche über Aufgaben, Kalender-Events, Notizen, Kontakte,
 *        Einkaufsartikel sowie Gesundheits-Medikamente und -Aktivitäten.
 *        Nutzt den FTS5-Index `search_index` (Migration 44/66) statt LIKE '%q%'-Scans.
 * Abhängigkeiten: express, server/db.js, server/services/search.js
 */

import express from 'express';
import * as db from '../db.js';
import { runSearch } from '../services/search.js';

const router = express.Router();

/**
 * GET /api/v1/search?q=<query>
 * Durchsucht Aufgaben, Kalender-Events, Notizen, Kontakte, Einkaufsartikel,
 * Gesundheits-Medikamente und -Aktivitäten (Health: nur eigene oder family-sichtbare Zeilen).
 * Response: { tasks, events, notes, contacts, items, meds, activities }
 */
router.get('/', (req, res) => {
  try {
    const q = String(req.query.q ?? '').trim();
    if (q.length < 2) return res.json({ tasks: [], events: [], notes: [], contacts: [], items: [], meds: [], activities: [] });

    const userId = req.authUserId || req.session.userId;
    res.json(runSearch(db.get(), q, userId));
  } catch (err) {
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});

export default router;
