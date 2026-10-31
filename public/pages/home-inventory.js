/**
 * Modul: 家庭库存（Home Inventory）— eigenständige Seite
 * Zweck: Alltagsartikel außerhalb der Küche verwalten (Waschmittel, Papiere,
 *        Pflege, Snacks, ...) — getrennt vom Küchen-Vorrat (#家庭库存)
 * Abhängigkeiten: /api.js, /i18n.js, /components/modal.js, /utils/empty-state.js,
 *                 /utils/home-inventory-taxonomy.js (isomorph)
 *
 * Bewusst NICHT die Pantry-Seite wiederverwendet: andere Kategorien, andere
 * Einheiten, anderer Vorlauf für "läuft bald ab" (30 statt 7 Tage). Nur die
 * CSS-Grammatik (list-row / pantry-row / pantry-stepper / filter-chip /
 * list-group) wird geteilt — sie ist generisch im Stylesheet verankert und hält
 * beide Seiten visuell im selben Familiensystem.
 *
 * Jede Zeile ist ein BATCH. Derselbe Artikel mit unterschiedlichem MHD steht
 * mehrfach in der Liste, jeweils mit eigener Menge, eigenem Datum und eigenem
 * Stepper. Deshalb zeigt die Metazeile bei mehreren Batches "批次 i/n" — ohne
 * diese Angabe sähe man drei identische Zeilen und wüsste nicht, welche zuerst
 * weg muss.
 */

import { api } from '/api.js';
import { t, formatDate } from '/i18n.js';
import { esc } from '/utils/html.js';
import {
  openModal as openSharedModal,
  closeModal as closeSharedModal,
  advancedSection,
  wireBlurValidation,
  reportFieldError,
} from '/components/modal.js';
import { renderSkeletonList } from '/utils/skeleton.js';
import { renderPageSearch, wirePageSearch } from '/utils/page-search.js';
import { emptyStateEl as emptyStateComponentEl, mountLoadError } from '/utils/empty-state.js';
import { scheduleUndoableDelete, wireScrollFade } from '/utils/ux.js';
import {
  HOME_INVENTORY_CATEGORIES,
  HOME_INVENTORY_UNITS,
  DEFAULT_HOME_CATEGORY,
  DEFAULT_HOME_UNIT,
  normalizeHomeQuantity,
  homeItemStatus,
  homeBatchKey,
  compareHomeBatches,
  isValidHomeDateKey,
  localDateKey,
} from '/utils/home-inventory-taxonomy.js';

const state = {
  items: [],
  query: '',
  category: 'all',
  status: 'all',
  todayKey: '',
  loaded: false,
};

let _container = null;
let _search = null;

// --------------------------------------------------------
// Helper
// --------------------------------------------------------

/** Kategorie-Label: i18n-Schlüssel homeInventory.cat.<key>. */
function catLabel(key) {
  return t(`homeInventory.cat.${key}`);
}

/** Einheiten-Label: i18n-Schlüssel homeInventory.unit.<key>. */
function unitLabel(key) {
  return t(`homeInventory.unit.${key}`);
}

/** 12.5 → "12.5", 12.0 → "12" — REAL ohne Dezimal-Trümmer anzeigen. */
function fmtQty(q) {
  return String(Math.round(Number(q) * 100) / 100);
}

/** Der Stepper bucht ganzzahlig; Feinmengen (0.5 Flasche) pflegt das Formular. */
const QTY_STEP = 1;

/** Status-Filter, in Anzeigereihenfolge. */
const STATUS_FILTERS = ['restock', 'expiring', 'expired'];

function matchesStatus(item) {
  if (state.status === 'all') return true;
  const s = homeItemStatus(item, state.todayKey);
  if (state.status === 'restock') return s.out || s.low;
  if (state.status === 'expiring') return s.expiry === 'soon';
  if (state.status === 'expired') return s.expiry === 'expired';
  return true;
}

function matchesQuery(item) {
  if (!state.query) return true;
  const q = state.query.toLowerCase();
  return (
    String(item.name).toLowerCase().includes(q) ||
    String(item.notes || '').toLowerCase().includes(q) ||
    String(item.location || '').toLowerCase().includes(q)
  );
}

function visibleItems() {
  return state.items.filter((item) => (
    matchesStatus(item) && matchesQuery(item)
    && (state.category === 'all' || item.category === state.category)
  ));
}

/** Zählt je Status-Filter, wie viele Batches ihn treffen. */
function statusCounts() {
  const counts = { restock: 0, expiring: 0, expired: 0 };
  for (const item of state.items) {
    const s = homeItemStatus(item, state.todayKey);
    if (s.out || s.low) counts.restock += 1;
    if (s.expiry === 'soon') counts.expiring += 1;
    if (s.expiry === 'expired') counts.expired += 1;
  }
  return counts;
}

/**
 * Batch-Position je Datensatz: { index, total }. `total` bezieht sich auf alle
 * Batches desselben Artikels (nicht nur die gerade sichtbaren) — sonst würde
 * "批次 2/2" beim Filtern zu "批次 2/1".
 */
function batchInfo() {
  const byKey = new Map();
  for (const item of state.items) {
    const key = homeBatchKey(item);
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(item);
  }
  const info = new Map();
  for (const list of byKey.values()) {
    list.sort(compareHomeBatches);
    list.forEach((item, i) => info.set(item.id, { index: i + 1, total: list.length }));
  }
  return info;
}

/** Nur nicht-leere Gruppen rendern — Reihenfolge = Taxonomie-Reihenfolge. */
function buildGroups() {
  const visible = visibleItems();
  const groups = [];
  for (const cat of HOME_INVENTORY_CATEGORIES) {
    const rows = visible.filter((i) => i.category === cat.key).sort(compareHomeBatches);
    if (rows.length) groups.push({ key: cat.key, icon: cat.icon, items: rows });
  }
  // Defensiv: Items mit unbekannter Kategorie (z. B. nach manueller DB-Pflege)
  // dürfen nicht verschwinden — sie rutschen unter "其他".
  const known = new Set(HOME_INVENTORY_CATEGORIES.map((c) => c.key));
  const orphans = visible.filter((i) => !known.has(i.category)).sort(compareHomeBatches);
  if (orphans.length) groups.push({ key: 'other', icon: 'package', items: orphans });
  return groups;
}

// --------------------------------------------------------
// Render
// --------------------------------------------------------

export async function render(container) {
  _container = container;
  state.todayKey = localDateKey();

  const page = document.createElement('div');
  page.className = 'pantry-page';

  // sr-only Titel: dieselbe Kopf-Grammatik wie die anderen Module.
  const title = document.createElement('h1');
  title.className = 'sr-only';
  title.textContent = t('nav.familyInventory');

  // Kanonischer Kopf: Suche im __center-Slot, Anlegen im __actions-Slot.
  const toolbar = document.createElement('div');
  toolbar.className = 'page-toolbar page-toolbar--narrow';
  toolbar.insertAdjacentHTML('beforeend', `
    <div class="page-toolbar__center">
      ${renderPageSearch({
        id: 'home-inventory-search',
        label: t('homeInventory.searchPlaceholder'),
        placeholder: t('homeInventory.searchPlaceholder'),
        value: state.query,
        clearLabel: t('common.searchClear'),
        className: 'pantry-search',
      })}
    </div>
    <div class="page-toolbar__actions">
      <button type="button" class="btn btn--primary" id="hi-add">
        <i data-lucide="plus" class="icon-md" aria-hidden="true"></i>
        ${esc(t('homeInventory.addItem'))}
      </button>
    </div>
  `);

  // Status-Leiste (补货/临期/过期) über der Kategorie-Leiste: sie beantwortet
  // "was muss ich tun", die Kategorie-Leiste "wo liegt was".
  const statusBar = document.createElement('div');
  statusBar.className = 'pantry-filters';
  statusBar.id = 'hi-status';
  statusBar.hidden = true;

  const filters = document.createElement('div');
  filters.className = 'pantry-filters';
  filters.id = 'hi-filters';
  filters.hidden = true;

  const list = document.createElement('div');
  list.className = 'pantry-list';
  list.id = 'hi-list';

  page.append(title, toolbar, statusBar, filters, list);
  container.replaceChildren(page);

  page.querySelector('#hi-add').addEventListener('click', () => openItemModal());
  _search = wirePageSearch(toolbar, {
    id: 'home-inventory-search',
    onQuery: (value) => {
      state.query = value.trim();
      renderFilters();
      renderList();
    },
  });

  if (!state.loaded) {
    list.setAttribute('aria-busy', 'true');
    list.insertAdjacentHTML('beforeend', renderSkeletonList({ rows: 6, lines: 2 }));
    try {
      const res = await api.get('/home-inventory');
      state.items = res.data;
      state.loaded = true;
    } catch (err) {
      mountLoadError(list, {
        title: t('homeInventory.loadErrorTitle'),
        description: t('common.loadErrorDescription'),
        error: err,
        retryLabel: t('common.retry'),
        onRetry: () => render(_container),
      });
      return;
    }
  }

  renderStatusFilters();
  renderFilters();
  renderList();
  if (window.lucide) window.lucide.createIcons({ el: page });
}

/** Chips: 全部 / 需要补货 / 临期 / 已过期 — nur wenn es etwas zu tun gibt. */
function renderStatusFilters() {
  const bar = _container?.querySelector('#hi-status');
  if (!bar) return;

  if (!bar.dataset.fadeWired) {
    bar.dataset.fadeWired = 'true';
    wireScrollFade(bar);
  }

  const counts = statusCounts();
  const active = STATUS_FILTERS.filter((key) => counts[key] > 0);

  // Der aktive Statusfilter hat gerade seinen letzten Treffer verloren.
  if (state.status !== 'all' && !active.includes(state.status)) state.status = 'all';

  const hadFocus = bar.contains(document.activeElement);
  bar.replaceChildren();

  if (!active.length || !state.items.length) {
    bar.hidden = true;
    return;
  }
  bar.hidden = false;

  const labels = {
    restock: { key: 'homeInventory.statusRestock', icon: 'package-open' },
    expiring: { key: 'homeInventory.statusExpiring', icon: 'clock' },
    expired: { key: 'homeInventory.statusExpired', icon: 'circle-alert' },
  };

  const chips = [{ id: 'all', label: t('homeInventory.statusAll'), icon: 'boxes', count: null }];
  for (const key of active) {
    chips.push({ id: key, label: t(labels[key].key), icon: labels[key].icon, count: counts[key] });
  }

  bar.insertAdjacentHTML('beforeend', chips.map((chip) => `
    <button type="button" class="filter-chip${chip.id === state.status ? ' filter-chip--active' : ''}"
            data-status="${esc(chip.id)}" aria-pressed="${chip.id === state.status}">
      <i data-lucide="${esc(chip.icon)}" class="icon-sm" aria-hidden="true"></i>
      <span>${esc(chip.label)}</span>
      ${chip.count != null ? `<span class="filter-chip__count">${chip.count}</span>` : ''}
    </button>`).join(''));
  if (window.lucide) window.lucide.createIcons({ el: bar });

  if (hadFocus) bar.querySelector('.filter-chip--active')?.focus({ preventScroll: true });

  for (const btn of bar.querySelectorAll('.filter-chip')) {
    btn.addEventListener('click', () => {
      state.status = btn.dataset.status;
      renderStatusFilters();
      renderFilters();
      renderList();
    });
  }
}

function renderFilters() {
  const bar = _container?.querySelector('#hi-filters');
  if (!bar) return;

  if (!bar.dataset.fadeWired) {
    bar.dataset.fadeWired = 'true';
    wireScrollFade(bar);
  }

  // Zählung über die status-/suchgefilterte Menge: ein Chip, der "3" sagt und
  // dann 0 Zeilen zeigt, ist schlimmer als kein Chip.
  const pool = state.items.filter((i) => matchesStatus(i) && matchesQuery(i));
  const counts = new Map();
  for (const item of pool) {
    counts.set(item.category, (counts.get(item.category) ?? 0) + 1);
  }
  const cats = HOME_INVENTORY_CATEGORIES.filter((c) => counts.has(c.key));

  // Der aktive Chip hat gerade seinen letzten Treffer verloren → zurück auf 全部.
  if (state.category !== 'all' && !cats.some((c) => c.key === state.category)) {
    state.category = 'all';
  }

  const hadFocus = bar.contains(document.activeElement);
  bar.replaceChildren();
  if (!state.items.length) {
    bar.hidden = true;
    return;
  }
  bar.hidden = false;

  const chips = [
    { id: 'all', label: t('homeInventory.catAll'), icon: 'boxes', count: pool.length },
    ...cats.map((c) => ({ id: c.key, label: catLabel(c.key), icon: c.icon, count: counts.get(c.key) })),
  ];
  bar.insertAdjacentHTML('beforeend', chips.map((chip) => `
    <button type="button" class="filter-chip${chip.id === state.category ? ' filter-chip--active' : ''}"
            data-key="${esc(chip.id)}" aria-pressed="${chip.id === state.category}">
      <i data-lucide="${esc(chip.icon)}" class="icon-sm" aria-hidden="true"></i>
      <span>${esc(chip.label)}</span>
      <span class="filter-chip__count">${chip.count}</span>
    </button>`).join(''));
  if (window.lucide) window.lucide.createIcons({ el: bar });

  if (hadFocus) bar.querySelector('.filter-chip--active')?.focus({ preventScroll: true });

  for (const btn of bar.querySelectorAll('.filter-chip')) {
    btn.addEventListener('click', () => {
      state.category = btn.dataset.key;
      renderFilters();
      renderList();
    });
  }
}

function emptyListEl() {
  return emptyStateComponentEl({
    variant: 'empty',
    icon: 'boxes',
    title: t('homeInventory.emptyTitle'),
    description: t('homeInventory.emptyDescription'),
    hint: t('homeInventory.emptyHint'),
    action: {
      label: t('homeInventory.addItem'),
      icon: 'plus',
      onClick: () => openItemModal(),
    },
  });
}

function noResultsEl() {
  const active = [];
  if (state.query) active.push(`„${state.query}"`);
  if (state.category !== 'all') active.push(catLabel(state.category));
  const statusKey = { restock: 'statusRestock', expiring: 'statusExpiring', expired: 'statusExpired' }[state.status];
  if (statusKey) active.push(t(`homeInventory.${statusKey}`));
  return emptyStateComponentEl({
    variant: 'no-results',
    title: t('homeInventory.noResultsTitle'),
    description: t('homeInventory.noResultsDescription'),
    hint: active.length ? active.join(' · ') : undefined,
    action: {
      label: t('common.searchClear'),
      onClick: () => {
        state.query = '';
        state.category = 'all';
        state.status = 'all';
        // clear() versteckt zugleich den Leeren-Knopf des geteilten Suchfelds.
        _search?.clear();
        renderStatusFilters();
        renderFilters();
        renderList();
        _search?.input.focus();
      },
    },
  });
}

function renderList() {
  const list = _container?.querySelector('#hi-list');
  if (!list) return;

  if (!state.items.length) {
    list.replaceChildren(emptyListEl());
    if (window.lucide) window.lucide.createIcons({ el: list });
    return;
  }

  const groups = buildGroups();
  if (!groups.length) {
    list.replaceChildren(noResultsEl());
    if (window.lucide) window.lucide.createIcons({ el: list });
    return;
  }

  const batches = batchInfo();
  list.replaceChildren();
  for (const group of groups) {
    const section = document.createElement('section');
    // Geteilte Gruppen-Grammatik (styles/list-row.css): die Gruppe trägt die
    // weiße Fläche, die Zeilen darin nur Trennlinien.
    section.className = 'list-group pantry-group';

    const heading = document.createElement('h2');
    heading.className = 'list-group__title';
    heading.insertAdjacentHTML('beforeend',
      `<i data-lucide="${esc(group.icon)}" class="icon-sm" aria-hidden="true"></i>`);
    const name = document.createElement('span');
    name.textContent = catLabel(group.key);
    const count = document.createElement('span');
    count.className = 'list-group__count';
    count.textContent = String(group.items.length);
    heading.append(name, count);
    section.appendChild(heading);

    const rows = document.createElement('ul');
    rows.className = 'list-rows pantry-rows';
    for (const item of group.items) rows.appendChild(rowEl(item, batches.get(item.id)));
    section.appendChild(rows);
    list.appendChild(section);
  }
  if (window.lucide) window.lucide.createIcons({ el: list });
}

/** Badges: Bestand (leer/knapp) und Haltbarkeit (abgelaufen/bald). */
function stockBadge(item) {
  const s = homeItemStatus(item, state.todayKey);
  if (s.out) return { tone: 'danger', text: t('homeInventory.badgeOut') };
  if (s.low) return { tone: 'warning', text: t('homeInventory.badgeLow') };
  return null;
}

function expiryBadge(item) {
  const s = homeItemStatus(item, state.todayKey);
  if (!s.expiry) return null;
  if (s.expiry === 'expired') {
    return {
      tone: 'danger',
      text: s.days === -1
        ? t('homeInventory.badgeExpiredYesterday')
        : t('homeInventory.badgeExpiredDays', { count: Math.abs(s.days) }),
    };
  }
  if (s.days === 0) return { tone: 'warning', text: t('homeInventory.badgeExpiresToday') };
  if (s.days === 1) return { tone: 'warning', text: t('homeInventory.badgeExpiresTomorrow') };
  return { tone: 'warning', text: t('homeInventory.badgeExpiresDays', { count: s.days }) };
}

function rowEl(item, batch) {
  const status = homeItemStatus(item, state.todayKey);
  const li = document.createElement('li');
  li.className = `list-row pantry-row${status.out ? ' pantry-row--out' : ''}`;
  li.dataset.id = item.id;

  // Klickfläche: öffnet das Bearbeiten-Formular. Die Stepper-Buttons daneben
  // sind eigene Stops und dürfen nicht durchschlagen.
  const main = document.createElement('button');
  main.type = 'button';
  main.className = 'list-row__main list-row__main--interactive pantry-row__main';
  main.dataset.action = 'edit';

  // Name und Status in EINER Zeile — dieselbe Grammatik wie die Küchen-Vorräte.
  const headline = document.createElement('span');
  headline.className = 'pantry-row__headline';
  const name = document.createElement('span');
  name.className = 'list-row__name';
  name.textContent = item.name;
  headline.appendChild(name);
  for (const badge of [stockBadge(item), expiryBadge(item)].filter(Boolean)) {
    const el = document.createElement('span');
    el.className = `pantry-badge pantry-badge--${badge.tone}`;
    el.textContent = badge.text;
    headline.appendChild(el);
  }
  main.appendChild(headline);

  // Metazeile: MHD als konkretes Datum, Batch-Position, Lagerort, Notiz.
  // Das Badge sagt "noch 12 Tage", die Zeile sagt "bis 2027-03-01" — beides
  // wird gebraucht: das eine zum Handeln, das andere zum Nachschauen.
  const metaParts = [];
  if (item.expires_on) metaParts.push(t('homeInventory.expiryMeta', { date: formatDate(item.expires_on) }));
  if (batch && batch.total > 1) metaParts.push(t('homeInventory.batchIndex', { index: batch.index, total: batch.total }));
  if (item.location) metaParts.push(item.location);
  if (item.notes) metaParts.push(item.notes);
  if (!metaParts.length) metaParts.push(unitLabel(item.unit));

  const meta = document.createElement('span');
  meta.className = 'list-row__meta';
  meta.textContent = metaParts.join(' · ');
  main.appendChild(meta);

  const sr = document.createElement('span');
  sr.className = 'sr-only';
  sr.textContent = t('common.edit');
  main.appendChild(sr);

  const actions = document.createElement('div');
  actions.className = 'list-row__actions';

  const stepper = document.createElement('div');
  stepper.className = 'pantry-stepper';
  const minus = document.createElement('button');
  minus.type = 'button';
  minus.className = 'pantry-stepper__btn';
  minus.dataset.action = 'dec';
  minus.setAttribute('aria-label', '−');
  minus.textContent = '−';
  // Bei 0 ist der Minus-Knopf ohne Wirkung — ein Knopf, der nichts tut, ist
  // ein Versprechen ohne Deckung.
  minus.disabled = status.out;
  const value = document.createElement('span');
  value.className = 'pantry-stepper__value';
  value.textContent = fmtQty(item.quantity);
  const plus = document.createElement('button');
  plus.type = 'button';
  plus.className = 'pantry-stepper__btn';
  plus.dataset.action = 'inc';
  plus.setAttribute('aria-label', '+');
  plus.textContent = '+';
  stepper.append(minus, value, plus);
  actions.appendChild(stepper);

  li.append(main, actions);

  main.addEventListener('click', () => openItemModal(item));
  minus.addEventListener('click', () => stepQty(item, -QTY_STEP, value));
  plus.addEventListener('click', () => stepQty(item, +QTY_STEP, value));
  return li;
}

// --------------------------------------------------------
// Aktionen
// --------------------------------------------------------

async function stepQty(item, delta, valueEl) {
  const next = normalizeHomeQuantity(item.quantity + delta, { fallback: item.quantity });
  valueEl.textContent = fmtQty(next);
  try {
    const res = await api.patch(`/home-inventory/${item.id}`, { quantity: next });
    Object.assign(item, res.data);
    valueEl.textContent = fmtQty(item.quantity);
    // Statusübertritt (0, Schwelle) ändert Badges und Chips → neu zeichnen.
    renderStatusFilters();
    renderFilters();
    renderList();
  } catch (err) {
    valueEl.textContent = fmtQty(item.quantity);
    window.yuvomi?.showToast(err.data?.error ?? t('common.errorGeneric'), 'danger');
  }
}

/**
 * Ein Modal für beide Modi (create/edit). Kategorien und Einheiten kommen aus
 * der festen Taxonomie; Labels via i18n (homeInventory.cat.* / unit.*).
 */
function openItemModal(item = null) {
  const isEdit = !!item;
  const catOptions = HOME_INVENTORY_CATEGORIES
    .map((c) => `<option value="${esc(c.key)}">${esc(catLabel(c.key))}</option>`)
    .join('');
  const unitOptions = HOME_INVENTORY_UNITS
    .map((u) => `<option value="${esc(u)}">${esc(unitLabel(u))}</option>`)
    .join('');

  openSharedModal({
    title: isEdit ? t('common.editItem') : t('homeInventory.addItem'),
    size: 'md',
    content: `
      <div class="form-group">
        <label class="form-label" for="hi-name">${esc(t('homeInventory.nameLabel'))}</label>
        <input id="hi-name" class="form-input" type="text" required
               placeholder="${esc(t('homeInventory.namePlaceholder'))}">
        <p class="form-hint" id="hi-name-hint" hidden></p>
      </div>
      <div class="pantry-form-row">
        <div class="form-group">
          <label class="form-label" for="hi-quantity">${esc(t('homeInventory.quantityLabel'))}</label>
          <input id="hi-quantity" class="form-input" type="number" min="0" step="any"
                 inputmode="decimal" required>
        </div>
        <div class="form-group">
          <label class="form-label" for="hi-unit">${esc(t('homeInventory.unitLabel'))}</label>
          <select id="hi-unit" class="form-input" required>${unitOptions}</select>
        </div>
      </div>
      <div class="pantry-form-row">
        <div class="form-group">
          <label class="form-label" for="hi-category">${esc(t('homeInventory.categoryLabel'))}</label>
          <select id="hi-category" class="form-input" required>${catOptions}</select>
        </div>
        <div class="form-group">
          <label class="form-label" for="hi-expires">${esc(t('homeInventory.expiresLabel'))}</label>
          <yuvomi-datepicker id="hi-expires" type="date"
                             value="${esc(isEdit && item.expires_on ? item.expires_on : '')}"></yuvomi-datepicker>
        </div>
      </div>
      <p class="form-hint">${esc(t('homeInventory.expiresHint'))}</p>
      ${advancedSection(`
        <div class="form-group">
          <label class="form-label" for="hi-min">${esc(t('homeInventory.minQuantityLabel'))}</label>
          <input id="hi-min" class="form-input" type="number" min="0" step="any" inputmode="decimal">
          <p class="form-hint">${esc(t('homeInventory.minQuantityHint'))}</p>
        </div>
        <div class="form-group">
          <label class="form-label" for="hi-location">${esc(t('homeInventory.locationLabel'))}</label>
          <input id="hi-location" class="form-input" type="text"
                 placeholder="${esc(t('homeInventory.locationPlaceholder'))}">
        </div>
        <div class="form-group">
          <label class="form-label" for="hi-notes">${esc(t('homeInventory.notesLabel'))}</label>
          <textarea id="hi-notes" class="form-input" rows="2"
                    placeholder="${esc(t('homeInventory.notesPlaceholder'))}"></textarea>
        </div>`,
        { open: isEdit && (item.min_quantity != null || !!item.location || !!item.notes) })}
      <div class="modal-panel__footer modal-panel__footer--plain">
        ${isEdit ? `<button type="button" class="btn btn--danger-ghost pantry-form__delete" id="hi-delete">${esc(t('common.delete'))}</button>` : ''}
        <button type="button" class="btn btn--secondary" data-action="close-modal">${esc(t('common.cancel'))}</button>
        <button type="button" class="btn btn--primary" id="hi-save">${esc(isEdit ? t('common.save') : t('common.add'))}</button>
      </div>`,
    onMount(panel) {
      const nameInput = panel.querySelector('#hi-name');
      nameInput.value = isEdit ? item.name : '';
      panel.querySelector('#hi-quantity').value = isEdit ? String(item.quantity) : '1';
      panel.querySelector('#hi-unit').value = isEdit ? item.unit : DEFAULT_HOME_UNIT;
      panel.querySelector('#hi-category').value = isEdit ? item.category : DEFAULT_HOME_CATEGORY;
      panel.querySelector('#hi-min').value = isEdit && item.min_quantity != null ? String(item.min_quantity) : '';
      panel.querySelector('#hi-location').value = isEdit && item.location ? item.location : '';
      panel.querySelector('#hi-notes').value = isEdit && item.notes ? item.notes : '';

      // Hinweis statt Blockade: gleicher Name ist erlaubt (das ist der
      // Batch-Fall), aber der Nutzer soll wissen, dass er einen zweiten
      // Datensatz anlegt und nicht den ersten bearbeitet.
      const hint = panel.querySelector('#hi-name-hint');
      const refreshDuplicateHint = () => {
        const value = nameInput.value.trim().toLowerCase();
        const count = value
          ? state.items.filter((i) => i.id !== item?.id && String(i.name).trim().toLowerCase() === value).length
          : 0;
        if (count > 0) {
          hint.textContent = t('homeInventory.duplicateHint', { count });
          hint.hidden = false;
        } else {
          hint.hidden = true;
        }
      };
      nameInput.addEventListener('input', refreshDuplicateHint);
      refreshDuplicateHint();

      wireBlurValidation(panel);
      panel.querySelector('#hi-save').addEventListener('click', () => saveItem(panel, isEdit, item));
      panel.querySelector('#hi-delete')?.addEventListener('click', async () => {
        closeSharedModal({ force: true });
        await removeItem(item);
      });
      if (window.lucide) window.lucide.createIcons({ el: panel });
    },
  });
}

async function saveItem(panel, isEdit, item) {
  const saveBtn = panel.querySelector('#hi-save');
  const nameInput = panel.querySelector('#hi-name');
  const qtyInput = panel.querySelector('#hi-quantity');
  const expiresInput = panel.querySelector('#hi-expires');

  // 必填项按顺序校验：第一个错误先报，并且不提交。
  const name = nameInput.value.trim();
  if (!name) {
    reportFieldError(nameInput, t('homeInventory.nameRequired'));
    return;
  }

  const qtyRaw = qtyInput.value.trim();
  if (!qtyRaw) {
    reportFieldError(qtyInput, t('homeInventory.quantityRequired'));
    return;
  }
  const qtyNumber = Number(qtyRaw);
  if (!Number.isFinite(qtyNumber) || qtyNumber < 0) {
    reportFieldError(qtyInput, t('homeInventory.quantityInvalid'));
    return;
  }

  // Das Datumsfeld liefert '' oder YYYY-MM-DD; alles andere ist ein Fehler und
  // darf nicht als stiller null-Wert durchrutschen.
  const expiresOn = String(expiresInput?.value ?? '').trim();
  if (expiresOn && !isValidHomeDateKey(expiresOn)) {
    reportFieldError(expiresInput, t('homeInventory.expiresInvalid'));
    return;
  }

  const minRaw = panel.querySelector('#hi-min').value.trim();
  const payload = {
    name,
    quantity: normalizeHomeQuantity(qtyNumber, { fallback: 0 }),
    unit: panel.querySelector('#hi-unit').value,
    category: panel.querySelector('#hi-category').value,
    expires_on: expiresOn || null,
    location: panel.querySelector('#hi-location').value.trim() || null,
    min_quantity: minRaw === '' ? null : normalizeHomeQuantity(minRaw, { fallback: 0 }),
    notes: panel.querySelector('#hi-notes').value.trim() || null,
  };

  saveBtn.disabled = true;
  try {
    if (isEdit) {
      const res = await api.put(`/home-inventory/${item.id}`, payload);
      const idx = state.items.findIndex((i) => i.id === item.id);
      if (idx >= 0) state.items[idx] = res.data;
    } else {
      const res = await api.post('/home-inventory', payload);
      state.items.push(res.data);
    }
    closeSharedModal({ force: true });
    renderStatusFilters();
    renderFilters();
    renderList();
    window.yuvomi?.showToast(isEdit ? t('homeInventory.updated') : t('homeInventory.created'), 'success');
  } catch (err) {
    saveBtn.disabled = false;
    window.yuvomi?.showToast(err.data?.error ?? t('common.errorGeneric'), 'danger');
  }
}

async function removeItem(item) {
  const rowEl_ = _container?.querySelector(`.pantry-row[data-id="${item.id}"]`);
  if (rowEl_) rowEl_.style.display = 'none';

  scheduleUndoableDelete({
    message: t('homeInventory.deleted'),
    commit: async ({ keepalive }) => {
      await api.delete(`/home-inventory/${item.id}`, { keepalive });
      if (keepalive) return;
      state.items = state.items.filter((i) => i.id !== item.id);
      renderStatusFilters();
      renderFilters();
      renderList();
    },
    restore: (err) => {
      if (rowEl_) rowEl_.style.display = '';
      if (err) window.yuvomi?.showToast(err.data?.error ?? t('common.unknownError'), 'danger');
    },
  });
}
