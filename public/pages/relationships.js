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

const RELATION_TYPES = ['family', 'friend', 'partner', 'colleague', 'neighbor', 'acquaintance', 'knows', 'met-through'];
const INTERACTION_TYPES = ['note', 'call', 'meeting', 'message', 'gift', 'other'];

let _container = null;
let _user = null;
const state = {
  contacts: [],
  options: { relationTypes: RELATION_TYPES, interactionTypes: INTERACTION_TYPES, photoMaxBytes: 6_990_507 },
  activeTab: 'network',
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
        <button class="sub-tab" role="tab" data-tab-id="timeline">${t('relationships.tab.timeline')}</button>
        <button class="sub-tab" role="tab" data-tab-id="anniversaries">${t('relationships.tab.anniversaries')}</button>
      </div>

      <section class="rel-panel" id="rel-panel-network" role="tabpanel"></section>
      <section class="rel-panel" id="rel-panel-people" role="tabpanel" hidden></section>
      <section class="rel-panel" id="rel-panel-common" role="tabpanel" hidden></section>
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
  const panels = ['network', 'people', 'common', 'timeline', 'anniversaries'];
  for (const p of panels) {
    const el = _container.querySelector(`#rel-panel-${p}`);
    if (el) el.hidden = p !== id;
  }
  if (id === 'network') return renderNetwork();
  if (id === 'people') return renderPeople();
  if (id === 'common') return renderCommon();
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
        <button class="btn btn--secondary btn--sm" data-action="rel-layout">${t('relationships.reLayout')}</button>
      </div>
      <svg class="rel-graph" viewBox="0 0 800 520" preserveAspectRatio="xMidYMid meet" role="img" aria-label="${t('relationships.graphAria')}"></svg>
    </div>`;
  if (window.lucide) window.lucide.createIcons({ el: panel });

  drawGraph(panel.querySelector('svg.rel-graph'), graph);
  panel.querySelector('[data-action="rel-layout"]').addEventListener('click', () => {
    drawGraph(panel.querySelector('svg.rel-graph'), graph, true);
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
    g.dataset.id = n.id;

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

      panel.querySelectorAll('[data-del-edge]').forEach((btn) => {
        btn.addEventListener('click', async () => {
          try {
            await api.delete(`/relationships/${btn.dataset.delEdge}`);
            const rows = await api.get(`/relationships?contactId=${c.id}`).then((r) => r?.data || []).catch(() => []);
            renderEdgesInModal(panel, c.id, rows);
          } catch (err) {
            toast(err.data?.error || t('common.unknownError'), 'danger');
          }
        });
      });

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
        const body = {};
        if (type !== (c.relationship_type || '')) body.relationship_type = type || null;
        if (pendingPhoto) body.photo = pendingPhoto;
        if (!Object.keys(body).length) { closeModal({ force: true }); return; }
        const btn = panel.querySelector('#rc-save');
        btn.disabled = true; btn.textContent = '…';
        try {
          const res = await api.patch(`/relationships/contacts/${c.id}`, body);
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
          await api.post('/relationships', { contact_a: contactId, contact_b: otherId, relation_type, note });
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
