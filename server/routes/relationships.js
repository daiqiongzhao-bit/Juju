import express from 'express';
import { createLogger } from '../logger.js';
import * as db from '../db.js';
import { collectErrors, date as validateDate, str, num, oneOf, MAX_SHORT, MAX_TEXT, MAX_TITLE } from '../middleware/validate.js';
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
const RELATION_TYPES = ['knows', 'family', 'friend', 'partner', 'colleague', 'neighbor', 'acquaintance', 'met-through', 'spouse', 'child', 'classmate', 'client', 'landlord', 'roommate', 'in-law', 'ex', 'doctor', 'teacher'];
const INTERACTION_TYPES = ['note', 'call', 'meeting', 'message', 'gift', 'other'];
const STRENGTH_LEVELS = [0, 1, 2, 3];
const EDGE_DIRECTIONS = ['both', 'oneway'];

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

function currentUid(req) {
  return req.authUserId || req.user?.id || req.session?.userId || 0;
}
function isAdminReq(req) {
  const role = req.authRole || req.user?.role || req.session?.role;
  return role === 'admin';
}
function actorName(req) {
  return req.user?.display_name || req.user?.username || null;
}
// Kollaborations-Audit-Log (wer hat wann was geändert).
function logOp(req, action, entity, entityId, summary) {
  try {
    db.get().prepare(
      'INSERT INTO relationship_op_log (actor_uid, actor_name, action, entity, entity_id, summary) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(currentUid(req) || null, actorName(req), action, entity, entityId ?? null, summary ?? null);
  } catch (e) {
    log.error('logOp failed:', e);
  }
}
function labelSuffix(label) {
  return label ? ` (${label})` : '';
}

// Nächstes Vorkommen eines wiederkehrenden Datums (Geburtstag/ Jahrestag).
// dateStr: 'YYYY-MM-DD' oder (mmdd=true) 'MM-DD'. Gibt { date, daysUntil, year } oder null.
function nextOccurrence(dateStr, mmdd = false) {
  if (!dateStr) return null;
  let month, day;
  if (mmdd) {
    const m = String(dateStr).match(/^(\d{2})-(\d{2})$/);
    if (!m) return null;
    month = parseInt(m[1], 10);
    day = parseInt(m[2], 10);
  } else {
    const m = String(dateStr).match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (!m) return null;
    month = parseInt(m[2], 10);
    day = parseInt(m[3], 10);
  }
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  let d = new Date(now.getFullYear(), month - 1, day);
  if (d < today) d = new Date(now.getFullYear() + 1, month - 1, day);
  const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const daysUntil = Math.round((d - today) / 86400000);
  return { date: iso, daysUntil, year: d.getFullYear() };
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
    const vMetAt = str(req.body.met_at, 'Met at', { max: MAX_SHORT, required: false });
    const vDirection = oneOf(req.body.direction || 'both', EDGE_DIRECTIONS, 'Direction');
    const vLabel = str(req.body.label, 'Label', { max: MAX_SHORT, required: false });
    const errors = collectErrors([va, vb, vType, vNote, vMetAt, vDirection, vLabel]);
    if (errors.length) return res.status(400).json({ error: errors.join(' '), code: 400 });

    let strength = 0;
    if (req.body.strength !== undefined && req.body.strength !== null && req.body.strength !== '') {
      const s = parseInt(req.body.strength, 10);
      if (!Number.isInteger(s) || s < 0 || s > 3) {
        return res.status(400).json({ error: 'strength must be an integer 0-3.', code: 400 });
      }
      strength = s;
    }

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
      INSERT INTO contact_relationships (contact_a, contact_b, relation_type, note, strength, met_at, direction, label, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(contact_a, contact_b, relation_type, vNote.value ?? null, strength, vMetAt.value ?? null, vDirection.value || 'both', vLabel.value ?? null, userId(req));

    logOp(req, 'create', 'relationship', result.lastInsertRowid, `${relation_type} ${labelSuffix(vLabel.value)}`);
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
    if (req.body.met_at !== undefined) checks.push(str(req.body.met_at, 'Met at', { max: MAX_SHORT, required: false }));
    if (req.body.direction !== undefined) checks.push(oneOf(req.body.direction, EDGE_DIRECTIONS, 'Direction'));
    if (req.body.label !== undefined) checks.push(str(req.body.label, 'Label', { max: MAX_SHORT, required: false }));
    const errors = collectErrors(checks);
    if (errors.length) return res.status(400).json({ error: errors.join(' '), code: 400 });

    let strength = existing.strength ?? 0;
    if (req.body.strength !== undefined && req.body.strength !== null && req.body.strength !== '') {
      const s = parseInt(req.body.strength, 10);
      if (!Number.isInteger(s) || s < 0 || s > 3) {
        return res.status(400).json({ error: 'strength must be an integer 0-3.', code: 400 });
      }
      strength = s;
    }

    const relation_type = req.body.relation_type !== undefined ? (req.body.relation_type?.trim() || existing.relation_type) : existing.relation_type;
    const note = req.body.note !== undefined ? (req.body.note?.trim() || null) : existing.note;
    const met_at = req.body.met_at !== undefined ? (req.body.met_at?.trim() || null) : existing.met_at;
    const direction = req.body.direction !== undefined ? (req.body.direction || 'both') : (existing.direction || 'both');
    const label = req.body.label !== undefined ? (req.body.label?.trim() || null) : existing.label;

    db.get().prepare(`
      UPDATE contact_relationships
      SET relation_type = ?, note = ?, strength = ?, met_at = ?, direction = ?, label = ?
      WHERE id = ?
    `).run(relation_type, note, strength, met_at, direction, label, id);

    logOp(req, 'update', 'relationship', id, relation_type);
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
    logOp(req, 'delete', 'relationship', id, existing.relation_type);
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
    const admin = isAdminReq(req);
    const hiddenFilter = admin ? '' : ' AND a.hidden = 0 AND b.hidden = 0';
    const edges = db.get().prepare(`
      SELECT r.id, r.contact_a, r.contact_b, r.relation_type, r.note, r.strength, r.met_at, r.direction, r.label,
             a.name AS name_a, b.name AS name_b,
             a.photo AS photo_a, b.photo AS photo_b
      FROM contact_relationships r
      JOIN contacts a ON a.id = r.contact_a
      JOIN contacts b ON b.id = r.contact_b
      WHERE 1=1${hiddenFilter}
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
        WHERE id IN (${placeholders})${admin ? '' : ' AND hidden = 0'}
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

    logOp(req, 'create', 'interaction', result.lastInsertRowid, `${vType.value || 'note'} @${vOccurred.value}`);
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
    logOp(req, 'delete', 'interaction', id, existing.type);
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
    logOp(req, 'create', 'anniversary', anniversary.id, `${vTitle.value} ${vDate.value}`);
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
    logOp(req, 'delete', 'anniversary', id, existing.title);
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
    // Erweiterte Kontakt-Metadaten (v137): Kennzeichen, Schule, eigene Tags
    if (req.body.vehiclePlate !== undefined) {
      const vPlate = str(req.body.vehiclePlate, 'Vehicle plate', { max: MAX_SHORT, required: false });
      if (vPlate.error) return res.status(400).json({ error: vPlate.error, code: 400 });
      sets.push('vehicle_plate = ?');
      params.push(vPlate.value ?? null);
    }
    if (req.body.school !== undefined) {
      const vSchool = str(req.body.school, 'School', { max: MAX_TITLE, required: false });
      if (vSchool.error) return res.status(400).json({ error: vSchool.error, code: 400 });
      sets.push('school = ?');
      params.push(vSchool.value ?? null);
    }
    if (req.body.customTags !== undefined) {
      const vTags = str(req.body.customTags, 'Custom tags', { max: MAX_TEXT, required: false });
      if (vTags.error) return res.status(400).json({ error: vTags.error, code: 400 });
      sets.push('custom_tags = ?');
      params.push(vTags.value ?? null);
    }
    // Erweiterte Profilfelder (#relationships)
    const textMap = [
      ['gender', 'gender', MAX_SHORT],
      ['hometown', 'hometown', MAX_TITLE],
      ['wechat', 'wechat', MAX_SHORT],
      ['douyin', 'douyin', MAX_SHORT],
      ['qq', 'qq', MAX_SHORT],
      ['contactGroups', 'contact_groups', MAX_TEXT],
      ['callThem', 'call_them', MAX_SHORT],
      ['callMe', 'call_me', MAX_SHORT],
    ];
    for (const [bodyKey, col, max] of textMap) {
      if (req.body[bodyKey] !== undefined) {
        const v = str(req.body[bodyKey], bodyKey, { max, required: false });
        if (v.error) return res.status(400).json({ error: v.error, code: 400 });
        sets.push(`${col} = ?`);
        params.push(v.value ?? null);
      }
    }
    // Node-Hiding für Kollaboratoren (nur Admins).
    if (req.body.hidden !== undefined) {
      if (!isAdminReq(req)) return res.status(403).json({ error: 'Only admins can change visibility.', code: 403 });
      sets.push('hidden = ?');
      params.push(req.body.hidden ? 1 : 0);
    }
    if (sets.length === 0) {
      return res.status(400).json({ error: 'No fields to update.', code: 400 });
    }

    params.push(id);
    db.get().prepare(`UPDATE contacts SET ${sets.join(', ')} WHERE id = ?`).run(...params);

    const updated = db.get().prepare(
      'SELECT id, name, photo, relationship_type, category, vehicle_plate, school, custom_tags, gender, hometown, wechat, douyin, qq, contact_groups, call_them, call_me, hidden FROM contacts WHERE id = ?'
    ).get(id);
    res.json({ data: updated });
  } catch (err) {
    log.error('PATCH /contacts/:id error:', err);
    res.status(500).json({ error: 'Internal error.', code: 500 });
  }
});


// GET /api/v1/relationships/tree-export  -> JSON-Backup des Beziehungsgraphen
router.get('/tree-export', (req, res) => {
  try {
    const contacts = db.get().prepare('SELECT id, name, photo, category, relationship_type FROM contacts').all();
    const edges = db.get().prepare('SELECT contact_a, contact_b, relation_type, note FROM contact_relationships').all();
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', 'attachment; filename="relationship-tree.json"');
    res.send(JSON.stringify({ exportedAt: new Date().toISOString(), nodes: contacts, edges }, null, 2));
  } catch (err) {
    if (typeof log !== 'undefined') log.error('GET /tree-export', err); else console.error(err);
    res.status(500).json({ error: 'Interner Fehler', code: 500 });
  }
});

// --------------------------------------------------------
// Pfadquery: "Wie kenne ich X?" / "Über wen kenne ich Y?"
// BFS über den ungerichteten Beziehungsgraphen.
// --------------------------------------------------------
router.get('/path', (req, res) => {
  try {
    const from = parseInt(req.query.from, 10);
    const to = parseInt(req.query.to, 10);
    if (!Number.isInteger(from) || !Number.isInteger(to)) {
      return res.status(400).json({ error: 'from and to must be numeric contact IDs.', code: 400 });
    }
    const admin = isAdminReq(req);
    const hiddenFilter = admin ? '' : ' AND a.hidden = 0 AND b.hidden = 0';
    const edges = db.get().prepare(`
      SELECT r.contact_a, r.contact_b, r.relation_type, r.label, r.strength, r.direction
      FROM contact_relationships r
      JOIN contacts a ON a.id = r.contact_a
      JOIN contacts b ON b.id = r.contact_b
      WHERE 1=1${hiddenFilter}
    `).all();

    const adj = new Map();
    const add = (x, y, meta) => {
      if (!adj.has(x)) adj.set(x, []);
      adj.get(x).push({ to: y, meta });
    };
    for (const e of edges) {
      add(e.contact_a, e.contact_b, e);
      add(e.contact_b, e.contact_a, e);
    }

    const nameOf = (id) => {
      const c = db.get().prepare('SELECT id, name, photo, relationship_type FROM contacts WHERE id = ?').get(id);
      return c || { id, name: '?', photo: null, relationship_type: null };
    };

    if (!adj.has(from) || !adj.has(to)) {
      return res.json({ data: { found: false, path: [], reason: 'unreachable' } });
    }
    if (from === to) {
      return res.json({ data: { found: true, path: [{ node: nameOf(from), via: null }] } });
    }

    const prev = new Map();
    const visited = new Set([from]);
    const queue = [from];
    let found = false;
    while (queue.length) {
      const cur = queue.shift();
      if (cur === to) { found = true; break; }
      for (const nb of adj.get(cur) || []) {
        if (visited.has(nb.to)) continue;
        visited.add(nb.to);
        prev.set(nb.to, { prevId: cur, meta: nb.meta });
        queue.push(nb.to);
      }
    }
    if (!found) return res.json({ data: { found: false, path: [], reason: 'unreachable' } });

    const chain = [];
    let cur = to;
    while (cur !== from) {
      const step = prev.get(cur);
      chain.unshift({ node: nameOf(cur), via: step.meta });
      cur = step.prevId;
    }
    chain.unshift({ node: nameOf(from), via: null });
    res.json({ data: { found: true, path: chain } });
  } catch (err) {
    log.error('GET /path error:', err);
    res.status(500).json({ error: 'Internal error.', code: 500 });
  }
});

// --------------------------------------------------------
// Insights: 亲疏排序 + 久未联系
// --------------------------------------------------------
router.get('/insights', (req, res) => {
  try {
    const admin = isAdminReq(req);
    const staleDays = Math.max(1, Math.min(3650, parseInt(req.query.staleDays || '90', 10) || 90));
    const contacts = db.get().prepare(
      admin
        ? 'SELECT id, name, photo, relationship_type FROM contacts'
        : 'SELECT id, name, photo, relationship_type FROM contacts WHERE hidden = 0'
    ).all();

    const strengthSum = new Map();
    const degree = new Map();
    const edges = db.get().prepare(admin
      ? 'SELECT contact_a, contact_b, strength FROM contact_relationships'
      : `SELECT r.contact_a, r.contact_b, r.strength
         FROM contact_relationships r
         JOIN contacts a ON a.id = r.contact_a
         JOIN contacts b ON b.id = r.contact_b
         WHERE a.hidden = 0 AND b.hidden = 0`
    ).all();
    for (const e of edges) {
      degree.set(e.contact_a, (degree.get(e.contact_a) || 0) + 1);
      degree.set(e.contact_b, (degree.get(e.contact_b) || 0) + 1);
      strengthSum.set(e.contact_a, (strengthSum.get(e.contact_a) || 0) + (e.strength || 0));
      strengthSum.set(e.contact_b, (strengthSum.get(e.contact_b) || 0) + (e.strength || 0));
    }
    const lastInteraction = new Map();
    for (const r of db.get().prepare('SELECT contact_id, MAX(occurred_at) AS last FROM contact_interactions GROUP BY contact_id').all()) {
      lastInteraction.set(r.contact_id, r.last);
    }

    const closeness = contacts
      .map((c) => ({
        ...c,
        degree: degree.get(c.id) || 0,
        strengthSum: strengthSum.get(c.id) || 0,
        closeness: (strengthSum.get(c.id) || 0) * 10 + (degree.get(c.id) || 0) * 2,
        lastInteraction: lastInteraction.get(c.id) || null,
      }))
      .sort((a, b) => b.closeness - a.closeness);

    const now = Date.now();
    const stale = contacts
      .filter((c) => (degree.get(c.id) || 0) > 0)
      .map((c) => {
        const last = lastInteraction.get(c.id) || null;
        const days = last ? Math.floor((now - new Date(last).getTime()) / 86400000) : null;
        return { id: c.id, name: c.name, photo: c.photo, relationship_type: c.relationship_type, lastInteraction: last, daysSinceContact: days };
      })
      .filter((c) => c.daysSinceContact === null || c.daysSinceContact >= staleDays)
      .sort((a, b) => (b.daysSinceContact ?? 1e9) - (a.daysSinceContact ?? 1e9));

    res.json({ data: { staleDays, closeness: closeness.slice(0, 50), stale: stale.slice(0, 100) } });
  } catch (err) {
    log.error('GET /insights error:', err);
    res.status(500).json({ error: 'Internal error.', code: 500 });
  }
});

// --------------------------------------------------------
// 偏好与忌讳 (Preferences & Taboos)
// --------------------------------------------------------
const PREF_FIELDS = ['interests', 'gift_hint', 'shoe_size', 'clothing_size', 'smoke', 'alcohol', 'dietary', 'allergy', 'taste', 'taboo', 'note'];

router.get('/preferences', (req, res) => {
  try {
    const contactId = parseInt(req.query.contactId, 10);
    if (!Number.isInteger(contactId)) return res.status(400).json({ error: 'contactId required.', code: 400 });
    const row = db.get().prepare('SELECT * FROM contact_preferences WHERE contact_id = ?').get(contactId);
    res.json({ data: row || null });
  } catch (err) {
    log.error('GET /preferences error:', err);
    res.status(500).json({ error: 'Internal error.', code: 500 });
  }
});

router.put('/preferences/:contactId', (req, res) => {
  try {
    const contactId = parseInt(req.params.contactId, 10);
    if (!contactExists(contactId)) return res.status(404).json({ error: 'Contact does not exist.', code: 404 });
    const body = req.body || {};
    const vals = {};
    const checks = [];
    for (const f of PREF_FIELDS) {
      const v = str(body[f], f, { max: MAX_TEXT, required: false });
      checks.push(v);
      vals[f] = v.value ?? null;
    }
    const errors = collectErrors(checks);
    if (errors.length) return res.status(400).json({ error: errors.join(' '), code: 400 });

    const existing = db.get().prepare('SELECT id FROM contact_preferences WHERE contact_id = ?').get(contactId);
    if (existing) {
      db.get().prepare(`
        UPDATE contact_preferences SET
          interests = ?, gift_hint = ?, shoe_size = ?, clothing_size = ?, smoke = ?, alcohol = ?,
          dietary = ?, allergy = ?, taste = ?, taboo = ?, note = ?,
          updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')
        WHERE contact_id = ?
      `).run(...PREF_FIELDS.map((f) => vals[f]), contactId);
    } else {
      db.get().prepare(`
        INSERT INTO contact_preferences (contact_id, interests, gift_hint, shoe_size, clothing_size, smoke, alcohol, dietary, allergy, taste, taboo, note)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(contactId, ...PREF_FIELDS.map((f) => vals[f]));
    }
    logOp(req, existing ? 'update' : 'create', 'preference', contactId, null);
    res.json({ data: db.get().prepare('SELECT * FROM contact_preferences WHERE contact_id = ?').get(contactId) });
  } catch (err) {
    log.error('PUT /preferences/:contactId error:', err);
    res.status(500).json({ error: 'Internal error.', code: 500 });
  }
});

// --------------------------------------------------------
// 标签 / 分组 (Tags & Groups)
// --------------------------------------------------------
router.get('/tags', (_req, res) => {
  try {
    const tags = db.get().prepare(`
      SELECT t.*, (SELECT COUNT(*) FROM contact_tag_map m WHERE m.tag_id = t.id) AS usage
      FROM contact_tags t ORDER BY t.name COLLATE NOCASE ASC
    `).all();
    res.json({ data: tags });
  } catch (err) {
    log.error('GET /tags error:', err);
    res.status(500).json({ error: 'Internal error.', code: 500 });
  }
});

router.post('/tags', (req, res) => {
  try {
    const vName = str(req.body.name, 'Name', { max: MAX_SHORT });
    const vColor = str(req.body.color, 'Color', { max: MAX_SHORT, required: false });
    const vKind = oneOf(req.body.kind || 'tag', ['tag', 'group'], 'Kind');
    const errors = collectErrors([vName, vColor, vKind].filter(Boolean));
    if (errors.length) return res.status(400).json({ error: errors.join(' '), code: 400 });
    const dup = db.get().prepare('SELECT id FROM contact_tags WHERE name = ? COLLATE NOCASE').get(vName.value);
    if (dup) return res.status(409).json({ error: 'Tag already exists.', code: 409 });
    const info = db.get().prepare('INSERT INTO contact_tags (name, color, kind, created_by) VALUES (?, ?, ?, ?)')
      .run(vName.value, vColor.value ?? null, vKind.value || 'tag', currentUid(req) || null);
    res.status(201).json({ data: db.get().prepare('SELECT * FROM contact_tags WHERE id = ?').get(info.lastInsertRowid) });
  } catch (err) {
    log.error('POST /tags error:', err);
    res.status(500).json({ error: 'Internal error.', code: 500 });
  }
});

router.delete('/tags/:id', (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    db.get().prepare('DELETE FROM contact_tag_map WHERE tag_id = ?').run(id);
    db.get().prepare('DELETE FROM contact_tags WHERE id = ?').run(id);
    res.status(204).end();
  } catch (err) {
    log.error('DELETE /tags/:id error:', err);
    res.status(500).json({ error: 'Internal error.', code: 500 });
  }
});

router.get('/contacts/:id/tags', (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const rows = db.get().prepare(`
      SELECT t.* FROM contact_tags t
      JOIN contact_tag_map m ON m.tag_id = t.id
      WHERE m.contact_id = ? ORDER BY t.name COLLATE NOCASE ASC
    `).all(id);
    res.json({ data: rows });
  } catch (err) {
    log.error('GET /contacts/:id/tags error:', err);
    res.status(500).json({ error: 'Internal error.', code: 500 });
  }
});

router.post('/contacts/:id/tags', (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!contactExists(id)) return res.status(404).json({ error: 'Contact does not exist.', code: 404 });
    let tagId = req.body.tagId ? parseInt(req.body.tagId, 10) : null;
    if (!Number.isInteger(tagId) && req.body.name) {
      const vName = str(req.body.name, 'Name', { max: MAX_SHORT });
      if (vName.error) return res.status(400).json({ error: vName.error, code: 400 });
      let tag = db.get().prepare('SELECT id FROM contact_tags WHERE name = ? COLLATE NOCASE').get(vName.value);
      if (!tag) {
        const info = db.get().prepare('INSERT INTO contact_tags (name, created_by) VALUES (?, ?)').run(vName.value, currentUid(req) || null);
        tagId = info.lastInsertRowid;
      } else {
        tagId = tag.id;
      }
    }
    if (!Number.isInteger(tagId)) return res.status(400).json({ error: 'tagId or name required.', code: 400 });
    db.get().prepare('INSERT OR IGNORE INTO contact_tag_map (contact_id, tag_id) VALUES (?, ?)').run(id, tagId);
    res.status(201).json({ data: { contactId: id, tagId } });
  } catch (err) {
    log.error('POST /contacts/:id/tags error:', err);
    res.status(500).json({ error: 'Internal error.', code: 500 });
  }
});

router.delete('/contacts/:id/tags/:tagId', (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const tagId = parseInt(req.params.tagId, 10);
    db.get().prepare('DELETE FROM contact_tag_map WHERE contact_id = ? AND tag_id = ?').run(id, tagId);
    res.status(204).end();
  } catch (err) {
    log.error('DELETE /contacts/:id/tags/:tagId error:', err);
    res.status(500).json({ error: 'Internal error.', code: 500 });
  }
});

// --------------------------------------------------------
// 提醒中心: 生日 / 纪念日 / 久未联系 / 该还礼 聚合
// --------------------------------------------------------
router.get('/reminders', (req, res) => {
  try {
    const admin = isAdminReq(req);
    const staleDays = Math.max(1, Math.min(3650, parseInt(req.query.staleDays || '90', 10) || 90));
    const hiddenCond = admin ? '' : ' AND hidden = 0';

    const birthdays = db.get().prepare(`
      SELECT id, name, photo, relationship_type, birthday FROM contacts
      WHERE birthday IS NOT NULL AND birthday != ''${hiddenCond}
    `).all()
      .map((c) => ({ ...c, type: 'birthday', next: nextOccurrence(c.birthday) }))
      .filter((c) => c.next)
      .sort((a, b) => a.next.daysUntil - b.next.daysUntil);

    const anniversaries = db.get().prepare(`
      SELECT a.id, a.title, a.anniversary_date, c.name AS contact_name, c.photo AS contact_photo
      FROM anniversaries a JOIN contacts c ON c.id = a.contact_id
      WHERE 1=1${admin ? '' : ' AND c.hidden = 0'}
    `).all()
      .map((a) => ({ ...a, type: 'anniversary', next: nextOccurrence(a.anniversary_date, true) }))
      .filter((a) => a.next)
      .sort((a, b) => a.next.daysUntil - b.next.daysUntil);

    const now = Date.now();
    const lastInteraction = new Map();
    for (const r of db.get().prepare('SELECT contact_id, MAX(occurred_at) AS last FROM contact_interactions GROUP BY contact_id').all()) {
      lastInteraction.set(r.contact_id, r.last);
    }
    const degree = new Map();
    const edgeRows = db.get().prepare(admin
      ? 'SELECT contact_a, contact_b FROM contact_relationships'
      : `SELECT r.contact_a, r.contact_b FROM contact_relationships r
         JOIN contacts a ON a.id = r.contact_a
         JOIN contacts b ON b.id = r.contact_b
         WHERE a.hidden = 0 AND b.hidden = 0`
    ).all();
    for (const e of edgeRows) {
      degree.set(e.contact_a, (degree.get(e.contact_a) || 0) + 1);
      degree.set(e.contact_b, (degree.get(e.contact_b) || 0) + 1);
    }
    const stale = db.get().prepare(`SELECT id, name, photo, relationship_type FROM contacts WHERE 1=1${hiddenCond}`).all()
      .filter((c) => (degree.get(c.id) || 0) > 0)
      .map((c) => {
        const last = lastInteraction.get(c.id) || null;
        const days = last ? Math.floor((now - new Date(last).getTime()) / 86400000) : null;
        return { id: c.id, name: c.name, photo: c.photo, relationship_type: c.relationship_type, lastInteraction: last, daysSinceContact: days };
      })
      .filter((c) => c.daysSinceContact === null || c.daysSinceContact >= staleDays)
      .sort((a, b) => (b.daysSinceContact ?? 1e9) - (a.daysSinceContact ?? 1e9))
      .slice(0, 100);

    // 隐私与 gift-ledger 模块保持一致：私密账目仅创建者与管理员可见
    const giftPrivacy = admin ? '' : ' AND (g.is_private = 0 OR g.creator_uid = ?)';
    const giftReturns = db.get().prepare(`
      SELECT g.id, g.type, g.event_name, g.event_date, g.amount, g.note,
             gc.name AS contact_name, gc.photo AS contact_photo
      FROM gift_ledger g
      LEFT JOIN contacts gc ON gc.id = COALESCE(g.related_contact_id, g.giver_contact_id)
      WHERE g.returned = 0${giftPrivacy}
      ORDER BY (g.event_date IS NULL), g.event_date DESC LIMIT 100
    `).all(...(admin ? [] : [currentUid(req)])).map((g) => ({ ...g, type: 'gift-return' }));

    res.json({ data: { staleDays, birthdays, anniversaries, stale, giftReturns } });
  } catch (err) {
    log.error('GET /reminders error:', err);
    res.status(500).json({ error: 'Internal error.', code: 500 });
  }
});

// --------------------------------------------------------
// Kollaborations-Audit-Log (nur Admins)
// --------------------------------------------------------
router.get('/op-log', (req, res) => {
  try {
    if (!isAdminReq(req)) return res.status(403).json({ error: 'Admin only.', code: 403 });
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit || '100', 10)));
    const rows = db.get().prepare('SELECT * FROM relationship_op_log ORDER BY created_at DESC, id DESC LIMIT ?').all(limit);
    res.json({ data: rows });
  } catch (err) {
    log.error('GET /op-log error:', err);
    res.status(500).json({ error: 'Internal error.', code: 500 });
  }
});

export default router;
