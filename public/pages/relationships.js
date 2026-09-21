/**
 * Modul: Relationships (Beziehungsmanagement)
 * Zweck: Kontakte aus dem Adressbuch mit einer Beziehungsschicht anreichern —
 *   Netzwerk (Kraft-Graph), gemeinsame Kontakte, Interaktions-Zeitstrahl,
 *   Jahrestage mit Kalender-/Reminder-Sync. Kontakt-Stammdaten kommen aus dem
 *   bestehenden /contacts-Endpunkt; diese Seite pflegt nur die Beziehungs-
 *   Metadaten (relationship_type, Foto, Kanten, Interaktionen, Jahrestage).
 *
 * Abhängigkeiten: api.js, i18n.js, components/modal.js, utils/tablist.js
 */

import { api } from '/api.js';
import { t, formatDate } from '/i18n.js';
import { esc } from '/utils/html.js';
import { openModal, closeModal, confirmModal } from '/components/modal.js';
import { wireTablist } from '/utils/tablist.js';

const RELATION_TYPES = ['family', 'friend', 'partner', 'spouse', 'child', 'colleague', 'neighbor', 'acquaintance', 'knows', 'met-through'];
const INTERACTION_TYPES = ['note', 'call', 'meeting', 'message', 'gift', 'other'];

let _container = null;
let _user = null;
const TREE_STORAGE_KEY = 'juju-rel-tree-sources';
const state = {
  contacts: [],
  options: { relationTypes: RELATION_TYPES, interactionTypes: INTERACTION_TYPES, photoMaxBytes: 6_990_507 },
  activeTab: 'network',
  treeSources: [],
  treeExpanded: new Set(),
  // Undo/Redo: jeder Eintrag ist { label, undo, redo }
  undoStack: [],
  redoStack: [],
  // Netzwerk-Canvas: letzte Geometrie fuer Suche/Fokus
  graph: null,
  graphPos: null,
  graphNodes: null,
  focusedId: null,
};

// --------------------------------------------------------
// Helpers
// --------------------------------------------------------
function initials(name = '') {
  const parts = String(name).trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

function relLabel(type) {
  if (!type) return t('relationships.type.unset');
  const key = `relationships.type.${type}`;
  const v = t(key);
  return v === key ? type : v;
}

function relColor(type) {
  const map = {
    family: 'var(--_module-birthdays)',
    friend: 'var(--_module-contacts)',
    partner: 'var(--_module-health)',
    colleague: 'var(--_module-budget)',
    spouse: 'var(--_module-birthdays)',
    child: 'var(--_module-housekeeping)',
    neighbor: 'var(--_module-housekeeping)',
    acquaintance: 'var(--_module-reminders)',
    knows: 'var(--color-text-tertiary)',
    'met-through': 'var(--color-text-tertiary)',
  };
  return map[type] || 'var(--module-relationships)';
}

function interactionIcon(type) {
  return ({
    note: 'sticky-note',
    call: 'phone',
    meeting: 'users',
    message: 'message-circle',
    gift: 'gift',
    other: 'dot',
  })[type] || 'dot';
}

function avatarHtml(contact, size = 44, cls = 'rel-avatar') {
  const photo = contact?.photo;
  const name = contact?.name || '?';
  if (photo) {
    return `<span class="${cls}" style="width:${size}px;height:${size}px;background-image:url('${esc(photo)}')" aria-hidden="true"></span>`;
  }
  return `<span class="${cls} ${cls}--initials" style="width:${size}px;height:${size}px;font-size:${Math.round(size * 0.36)}px" aria-hidden="true">${esc(initials(name))}</span>`;
}

function fileToThumb(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        const max = 420;
        let { width, height } = img;
        const scale = Math.min(max / width, max / height, 1);
        width = Math.round(width * scale);
        height = Math.round(height * scale);
        const c = document.createElement('canvas');
        c.width = width; c.height = height;
        c.getContext('2d').drawImage(img, 0, 0, width, height);
        resolve(c.toDataURL('image/jpeg', 0.72));
      };
      img.onerror = reject;
      img.src = reader.result;
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

async function ensureOptions() {
  try {
    const res = await api.get('/relationships/meta/options');
    if (res?.data) state.options = { ...state.options, ...res.data };
  } catch { /* defaults already set */ }
}

async function ensureContacts() {
  if (state.contacts.length) return;
  try {
    const res = await api.get('/contacts');
    state.contacts = Array.isArray(res?.data) ? res.data : [];
  } catch {
    state.contacts = [];
  }
}

function contactById(id) {
  return state.contacts.find((c) => c.id === id) || null;
}

function toast(msg, type = 'success') {
  window.yuvomi?.showToast?.(msg, type);
}

// --------------------------------------------------------
// Undo / Redo (Beziehungskanten + Kontakt-Metadaten)
// --------------------------------------------------------
function pushHistory(entry) {
  state.undoStack.push(entry);
  if (state.undoStack.length > 50) state.undoStack.shift();
  state.redoStack.length = 0;
}

async function refreshActiveTab() {
  if (state.activeTab === 'network') return renderNetwork();
  if (state.activeTab === 'people') return renderPeople();
  if (state.activeTab === 'common') return renderCommon();
  if (state.activeTab === 'tree') return renderTree();
  if (state.activeTab === 'genealogy') return renderGenealogy();
  if (state.activeTab === 'timeline') return renderTimeline();
  if (state.activeTab === 'anniversaries') return renderAnniversaries();
}

async function runUndo() {
  const entry = state.undoStack.pop();
  if (!entry) { toast(t('relationships.undoNothing'), 'info'); return; }
  try {
    await entry.undo();
    state.redoStack.push(entry);
    toast(`${t('relationships.undo')}: ${entry.label}`);
    await refreshActiveTab();
  } catch (err) {
    toast(err?.data?.error || t('common.unknownError'), 'danger');
  }
}

async function runRedo() {
  const entry = state.redoStack.pop();
  if (!entry) { toast(t('relationships.redoNothing'), 'info'); return; }
  try {
    await entry.redo();
    state.undoStack.push(entry);
    toast(`${t('relationships.redo')}: ${entry.label}`);
    await refreshActiveTab();
  } catch (err) {
    toast(err?.data?.error || t('common.unknownError'), 'danger');
  }
}

function historyEdgeAdd(edge) {
  if (!edge?.id) return;
  const { id, contact_a, contact_b, relation_type, note } = edge;
  pushHistory({
    label: t('relationships.addRelationship'),
    undo: () => api.delete(`/relationships/${id}`),
    redo: () => api.post('/relationships', { contact_a, contact_b, relation_type, note }),
  });
}

function historyEdgeDelete(edge) {
  if (!edge?.id) return;
  const { contact_a, contact_b, relation_type, note } = edge;
  pushHistory({
    label: t('common.delete'),
    undo: () => api.post('/relationships', { contact_a, contact_b, relation_type, note }),
    redo: async () => {
      const rows = await api.get(`/relationships?contactId=${contact_a}`).then((r) => r?.data || []);
      const hit = rows.find((r) => r.contact_a === contact_a && r.contact_b === contact_b && r.relation_type === relation_type);
      if (hit) await api.delete(`/relationships/${hit.id}`);
    },
  });
}

// --------------------------------------------------------
// Suche / Fokus im Netzwerk-Canvas
// --------------------------------------------------------
function focusNode(svg, id, zoom = true) {
  if (!svg || !state.graphPos) return;
  const pos = state.graphPos.get(id);
  if (!pos) return;
  svg.querySelectorAll('.rel-node--found').forEach((el) => el.classList.remove('rel-node--found'));
  const el = svg.querySelector(`.rel-node[data-id="${id}"]`);
  if (el) {
    el.classList.add('rel-node--found');
    el.parentNode.appendChild(el); // in den Vordergrund zeichnen
  }
  if (zoom) {
    const w = 380; const h = 250;
    svg.setAttribute('viewBox', `${pos.x - w / 2} ${pos.y - h / 2} ${w} ${h}`);
  }
  state.focusedId = id;
}

function resetGraphView(svg) {
  if (!svg) return;
  svg.setAttribute('viewBox', '0 0 800 520');
  svg.querySelectorAll('.rel-node--found').forEach((el) => el.classList.remove('rel-node--found'));
  state.focusedId = null;
}

function searchAndFocus(svg, query) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) { resetGraphView(svg); return; }
  const nodes = state.graph?.nodes || [];
  const hit = nodes.find((n) => String(n.name || '').toLowerCase().includes(q));
  if (!hit) { toast(t('relationships.noMatch'), 'info'); return; }
  focusNode(svg, hit.id);
}

// --------------------------------------------------------
// Export: JSON-Backup des Beziehungsgraphen
// --------------------------------------------------------
async function exportTreeJson() {
  try {
    const res = await api.get('/relationships/tree-export');
    const blob = new Blob([JSON.stringify(res, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `relationship-tree-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  } catch (err) {
    toast(err?.data?.error || t('common.unknownError'), 'danger');
  }
}

// --------------------------------------------------------
// Render shell
// --------------------------------------------------------
export async function render(container, { user } = {}) {
  _container = container;
  _user = user;
  container.innerHTML = `
    <div class="page relationships-page">
      <header class="page-toolbar">
        <div class="page-toolbar__titles">
          <h1 class="page-title">${t('nav.relationships')}</h1>
          <p class="page-subtitle">${t('relationships.subtitle')}</p>
        </div>
      </header>

      <div class="sub-tabs" role="tablist" aria-label="${t('relationships.tabsLabel')}">
        <button class="sub-tab" role="tab" data-tab-id="network" aria-selected="true">${t('relationships.tab.network')}</button>
        <button class="sub-tab" role="tab" data-tab-id="people">${t('relationships.tab.people')}</button>
        <button class="sub-tab" role="tab" data-tab-id="common">${t('relationships.tab.common')}</button>
        <button class="sub-tab" role="tab" data-tab-id="tree">${t('relationships.tab.tree')}</button>
        <button class="sub-tab" role="tab" data-tab-id="genealogy">${t('relationships.tab.genealogy')}</button>
        <button class="sub-tab" role="tab" data-tab-id="timeline">${t('relationships.tab.timeline')}</button>
        <button class="sub-tab" role="tab" data-tab-id="anniversaries">${t('relationships.tab.anniversaries')}</button>
      </div>

      <section class="rel-panel" id="rel-panel-network" role="tabpanel"></section>
      <section class="rel-panel" id="rel-panel-people" role="tabpanel" hidden></section>
      <section class="rel-panel" id="rel-panel-common" role="tabpanel" hidden></section>
      <section class="rel-panel" id="rel-panel-tree" role="tabpanel" hidden></section>
      <section class="rel-panel" id="rel-panel-genealogy" role="tabpanel" hidden></section>
      <section class="rel-panel" id="rel-panel-timeline" role="tabpanel" hidden></section>
      <section class="rel-panel" id="rel-panel-anniversaries" role="tabpanel" hidden></section>
    </div>`;

  const tablist = container.querySelector('.sub-tabs');
  wireTablist(tablist, {
    activeId: state.activeTab,
    onChange: (id) => switchTab(id),
  });

  await ensureOptions();
  await ensureContacts();
  await switchTab(state.activeTab);
}

async function switchTab(id) {
  state.activeTab = id;
  const panels = ['network', 'people', 'common', 'tree', 'genealogy', 'timeline', 'anniversaries'];
  for (const p of panels) {
    const el = _container.querySelector(`#rel-panel-${p}`);
    if (el) el.hidden = p !== id;
  }
  if (id === 'network') return renderNetwork();
  if (id === 'people') return renderPeople();
  if (id === 'common') return renderCommon();
  if (id === 'tree') return renderTree();
  if (id === 'genealogy') return renderGenealogy();
  if (id === 'timeline') return renderTimeline();
  if (id === 'anniversaries') return renderAnniversaries();
}

// --------------------------------------------------------
// Tab: Network (Kraft-Graph)
// --------------------------------------------------------
let _graphDrag = null;

async function renderNetwork() {
  const panel = _container.querySelector('#rel-panel-network');
  panel.innerHTML = `<div class="rel-loading">${t('common.loading')}</div>`;
  let graph;
  try {
    const res = await api.get('/relationships/graph');
    graph = res?.data || { nodes: [], edges: [] };
  } catch {
    graph = { nodes: [], edges: [] };
  }

  if (!graph.nodes.length) {
    panel.innerHTML = `
      <div class="empty-state">
        <svg class="empty-state__icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
          <circle cx="6" cy="6" r="2.5"/><circle cx="18" cy="7" r="2.5"/><circle cx="12" cy="18" r="2.5"/>
          <path d="M8 7.5 16 7M7 8l4 8M16.5 9 13 16"/>
        </svg>
        <div class="empty-state__title">${t('relationships.networkEmptyTitle')}</div>
        <div class="empty-state__description">${t('relationships.networkEmptyDesc')}</div>
        <button class="btn btn--primary empty-state__cta" data-action="go-people">
          <i data-lucide="users" class="icon-md" aria-hidden="true"></i>${t('relationships.networkEmptyCta')}
        </button>
      </div>`;
    panel.querySelector('[data-action="go-people"]').addEventListener('click', () => switchTab('people'));
    if (window.lucide) window.lucide.createIcons({ el: panel });
    return;
  }

  panel.innerHTML = `
    <div class="rel-graph-wrap card">
      <div class="rel-graph-toolbar">
        <span class="rel-graph-hint">${t('relationships.graphHint')}</span>
        <div class="rel-graph-actions">
          <input type="search" class="form-input rel-search-input" id="rel-search"
                 placeholder="${t('relationships.searchPlaceholder')}"
                 aria-label="${t('relationships.searchPerson')}">
          <button class="btn btn--secondary btn--sm" data-action="rel-search-go">${t('relationships.searchPerson')}</button>
          <button class="btn btn--secondary btn--sm" data-action="rel-reset">${t('relationships.resetView')}</button>
          <button class="btn btn--secondary btn--sm" data-action="rel-undo">${t('relationships.undo')}</button>
          <button class="btn btn--secondary btn--sm" data-action="rel-redo">${t('relationships.redo')}</button>
          <button class="btn btn--secondary btn--sm" data-action="rel-layout">${t('relationships.reLayout')}</button>
          <button class="btn btn--secondary btn--sm" data-action="rel-export">${t('relationships.exportTree')}</button>
        </div>
      </div>
      <svg class="rel-graph" viewBox="0 0 800 520" preserveAspectRatio="xMidYMid meet" role="img" aria-label="${t('relationships.graphAria')}"></svg>
    </div>`;
  if (window.lucide) window.lucide.createIcons({ el: panel });

  const svg = panel.querySelector('svg.rel-graph');
  drawGraph(svg, graph);

  panel.querySelector('[data-action="rel-layout"]').addEventListener('click', () => drawGraph(svg, graph, true));
  panel.querySelector('[data-action="rel-undo"]').addEventListener('click', () => runUndo());
  panel.querySelector('[data-action="rel-redo"]').addEventListener('click', () => runRedo());
  panel.querySelector('[data-action="rel-export"]').addEventListener('click', () => exportTreeJson());
  panel.querySelector('[data-action="rel-reset"]').addEventListener('click', () => {
    const input = panel.querySelector('#rel-search');
    if (input) input.value = '';
    resetGraphView(svg);
  });
  const searchInput = panel.querySelector('#rel-search');
  const doSearch = () => searchAndFocus(svg, searchInput.value);
  panel.querySelector('[data-action="rel-search-go"]').addEventListener('click', doSearch);
  searchInput.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') { ev.preventDefault(); doSearch(); }
  });
}

function computeLayout(nodes, edges, w = 800, h = 520, seed = null) {
  const pos = new Map();
  const rng = seed == null ? Math.random : (() => 0.5);
  nodes.forEach((n, i) => {
    const angle = (i / Math.max(nodes.length, 1)) * Math.PI * 2;
    const r = Math.min(w, h) * 0.34;
    pos.set(n.id, {
      x: w / 2 + r * Math.cos(angle) + (rng() - 0.5) * 30,
      y: h / 2 + r * Math.sin(angle) + (rng() - 0.5) * 30,
    });
  });
  const k = Math.sqrt((w * h) / Math.max(nodes.length, 1));
  for (let iter = 0; iter < 380; iter++) {
    const disp = new Map();
    nodes.forEach((n) => disp.set(n.id, { x: 0, y: 0 }));
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const a = pos.get(nodes[i].id); const b = pos.get(nodes[j].id);
        let dx = a.x - b.x; let dy = a.y - b.y;
        const dist = Math.hypot(dx, dy) || 0.01;
        const rep = (k * k) / dist;
        const fx = (dx / dist) * rep; const fy = (dy / dist) * rep;
        const da = disp.get(nodes[i].id); const db = disp.get(nodes[j].id);
        da.x += fx; da.y += fy; db.x -= fx; db.y -= fy;
      }
    }
    for (const e of edges) {
      const a = pos.get(e.contact_a); const b = pos.get(e.contact_b);
      if (!a || !b) continue;
      let dx = a.x - b.x; let dy = a.y - b.y;
      const dist = Math.hypot(dx, dy) || 0.01;
      const spring = (dist - k) * 0.04;
      const fx = (dx / dist) * spring; const fy = (dy / dist) * spring;
      const da = disp.get(e.contact_a); const db = disp.get(e.contact_b);
      da.x -= fx; da.y -= fy; db.x += fx; db.y += fy;
    }
    const temp = 0.9 * (1 - iter / 380) + 0.05;
    nodes.forEach((n) => {
      const d = disp.get(n.id);
      const dl = Math.hypot(d.x, d.y) || 0.01;
      const lim = Math.min(dl, temp * k * 0.5);
      const p = pos.get(n.id);
      p.x += (d.x / dl) * lim;
      p.y += (d.y / dl) * lim;
      p.x = Math.max(46, Math.min(w - 46, p.x));
      p.y = Math.max(46, Math.min(h - 46, p.y));
    });
  }
  return pos;
}

function drawGraph(svg, graph, reseed = false) {
  const W = 800; const H = 520;
  const nodes = graph.nodes;
  const edges = graph.edges;
  const pos = computeLayout(nodes, edges, W, H, reseed ? null : 1);

  svg.innerHTML = '';
  const NS = 'http://www.w3.org/2000/svg';

  const edgeLayer = document.createElementNS(NS, 'g');
  const nodeLayer = document.createElementNS(NS, 'g');
  svg.appendChild(edgeLayer);
  svg.appendChild(nodeLayer);

  const edgeEls = new Map();
  for (const e of edges) {
    const line = document.createElementNS(NS, 'line');
    line.setAttribute('class', 'rel-edge');
    line.setAttribute('data-a', e.contact_a);
    line.setAttribute('data-b', e.contact_b);
    edgeLayer.appendChild(line);
    edgeEls.set(`${e.contact_a}-${e.contact_b}`, line);
  }

  const nodeEls = new Map();
  for (const n of nodes) {
    const r = 16 + Math.min(n.degree, 8) * 2.2;
    const g = document.createElementNS(NS, 'g');
    g.setAttribute('class', 'rel-node');
    g.setAttribute('transform', `translate(${pos.get(n.id).x},${pos.get(n.id).y})`);
    g.setAttribute('data-id', n.id);

    const circle = document.createElementNS(NS, 'circle');
    circle.setAttribute('r', r);
    circle.setAttribute('class', 'rel-node__circle');
    circle.setAttribute('fill', relColor(n.relationship_type));
    g.appendChild(circle);

    const label = document.createElementNS(NS, 'text');
    label.setAttribute('class', 'rel-node__label');
    label.setAttribute('text-anchor', 'middle');
    label.setAttribute('dy', r + 14);
    label.textContent = n.name || '?';
    g.appendChild(label);

    nodeLayer.appendChild(g);
    nodeEls.set(n.id, { g, circle, r });

    g.addEventListener('click', (ev) => {
      if (_graphDrag?.moved) return;
      const c = contactById(n.id) || n;
      openContactModal(c);
    });
    g.addEventListener('pointerdown', (ev) => startDrag(ev, n.id, pos, svg, edgeEls, nodeEls, W, H));
  }

  const paintEdges = () => {
    for (const e of edges) {
      const a = pos.get(e.contact_a); const b = pos.get(e.contact_b);
      const line = edgeEls.get(`${e.contact_a}-${e.contact_b}`);
      if (a && b && line) {
        line.setAttribute('x1', a.x); line.setAttribute('y1', a.y);
        line.setAttribute('x2', b.x); line.setAttribute('y2', b.y);
      }
    }
  };
  paintEdges();

  // Geometrie fuer Suche/Fokus + Undo/Redo merken
  state.graph = graph;
  state.graphPos = pos;
  state.graphNodes = nodeEls;
  if (state.focusedId && pos.has(state.focusedId)) {
    const el = svg.querySelector(`.rel-node[data-id="${state.focusedId}"]`);
    if (el) el.classList.add('rel-node--found');
  }
}

function startDrag(ev, id, pos, svg, edgeEls, nodeEls, W, H) {
  ev.preventDefault();
  const pt = svgPoint(svg, ev);
  const start = { ...pos.get(id) };
  _graphDrag = { id, moved: false, startX: pt.x, startY: pt.y, origX: start.x, origY: start.y };

  const move = (e) => {
    const p = svgPoint(svg, e);
    const dx = p.x - _graphDrag.startX;
    const dy = p.y - _graphDrag.startY;
    if (Math.hypot(dx, dy) > 4) _graphDrag.moved = true;
    const np = pos.get(id);
    np.x = Math.max(46, Math.min(W - 46, _graphDrag.origX + dx));
    np.y = Math.max(46, Math.min(H - 46, _graphDrag.origY + dy));
    const el = nodeEls.get(id);
    el.g.setAttribute('transform', `translate(${np.x},${np.y})`);
    // repaint connected edges
    edgeEls.forEach((line, key) => {
      const [a, b] = key.split('-').map(Number);
      if (a === id || b === id) {
        const pa = pos.get(a); const pb = pos.get(b);
        line.setAttribute('x1', pa.x); line.setAttribute('y1', pa.y);
        line.setAttribute('x2', pb.x); line.setAttribute('y2', pb.y);
      }
    });
  };
  const up = () => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    setTimeout(() => { _graphDrag = null; }, 0);
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
}

function svgPoint(svg, ev) {
  const rect = svg.getBoundingClientRect();
  const vb = svg.viewBox.baseVal;
  const x = ((ev.clientX - rect.left) / rect.width) * vb.width + vb.x;
  const y = ((ev.clientY - rect.top) / rect.height) * vb.height + vb.y;
  return { x, y };
}

// --------------------------------------------------------
// Tab: People (Kontakte + Beziehungs-Metadaten)
// --------------------------------------------------------
async function renderPeople() {
  const panel = _container.querySelector('#rel-panel-people');
  panel.innerHTML = `
    <div class="rel-toolbar">
      <div class="rel-search">
        <i data-lucide="search" class="icon-sm" aria-hidden="true"></i>
        <input type="search" class="form-input rel-search__input" id="rel-people-search"
               placeholder="${t('relationships.searchPlaceholder')}" aria-label="${t('relationships.searchPlaceholder')}">
      </div>
      <select class="form-input rel-filter" id="rel-people-filter" aria-label="${t('relationships.filterByType')}">
        <option value="">${t('relationships.filterAll')}</option>
        ${state.options.relationTypes.map((rt) => `<option value="${rt}">${esc(relLabel(rt))}</option>`).join('')}
      </select>
    </div>
    <div class="rel-people-grid" id="rel-people-grid" aria-busy="true"></div>`;
  if (window.lucide) window.lucide.createIcons({ el: panel });

  const search = panel.querySelector('#rel-people-search');
  const filter = panel.querySelector('#rel-people-filter');
  search.addEventListener('input', () => paintPeople());
  filter.addEventListener('change', () => paintPeople());
  await ensureContacts();
  paintPeople();
}

function paintPeople() {
  const panel = _container.querySelector('#rel-panel-people');
  const grid = panel.querySelector('#rel-people-grid');
  if (!grid) return;
  const q = panel.querySelector('#rel-people-search').value.trim().toLowerCase();
  const f = panel.querySelector('#rel-people-filter').value;

  let list = state.contacts.slice();
  if (f) list = list.filter((c) => (c.relationship_type || '') === f);
  if (q) list = list.filter((c) => (c.name || '').toLowerCase().includes(q));

  grid.removeAttribute('aria-busy');
  if (!list.length) {
    grid.innerHTML = `<div class="empty-state"><div class="empty-state__title">${t('relationships.noPeopleTitle')}</div></div>`;
    return;
  }
  grid.innerHTML = list.map((c) => `
    <button class="rel-person card" data-contact="${c.id}">
      ${avatarHtml(c, 48)}
      <span class="rel-person__body">
        <span class="rel-person__name">${esc(c.name || '?')}</span>
        <span class="rel-person__type" style="color:${relColor(c.relationship_type)}">
          ${esc(relLabel(c.relationship_type))}
        </span>
      </span>
    </button>`).join('');
  grid.querySelectorAll('[data-contact]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const c = contactById(Number(btn.dataset.contact));
      if (c) openContactModal(c);
    });
  });
}

// --------------------------------------------------------
// Tab: Common (gemeinsame Kontakte)
// --------------------------------------------------------
async function renderCommon() {
  const panel = _container.querySelector('#rel-panel-common');
  panel.innerHTML = `<div class="rel-loading">${t('common.loading')}</div>`;
  let common;
  try {
    const res = await api.get('/relationships/common');
    common = res?.data || [];
  } catch {
    common = [];
  }

  if (!common.length) {
    panel.innerHTML = `<div class="empty-state">
      <div class="empty-state__title">${t('relationships.commonEmptyTitle')}</div>
      <div class="empty-state__description">${t('relationships.commonEmptyDesc')}</div>
    </div>`;
    return;
  }

  const full = common.filter((e) => e.shared && e.shared.length);
  const rows = full.length ? full : common;

  panel.innerHTML = `
    <div class="rel-common-list">
      ${rows.map((e) => {
        const shared = (e.shared || []);
        return `<div class="rel-common card">
          <div class="rel-common__pair">
            ${avatarHtml(e.contactA, 36)}<span class="rel-common__name">${esc(e.contactA.name)}</span>
            <span class="rel-common__amp">${t('relationships.and')}</span>
            ${avatarHtml(e.contactB, 36)}<span class="rel-common__name">${esc(e.contactB.name)}</span>
          </div>
          <div class="rel-common__shared">
            <span class="rel-common__shared-label">${t('relationships.commonShared', { count: shared.length })}</span>
            <div class="rel-common__chips">
              ${shared.length ? shared.map((s) => `<button class="chip" data-contact="${s.id}">${avatarHtml(s, 22)}${esc(s.name)}</button>`).join('')
                : `<span class="rel-muted">${t('relationships.commonNone')}</span>`}
            </div>
          </div>
        </div>`;
      }).join('')}
    </div>`;
  panel.querySelectorAll('[data-contact]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const c = contactById(Number(btn.dataset.contact));
      if (c) openContactModal(c);
    });
  });
}

// --------------------------------------------------------
// Tab: Tree (hierarchische gemeinsame Kontakte)
// --------------------------------------------------------
async function renderTree() {
  const panel = _container.querySelector('#rel-panel-tree');
  panel.innerHTML = `<div class="rel-loading">${t('common.loading')}</div>`;

  await ensureContacts();

  // Persistierte Auswahl wiederherstellen
  if (!state.treeSources.length) {
    try {
      const saved = JSON.parse(localStorage.getItem(TREE_STORAGE_KEY) || '[]');
      if (Array.isArray(saved) && saved.length) state.treeSources = saved;
    } catch { /* ignore */ }
  }

  let tree;
  try {
    const qs = state.treeSources.length ? `?sourceIds=${state.treeSources.join(',')}` : '';
    const res = await api.get(`/relationships/tree${qs}`);
    tree = res?.data || { sources: [], branches: [], shared: [], commonToAll: [] };
  } catch {
    tree = { sources: [], branches: [], shared: [], commonToAll: [] };
  }

  // Synchronisiere die Auswahl mit der Server-Antwort (wenn auto-selected)
  if (tree.sources?.length) {
    state.treeSources = tree.sources.map((s) => s.id);
    try {
      localStorage.setItem(TREE_STORAGE_KEY, JSON.stringify(state.treeSources));
    } catch { /* ignore */ }
  }

  const sharedIds = new Set((tree.shared || []).map((s) => s.contactId));

  panel.innerHTML = `
    <div class="rel-tree card">
      <div class="rel-tree__header">
        <div class="rel-tree__controls">
          <span class="rel-tree__label">${t('relationships.tree.sourcesLabel')}</span>
          <div class="rel-tree__source-chips" id="rel-tree-sources"></div>
        </div>
        <div class="rel-tree__actions">
          <button class="btn btn--secondary btn--sm" data-action="tree-expand">${t('relationships.tree.expandAll')}</button>
          <button class="btn btn--secondary btn--sm" data-action="tree-collapse">${t('relationships.tree.collapseAll')}</button>
        </div>
      </div>
      <div class="rel-tree__body" id="rel-tree-body"></div>
    </div>`;

  paintTreeSources(panel, tree);
  paintTreeBody(panel, tree, sharedIds);

  panel.querySelector('[data-action="tree-expand"]')?.addEventListener('click', () => {
    state.treeExpanded = new Set((tree.branches || []).map((b) => b.sourceId));
    paintTreeBody(panel, tree, sharedIds);
  });
  panel.querySelector('[data-action="tree-collapse"]')?.addEventListener('click', () => {
    state.treeExpanded.clear();
    paintTreeBody(panel, tree, sharedIds);
  });
}

function paintTreeSources(panel, tree) {
  const box = panel.querySelector('#rel-tree-sources');
  if (!box) return;

  const selectedIds = new Set(state.treeSources);
  const contactsWithEdges = new Set();
  for (const b of tree.branches || []) contactsWithEdges.add(b.sourceId);

  const chips = state.contacts
    .filter((c) => contactsWithEdges.has(c.id) || selectedIds.has(c.id))
    .map((c) => {
      const active = selectedIds.has(c.id);
      return `<button class="rel-tree-source ${active ? 'rel-tree-source--active' : ''}" data-source="${c.id}" title="${esc(c.name || '?')}">
        ${avatarHtml(c, 24)}
        <span>${esc(c.name || '?')}</span>
      </button>`;
    });

  if (!chips.length) {
    box.innerHTML = `<span class="rel-muted">${t('relationships.tree.noSourcesHint')}</span>`;
    return;
  }
  box.innerHTML = chips.join('');

  box.querySelectorAll('[data-source]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = Number(btn.dataset.source);
      const idx = state.treeSources.indexOf(id);
      if (idx === -1) state.treeSources.push(id);
      else state.treeSources.splice(idx, 1);
      try {
        localStorage.setItem(TREE_STORAGE_KEY, JSON.stringify(state.treeSources));
      } catch { /* ignore */ }
      renderTree();
    });
  });
}

function paintTreeBody(panel, tree, sharedIds) {
  const body = panel.querySelector('#rel-tree-body');
  if (!body) return;

  const branches = tree.branches || [];
  const commonToAll = tree.commonToAll || [];
  const shared = tree.shared || [];

  if (!branches.length) {
    body.innerHTML = `<div class="empty-state">
      <div class="empty-state__title">${t('relationships.tree.emptyTitle')}</div>
      <div class="empty-state__description">${t('relationships.tree.emptyDesc')}</div>
    </div>`;
    return;
  }

  const renderConnection = (conn) => {
    const isShared = sharedIds.has(conn.contactId);
    return `
      <div class="rel-tree-node ${isShared ? 'rel-tree-node--shared' : ''}" data-contact="${conn.contactId}">
        <span class="rel-tree-node__line"></span>
        ${avatarHtml(conn, 28)}
        <span class="rel-tree-node__name">${esc(conn.name || '?')}</span>
        <span class="rel-tree-node__edge" style="color:${relColor(conn.relation_type)}">${esc(relLabel(conn.relation_type))}</span>
        ${isShared ? `<span class="rel-tree-node__badge" title="${t('relationships.tree.sharedBadge')}">${t('relationships.tree.shared')}</span>` : ''}
      </div>`;
  };

  const renderBranch = (branch) => {
    const expanded = state.treeExpanded.has(branch.sourceId);
    const count = branch.connections?.length || 0;
    const sourceContact = {
      name: branch.sourceName,
      photo: branch.sourcePhoto,
      relationship_type: branch.sourceRelationshipType,
    };
    return `
      <div class="rel-tree-branch" data-branch="${branch.sourceId}">
        <button class="rel-tree-branch__header" aria-expanded="${expanded ? 'true' : 'false'}">
          <i data-lucide="chevron-right" class="icon-sm rel-tree-branch__chevron ${expanded ? 'rel-tree-branch__chevron--open' : ''}" aria-hidden="true"></i>
          ${avatarHtml(sourceContact, 32)}
          <span class="rel-tree-branch__name">${esc(branch.sourceName || '?')}</span>
          <span class="rel-tree-branch__count">${count}</span>
        </button>
        <div class="rel-tree-branch__children ${expanded ? '' : 'rel-tree-branch__children--collapsed'}">
          ${count ? branch.connections.map(renderConnection).join('') : `<div class="rel-muted rel-tree-node">${t('relationships.tree.noConnections')}</div>`}
        </div>
      </div>`;
  };

  const hasShared = shared.length > 0;
  const hasCommonToAll = commonToAll.length > 0 && tree.sources?.length > 1;

  body.innerHTML = `
    ${hasCommonToAll ? `
      <div class="rel-tree-aggregate rel-tree-aggregate--all">
        <div class="rel-tree-aggregate__title">
          <i data-lucide="users" class="icon-sm" aria-hidden="true"></i>
          ${t('relationships.tree.commonToAll')}
          <span class="rel-tree-aggregate__subtitle">${t('relationships.tree.commonToAllDesc', { count: tree.sources.length })}</span>
        </div>
        <div class="rel-tree-aggregate__list">
          ${commonToAll.map((c) => `
            <button class="rel-tree-node rel-tree-node--shared" data-contact="${c.contactId}">
              ${avatarHtml(c, 28)}
              <span class="rel-tree-node__name">${esc(c.name || '?')}</span>
            </button>
          `).join('')}
        </div>
      </div>` : ''}
    ${hasShared && !hasCommonToAll ? `
      <div class="rel-tree-aggregate">
        <div class="rel-tree-aggregate__title">
          <i data-lucide="share-2" class="icon-sm" aria-hidden="true"></i>
          ${t('relationships.tree.sharedContacts')}
        </div>
        <div class="rel-tree-aggregate__list">
          ${shared.map((c) => `
            <button class="rel-tree-node rel-tree-node--shared" data-contact="${c.contactId}">
              ${avatarHtml(c, 28)}
              <span class="rel-tree-node__name">${esc(c.name || '?')}</span>
              <span class="rel-tree-node__sources">${t('relationships.tree.sharedBy', { count: c.sourceCount })}</span>
            </button>
          `).join('')}
        </div>
      </div>` : ''}
    <div class="rel-tree-branches">
      ${branches.map(renderBranch).join('')}
    </div>`;

  if (window.lucide) window.lucide.createIcons({ el: body });

  // Interaktionen
  body.querySelectorAll('.rel-tree-branch__header').forEach((hdr) => {
    hdr.addEventListener('click', () => {
      const branchId = Number(hdr.closest('[data-branch]')?.dataset.branch);
      if (state.treeExpanded.has(branchId)) state.treeExpanded.delete(branchId);
      else state.treeExpanded.add(branchId);
      paintTreeBody(panel, tree, sharedIds);
    });
  });

  body.querySelectorAll('[data-contact]').forEach((node) => {
    node.addEventListener('click', () => {
      const c = contactById(Number(node.dataset.contact));
      if (c) openContactModal(c);
    });
  });
}

// --------------------------------------------------------
// Tab: Genealogy (族谱视图)
// Stammbaum aus parent-child-/spouse-Kanten: 'child' heisst
// „contact_a ist Kind von contact_b". Drei Darstellungen:
// top (Weltallschema oben-unten), side (Mindmap links-rechts),
// list (Generationenliste). Startperson waehlbar, Zoom im SVG.
// --------------------------------------------------------
const GEN_LAYOUT_KEY = 'juju-rel-gen-layout';
const genState = { layout: 'top', rootId: null, zoom: 1 };

async function renderGenealogy() {
  const panel = _container.querySelector('#rel-panel-genealogy');
  panel.innerHTML = `<div class="rel-loading">${t('common.loading')}</div>`;
  await ensureContacts();
  let graph;
  try {
    const res = await api.get('/relationships/graph');
    graph = res?.data || { nodes: [], edges: [] };
  } catch {
    graph = { nodes: [], edges: [] };
  }
  const gen = buildGenData(graph);

  try {
    const saved = JSON.parse(localStorage.getItem(GEN_LAYOUT_KEY) || '{}');
    if (['top', 'side', 'list'].includes(saved.layout)) genState.layout = saved.layout;
    if (saved.rootId === null || typeof saved.rootId === 'number') genState.rootId = saved.rootId;
  } catch { /* ignore */ }
  if (genState.rootId !== null && !gen.persons.has(genState.rootId)) genState.rootId = null;

  if (!gen.persons.size) {
    panel.innerHTML = `<div class="empty-state">
      <div class="empty-state__title">${t('relationships.gen.emptyTitle')}</div>
      <div class="empty-state__description">${t('relationships.gen.emptyDesc')}</div>
    </div>`;
    return;
  }

  panel.innerHTML = `
    <div class="rel-gen card">
      <div class="rel-gen__toolbar">
        <div class="rel-gen__modes">
          <button class="btn btn--sm ${genState.layout === 'top' ? 'btn--primary' : 'btn--secondary'}" data-mode="top">${t('relationships.gen.top')}</button>
          <button class="btn btn--sm ${genState.layout === 'side' ? 'btn--primary' : 'btn--secondary'}" data-mode="side">${t('relationships.gen.side')}</button>
          <button class="btn btn--sm ${genState.layout === 'list' ? 'btn--primary' : 'btn--secondary'}" data-mode="list">${t('relationships.gen.list')}</button>
        </div>
        <select class="form-input rel-gen__root" id="gen-root" aria-label="${t('relationships.gen.root')}">
          <option value="">${t('relationships.gen.rootAll')}</option>
          ${graph.nodes.map((n) => `<option value="${n.id}" ${genState.rootId === n.id ? 'selected' : ''}>${esc(n.name || '?')}</option>`).join('')}
        </select>
        <div class="rel-gen__zoom" ${genState.layout === 'list' ? 'hidden' : ''}>
          <button class="btn btn--secondary btn--sm" data-zoom="out" aria-label="-">－</button>
          <button class="btn btn--secondary btn--sm" data-zoom="reset">${t('relationships.resetView')}</button>
          <button class="btn btn--secondary btn--sm" data-zoom="in" aria-label="+">＋</button>
        </div>
      </div>
      <div class="rel-gen__canvas" id="gen-canvas"></div>
      <div class="rel-gen__legend">
        <span><span class="rel-gen__swatch rel-gen__swatch--couple"></span>${t('relationships.gen.spouseLine')}</span>
        <span><span class="rel-gen__swatch rel-gen__swatch--child"></span>${t('relationships.gen.childLine')}</span>
      </div>
    </div>`;

  const paint = () => {
    const zoomBox = panel.querySelector('.rel-gen__zoom');
    if (zoomBox) zoomBox.hidden = genState.layout === 'list';
    if (genState.layout === 'list') renderGenList(panel, gen);
    else drawGenTree(panel, gen);
  };
  paint();

  panel.querySelectorAll('[data-mode]').forEach((btn) => btn.addEventListener('click', () => {
    genState.layout = btn.dataset.mode;
    saveGenPrefs();
    panel.querySelectorAll('[data-mode]').forEach((b) => {
      b.classList.toggle('btn--primary', b === btn);
      b.classList.toggle('btn--secondary', b !== btn);
    });
    paint();
  }));
  panel.querySelector('#gen-root').addEventListener('change', (e) => {
    genState.rootId = e.target.value ? Number(e.target.value) : null;
    saveGenPrefs();
    paint();
  });
  panel.querySelectorAll('[data-zoom]').forEach((btn) => btn.addEventListener('click', () => {
    if (btn.dataset.zoom === 'in') genState.zoom = Math.min(2, Math.round((genState.zoom + 0.2) * 10) / 10);
    if (btn.dataset.zoom === 'out') genState.zoom = Math.max(0.4, Math.round((genState.zoom - 0.2) * 10) / 10);
    if (btn.dataset.zoom === 'reset') genState.zoom = 1;
    const svg = panel.querySelector('svg.rel-gen__svg');
    if (svg) svg.style.width = `${Math.round(genState.zoom * 100)}%`;
  }));
}

function saveGenPrefs() {
  try {
    localStorage.setItem(GEN_LAYOUT_KEY, JSON.stringify({ layout: genState.layout, rootId: genState.rootId }));
  } catch { /* ignore */ }
}

function buildGenData(graph) {
  const persons = new Map((graph.nodes || []).map((n) => [n.id, n]));
  const parentIds = new Map(); // childId -> Set parentId
  const childIds = new Map();  // parentId -> Set childId
  const spouseIds = new Map(); // personId -> Set spouseId
  const push = (m, k, v) => { if (!m.has(k)) m.set(k, new Set()); m.get(k).add(v); };
  for (const e of graph.edges || []) {
    if (e.relation_type === 'child') {
      push(childIds, e.contact_b, e.contact_a);
      push(parentIds, e.contact_a, e.contact_b);
    } else if (e.relation_type === 'spouse' || e.relation_type === 'partner') {
      push(spouseIds, e.contact_a, e.contact_b);
      push(spouseIds, e.contact_b, e.contact_a);
    }
  }
  return { persons, parentIds, childIds, spouseIds };
}

function genUnitSpouse(gen, personId) {
  for (const s of gen.spouseIds.get(personId) || new Set()) return s;
  return null;
}

function genUnitChildren(gen, personId, spouseId) {
  const set = new Set();
  for (const p of spouseId != null ? [personId, spouseId] : [personId]) {
    for (const c of gen.childIds.get(p) || new Set()) set.add(c);
  }
  return [...set];
}

function genRootIds(gen) {
  if (genState.rootId !== null && gen.persons.has(genState.rootId)) return [genState.rootId];
  const roots = [];
  for (const id of gen.persons.keys()) {
    const parents = gen.parentIds.get(id);
    if (!parents || !parents.size) roots.push(id);
  }
  if (!roots.length) {
    // Fallback: verschachtelte Daten ohne echte Wurzel -> alle mit Kindern
    for (const [id, kids] of gen.childIds) if (kids.size) roots.push(id);
    if (!roots.length) roots.push(...gen.persons.keys());
  }
  return roots;
}

// Layout im abstrakten Koordinatensystem (u = quer, v = Generationstiefe),
// danach je Modus auf x/y abgebildet.
function layoutGenTree(gen, rootIds, mode) {
  const NODE_W = 132, NODE_H = 46, SPOUSE_GAP = 16, SIB_GAP = 20, DEPTH_GAP = 88, MARGIN = 28;
  const pos = new Map();   // id -> {u, v}
  const links = [];        // {from, to} Eltern->Kind (Pixel werden spaeter gezeichnet)
  const placed = new Set();

  const measure = (id, seen) => {
    if (seen.has(id) || placed.has(id)) return { w: 0, unit: null };
    seen.add(id);
    const sp = genUnitSpouse(gen, id);
    const ownW = sp ? NODE_W * 2 + SPOUSE_GAP : NODE_W;
    const kids = genUnitChildren(gen, id, sp).filter((c) => !seen.has(c) && c !== id);
    const childTrees = kids.map((k) => measure(k, seen)).filter((t) => t.unit);
    const childrenW = childTrees.reduce((a, t) => a + t.w, 0) + Math.max(0, childTrees.length - 1) * SIB_GAP;
    return { w: Math.max(ownW, childrenW), unit: { id, spouse: sp, kids: childTrees.map((t) => t.unit.id), childTrees, ownW, childrenW } };
  };

  const assign = (unit, uLeft, depth) => {
    placed.add(unit.id);
    if (unit.spouse != null) placed.add(unit.spouse);
    const unitW = Math.max(unit.ownW, unit.childrenW);
    const childStart = uLeft + (unitW - unit.childrenW) / 2;
    let cx = childStart;
    for (const ct of unit.childTrees) {
      assign(ct.unit, cx, depth + 1);
      cx += ct.w + SIB_GAP;
      links.push({ from: unit.id, to: ct.unit.id, viaSpouse: unit.spouse != null });
    }
    // Paar-Block zentrieren
    const center = uLeft + unitW / 2;
    if (unit.spouse != null) {
      pos.set(unit.id, { u: center - SPOUSE_GAP / 2 - NODE_W / 2, v: depth });
      pos.set(unit.spouse, { u: center + SPOUSE_GAP / 2 + NODE_W / 2, v: depth });
    } else {
      pos.set(unit.id, { u: center, v: depth });
    }
    unit._w = unitW;
  };

  const seen = new Set();
  const rootUnits = rootIds.map((r) => measure(r, seen)).filter((t) => t.unit);
  // Gesamtspanne: Wurzel-Einheiten nebeneinander
  const totalW = rootUnits.reduce((a, t) => a + t.w, 0) + Math.max(0, rootUnits.length - 1) * (SIB_GAP + 40);
  let rx = 0;
  for (const t of rootUnits) {
    assign(t.unit, rx, 0);
    rx += t.w + SIB_GAP + 40;
  }

  // u/v -> Pixel
  const xy = (p) => mode === 'top'
    ? { x: MARGIN + p.u, y: MARGIN + p.v * DEPTH_GAP }
    : { x: MARGIN + p.v * DEPTH_GAP, y: MARGIN + p.u };
  const px = new Map();
  let maxX = 0, maxY = 0;
  for (const [id, p] of pos) {
    const pt = xy(p);
    px.set(id, pt);
    maxX = Math.max(maxX, pt.x + NODE_W);
    maxY = Math.max(maxY, pt.y + NODE_H);
  }
  return { pos: px, links, couples: null, width: maxX + MARGIN, height: maxY + MARGIN, nodeW: NODE_W, nodeH: NODE_H, mode };
}

function drawGenTree(panel, gen) {
  const canvas = panel.querySelector('#gen-canvas');
  if (!canvas) return;
  const rootIds = genRootIds(gen);
  const layout = layoutGenTree(gen, rootIds, genState.layout);
  const { pos, links, nodeW: W, nodeH: H, mode } = layout;

  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('class', 'rel-gen__svg');
  svg.setAttribute('viewBox', `0 0 ${Math.ceil(layout.width)} ${Math.ceil(layout.height)}`);
  svg.setAttribute('preserveAspectRatio', 'xMinYMin meet');
  svg.style.width = `${Math.round(genState.zoom * 100)}%`;

  const edgeLayer = document.createElementNS(NS, 'g');
  const nodeLayer = document.createElementNS(NS, 'g');
  svg.appendChild(edgeLayer);
  svg.appendChild(nodeLayer);

  const midOf = (id) => {
    const p = pos.get(id);
    return p ? { x: p.x + W / 2, y: p.y + H / 2 } : null;
  };

  for (const l of links) {
    const a = pos.get(l.from);
    const b = pos.get(l.to);
    if (!a || !b) continue;
    const path = document.createElementNS(NS, 'path');
    path.setAttribute('class', 'rel-gen__link');
    if (mode === 'top') {
      const y1 = a.y + H, y2 = b.y, x1 = a.x + W / 2, x2 = b.x + W / 2;
      const ym = (y1 + y2) / 2;
      path.setAttribute('d', `M ${x1} ${y1} L ${x1} ${ym} L ${x2} ${ym} L ${x2} ${y2}`);
    } else {
      const x1 = a.x + W, x2 = b.x, y1 = a.y + H / 2, y2 = b.y + H / 2;
      const xm = (x1 + x2) / 2;
      path.setAttribute('d', `M ${x1} ${y1} L ${xm} ${y1} L ${xm} ${y2} L ${x2} ${y2}`);
    }
    edgeLayer.appendChild(path);
  }

  // Paare: doppelte Querlinie zwischen den Partnern
  const drawn = new Set();
  for (const [id, p] of pos) {
    if (drawn.has(id)) continue;
    const sp = genUnitSpouse(gen, id);
    if (sp != null && pos.has(sp) && !drawn.has(sp)) {
      const b = pos.get(sp);
      const left = p.x < b.x ? p : b;
      const right = p.x < b.x ? b : p;
      for (const off of [-3, 3]) {
        const line = document.createElementNS(NS, 'line');
        line.setAttribute('class', 'rel-gen__spouse');
        line.setAttribute('x1', left.x + W);
        line.setAttribute('y1', left.y + H / 2 + off);
        line.setAttribute('x2', right.x);
        line.setAttribute('y2', right.y + H / 2 + off);
        edgeLayer.appendChild(line);
      }
    }
    drawn.add(id);
  }

  for (const [id, p] of pos) {
    const person = gen.persons.get(id) || { name: '?', relationship_type: null };
    const g = document.createElementNS(NS, 'g');
    g.setAttribute('class', 'rel-gen__node');
    g.setAttribute('transform', `translate(${p.x},${p.y})`);
    g.setAttribute('data-id', id);
    g.setAttribute('tabindex', '0');
    g.setAttribute('role', 'button');
    g.setAttribute('aria-label', person.name || '?');

    const rect = document.createElementNS(NS, 'rect');
    rect.setAttribute('width', W);
    rect.setAttribute('height', H);
    rect.setAttribute('rx', 10);
    rect.setAttribute('ry', 10);
    rect.setAttribute('class', 'rel-gen__rect');
    rect.setAttribute('fill', relColor(person.relationship_type));
    g.appendChild(rect);

    const name = document.createElementNS(NS, 'text');
    name.setAttribute('class', 'rel-gen__name');
    name.setAttribute('x', W / 2);
    name.setAttribute('y', person.photo ? H / 2 + 4 : H / 2 + 5);
    name.setAttribute('text-anchor', 'middle');
    name.textContent = String(person.name || '?').slice(0, 9);
    g.appendChild(name);
    if (person.photo) {
      const img = document.createElementNS(NS, 'image');
      img.setAttribute('href', person.photo);
      img.setAttribute('x', W - 20);
      img.setAttribute('y', 4);
      img.setAttribute('width', 16);
      img.setAttribute('height', 16);
      img.setAttribute('preserveAspectRatio', 'xMidYMid slice');
      img.setAttribute('clip-path', 'inset(0 round 8px)');
      g.appendChild(img);
    }

    nodeLayer.appendChild(g);
  }

  if (window.lucide) window.lucide.createIcons({ el: canvas });
  canvas.innerHTML = '';
  canvas.appendChild(svg);

  svg.querySelectorAll('.rel-gen__node').forEach((el) => {
    const open = () => {
      const c = contactById(Number(el.dataset.id));
      if (c) openContactModal(c);
    };
    el.addEventListener('click', open);
    el.addEventListener('keydown', (e) => { if (e.key === 'Enter') open(); });
  });
}

function renderGenList(panel, gen) {
  const canvas = panel.querySelector('#gen-canvas');
  if (!canvas) return;

  const unitHtml = (id, depth, seen) => {
    if (seen.has(id)) return '';
    seen.add(id);
    const person = gen.persons.get(id) || { name: '?' };
    const sp = genUnitSpouse(gen, id);
    let spouseHtml = '';
    if (sp != null && !seen.has(sp)) {
      seen.add(sp);
      const spouse = gen.persons.get(sp) || { name: '?' };
      spouseHtml = `<span class="rel-gen-list__spouse">♡ ${esc(spouse.name || '?')}</span>`;
    }
    const kids = genUnitChildren(gen, id, sp).filter((k) => !seen.has(k));
    const childrenHtml = kids.length
      ? `<ul class="rel-gen-list__children">${kids.map((k) => `<li>${unitHtml(k, depth + 1, seen)}</li>`).join('')}</ul>`
      : '';
    return `<div class="rel-gen-list__row" data-id="${id}">
      <button class="rel-gen-list__person" data-id="${id}">
        ${avatarHtml(person, 26)}
        <span>${esc(person.name || '?')}</span>
      </button>
      ${spouseHtml}
      ${childrenHtml}
    </div>`;
  };

  const seen = new Set();
  canvas.innerHTML = `<div class="rel-gen-list">${genRootIds(gen).map((r) => unitHtml(r, 0, seen)).join('')}</div>`;
  canvas.querySelectorAll('.rel-gen-list__person').forEach((btn) => {
    btn.addEventListener('click', () => {
      const c = contactById(Number(btn.dataset.id));
      if (c) openContactModal(c);
    });
  });
}

// --------------------------------------------------------
// Tab: Timeline (Interaktionen)
// --------------------------------------------------------
async function renderTimeline() {
  const panel = _container.querySelector('#rel-panel-timeline');
  panel.innerHTML = `
    <div class="rel-toolbar">
      <button class="btn btn--primary" data-action="add-interaction">
        <i data-lucide="plus" class="icon-md" aria-hidden="true"></i>${t('relationships.addInteraction')}
      </button>
    </div>
    <div class="rel-timeline" id="rel-timeline" aria-busy="true"></div>`;
  if (window.lucide) window.lucide.createIcons({ el: panel });
  panel.querySelector('[data-action="add-interaction"]').addEventListener('click', () => openInteractionModal());
  await paintTimeline();
}

async function paintTimeline() {
  const panel = _container.querySelector('#rel-panel-timeline');
  const list = panel.querySelector('#rel-timeline');
  if (!list) return;
  let items;
  try {
    const res = await api.get('/relationships/interactions');
    items = res?.data || [];
  } catch {
    items = [];
  }
  list.removeAttribute('aria-busy');
  if (!items.length) {
    list.innerHTML = `<div class="empty-state">
      <div class="empty-state__title">${t('relationships.timelineEmptyTitle')}</div>
      <div class="empty-state__description">${t('relationships.timelineEmptyDesc')}</div>
    </div>`;
    return;
  }
  list.innerHTML = items.map((it) => `
    <div class="rel-event" data-id="${it.id}">
      <span class="rel-event__icon"><i data-lucide="${interactionIcon(it.type)}" class="icon-md" aria-hidden="true"></i></span>
      <div class="rel-event__body">
        <div class="rel-event__head">
          <span class="rel-event__contact">${esc(it.contact_name || '?')}</span>
          <span class="rel-event__date">${esc(formatDate(it.occurred_at))}</span>
        </div>
        ${it.note ? `<div class="rel-event__note">${esc(it.note)}</div>` : ''}
        <span class="rel-event__type">${esc(relInteractionLabel(it.type))}</span>
      </div>
      <button class="row-action row-action--danger" data-del="${it.id}" aria-label="${t('common.delete')}">
        <i data-lucide="trash-2" class="icon-sm" aria-hidden="true"></i>
      </button>
    </div>`).join('');
  if (window.lucide) window.lucide.createIcons({ el: list });
  list.querySelectorAll('[data-del]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const ok = await confirmModal(t('relationships.deleteInteractionConfirm'), { danger: true, confirmLabel: t('common.delete') });
      if (!ok) return;
      try {
        await api.delete(`/relationships/interactions/${btn.dataset.del}`);
        toast(t('relationships.interactionDeleted'));
        paintTimeline();
      } catch (err) {
        toast(err.data?.error || t('common.unknownError'), 'danger');
      }
    });
  });
}

function relInteractionLabel(type) {
  const key = `relationships.interaction.${type}`;
  const v = t(key);
  return v === key ? (type || 'note') : v;
}

// --------------------------------------------------------
// Tab: Anniversaries (Jahrestage)
// --------------------------------------------------------
async function renderAnniversaries() {
  const panel = _container.querySelector('#rel-panel-anniversaries');
  panel.innerHTML = `
    <div class="rel-toolbar">
      <button class="btn btn--primary" data-action="add-anniversary">
        <i data-lucide="gift" class="icon-md" aria-hidden="true"></i>${t('relationships.addAnniversary')}
      </button>
    </div>
    <div class="rel-anniv-list" id="rel-anniv-list" aria-busy="true"></div>`;
  if (window.lucide) window.lucide.createIcons({ el: panel });
  panel.querySelector('[data-action="add-anniversary"]').addEventListener('click', () => openAnniversaryModal());
  await paintAnniversaries();
}

async function paintAnniversaries() {
  const panel = _container.querySelector('#rel-panel-anniversaries');
  const list = panel.querySelector('#rel-anniv-list');
  if (!list) return;
  let items;
  try {
    const res = await api.get('/relationships/anniversaries');
    items = res?.data || [];
  } catch {
    items = [];
  }
  list.removeAttribute('aria-busy');
  if (!items.length) {
    list.innerHTML = `<div class="empty-state">
      <div class="empty-state__title">${t('relationships.annivEmptyTitle')}</div>
      <div class="empty-state__description">${t('relationships.annivEmptyDesc')}</div>
    </div>`;
    return;
  }
  items.sort((a, b) => (a.days_until ?? 999) - (b.days_until ?? 999));
  list.innerHTML = items.map((a) => `
    <div class="rel-anniv card" data-id="${a.id}">
      <div class="rel-anniv__main">
        <div class="rel-anniv__title">${esc(a.title)}</div>
        <div class="rel-anniv__meta">
          ${avatarHtml({ name: a.contact_name, photo: a.contact_photo }, 24)}
          <span class="rel-anniv__contact">${esc(a.contact_name || '?')}</span>
          <span class="rel-anniv__date">${esc(formatDate(a.next_date))}</span>
        </div>
      </div>
      <div class="rel-anniv__right">
        <span class="rel-anniv__count ${a.days_until <= 14 ? 'rel-anniv__count--soon' : ''}">${t('relationships.inDays', { count: a.days_until })}</span>
        <div class="rel-anniv__actions">
          <button class="row-action" data-edit="${a.id}" aria-label="${t('common.edit')}"><i data-lucide="pencil" class="icon-sm" aria-hidden="true"></i></button>
          <button class="row-action row-action--danger" data-del="${a.id}" aria-label="${t('common.delete')}"><i data-lucide="trash-2" class="icon-sm" aria-hidden="true"></i></button>
        </div>
      </div>
    </div>`).join('');
  if (window.lucide) window.lucide.createIcons({ el: list });
  list.querySelectorAll('[data-edit]').forEach((btn) => {
    btn.addEventListener('click', () => openAnniversaryModal(Number(btn.dataset.edit)));
  });
  list.querySelectorAll('[data-del]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const ok = await confirmModal(t('relationships.deleteAnniversaryConfirm'), { danger: true, confirmLabel: t('common.delete') });
      if (!ok) return;
      try {
        await api.delete(`/relationships/anniversaries/${btn.dataset.del}`);
        toast(t('relationships.anniversaryDeleted'));
        paintAnniversaries();
      } catch (err) {
        toast(err.data?.error || t('common.unknownError'), 'danger');
      }
    });
  });
}

// --------------------------------------------------------
// Modals
// --------------------------------------------------------
function contactOptionsHtml(selectedId) {
  return state.contacts
    .map((c) => `<option value="${c.id}" ${c.id === selectedId ? 'selected' : ''}>${esc(c.name || '?')}</option>`)
    .join('');
}

async function openContactModal(contact) {
  const full = contact.id ? (await api.get(`/contacts/${contact.id}`).catch(() => ({ data: contact }))).data : contact;
  const c = { ...contact, ...full };
  const edgeRows = await api.get(`/relationships?contactId=${c.id}`).then((r) => r?.data || []).catch(() => []);

  const content = `
    <div class="rel-contact-modal">
      <div class="rel-contact-modal__head">
        ${avatarHtml(c, 64, 'rel-avatar rel-avatar--lg')}
        <div>
          <div class="rel-contact-modal__name">${esc(c.name || '?')}</div>
          <div class="rel-contact-modal__cat">${esc(c.category || '')}</div>
        </div>
      </div>

      <div class="form-group">
        <label class="form-label" for="rc-type">${t('relationships.relationshipType')}</label>
        <select class="form-input" id="rc-type">
          <option value="">${t('relationships.type.unset')}</option>
          ${state.options.relationTypes.map((rt) => `<option value="${rt}" ${(c.relationship_type || '') === rt ? 'selected' : ''}>${esc(relLabel(rt))}</option>`).join('')}
        </select>
      </div>

      <div class="form-group">
        <label class="form-label" for="rc-plate">${t('relationships.vehiclePlate')}</label>
        <input class="form-input" id="rc-plate" type="text" maxlength="64" value="${esc(c.vehicle_plate || '')}" autocomplete="off">
      </div>

      <div class="form-group">
        <label class="form-label" for="rc-school">${t('relationships.school')}</label>
        <input class="form-input" id="rc-school" type="text" maxlength="120" value="${esc(c.school || '')}" autocomplete="off">
      </div>

      <div class="form-group">
        <label class="form-label" for="rc-tags">${t('relationships.customTags')}</label>
        <input class="form-input" id="rc-tags" type="text" maxlength="500" value="${esc(c.custom_tags || '')}" placeholder="${t('relationships.customTagsHint')}" autocomplete="off">
      </div>

      <div class="form-group">
        <label class="form-label">${t('relationships.photo')}</label>
        <div class="rel-photo-row">
          ${avatarHtml(c, 48)}
          <input type="file" id="rc-photo" accept="image/*" class="form-input" hidden>
          <button class="btn btn--secondary btn--sm" id="rc-photo-btn">${t('relationships.uploadPhoto')}</button>
        </div>
      </div>

      <div class="form-group">
        <div class="rel-modal-subhead">
          <span>${t('relationships.relationships')}</span>
          <button class="btn btn--ghost btn--sm" id="rc-add-rel">${t('relationships.addRelationship')}</button>
        </div>
        <div class="rel-edge-list" id="rc-edges">
          ${edgeRows.length ? edgeRows.map((e) => {
            const otherId = e.contact_a === c.id ? e.contact_b : e.contact_a;
            const other = contactById(otherId) || { name: e.contact_a === c.id ? e.name_b : e.name_a };
            return `<div class="rel-edge-item" data-edge="${e.id}">
              ${avatarHtml(other, 28)}
              <span class="rel-edge-item__name">${esc(other.name || '?')}</span>
              <span class="rel-edge-item__type">${esc(relLabel(e.relation_type))}</span>
              <button class="row-action row-action--danger" data-del-edge="${e.id}" aria-label="${t('common.delete')}"><i data-lucide="x" class="icon-sm" aria-hidden="true"></i></button>
            </div>`;
          }).join('') : `<div class="rel-muted">${t('relationships.noRelationships')}</div>`}
        </div>
      </div>

      <div class="rel-modal-quick">
        <button class="btn btn--secondary btn--sm" id="rc-add-interaction">${t('relationships.quickAddInteraction')}</button>
        <button class="btn btn--secondary btn--sm" id="rc-add-anniv">${t('relationships.quickAddAnniversary')}</button>
      </div>
    </div>
    <div class="modal-panel__footer">
      <div></div>
      <div class="contact-modal__footer-actions">
        <button class="btn btn--secondary" id="rc-cancel">${t('common.cancel')}</button>
        <button class="btn btn--primary" id="rc-save">${t('common.save')}</button>
      </div>
    </div>`;

  openModal({
    title: c.name || t('relationships.contact'),
    content,
    size: 'md',
    onSave: (panel) => {
      if (window.lucide) window.lucide.createIcons({ el: panel });
      let pendingPhoto = null;

      panel.querySelector('#rc-cancel').addEventListener('click', () => closeModal());

      panel.querySelector('#rc-photo-btn').addEventListener('click', () => panel.querySelector('#rc-photo').click());
      panel.querySelector('#rc-photo').addEventListener('change', async (ev) => {
        const file = ev.target.files?.[0];
        if (!file) return;
        try {
          pendingPhoto = await fileToThumb(file);
          const av = panel.querySelector('.rel-contact-modal__head .rel-avatar');
          av.style.backgroundImage = `url('${pendingPhoto}')`;
          av.textContent = '';
        } catch {
          toast(t('relationships.photoError'), 'danger');
        }
      });

      panel.querySelector('#rc-add-rel').addEventListener('click', () => openAddRelationshipModal(c.id, async () => {
        const rows = await api.get(`/relationships?contactId=${c.id}`).then((r) => r?.data || []).catch(() => []);
        renderEdgesInModal(panel, c.id, rows);
      }));

      // Kantenliste einmalig neu zeichnen -> bindet Loesch-Buttons inkl. Undo
      renderEdgesInModal(panel, c.id, edgeRows);

      panel.querySelector('#rc-add-interaction').addEventListener('click', () => {
        closeModal({ force: true });
        switchTab('timeline').then(() => openInteractionModal(c.id));
      });
      panel.querySelector('#rc-add-anniv').addEventListener('click', () => {
        closeModal({ force: true });
        switchTab('anniversaries').then(() => openAnniversaryModal(null, c.id));
      });

      panel.querySelector('#rc-save').addEventListener('click', async () => {
        const type = panel.querySelector('#rc-type').value;
        const plate = panel.querySelector('#rc-plate').value.trim();
        const school = panel.querySelector('#rc-school').value.trim();
        const tags = panel.querySelector('#rc-tags').value.trim();
        const body = {};
        if (type !== (c.relationship_type || '')) body.relationship_type = type || null;
        if (plate !== (c.vehicle_plate || '')) body.vehiclePlate = plate || null;
        if (school !== (c.school || '')) body.school = school || null;
        if (tags !== (c.custom_tags || '')) body.customTags = tags || null;
        if (pendingPhoto) body.photo = pendingPhoto;
        if (!Object.keys(body).length) { closeModal({ force: true }); return; }
        const btn = panel.querySelector('#rc-save');
        btn.disabled = true; btn.textContent = '…';
        try {
          const res = await api.patch(`/relationships/contacts/${c.id}`, body);
          const metaBody = { ...body };
          delete metaBody.photo; // Fotos nicht im Undo-Puffer halten
          if (Object.keys(metaBody).length) {
            const prev = {
              relationship_type: c.relationship_type || null,
              vehicle_plate: c.vehicle_plate || null,
              school: c.school || null,
              custom_tags: c.custom_tags || null,
            };
            pushHistory({
              label: t('relationships.contact'),
              undo: () => api.patch(`/relationships/contacts/${c.id}`, {
                relationship_type: prev.relationship_type,
                vehiclePlate: prev.vehicle_plate,
                school: prev.school,
                customTags: prev.custom_tags,
              }),
              redo: () => api.patch(`/relationships/contacts/${c.id}`, metaBody),
            });
          }
          const idx = state.contacts.findIndex((x) => x.id === c.id);
          if (idx !== -1) state.contacts[idx] = { ...state.contacts[idx], ...res.data };
          closeModal({ force: true });
          toast(t('relationships.savedToast'));
          if (state.activeTab === 'people') paintPeople();
          if (state.activeTab === 'network') renderNetwork();
        } catch (err) {
          toast(err.data?.error || t('common.unknownError'), 'danger');
          btn.disabled = false; btn.textContent = t('common.save');
        }
      });
    },
  });
}

function renderEdgesInModal(panel, contactId, rows) {
  const box = panel.querySelector('#rc-edges');
  if (!box) return;
  if (!rows.length) { box.innerHTML = `<div class="rel-muted">${t('relationships.noRelationships')}</div>`; return; }
  box.innerHTML = rows.map((e) => {
    const otherId = e.contact_a === contactId ? e.contact_b : e.contact_a;
    const other = contactById(otherId) || { name: e.contact_a === contactId ? e.name_b : e.name_a };
    return `<div class="rel-edge-item" data-edge="${e.id}">
      ${avatarHtml(other, 28)}
      <span class="rel-edge-item__name">${esc(other.name || '?')}</span>
      <span class="rel-edge-item__type">${esc(relLabel(e.relation_type))}</span>
      <button class="row-action row-action--danger" data-del-edge="${e.id}" aria-label="${t('common.delete')}"><i data-lucide="x" class="icon-sm" aria-hidden="true"></i></button>
    </div>`;
  }).join('');
  if (window.lucide) window.lucide.createIcons({ el: box });

  box.querySelectorAll('[data-del-edge]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const edge = rows.find((r) => String(r.id) === String(btn.dataset.delEdge));
      try {
        await api.delete(`/relationships/${btn.dataset.delEdge}`);
        if (edge) historyEdgeDelete(edge);
        const fresh = await api.get(`/relationships?contactId=${contactId}`).then((r) => r?.data || []).catch(() => []);
        renderEdgesInModal(panel, contactId, fresh);
      } catch (err) {
        toast(err?.data?.error || t('common.unknownError'), 'danger');
      }
    });
  });
}

function openAddRelationshipModal(contactId, onDone) {
  const others = state.contacts.filter((c) => c.id !== contactId);
  const content = `
    <div class="form-group">
      <label class="form-label" for="ar-other">${t('relationships.withContact')}</label>
      <select class="form-input" id="ar-other">${contactOptionsHtml(others[0]?.id)}</select>
    </div>
    <div class="form-group">
      <label class="form-label" for="ar-type">${t('relationships.relationshipType')}</label>
      <select class="form-input" id="ar-type">
        ${state.options.relationTypes.map((rt) => `<option value="${rt}">${esc(relLabel(rt))}</option>`).join('')}
      </select>
    </div>
    <div class="form-group">
      <label class="form-label" for="ar-note">${t('relationships.note')}</label>
      <textarea class="form-input" id="ar-note" rows="2"></textarea>
    </div>
    <div class="modal-panel__footer">
      <div></div>
      <div class="contact-modal__footer-actions">
        <button class="btn btn--secondary" id="ar-cancel">${t('common.cancel')}</button>
        <button class="btn btn--primary" id="ar-save">${t('common.save')}</button>
      </div>
    </div>`;
  openModal({
    title: t('relationships.addRelationship'),
    content,
    size: 'md',
    onSave: (panel) => {
      panel.querySelector('#ar-cancel').addEventListener('click', () => closeModal());
      panel.querySelector('#ar-save').addEventListener('click', async () => {
        const otherId = Number(panel.querySelector('#ar-other').value);
        const relation_type = panel.querySelector('#ar-type').value;
        const note = panel.querySelector('#ar-note').value.trim() || null;
        const btn = panel.querySelector('#ar-save');
        btn.disabled = true;
        try {
          const res = await api.post('/relationships', { contact_a: contactId, contact_b: otherId, relation_type, note });
          if (res?.data) historyEdgeAdd(res.data);
          closeModal({ force: true });
          toast(t('relationships.relationshipAdded'));
          if (onDone) await onDone();
        } catch (err) {
          toast(err.data?.error || t('common.unknownError'), 'danger');
          btn.disabled = false;
        }
      });
    },
  });
}

function openInteractionModal(presetContactId = null) {
  const content = `
    <div class="form-group">
      <label class="form-label" for="it-contact">${t('relationships.contact')}</label>
      <select class="form-input" id="it-contact">${contactOptionsHtml(presetContactId)}</select>
    </div>
    <div class="form-group">
      <label class="form-label" for="it-type">${t('relationships.type')}</label>
      <select class="form-input" id="it-type">
        ${state.options.interactionTypes.map((it) => `<option value="${it}">${esc(relInteractionLabel(it))}</option>`).join('')}
      </select>
    </div>
    <div class="form-group">
      <label class="form-label" for="it-date">${t('relationships.date')}</label>
      <input type="date" class="form-input" id="it-date" value="${new Date().toISOString().slice(0, 10)}">
    </div>
    <div class="form-group">
      <label class="form-label" for="it-note">${t('relationships.note')}</label>
      <textarea class="form-input" id="it-note" rows="3"></textarea>
    </div>
    <div class="modal-panel__footer">
      <div></div>
      <div class="contact-modal__footer-actions">
        <button class="btn btn--secondary" id="it-cancel">${t('common.cancel')}</button>
        <button class="btn btn--primary" id="it-save">${t('common.save')}</button>
      </div>
    </div>`;
  openModal({
    title: t('relationships.addInteraction'),
    content,
    size: 'md',
    onSave: (panel) => {
      panel.querySelector('#it-cancel').addEventListener('click', () => closeModal());
      panel.querySelector('#it-save').addEventListener('click', async () => {
        const contact_id = Number(panel.querySelector('#it-contact').value);
        const type = panel.querySelector('#it-type').value;
        const occurred_at = panel.querySelector('#it-date').value;
        const note = panel.querySelector('#it-note').value.trim() || null;
        if (!contact_id) { toast(t('relationships.pickContact'), 'danger'); return; }
        const btn = panel.querySelector('#it-save');
        btn.disabled = true;
        try {
          await api.post('/relationships/interactions', { contact_id, type, occurred_at, note });
          closeModal({ force: true });
          toast(t('relationships.interactionAdded'));
          if (state.activeTab === 'timeline') paintTimeline();
        } catch (err) {
          toast(err.data?.error || t('common.unknownError'), 'danger');
          btn.disabled = false;
        }
      });
    },
  });
}

async function openAnniversaryModal(editId = null, presetContactId = null) {
  let a = null;
  if (editId) {
    const list = await api.get('/relationships/anniversaries').then((r) => r?.data || []).catch(() => []);
    a = list.find((x) => x.id === editId) || null;
  }
  const content = `
    <div class="form-group">
      <label class="form-label" for="an-contact">${t('relationships.contact')}</label>
      <select class="form-input" id="an-contact">${contactOptionsHtml(a?.contact_id || presetContactId)}</select>
    </div>
    <div class="form-group">
      <label class="form-label" for="an-title">${t('relationships.annivTitle')}</label>
      <input type="text" class="form-input" id="an-title" maxlength="200" value="${esc(a?.title || '')}" placeholder="${t('relationships.annivTitlePlaceholder')}">
    </div>
    <div class="form-group">
      <label class="form-label" for="an-date">${t('relationships.annivDate')}</label>
      <input type="date" class="form-input" id="an-date" value="${a ? `2000-${a.anniversary_date}` : ''}">
      <span class="rel-muted">${t('relationships.annivDateHint')}</span>
    </div>
    <div class="form-group">
      <label class="form-label" for="an-notes">${t('relationships.note')}</label>
      <textarea class="form-input" id="an-notes" rows="2">${esc(a?.notes || '')}</textarea>
    </div>
    <div class="form-group">
      <label class="form-label" for="an-reminder">${t('relationships.reminder')}</label>
      <select class="form-input" id="an-reminder">
        <option value="">${t('relationships.reminderNone')}</option>
        <option value="0">${t('relationships.remindOnDate')}</option>
        <option value="10080">${t('relationships.remindWeekBefore')}</option>
        <option value="4320">${t('relationships.remind3DaysBefore')}</option>
        <option value="1440">${t('relationships.remindDayBefore')}</option>
      </select>
    </div>
    <div class="modal-panel__footer">
      <div></div>
      <div class="contact-modal__footer-actions">
        <button class="btn btn--secondary" id="an-cancel">${t('common.cancel')}</button>
        <button class="btn btn--primary" id="an-save">${t('common.save')}</button>
      </div>
    </div>`;
  openModal({
    title: editId ? t('relationships.editAnniversary') : t('relationships.addAnniversary'),
    content,
    size: 'md',
    onSave: (panel) => {
      panel.querySelector('#an-cancel').addEventListener('click', () => closeModal());
      panel.querySelector('#an-save').addEventListener('click', async () => {
        const contact_id = Number(panel.querySelector('#an-contact').value);
        const title = panel.querySelector('#an-title').value.trim();
        const dateVal = panel.querySelector('#an-date').value;
        const md = dateVal ? dateVal.slice(5) : '';
        const notes = panel.querySelector('#an-notes').value.trim() || null;
        const reminder_offset = panel.querySelector('#an-reminder').value;
        if (!contact_id) { toast(t('relationships.pickContact'), 'danger'); return; }
        if (!title) { toast(t('relationships.titleRequired'), 'danger'); return; }
        if (!/^\d{2}-\d{2}$/.test(md)) { toast(t('relationships.dateRequired'), 'danger'); return; }
        const body = {
          contact_id, title, anniversary_date: md, notes,
          reminder_offset: reminder_offset || '',
        };
        const btn = panel.querySelector('#an-save');
        btn.disabled = true;
        try {
          if (editId) await api.put(`/relationships/anniversaries/${editId}`, body);
          else await api.post('/relationships/anniversaries', body);
          closeModal({ force: true });
          toast(t('relationships.anniversarySaved'));
          if (state.activeTab === 'anniversaries') paintAnniversaries();
        } catch (err) {
          toast(err.data?.error || t('common.unknownError'), 'danger');
          btn.disabled = false;
        }
      });
    },
  });
}
