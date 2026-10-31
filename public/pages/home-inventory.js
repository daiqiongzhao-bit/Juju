/**
 * Modul: 家庭库存（Home Inventory）— eigenständige Seite
 * Zweck: Alltagsartikel außerhalb der Küche verwalten (Waschmittel, Papiere,
 *        Pflege, Snacks, ...) — getrennt vom Küchen-Vorrat (#家庭库存)
 * Abhängigkeiten: /api.js, /components/modal.js, /utils/empty-state.js,
 *                 /utils/home-inventory-taxonomy.js (isomorph)
 *
 * Bewusst NICHT die Pantry-Seite wiederverwendet: andere Kategorien, andere
 * Einheiten, kein MHD, kein Lagerort, kein Einkaufs-Import. Nur die CSS-
 * Grammatik (list-row / pantry-row / pantry-stepper / filter-chip / list-group)
 * wird geteilt — sie ist generisch im Stylesheet verankert und hält beide
 * Seiten visuell im selben Familiensystem.
 */

import { api } from '/api.js';
import { t } from '/i18n.js';
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
} from '/utils/home-inventory-taxonomy.js';

const state = {
  items: [],
  query: '',
  category: 'all',
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
  return String(Math.round(q * 100) / 100);
}

/** Der Stepper bucht ganzzahlig; Feinmengen (0.5 Flasche) pflegt das Formular. */
const QTY_STEP = 1;

function matchesFilter(item) {
  if (state.category !== 'all' && item.category !== state.category) return false;
  if (!state.query) return true;
  const q = state.query.toLowerCase();
  return (
    String(item.name).toLowerCase().includes(q) ||
    String(item.notes || '').toLowerCase().includes(q)
  );
}

/** Nur nicht-leere Gruppen rendern — Reihenfolge = Taxonomie-Reihenfolge. */
function buildGroups() {
  const visible = state.items.filter(matchesFilter);
  const groups = [];
  for (const cat of HOME_INVENTORY_CATEGORIES) {
    const rows = visible.filter((i) => i.category === cat.key);
    if (rows.length) groups.push({ key: cat.key, icon: cat.icon, items: rows });
  }
  // Defensiv: Items mit unbekannter Kategorie (z. B. nach manueller DB-Pflege)
  // dürfen nicht verschwinden — sie rutschen unter "其他".
  const known = new Set(HOME_INVENTORY_CATEGORIES.map((c) => c.key));
  const orphans = visible.filter((i) => !known.has(i.category));
  if (orphans.length) groups.push({ key: 'other', icon: 'package', items: orphans });
  return groups;
}

function isLowStock(item) {
  return item.min_quantity != null && item.quantity <= item.min_quantity;
}

// --------------------------------------------------------
// Render
// --------------------------------------------------------

export async function render(container) {
  _container = container;

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
        // Label und Placeholder aus demselben Key — dieselbe Grammatik wie
        // pantry/notes/contacts (ein eigener Label-Key über 23 Locales ohne
        // zusätzliche Aussage).
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

  // Kategorie-Chips: leere Kategorien blenden sich selbst aus — ein Filter auf
  // "leer" wäre nur ein Klick ohne Effekt.
  const filters = document.createElement('div');
  filters.className = 'pantry-filters';
  filters.id = 'hi-filters';
  filters.hidden = true;

  const list = document.createElement('div');
  list.className = 'pantry-list';
  list.id = 'hi-list';

  page.append(title, toolbar, filters, list);
  container.replaceChildren(page);

  page.querySelector('#hi-add').addEventListener('click', () => openItemModal());
  _search = wirePageSearch(toolbar, {
    id: 'home-inventory-search',
    onQuery: (value) => {
      state.query = value.trim();
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

  renderFilters();
  renderList();
  if (window.lucide) window.lucide.createIcons({ el: page });
}

function renderFilters() {
  const bar = _container?.querySelector('#hi-filters');
  if (!bar) return;

  if (!bar.dataset.fadeWired) {
    bar.dataset.fadeWired = 'true';
    wireScrollFade(bar);
  }

  const counts = new Map();
  for (const item of state.items) {
    counts.set(item.category, (counts.get(item.category) ?? 0) + 1);
  }
  const cats = HOME_INVENTORY_CATEGORIES.filter((c) => counts.has(c.key));

  // Der aktive Chip hat gerade seinen letzten Treffer verloren → zurück auf 全部.
  if (state.category !== 'all' && !cats.some((c) => c.key === state.category)) {
    state.category = 'all';
  }

  bar.replaceChildren();
  if (!state.items.length) {
    bar.hidden = true;
    return;
  }
  bar.hidden = false;

  const chips = [
    { id: 'all', label: t('homeInventory.catAll'), icon: 'boxes', count: state.items.length },
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
        // clear() versteckt zugleich den Leeren-Knopf des geteilten Suchfelds.
        _search?.clear();
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
    for (const item of group.items) rows.appendChild(rowEl(item));
    section.appendChild(rows);
    list.appendChild(section);
  }
  if (window.lucide) window.lucide.createIcons({ el: list });
}

function rowEl(item) {
  const li = document.createElement('li');
  li.className = 'list-row pantry-row';
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
  if (isLowStock(item)) {
    const badge = document.createElement('span');
    badge.className = 'pantry-badge pantry-badge--warning';
    badge.textContent = t('homeInventory.lowStock');
    headline.appendChild(badge);
  }
  main.appendChild(headline);

  const meta = document.createElement('span');
  meta.className = 'list-row__meta';
  meta.textContent = item.notes
    ? t('homeInventory.rowMeta', { unit: unitLabel(item.unit), notes: item.notes })
    : unitLabel(item.unit);
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
    // min_quantity-Übertritt ändert Badge/Chips — die Zeile neu zeichnen.
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
      </div>
      <div class="pantry-form-row">
        <div class="form-group">
          <label class="form-label" for="hi-quantity">${esc(t('homeInventory.quantityLabel'))}</label>
          <input id="hi-quantity" class="form-input" type="number" min="0" step="any" inputmode="decimal">
        </div>
        <div class="form-group">
          <label class="form-label" for="hi-unit">${esc(t('homeInventory.unitLabel'))}</label>
          <select id="hi-unit" class="form-input">${unitOptions}</select>
        </div>
      </div>
      <div class="form-group">
        <label class="form-label" for="hi-category">${esc(t('homeInventory.categoryLabel'))}</label>
        <select id="hi-category" class="form-input">${catOptions}</select>
      </div>
      ${advancedSection(`
        <div class="form-group">
          <label class="form-label" for="hi-min">${esc(t('homeInventory.minQuantityLabel'))}</label>
          <input id="hi-min" class="form-input" type="number" min="0" step="any" inputmode="decimal">
          <p class="form-hint">${esc(t('homeInventory.minQuantityHint'))}</p>
        </div>
        <div class="form-group">
          <label class="form-label" for="hi-notes">${esc(t('homeInventory.notesLabel'))}</label>
          <textarea id="hi-notes" class="form-input" rows="2"
                    placeholder="${esc(t('homeInventory.notesPlaceholder'))}"></textarea>
        </div>`,
        { open: isEdit && (item.min_quantity != null || !!item.notes) })}
      <div class="modal-panel__footer modal-panel__footer--plain">
        ${isEdit ? `<button type="button" class="btn btn--danger-ghost pantry-form__delete" id="hi-delete">${esc(t('common.delete'))}</button>` : ''}
        <button type="button" class="btn btn--secondary" data-action="close-modal">${esc(t('common.cancel'))}</button>
        <button type="button" class="btn btn--primary" id="hi-save">${esc(isEdit ? t('common.save') : t('common.add'))}</button>
      </div>`,
    onMount(panel) {
      panel.querySelector('#hi-name').value = isEdit ? item.name : '';
      panel.querySelector('#hi-quantity').value = isEdit ? String(item.quantity) : '1';
      panel.querySelector('#hi-unit').value = isEdit ? item.unit : DEFAULT_HOME_UNIT;
      panel.querySelector('#hi-category').value = isEdit ? item.category : DEFAULT_HOME_CATEGORY;
      panel.querySelector('#hi-min').value = isEdit && item.min_quantity != null ? String(item.min_quantity) : '';
      panel.querySelector('#hi-notes').value = isEdit && item.notes ? item.notes : '';

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
  const name = nameInput.value.trim();

  if (!name) {
    reportFieldError(nameInput, t('common.nameRequired'));
    return;
  }

  const minRaw = panel.querySelector('#hi-min').value.trim();
  const payload = {
    name,
    quantity: normalizeHomeQuantity(panel.querySelector('#hi-quantity').value, { fallback: 1 }),
    unit: panel.querySelector('#hi-unit').value,
    category: panel.querySelector('#hi-category').value,
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
      renderFilters();
      renderList();
    },
    restore: (err) => {
      if (rowEl_) rowEl_.style.display = '';
      if (err) window.yuvomi?.showToast(err.data?.error ?? t('common.unknownError'), 'danger');
    },
  });
}
