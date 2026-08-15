import express from 'express';
import { createLogger } from '../logger.js';
import * as db from '../db.js';
import { collectErrors, date as validateDate, str, MAX_SHORT, MAX_TEXT, MAX_TITLE } from '../middleware/validate.js';
import {
  deleteAnniversaryArtifacts,
  hydrateAnniversary,
  syncAnniversaryArtifacts,
  syncAllAnniversaryReminders,
} from '../services/anniversaries.js';

const log = createLogger('Relationships');
const router = express.Router();
const MAX_PHOTO_LENGTH = 6_990_507; // ~5 MB raw image in base64
const PHOTO_RE = /^data:image\/(png|jpeg|jpg|webp|gif);base64,[A-Za-z0-9+/=]+$/;
const RELATION_TYPES = ['knows', 'family', 'friend', 'partner', 'colleague', 'neighbor', 'acquaintance', 'met-through'];
const INTERACTION_TYPES = ['note', 'call', 'meeting', 'message', 'gift', 'other'];

function validatePhotoData(val) {
  if (val === undefined) return { value: undefined, error: null };
  if (val === null || val === '') return { value: null, error: null };
  const s = String(val).trim();
  if (s.length > MAX_PHOTO_LENGTH) return { value: null, error: 'Profile picture is too large.' };
  if (!PHOTO_RE.test(s)) return { value: null, error: 'Profile picture must be a valid image data URL.' };
  return { value: s, error: null };
}

function userId(req) {
  return req.authUserId || req.session.userId;
}

function loadEdge(id) {
  return db.get().prepare('SELECT * FROM contact_relationships WHERE id = ?').get(id);
}

function contactExists(contactId) {
  return !!db.get().prepare('SELECT 1 FROM contacts WHERE id = ?').get(contactId);
}

function loadAnniversary(id) {
  return db.get().prepare('SELECT * FROM anniversaries WHERE id = ?').get(id);
}

function loadInteraction(id) {
  return db.get().prepare('SELECT * FROM contact_interactions WHERE id = ?').get(id);
}

// --------------------------------------------------------
// Metadaten (Foto-Limits, erlaubte Werte)
// --------------------------------------------------------
router.get('/meta/options', (_req, res) => {
  res.json({
    data: {
      photoMaxBytes: MAX_PHOTO_LENGTH,
      acceptedImageTypes: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'],
      relationTypes: RELATION_TYPES,
      interactionTypes: INTERACTION_TYPES,
    },
  });
});

// --------------------------------------------------------
// Beziehungskanten (Edges)
// --------------------------------------------------------
router.get('/', (req, res) => {
  try {
    const params = [];
    let sql = `
      SELECT r.*,
             a.name AS name_a, a.photo AS photo_a, a.relationship_type AS relationship_type_a,
             b.name AS name_b, b.photo AS photo_b, b.relationship_type AS relationship_type_b
      FROM contact_relationships r
      JOIN contacts a ON a.id = r.contact_a
      JOIN contacts b ON b.id = r.contact_b
      WHERE 1=1
    `;
    if (req.query.contactId) {
      sql += ' AND (r.contact_a = ? OR r.contact_b = ?)';
      params.push(req.query.contactId, req.query.contactId);
    }
    sql += ' ORDER BY r.created_at DESC';
    const rows = db.get().prepare(sql).all(...params);
    res.json({ data: rows });
  } catch (err) {
    log.error('GET / error:', err);
    res.status(500).json({ error: 'Internal error.', code: 500 });
  }
});

router.post('/', (req, res) => {
  try {
    const va = str(req.body.contact_a, 'Contact A', { max: MAX_TITLE });
    const vb = str(req.body.contact_b, 'Contact B', { max: MAX_TITLE });
    const vType = str(req.body.relation_type, 'Relation type', { max: MAX_SHORT, required: false });
    const vNote = str(req.body.note, 'Note', { max: MAX_TEXT, required: false });
    const errors = collectErrors([va, vb, vType, vNote]);
    if (errors.length) return res.status(400).json({ error: errors.join(' '), code: 400 });

    const idA = parseInt(va.value, 10);
    const idB = parseInt(vb.value, 10);
    if (!Number.isInteger(idA) || !Number.isInteger(idB)) {
      return res.status(400).json({ error: 'contact_a and contact_b must be numeric IDs.', code: 400 });
    }
    if (idA === idB) {
      return res.status(400).json({ error: 'A contact cannot be related to itself.', code: 400 });
    }
    if (!contactExists(idA) || !contactExists(idB)) {
      return res.status(404).json({ error: 'One or both contacts do not exist.', code: 404 });
    }

    // Richtungsunabhängig speichern: kleinere ID zuerst.
    const [contact_a, contact_b] = idA < idB ? [idA, idB] : [idB, idA];
    const relation_type = vType.value || 'knows';

    const existing = db.get().prepare(
      'SELECT id FROM contact_relationships WHERE contact_a = ? AND contact_b = ? AND relation_type = ?'
    ).get(contact_a, contact_b, relation_type);
    if (existing) {
      return res.status(409).json({ error: 'This relationship already exists.', code: 409 });
    }

    const result = db.get().prepare(`
      INSERT INTO contact_relationships (contact_a, contact_b, relation_type, note, created_by)
      VALUES (?, ?, ?, ?, ?)
    `).run(contact_a, contact_b, relation_type, vNote.value ?? null, userId(req));

    res.status(201).json({ data: loadEdge(result.lastInsertRowid) });
  } catch (err) {
    log.error('POST / error:', err);
    res.status(500).json({ error: 'Internal error.', code: 500 });
  }
});

router.put('/:id', (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const existing = loadEdge(id);
    if (!existing) return res.status(404).json({ error: 'Relationship not found.', code: 404 });

    const checks = [];
    if (req.body.relation_type !== undefined) checks.push(str(req.body.relation_type, 'Relation type', { max: MAX_SHORT, required: false }));
    if (req.body.note !== undefined) checks.push(str(req.body.note, 'Note', { max: MAX_TEXT, required: false }));
    const errors = collectErrors(checks);
    if (errors.length) return res.status(400).json({ error: errors.join(' '), code: 400 });

    const relation_type = req.body.relation_type !== undefined ? (req.body.relation_type?.trim() || existing.relation_type) : existing.relation_type;
    const note = req.body.note !== undefined ? (req.body.note?.trim() || null) : existing.note;

    db.get().prepare(`
      UPDATE contact_relationships
      SET relation_type = ?, note = ?
      WHERE id = ?
    `).run(relation_type, note, id);

    res.json({ data: loadEdge(id) });
  } catch (err) {
    log.error('PUT /:id error:', err);
    res.status(500).json({ error: 'Internal error.', code: 500 });
  }
});

router.delete('/:id', (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const existing = loadEdge(id);
    if (!existing) return res.status(404).json({ error: 'Relationship not found.', code: 404 });
    db.get().prepare('DELETE FROM contact_relationships WHERE id = ?').run(id);
    res.status(204).end();
  } catch (err) {
    log.error('DELETE /:id error:', err);
    res.status(500).json({ error: 'Internal error.', code: 500 });
  }
});

// --------------------------------------------------------
// Netzwerk-Graph (Knoten + Kanten)
// --------------------------------------------------------
router.get('/graph', (req, res) => {
  try {
    const edges = db.get().prepare(`
      SELECT r.id, r.contact_a, r.contact_b, r.relation_type, r.note,
             a.name AS name_a, b.name AS name_b,
             a.photo AS photo_a, b.photo AS photo_b
      FROM contact_relationships r
      JOIN contacts a ON a.id = r.contact_a
      JOIN contacts b ON b.id = r.contact_b
    `).all();

    const nodeIds = new Set();
    for (const e of edges) {
      nodeIds.add(e.contact_a);
      nodeIds.add(e.contact_b);
    }

    let nodes = [];
    if (nodeIds.size > 0) {
      const placeholders = Array.from(nodeIds, () => '?').join(',');
      nodes = db.get().prepare(`
        SELECT id, name, photo, relationship_type, category
        FROM contacts
        WHERE id IN (${placeholders})
        ORDER BY name COLLATE NOCASE ASC
      `).all(...nodeIds);
    }

    const degree = new Map();
    for (const e of edges) {
      degree.set(e.contact_a, (degree.get(e.contact_a) || 0) + 1);
      degree.set(e.contact_b, (degree.get(e.contact_b) || 0) + 1);
    }
    nodes = nodes.map((n) => ({ ...n, degree: degree.get(n.id) || 0 }));

    res.json({ data: { nodes, edges } });
  } catch (err) {
    log.error('GET /graph error:', err);
    res.status(500).json({ error: 'Internal error.', code: 500 });
  }
});

// --------------------------------------------------------
// Gemeinsame Kontakte (für jede Kante: wer kennt BEIDE Endpunkte?)
// --------------------------------------------------------
router.get('/common', (req, res) => {
  try {
    const focusId = req.query.contactId ? parseInt(req.query.contactId, 10) : null;
    const edges = db.get().prepare(`
      SELECT contact_a, contact_b FROM contact_relationships
    `).all();

    // Adjazenzliste (ungerichtet)
    const adj = new Map();
    const addEdge = (x, y) => {
      if (!adj.has(x)) adj.set(x, new Set());
      adj.get(x).add(y);
    };
    for (const e of edges) {
      addEdge(e.contact_a, e.contact_b);
      addEdge(e.contact_b, e.contact_a);
    }

    const nameOf = (id) => {
      const c = db.get().prepare('SELECT id, name, photo, relationship_type FROM contacts WHERE id = ?').get(id);
      return c || { id, name: '?', photo: null, relationship_type: null };
    };

    const results = [];
    const seen = new Set();
    for (const e of edges) {
      if (focusId && e.contact_a !== focusId && e.contact_b !== focusId) continue;
      const key = e.contact_a < e.contact_b ? `${e.contact_a}-${e.contact_b}` : `${e.contact_b}-${e.contact_a}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const na = adj.get(e.contact_a) || new Set();
      const nb = adj.get(e.contact_b) || new Set();
      const shared = [...na].filter((x) => nb.has(x) && x !== e.contact_a && x !== e.contact_b)
        .map((x) => nameOf(x));

      results.push({
        contactA: nameOf(e.contact_a),
        contactB: nameOf(e.contact_b),
        shared: shared.map((s) => ({ id: s.id, name: s.name, photo: s.photo, relationship_type: s.relationship_type })),
      });
    }

    res.json({ data: results });
  } catch (err) {
    log.error('GET /common error:', err);
    res.status(500).json({ error: 'Internal error.', code: 500 });
  }
});

// --------------------------------------------------------
// Beziehungsbaum (hierarchische Ansicht gemeinsamer Kontakte)
// --------------------------------------------------------
router.get('/tree', (req, res) => {
  try {
    let sourceIds = [];
    if (req.query.sourceIds) {
      sourceIds = String(req.query.sourceIds)
        .split(',')
        .map((s) => parseInt(s.trim(), 10))
        .filter((n) => Number.isInteger(n) && n > 0);
    }

    const allEdges = db.get().prepare(`
      SELECT r.contact_a, r.contact_b, r.relation_type,
             a.name AS name_a, b.name AS name_b,
             a.photo AS photo_a, b.photo AS photo_b,
             a.relationship_type AS rt_a, b.relationship_type AS rt_b
      FROM contact_relationships r
      JOIN contacts a ON a.id = r.contact_a
      JOIN contacts b ON b.id = r.contact_b
    `).all();

    // Falls keine Quellen angegeben, automatisch alle Kontakte mit Kanten wählen.
    if (!sourceIds.length && allEdges.length) {
      const touched = new Set();
      for (const e of allEdges) {
        touched.add(e.contact_a);
        touched.add(e.contact_b);
      }
      sourceIds = [...touched].slice(0, 12);
    }

    // Kontakt-Metadaten auflösen
    const contactMap = new Map();
    const loadContact = (id) => {
      if (contactMap.has(id)) return contactMap.get(id);
      const c = db.get().prepare('SELECT id, name, photo, relationship_type FROM contacts WHERE id = ?').get(id);
      const resolved = c || { id, name: '?', photo: null, relationship_type: null };
      contactMap.set(id, resolved);
      return resolved;
    };

    // Adjazenzliste inkl. Beziehungstyp (ungerichtet)
    const adj = new Map();
    for (const e of allEdges) {
      const push = (from, to, type) => {
        if (!adj.has(from)) adj.set(from, []);
        adj.get(from).push({ contactId: to, relation_type: type });
      };
      push(e.contact_a, e.contact_b, e.relation_type);
      push(e.contact_b, e.contact_a, e.relation_type);
    }

    const sources = sourceIds.map((id) => loadContact(id));

    // Äste: pro Quellkontakt dessen direkte Verbindungen
    const branches = sources.map((s) => {
      const connections = (adj.get(s.id) || [])
        .map((conn) => {
          const c = loadContact(conn.contactId);
          return {
            contactId: c.id,
            name: c.name,
            photo: c.photo,
            relationship_type: c.relationship_type,
            relation_type: conn.relation_type,
          };
        })
        .sort((a, b) => String(a.name).localeCompare(b.name));
      return {
        sourceId: s.id,
        sourceName: s.name,
        sourcePhoto: s.photo,
        sourceRelationshipType: s.relationship_type,
        connections,
      };
    });

    // Häufigkeit: wie viele ausgewählte Quellen kennen diesen Kontakt?
    const freq = new Map();
    for (const b of branches) {
      for (const c of b.connections) {
        freq.set(c.contactId, (freq.get(c.contactId) || 0) + 1);
      }
    }

    const shared = [];
    const commonToAll = [];
    for (const [contactId, count] of freq.entries()) {
      if (count < 2) continue;
      const c = loadContact(contactId);
      const sourceIdsForContact = branches
        .filter((b) => b.connections.some((conn) => conn.contactId === contactId))
        .map((b) => b.sourceId);
      const entry = {
        contactId: c.id,
        name: c.name,
        photo: c.photo,
        relationship_type: c.relationship_type,
        sourceCount: count,
        sourceIds: sourceIdsForContact,
      };
      shared.push(entry);
      if (count === sources.length && sources.length > 1) {
        commonToAll.push(entry);
      }
    }

    // Alphabetisch sortieren
    const sortByName = (a, b) => String(a.name).localeCompare(b.name);
    shared.sort(sortByName);
    commonToAll.sort(sortByName);

    res.json({
      data: {
        sources,
        branches,
        shared,
        commonToAll,
      },
    });
  } catch (err) {
    log.error('GET /tree error:', err);
    res.status(500).json({ error: 'Internal error.', code: 500 });
  }
});

// --------------------------------------------------------
// Interaktionen (Zeitstrahl)
// --------------------------------------------------------
router.get('/interactions', (req, res) => {
  try {
    const params = [];
    let sql = `
      SELECT i.*, c.name AS contact_name, c.photo AS contact_photo
      FROM contact_interactions i
      JOIN contacts c ON c.id = i.contact_id
      WHERE 1=1
    `;
    if (req.query.contactId) {
      sql += ' AND i.contact_id = ?';
      params.push(req.query.contactId);
    }
    if (req.query.q) {
      sql += ' AND (i.note LIKE ? OR c.name LIKE ?)';
      params.push(`%${String(req.query.q).trim()}%`, `%${String(req.query.q).trim()}%`);
    }
    sql += ' ORDER BY i.occurred_at DESC, i.created_at DESC';
    const rows = db.get().prepare(sql).all(...params);
    res.json({ data: rows });
  } catch (err) {
    log.error('GET /interactions error:', err);
    res.status(500).json({ error: 'Internal error.', code: 500 });
  }
});

router.post('/interactions', (req, res) => {
  try {
    const vContact = str(req.body.contact_id, 'Contact', { max: MAX_TITLE });
    const vType = str(req.body.type, 'Type', { max: MAX_SHORT, required: false });
    const vNote = str(req.body.note, 'Note', { max: MAX_TEXT, required: false });
    const vOccurred = validateDate(req.body.occurred_at, 'Occurred at', true);
    const errors = collectErrors([vContact, vType, vNote, vOccurred]);
    if (errors.length) return res.status(400).json({ error: errors.join(' '), code: 400 });

    const contactId = parseInt(vContact.value, 10);
    if (!contactExists(contactId)) {
      return res.status(404).json({ error: 'Contact does not exist.', code: 404 });
    }

    const result = db.get().prepare(`
      INSERT INTO contact_interactions (contact_id, type, note, occurred_at, created_by)
      VALUES (?, ?, ?, ?, ?)
    `).run(contactId, vType.value || 'note', vNote.value ?? null, vOccurred.value, userId(req));

    res.status(201).json({ data: loadInteraction(result.lastInsertRowid) });
  } catch (err) {
    log.error('POST /interactions error:', err);
    res.status(500).json({ error: 'Internal error.', code: 500 });
  }
});

router.delete('/interactions/:id', (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const existing = loadInteraction(id);
    if (!existing) return res.status(404).json({ error: 'Interaction not found.', code: 404 });
    db.get().prepare('DELETE FROM contact_interactions WHERE id = ?').run(id);
    res.status(204).end();
  } catch (err) {
    log.error('DELETE /interactions/:id error:', err);
    res.status(500).json({ error: 'Internal error.', code: 500 });
  }
});

// --------------------------------------------------------
// Jahrestage (mit Kalender-/Reminder-Artefakten)
// --------------------------------------------------------
router.get('/anniversaries', (req, res) => {
  try {
    const uid = userId(req);
    syncAllAnniversaryReminders(db.get(), uid);
    const rows = db.get().prepare(`
      SELECT a.*, c.name AS contact_name, c.photo AS contact_photo
      FROM anniversaries a
      JOIN contacts c ON c.id = a.contact_id
      ORDER BY a.anniversary_date ASC
    `).all();
    res.json({ data: rows.map((r) => hydrateAnniversary(r)) });
  } catch (err) {
    log.error('GET /anniversaries error:', err);
    res.status(500).json({ error: 'Internal error.', code: 500 });
  }
});

router.post('/anniversaries', (req, res) => {
  try {
    const vContact = str(req.body.contact_id, 'Contact', { max: MAX_TITLE });
    const vTitle = str(req.body.title, 'Title', { max: MAX_TITLE });
    const vDate = str(req.body.anniversary_date, 'Date', { max: MAX_SHORT });
    const vNotes = str(req.body.notes, 'Notes', { max: MAX_TEXT, required: false });
    const errors = collectErrors([vContact, vTitle, vDate, vNotes]);
    if (errors.length) return res.status(400).json({ error: errors.join(' '), code: 400 });

    // anniversary_date muss MM-DD sein.
    if (!/^\d{2}-\d{2}$/.test(vDate.value)) {
      return res.status(400).json({ error: 'anniversary_date must be in MM-DD format.', code: 400 });
    }

    const contactId = parseInt(vContact.value, 10);
    if (!contactExists(contactId)) {
      return res.status(404).json({ error: 'Contact does not exist.', code: 404 });
    }

    const result = db.get().prepare(`
      INSERT INTO anniversaries
        (contact_id, title, anniversary_date, notes, reminder_offset, reminder_custom_amount, reminder_custom_unit, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      contactId,
      vTitle.value,
      vDate.value,
      vNotes.value ?? null,
      req.body.reminder_offset ?? '',
      req.body.reminder_custom_amount ?? null,
      req.body.reminder_custom_unit ?? null,
      userId(req),
    );

    const anniversary = loadAnniversary(result.lastInsertRowid);
    db.transaction(() => syncAnniversaryArtifacts(db.get(), anniversary));
    res.status(201).json({ data: hydrateAnniversary(loadAnniversary(anniversary.id)) });
  } catch (err) {
    log.error('POST /anniversaries error:', err);
    res.status(500).json({ error: 'Internal error.', code: 500 });
  }
});

router.put('/anniversaries/:id', (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const existing = loadAnniversary(id);
    if (!existing) return res.status(404).json({ error: 'Anniversary not found.', code: 404 });

    const checks = [];
    if (req.body.title !== undefined) checks.push(str(req.body.title, 'Title', { max: MAX_TITLE, required: false }));
    if (req.body.anniversary_date !== undefined) checks.push(str(req.body.anniversary_date, 'Date', { max: MAX_SHORT, required: false }));
    if (req.body.notes !== undefined) checks.push(str(req.body.notes, 'Notes', { max: MAX_TEXT, required: false }));
    const errors = collectErrors(checks);
    if (errors.length) return res.status(400).json({ error: errors.join(' '), code: 400 });

    if (req.body.anniversary_date !== undefined && req.body.anniversary_date && !/^\d{2}-\d{2}$/.test(req.body.anniversary_date)) {
      return res.status(400).json({ error: 'anniversary_date must be in MM-DD format.', code: 400 });
    }

    db.get().prepare(`
      UPDATE anniversaries
      SET title = COALESCE(?, title),
          anniversary_date = COALESCE(?, anniversary_date),
          notes = ?,
          reminder_offset = ?,
          reminder_custom_amount = ?,
          reminder_custom_unit = ?,
          updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
      WHERE id = ?
    `).run(
      req.body.title?.trim() ?? null,
      req.body.anniversary_date ?? null,
      req.body.notes !== undefined ? (req.body.notes?.trim() || null) : existing.notes,
      req.body.reminder_offset !== undefined ? req.body.reminder_offset : existing.reminder_offset,
      req.body.reminder_custom_amount !== undefined ? req.body.reminder_custom_amount : existing.reminder_custom_amount,
      req.body.reminder_custom_unit !== undefined ? req.body.reminder_custom_unit : existing.reminder_custom_unit,
      id,
    );

    const updated = loadAnniversary(id);
    db.transaction(() => syncAnniversaryArtifacts(db.get(), updated));
    res.json({ data: hydrateAnniversary(loadAnniversary(id)) });
  } catch (err) {
    log.error('PUT /anniversaries/:id error:', err);
    res.status(500).json({ error: 'Internal error.', code: 500 });
  }
});

router.delete('/anniversaries/:id', (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const existing = loadAnniversary(id);
    if (!existing) return res.status(404).json({ error: 'Anniversary not found.', code: 404 });
    db.transaction(() => {
      deleteAnniversaryArtifacts(db.get(), existing);
      db.get().prepare('DELETE FROM anniversaries WHERE id = ?').run(id);
    });
    res.status(204).end();
  } catch (err) {
    log.error('DELETE /anniversaries/:id error:', err);
    res.status(500).json({ error: 'Internal error.', code: 500 });
  }
});

// --------------------------------------------------------
// Kontakt-Metadaten: relationship_type + Foto (Schicht über contacts)
// --------------------------------------------------------
router.patch('/contacts/:id', (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const contact = db.get().prepare('SELECT id, name FROM contacts WHERE id = ?').get(id);
    if (!contact) return res.status(404).json({ error: 'Contact not found.', code: 404 });

    const sets = [];
    const params = [];

    if (req.body.relationship_type !== undefined) {
      const vType = str(req.body.relationship_type, 'Relationship type', { max: MAX_SHORT, required: false });
      if (vType.error) return res.status(400).json({ error: vType.error, code: 400 });
      sets.push('relationship_type = ?');
      params.push(req.body.relationship_type?.trim() || null);
    }
    if (req.body.photo !== undefined) {
      const vPhoto = validatePhotoData(req.body.photo);
      if (vPhoto.error) return res.status(400).json({ error: vPhoto.error, code: 400 });
      sets.push('photo = ?');
      params.push(vPhoto.value ?? null);
    }
    if (sets.length === 0) {
      return res.status(400).json({ error: 'No fields to update.', code: 400 });
    }

    params.push(id);
    db.get().prepare(`UPDATE contacts SET ${sets.join(', ')} WHERE id = ?`).run(...params);

    const updated = db.get().prepare('SELECT id, name, photo, relationship_type, category FROM contacts WHERE id = ?').get(id);
    res.json({ data: updated });
  } catch (err) {
    log.error('PATCH /contacts/:id error:', err);
    res.status(500).json({ error: 'Internal error.', code: 500 });
  }
});

export default router;
