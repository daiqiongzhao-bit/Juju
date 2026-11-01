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
 *
 * Kategorien/Einheiten: feste Basisliste (taxonomy.js) + eigene Einträge aus
 * /home-inventory/taxonomy. Eigene Einträge tragen ihren Namen als Key — es
 * gibt keinen i18n-Key dafür, also wird der Name direkt angezeigt. Anlegen geht
 * direkt im Artikelformular ("+ 新增"), Verwalten (umbenennen/löschen) über den
 * Knopf in der Kopfzeile.
 */

import { api } from '/api.js';
import { t, formatDate } from '/i18n.js';
import { esc } from '/utils/html.js';
import {
  openModal as openSharedModal,
  closeModal as closeSharedModal,
  confirmModal,
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
  HOME_INVENTORY_LOCATIONS,
  HOME_ITEM_TEMPLATES,
  DEFAULT_HOME_CATEGORY,
  DEFAULT_HOME_UNIT,
  normalizeHomeQuantity,
  normalizeHomeOptionName,
  checkHomeOptionName,
  homeOptionMaxLength,
  homeItemStatus,
  homeBatchKey,
  compareHomeBatches,
  isValidHomeDateKey,
  isValidHomeBarcode,
  normalizeHomeBarcode,
  localDateKey,
} from '/utils/home-inventory-taxonomy.js';

/**
 * Kategorien in Anzeigereihenfolge: feste Liste ohne "其他", dann eigene,
 * "其他" zuletzt. Dieselbe Regel baut der Server (categoryOrderMap) — so
 * sortieren Liste und Gruppen identisch, ohne dass der Client nachsortiert.
 */
function buildCategoryList(customs) {
  const base = HOME_INVENTORY_CATEGORIES
    .filter((c) => c.key !== 'other')
    .map((c) => ({ key: c.key, icon: c.icon, custom: false, id: null }));
  const other = HOME_INVENTORY_CATEGORIES.find((c) => c.key === 'other');
  return [
    ...base,
    ...customs,
    { key: other.key, icon: other.icon, custom: false, id: null },
  ];
}

function builtinUnits() {
  return HOME_INVENTORY_UNITS.map((u) => ({ key: u, custom: false, id: null }));
}

/** Feste Lagerorte — dieselbe Bauart wie Einheiten (Schlüssel + i18n-Text). */
function builtinLocations() {
  return HOME_INVENTORY_LOCATIONS.map((key) => ({ key, custom: false, id: null }));
}

const state = {
  items: [],
  query: '',
  category: 'all',
  status: 'all',
  todayKey: '',
  loaded: false,
  // Wird von loadTaxonomy() mit den eigenen Einträgen ergänzt.
  categories: buildCategoryList([]),
  units: builtinUnits(),
  locations: builtinLocations(),
  // 多批次折叠：默认只显示"最先到期"的那一批，其余收起。key = homeBatchKey
  expanded: new Set(),
  // 批量选择模式（补货/删除一组物品）
  selectMode: false,
  selected: new Set(),
};

let _container = null;
let _search = null;
let _deepLinkHandled = false;

// --------------------------------------------------------
// Helper
// --------------------------------------------------------

function categoryEntry(key) {
  return state.categories.find((c) => c.key === key) || null;
}

function unitEntry(key) {
  return state.units.find((u) => u.key === key) || null;
}

/**
 * Kategorie-Label: eigene Kategorien zeigen ihren Namen (er IST der Key),
 * feste Kategorien ihren i18n-Text. Unbekannte Keys (z. B. nach manueller
 * DB-Pflege) werden roh angezeigt statt zu verschwinden.
 */
function catLabel(key) {
  const entry = categoryEntry(key);
  if (!entry) return String(key);
  return entry.custom ? entry.key : t(`homeInventory.cat.${entry.key}`);
}

function catIcon(key) {
  return categoryEntry(key)?.icon ?? 'package';
}

/** Einheiten-Label: gleiche Regel wie bei den Kategorien. */
function unitLabel(key) {
  const entry = unitEntry(key);
  if (!entry) return String(key);
  return entry.custom ? entry.key : t(`homeInventory.unit.${entry.key}`);
}

function locationEntry(key) {
  return state.locations.find((l) => l.key === key) || null;
}

/**
 * Lagerort-Label: fester Ort → übersetzter Text, eigener Ort → sein Name.
 * Unbekannte Werte (Freitext aus der Zeit vor dem Auswahlfeld) werden roh
 * angezeigt, statt zu verschwinden.
 */
function locLabel(key) {
  const entry = locationEntry(key);
  if (!entry) return String(key);
  return entry.custom ? entry.key : t(`homeInventory.loc.${entry.key}`);
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
    String(item.location || '').toLowerCase().includes(q) ||
    (item.location ? locLabel(item.location).toLowerCase().includes(q) : false)
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

/**
 * Nur nicht-leere Gruppen rendern — Reihenfolge = Kategorien-Reihenfolge.
 * Artikel mit unbekannter Kategorie landen in "其他" statt zu verschwinden.
 */
function buildGroups() {
  const visible = visibleItems();
  const known = new Set(state.categories.map((c) => c.key));
  const groups = [];
  for (const cat of state.categories) {
    const rows = visible
      .filter((i) => (cat.key === 'other'
        ? i.category === cat.key || !known.has(i.category)
        : i.category === cat.key))
      .sort(compareHomeBatches);
    if (rows.length) groups.push({ key: cat.key, icon: cat.icon, items: rows });
  }
  return groups;
}

// --------------------------------------------------------
// Taxonomie laden
// --------------------------------------------------------

/** Eigene Kategorien/Einheiten/Lagerorte vom Server holen; bei Fehler bleibt die Basisliste. */
async function loadTaxonomy() {
  try {
    const res = await api.get('/home-inventory/taxonomy');
    const data = res.data || {};
    const categories = (data.customCategories || []).map((c) => ({
      key: c.name, icon: c.icon || 'tag', custom: true, id: c.id,
    }));
    const units = (data.customUnits || []).map((u) => ({
      key: u.name, custom: true, id: u.id,
    }));
    const locations = (data.customLocations || []).map((l) => ({
      key: l.name, custom: true, id: l.id,
    }));
    state.categories = buildCategoryList(categories);
    state.units = [...builtinUnits(), ...units];
    state.locations = [...builtinLocations(), ...locations];
  } catch {
    // Kein harter Fehler: die feste Basisliste trägt die Seite weiter, eigene
    // Einträge erscheinen dann in "其他" (Artikel bleiben sichtbar).
  }
  // Altbestand: Freitext-Orte, die es in keiner Liste gibt, trotzdem anbieten —
  // sonst würde ein bearbeiteter Artikel seinen Ort verlieren.
  mergeLegacyLocations();
}

/** Orte aus Altdaten (Freitext) in die Auswahlliste aufnehmen. */
function mergeLegacyLocations() {
  const known = new Set(state.locations.map((l) => l.key.toLowerCase()));
  for (const item of state.items) {
    const value = String(item.location || '').trim();
    if (value && !known.has(value.toLowerCase())) {
      known.add(value.toLowerCase());
      state.locations.push({ key: value, custom: true, id: null, legacy: true });
    }
  }
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
      <button type="button" class="btn btn--secondary" id="hi-select"
              title="${esc(t('homeInventory.selectMode'))}" aria-label="${esc(t('homeInventory.selectMode'))}">
        <i data-lucide="list-checks" class="icon-md" aria-hidden="true"></i>
      </button>
      <button type="button" class="btn btn--secondary" id="hi-manage"
              title="${esc(t('homeInventory.manage'))}" aria-label="${esc(t('homeInventory.manage'))}">
        <i data-lucide="sliders-horizontal" class="icon-md" aria-hidden="true"></i>
      </button>
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

  // Auswahl-Leiste: erscheint im Mehrfach-Modus über der Liste (补货/删除).
  const selectBar = document.createElement('div');
  selectBar.className = 'hi-selectbar';
  selectBar.id = 'hi-selectbar';
  selectBar.hidden = true;

  const list = document.createElement('div');
  list.className = 'pantry-list';
  list.id = 'hi-list';

  page.append(title, toolbar, statusBar, filters, selectBar, list);
  container.replaceChildren(page);

  page.querySelector('#hi-add').addEventListener('click', () => openItemModal());
  page.querySelector('#hi-manage').addEventListener('click', () => openManageModal());
  page.querySelector('#hi-select').addEventListener('click', () => toggleSelectMode(!state.selectMode));
  wirePullToRefresh(list);
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
      // Taxonomie zuerst: die Liste gruppiert nach Kategorien, eigene
      // Kategorien müssen also bekannt sein, bevor Zeilen entstehen.
      await loadTaxonomy();
      const res = await api.get('/home-inventory');
      state.items = res.data;
      state.loaded = true;
      // Erst jetzt sind die Artikel da — Freitext-Orte daraus nachziehen.
      mergeLegacyLocations();
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

  // Deep-Link aus der globalen Suche: ?open=<id> öffnet genau diesen Batch.
  if (!_deepLinkHandled) {
    _deepLinkHandled = true;
    const openId = new URLSearchParams(window.location.search).get('open');
    const target = openId
      ? state.items.find((i) => String(i.id) === String(openId))
      : null;
    if (target) openItemModal(target);
  }
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

  // Der Weg von "3 件待补货" zum Einkaufszettel: ein Klick, statt jeden Artikel
  // einzeln nachzutragen. Im Auswahl-Modus übernimmt das die Auswahl-Leiste.
  if (counts.restock > 0 && !state.selectMode) {
    bar.insertAdjacentHTML('beforeend', `
      <button type="button" class="filter-chip filter-chip--action" id="hi-restock">
        <i data-lucide="shopping-cart" class="icon-sm" aria-hidden="true"></i>
        <span>${esc(t('homeInventory.restockToShopping'))}</span>
      </button>`);
    if (window.lucide) window.lucide.createIcons({ el: bar });
    bar.querySelector('#hi-restock')
      .addEventListener('click', () => restockItems([...new Set([...state.items]
        .filter((i) => { const s = homeItemStatus(i, state.todayKey); return s.out || s.low; })
        .map((i) => i.id))]));
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
  const cats = state.categories.filter((c) => counts.has(c.key));

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

  // Die Auswahl-Leiste hängt am Zustand (Modus + Anzahl), nicht an den Daten.
  renderSelectBar();

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
    // Ein Artikel = eine Karte. Mehrere MHDs bleiben eigene Zeilen (jede führt
    // ihre Menge selbst), aber die überzähligen starten eingeklappt: sonst
    // stehen nach drei Einkäufen drei fast gleiche Zeilen untereinander und die
    // Liste wächst mit jedem Einkauf.
    for (const product of groupByProduct(group.items)) {
      const expanded = state.expanded.has(product.key);
      product.rows.forEach((item, index) => {
        rows.appendChild(rowEl(item, batches.get(item.id), {
          productKey: product.key,
          batchCount: product.rows.length,
          primary: index === 0,
          hidden: index > 0 && !expanded,
        }));
      });
    }
    section.appendChild(rows);
    list.appendChild(section);
  }
  if (window.lucide) window.lucide.createIcons({ el: list });
}

/** Zeilen nach Artikel gruppieren (Reihenfolge bleibt die der Gruppe). */
function groupByProduct(items) {
  const byKey = new Map();
  for (const item of items) {
    const key = homeBatchKey(item);
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(item);
  }
  return [...byKey.entries()].map(([key, rows]) => ({
    key,
    rows: [...rows].sort(compareHomeBatches),
  }));
}

/** Alle Zeilen eines Artikels ein-/ausklappen. */
function toggleProduct(key) {
  if (state.expanded.has(key)) state.expanded.delete(key);
  else state.expanded.add(key);
  renderList();
}

// --------------------------------------------------------
// Mehrfach-Auswahl: 补货 / 删除 für mehrere Artikel auf einmal
// --------------------------------------------------------

function toggleSelectMode(on) {
  state.selectMode = on;
  state.selected.clear();
  renderSelectBar();
  renderStatusFilters();
  renderList();
}

function toggleSelected(id) {
  if (state.selected.has(id)) state.selected.delete(id);
  else state.selected.add(id);
  renderSelectBar();
  // Nur die betroffene Zeile neu zeichnen wäre schneller, aber der Zustand
  // hängt an Chips und Zählern — ein Neuaufbau ist hier billig und ehrlich.
  renderList();
}

function renderSelectBar() {
  const bar = _container?.querySelector('#hi-selectbar');
  if (!bar) return;
  if (!state.selectMode) {
    bar.hidden = true;
    bar.replaceChildren();
    return;
  }

  bar.hidden = false;
  const visible = visibleItems();
  const allSelected = visible.length > 0 && visible.every((i) => state.selected.has(i.id));
  const count = state.selected.size;

  bar.innerHTML = `
    <span class="hi-selectbar__count">${esc(t('homeInventory.selectedCount', { count }))}</span>
    <button type="button" class="btn btn--ghost btn--sm" data-act="all">
      ${esc(allSelected ? t('homeInventory.selectNone') : t('homeInventory.selectAll'))}
    </button>
    <button type="button" class="btn btn--secondary btn--sm" data-act="restock" ${count ? '' : 'disabled'}>
      ${esc(t('homeInventory.restockToShopping'))}
    </button>
    <button type="button" class="btn btn--danger-ghost btn--sm" data-act="delete" ${count ? '' : 'disabled'}>
      ${esc(t('homeInventory.batchDelete'))}
    </button>
    <button type="button" class="btn btn--ghost btn--sm" data-act="cancel">${esc(t('common.cancel'))}</button>`;

  bar.querySelector('[data-act="cancel"]').addEventListener('click', () => toggleSelectMode(false));
  bar.querySelector('[data-act="all"]').addEventListener('click', () => {
    if (allSelected) state.selected.clear();
    else for (const i of visible) state.selected.add(i.id);
    renderSelectBar();
    renderList();
  });
  bar.querySelector('[data-act="restock"]').addEventListener('click', () => restockItems([...state.selected]));
  bar.querySelector('[data-act="delete"]').addEventListener('click', () => deleteSelected());
}

/** Ausgewählte Batches löschen — mit Rückfrage, weil es mehrere sind. */
async function deleteSelected() {
  const ids = [...state.selected];
  if (!ids.length) return;
  const ok = await confirmModal(t('homeInventory.batchDeleteConfirm', { count: ids.length }), {
    danger: true,
    confirmLabel: t('homeInventory.batchDelete'),
  });
  if (!ok) return;

  let removed = 0;
  for (const id of ids) {
    try {
      await api.delete(`/home-inventory/${id}`);
      state.items = state.items.filter((i) => i.id !== id);
      removed += 1;
    } catch (err) {
      window.yuvomi?.showToast(err.data?.error ?? t('common.errorGeneric'), 'danger');
    }
  }
  state.selected.clear();
  state.selectMode = false;
  renderStatusFilters();
  renderFilters();
  renderList();
  if (removed) window.yuvomi?.showToast(t('homeInventory.batchDeleted', { count: removed }), 'success');
}

/**
 * Artikel in die Einkaufsliste übertragen. Mehrere auf einmal, weil man nach
 * dem Aufräumen selten genau einen Artikel nachkaufen muss.
 * @param {number[]|null} ids null = der Server nimmt alles, was Nachschub braucht
 */
async function restockItems(ids) {
  const btn = _container?.querySelector('#hi-restock');
  if (btn) btn.disabled = true;
  try {
    const res = await api.post('/home-inventory/restock', ids?.length ? { ids } : {});
    const { added, skipped } = res.data;
    const parts = [t('homeInventory.restockDone', { count: added })];
    if (skipped) parts.push(t('homeInventory.restockSkipped', { count: skipped }));
    window.yuvomi?.showToast(parts.join(' · '), added ? 'success' : 'info');
    if (state.selectMode) toggleSelectMode(false);
  } catch (err) {
    window.yuvomi?.showToast(err.data?.error ?? t('common.errorGeneric'), 'danger');
  } finally {
    if (btn) btn.disabled = false;
  }
}

/**
 * Nach unten ziehen lädt neu — die Geste, die man auf dem Handy erwartet.
 * Nur am oberen Rand und nur mit Finger: sonst kapert sie das Scrollen.
 */
function wirePullToRefresh(listEl) {
  let startY = null;
  let pulled = 0;

  listEl.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 1) return;
    const scroller = listEl.closest('.page-content') ?? document.scrollingElement;
    const atTop = !scroller || scroller.scrollTop <= 0;
    startY = atTop ? e.touches[0].clientY : null;
    pulled = 0;
  }, { passive: true });

  listEl.addEventListener('touchmove', (e) => {
    if (startY === null) return;
    pulled = Math.max(0, e.touches[0].clientY - startY);
    if (pulled > 10) listEl.classList.add('hi-pulling');
  }, { passive: true });

  const end = async () => {
    if (startY === null) return;
    const shouldReload = pulled > 70;
    startY = null;
    pulled = 0;
    listEl.classList.remove('hi-pulling');
    if (!shouldReload) return;
    try {
      const res = await api.get('/home-inventory');
      state.items = res.data;
      state.todayKey = localDateKey();
      renderStatusFilters();
      renderFilters();
      renderList();
      window.yuvomi?.showToast(t('homeInventory.refreshed'), 'info');
    } catch {
      /* still: das nächste Öffnen lädt ohnehin neu */
    }
  };
  listEl.addEventListener('touchend', end);
  listEl.addEventListener('touchcancel', end);
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

function rowEl(item, batch, opts = {}) {
  const { productKey, batchCount = 1, primary = true, hidden = false } = opts;
  const status = homeItemStatus(item, state.todayKey);
  const selected = state.selected.has(item.id);

  const li = document.createElement('li');
  li.className = `list-row pantry-row${status.out ? ' pantry-row--out' : ''}`
    + (primary ? '' : ' hi-batch-extra')
    + (state.selectMode && selected ? ' is-selected' : '');
  li.dataset.id = item.id;
  li.hidden = hidden;

  // Klickfläche: öffnet das Bearbeiten-Formular. Die Stepper-Buttons daneben
  // sind eigene Stops und dürfen nicht durchschlagen. Im Auswahl-Modus wählt
  // derselbe Klick aus, statt zu bearbeiten.
  const main = document.createElement('button');
  main.type = 'button';
  main.className = 'list-row__main list-row__main--interactive pantry-row__main';
  main.dataset.action = 'edit';

  if (state.selectMode) {
    const box = document.createElement('span');
    box.className = `hi-check${selected ? ' hi-check--on' : ''}`;
    box.setAttribute('aria-hidden', 'true');
    box.innerHTML = '<i data-lucide="check" class="icon-sm"></i>';
    main.appendChild(box);
  }

  // Name und Status in EINER Zeile — dieselbe Grammatik wie die Küchen-Vorräte.
  const headline = document.createElement('span');
  headline.className = 'pantry-row__headline';
  const name = document.createElement('span');
  name.className = 'list-row__name';
  name.textContent = item.name;
  headline.appendChild(name);
  for (const badge of [stockBadge(item), expiryBadge(item), daysLeftBadge(item, primary)].filter(Boolean)) {
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
  if (item.location) metaParts.push(locLabel(item.location));
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

  // Mehrere Batches: die erste Zeile trägt den Schalter für die übrigen.
  if (primary && batchCount > 1) {
    const collapsed = !state.expanded.has(productKey);
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'pantry-stepper__btn hi-batches__toggle';
    toggle.dataset.action = 'toggle-batches';
    toggle.setAttribute('aria-expanded', String(!collapsed));
    toggle.setAttribute('aria-label', t(collapsed ? 'homeInventory.batchToggle' : 'homeInventory.batchToggleClose', { count: batchCount - 1 }));
    toggle.title = toggle.getAttribute('aria-label');
    toggle.innerHTML = collapsed
      ? `<i data-lucide="chevron-down" class="icon-sm" aria-hidden="true"></i><span>${batchCount}</span>`
      : '<i data-lucide="chevron-up" class="icon-sm" aria-hidden="true"></i>';
    toggle.addEventListener('click', () => toggleProduct(productKey));
    actions.appendChild(toggle);
  }

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

  main.addEventListener('click', () => {
    if (state.selectMode) toggleSelected(item.id);
    else openItemModal(item);
  });
  // Kurz tippen = ein Schritt, gedrückt halten = durchlaufen. Der Netzaufruf
  // wird gebündelt (siehe stepQty), damit Halten nicht 30 Requests erzeugt.
  minus.addEventListener('click', () => stepQty(item, -QTY_STEP, value));
  plus.addEventListener('click', () => stepQty(item, +QTY_STEP, value));
  wireLongPress(minus, () => { if (!minus.disabled) stepQty(item, -QTY_STEP, value); });
  wireLongPress(plus, () => stepQty(item, +QTY_STEP, value));
  return li;
}

/**
 * Gibt es eine Verbrauchsprognose, ist "noch ~N Tage" die nützlichste Zahl auf
 * der Zeile — sie beantwortet, ob man diese Woche nachkaufen muss. Nur auf der
 * ersten Zeile eines Artikels: an jedem Batch dieselbe Zahl wäre Rauschen.
 */
function daysLeftBadge(item, primary) {
  if (!primary) return null;
  const days = item.days_left;
  if (days == null || days > 60) return null;
  return { tone: days <= 7 ? 'warning' : 'neutral', text: t('homeInventory.daysLeft', { count: days }) };
}

/** Gedrückt halten → wiederholen (Handy-Geste für "+5"). */
function wireLongPress(btn, action) {
  let delay = null;
  let repeat = null;
  const stop = () => {
    clearTimeout(delay);
    clearInterval(repeat);
    delay = null;
    repeat = null;
  };
  btn.addEventListener('pointerdown', (e) => {
    if (btn.disabled || (e.pointerType === 'mouse' && e.button !== 0)) return;
    delay = setTimeout(() => {
      repeat = setInterval(action, 160);
    }, 450);
  });
  for (const evt of ['pointerup', 'pointerleave', 'pointercancel', 'blur']) {
    btn.addEventListener(evt, stop);
  }
}

// --------------------------------------------------------
// Aktionen
// --------------------------------------------------------

/** Ausstehende Mengen-Buchungen je Batch — Halten erzeugt genau einen Request. */
const _stepTimers = new Map();

/**
 * Menge lokal verändern und gebündelt an den Server schicken.
 *
 * Vorher war jeder Klick ein Request: bei "gedrückt halten" wären das dutzende
 * Aufrufe hintereinander, die sich gegenseitig überholen könnten. Jetzt zeigt
 * die Zeile sofort den neuen Wert, und 260 ms nach dem letzten Klick geht EIN
 * PATCH mit dem Endstand raus.
 */
function stepQty(item, delta, valueEl) {
  const next = normalizeHomeQuantity((Number(item.quantity) || 0) + delta, { fallback: item.quantity });
  item.quantity = next;
  if (valueEl) valueEl.textContent = fmtQty(next);
  valueEl?.closest('.pantry-row')?.classList.toggle('pantry-row--out', next <= 0);

  clearTimeout(_stepTimers.get(item.id));
  _stepTimers.set(item.id, setTimeout(() => {
    _stepTimers.delete(item.id);
    commitQty(item);
  }, 260));
}

/** Gebuchte Menge festschreiben; bei Fehler den Serverstand zurückholen. */
async function commitQty(item) {
  try {
    const res = await api.patch(`/home-inventory/${item.id}`, { quantity: item.quantity });
    Object.assign(item, res.data);
  } catch (err) {
    try {
      const fresh = await api.get('/home-inventory');
      state.items = fresh.data;
    } catch { /* Netzwege gescheitert: alter Stand bleibt stehen */ }
    window.yuvomi?.showToast(err.data?.error ?? t('common.errorGeneric'), 'danger');
  }
  // Statusübertritt (0, Schwelle) ändert Badges und Chips → neu zeichnen.
  renderStatusFilters();
  renderFilters();
  renderList();
}

/** Auswahlliste für ein Select (Kategorien, Einheiten oder Lagerorte). */
function optionHtml(entry, kind) {
  const label = kind === 'category'
    ? catLabel(entry.key)
    : kind === 'location'
      ? locLabel(entry.key)
      : unitLabel(entry.key);
  return `<option value="${esc(entry.key)}">${esc(label)}</option>`;
}

/**
 * Ein Modal für beide Modi (create/edit).
 *
 * Aufbau: die Pflichtfelder stehen offen (Name, Menge, Einheit, Kategorie,
 * 有效期, 存放位置), nur 低量提醒 und 备注 liegen unter "更多设置". 存放位置
 * stand vorher in den更多设置 — dort wurde es übersehen, obwohl es beim
 * Einräumen die eigentliche Frage beantwortet ("wohin damit?").
 */
function openItemModal(item = null) {
  const isEdit = !!item;
  const catOptions = state.categories.map((c) => optionHtml(c, 'category')).join('');
  const unitOptions = state.units.map((u) => optionHtml(u, 'unit')).join('');
  // Leere Auswahl zuerst: 存放位置 ist optional, das Feld darf leer bleiben.
  const locOptions = [
    `<option value="">${esc(t('homeInventory.locationNone'))}</option>`,
    ...state.locations.map((l) => optionHtml(l, 'location')),
  ].join('');
  openSharedModal({
    title: isEdit ? t('common.editItem') : t('homeInventory.addItem'),
    size: 'md',
    content: `
      ${isEdit ? '' : `<details class="hi-templates">
        <summary class="hi-templates__summary">
          <span>${esc(t('homeInventory.templatesHeading'))}</span>
          <i data-lucide="chevron-down" class="hi-templates__chevron" aria-hidden="true"></i>
        </summary>
        <div class="hi-templates__chips">
          ${HOME_ITEM_TEMPLATES.map((tpl) => `<button type="button" class="filter-chip hi-tpl" data-tpl="${esc(tpl.key)}">
            ${esc(t(`homeInventory.tpl.${tpl.key}`))}
          </button>`).join('')}
        </div>
      </details>`}
      <div class="form-group">
        <div class="form-label-row">
          <label class="form-label" for="hi-name">${esc(t('homeInventory.nameLabel'))}</label>
          <button type="button" class="hi-addbtn" id="hi-scan">
            <i data-lucide="scan-line" class="icon-sm" aria-hidden="true"></i>${esc(t('homeInventory.scanBarcode'))}
          </button>
        </div>
        <input id="hi-name" class="form-input" type="text" required
               placeholder="${esc(t('homeInventory.namePlaceholder'))}">
        <p class="form-hint" id="hi-name-hint" hidden></p>
      </div>
      <div class="pantry-form-row">
        <div class="form-group">
          <div class="form-label-row">
            <label class="form-label" for="hi-quantity">${esc(t('homeInventory.quantityLabel'))}</label>
          </div>
          <input id="hi-quantity" class="form-input" type="number" min="0" step="any"
                 inputmode="decimal" required>
        </div>
        <div class="form-group">
          <div class="form-label-row">
            <label class="form-label" for="hi-unit">${esc(t('homeInventory.unitLabel'))}</label>
            <button type="button" class="hi-addbtn" id="hi-unit-add">
              <i data-lucide="plus" class="icon-sm" aria-hidden="true"></i>${esc(t('homeInventory.optAdd'))}
            </button>
          </div>
          <select id="hi-unit" class="form-input" required>${unitOptions}</select>
          <div class="hi-quickadd" id="hi-unit-quick" hidden>
            <input id="hi-unit-new" class="form-input" type="text"
                   maxlength="${homeOptionMaxLength('unit')}"
                   placeholder="${esc(t('homeInventory.optUnitPlaceholder'))}">
            <button type="button" class="btn btn--secondary hi-quickadd__ok" id="hi-unit-ok">${esc(t('homeInventory.optSave'))}</button>
          </div>
        </div>
      </div>
      <div class="pantry-form-row">
        <div class="form-group">
          <div class="form-label-row">
            <label class="form-label" for="hi-category">${esc(t('homeInventory.categoryLabel'))}</label>
            <button type="button" class="hi-addbtn" id="hi-category-add">
              <i data-lucide="plus" class="icon-sm" aria-hidden="true"></i>${esc(t('homeInventory.optAdd'))}
            </button>
          </div>
          <select id="hi-category" class="form-input" required>${catOptions}</select>
          <div class="hi-quickadd" id="hi-category-quick" hidden>
            <input id="hi-category-new" class="form-input" type="text"
                   maxlength="${homeOptionMaxLength('category')}"
                   placeholder="${esc(t('homeInventory.optCatPlaceholder'))}">
            <button type="button" class="btn btn--secondary hi-quickadd__ok" id="hi-category-ok">${esc(t('homeInventory.optSave'))}</button>
          </div>
        </div>
        <div class="form-group">
          <div class="form-label-row">
            <label class="form-label" for="hi-expires">${esc(t('homeInventory.expiresLabel'))}</label>
          </div>
          <yuvomi-datepicker id="hi-expires" type="date"
                             value="${esc(isEdit && item.expires_on ? item.expires_on : '')}"></yuvomi-datepicker>
        </div>
      </div>
      <div class="form-group">
        <div class="form-label-row">
          <label class="form-label" for="hi-location">${esc(t('homeInventory.locationLabel'))}</label>
          <button type="button" class="hi-addbtn" id="hi-location-add">
            <i data-lucide="plus" class="icon-sm" aria-hidden="true"></i>${esc(t('homeInventory.optAdd'))}
          </button>
        </div>
        <select id="hi-location" class="form-input">${locOptions}</select>
        <div class="hi-quickadd" id="hi-location-quick" hidden>
          <input id="hi-location-new" class="form-input" type="text"
                 maxlength="${homeOptionMaxLength('location')}"
                 placeholder="${esc(t('homeInventory.optLocPlaceholder'))}">
          <button type="button" class="btn btn--secondary hi-quickadd__ok" id="hi-location-ok">${esc(t('homeInventory.optSave'))}</button>
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
          <label class="form-label" for="hi-notes">${esc(t('homeInventory.notesLabel'))}</label>
          <textarea id="hi-notes" class="form-input" rows="2"
                    placeholder="${esc(t('homeInventory.notesPlaceholder'))}"></textarea>
        </div>
        <div class="form-group">
          <label class="form-label" for="hi-barcode">${esc(t('homeInventory.barcodeLabel'))}</label>
          <input id="hi-barcode" class="form-input" type="text" inputmode="numeric"
                 maxlength="64" autocomplete="off">
          <p class="form-hint">${esc(t('homeInventory.scanHint'))}</p>
        </div>`,
        { open: isEdit && (item.min_quantity != null || !!item.notes) })}
      ${isEdit ? `<section class="hi-history" id="hi-history" hidden></section>` : ''}
      <div class="modal-panel__footer modal-panel__footer--plain">
        ${isEdit ? `<button type="button" class="btn btn--danger-ghost pantry-form__delete" id="hi-delete">${esc(t('common.delete'))}</button>` : ''}
        <button type="button" class="btn btn--secondary" data-action="close-modal">${esc(t('common.cancel'))}</button>
        <button type="button" class="btn btn--primary" id="hi-save">${esc(isEdit ? t('common.save') : t('common.add'))}</button>
      </div>`,
    onSave(panel) {
      const nameInput = panel.querySelector('#hi-name');
      nameInput.value = isEdit ? item.name : '';
      panel.querySelector('#hi-quantity').value = isEdit ? String(item.quantity) : '1';
      panel.querySelector('#hi-unit').value = isEdit ? item.unit : DEFAULT_HOME_UNIT;
      panel.querySelector('#hi-category').value = isEdit ? item.category : DEFAULT_HOME_CATEGORY;
      panel.querySelector('#hi-min').value = isEdit && item.min_quantity != null ? String(item.min_quantity) : '';
      panel.querySelector('#hi-location').value = isEdit && item.location ? item.location : '';
      panel.querySelector('#hi-notes').value = isEdit && item.notes ? item.notes : '';
      panel.querySelector('#hi-barcode').value = isEdit && item.barcode ? item.barcode : '';

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

      wireQuickAdd(panel, 'category');
      wireQuickAdd(panel, 'unit');
      wireQuickAdd(panel, 'location');
      wireTemplates(panel);
      panel.querySelector('#hi-scan')?.addEventListener('click', () => openScanner(panel));
      if (isEdit) loadHistory(panel, item);

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

/**
 * UI-Verdrahtung je Optionstyp: wo die Felder im Artikelformular liegen, wie
 * die Liste heißt und wie ein neuer Eintrag aussieht. Eine Tabelle statt
 * dreimal derselbe Ablauf.
 */
const OPTION_UI = Object.freeze({
  category: {
    ids: { trigger: '#hi-category-add', wrap: '#hi-category-quick', input: '#hi-category-new', ok: '#hi-category-ok', select: '#hi-category' },
    endpoint: '/home-inventory/categories',
    list: () => state.categories,
    entry: (d) => ({ key: d.name, icon: d.icon || 'tag', custom: true, id: d.id }),
    // Vor "其他" einhängen — "其他" bleibt der letzte Eintrag.
    insert(list, entry) {
      const idx = list.findIndex((e) => e.key === 'other');
      list.splice(idx === -1 ? list.length : idx, 0, entry);
    },
  },
  unit: {
    ids: { trigger: '#hi-unit-add', wrap: '#hi-unit-quick', input: '#hi-unit-new', ok: '#hi-unit-ok', select: '#hi-unit' },
    endpoint: '/home-inventory/units',
    list: () => state.units,
    entry: (d) => ({ key: d.name, custom: true, id: d.id }),
    insert(list, entry) { list.push(entry); },
  },
  location: {
    ids: { trigger: '#hi-location-add', wrap: '#hi-location-quick', input: '#hi-location-new', ok: '#hi-location-ok', select: '#hi-location' },
    endpoint: '/home-inventory/locations',
    list: () => state.locations,
    entry: (d) => ({ key: d.name, custom: true, id: d.id }),
    insert(list, entry) { list.push(entry); },
  },
});

/**
 * Eigenen Eintrag anlegen und in die lokale Liste aufnehmen. Gibt den Eintrag
 * zurück, damit der Aufrufer ihn direkt auswählen kann.
 * @param {'category'|'unit'|'location'} kind
 * @param {string} name bereits normalisierter Name
 */
async function createOption(kind, name) {
  const cfg = OPTION_UI[kind];
  const res = await api.post(cfg.endpoint, { name });
  const entry = cfg.entry(res.data);
  const list = cfg.list();
  cfg.insert(list, entry);
  return entry;
}

/**
 * Inline-Anlegen einer eigenen Kategorie/Einheit/eines Lagerorts direkt im
 * Artikelformular. Kein zweites Modal: das Formular bleibt gefüllt, der neue
 * Eintrag ist danach sofort ausgewählt.
 * @param {HTMLElement} panel
 * @param {'category'|'unit'|'location'} kind
 */
function wireQuickAdd(panel, kind) {
  const cfg = OPTION_UI[kind];
  const pick = (sel) => panel.querySelector(sel);
  const trigger = pick(cfg.ids.trigger);
  const wrap = pick(cfg.ids.wrap);
  const input = pick(cfg.ids.input);
  const okBtn = pick(cfg.ids.ok);
  const select = pick(cfg.ids.select);
  if (!trigger || !wrap || !input || !okBtn || !select) return;
  const max = homeOptionMaxLength(kind);

  const close = () => {
    wrap.hidden = true;
    trigger.hidden = false;
    input.value = '';
  };

  trigger.addEventListener('click', () => {
    trigger.hidden = true;
    wrap.hidden = false;
    input.focus();
  });

  const submit = async () => {
    const name = normalizeHomeOptionName(input.value);
    const verdict = checkHomeOptionName(name, kind);
    if (verdict === 'required') return reportFieldError(input, t('homeInventory.optRequired'));
    if (verdict === 'too-long') {
      return reportFieldError(input, t('homeInventory.optTooLong', { max }));
    }
    if (verdict === 'reserved') return reportFieldError(input, t('homeInventory.optExists'));

    if (cfg.list().some((e) => e.key.toLowerCase() === name.toLowerCase())) {
      return reportFieldError(input, t('homeInventory.optExists'));
    }

    okBtn.disabled = true;
    try {
      const entry = await createOption(kind, name);
      // Auswahl neu aufbauen statt nur anzuhängen: die Option soll an derselben
      // Stelle stehen wie in der Liste (bei Kategorien vor "其他").
      select.innerHTML = cfg.list().map((e) => optionHtml(e, kind)).join('');
      if (kind === 'location') {
        select.insertAdjacentHTML('afterbegin', `<option value="">${esc(t('homeInventory.locationNone'))}</option>`);
      }
      select.value = entry.key;
      close();
      window.yuvomi?.showToast(t('homeInventory.optAdded', { name: entry.key }), 'success');
    } catch (err) {
      reportFieldError(input, err.data?.error ?? t('common.errorGeneric'));
    } finally {
      okBtn.disabled = false;
    }
  };

  okBtn.addEventListener('click', submit);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      submit();
    } else if (e.key === 'Escape') {
      e.stopPropagation();
      close();
    }
  });
}

/**
 * 常用物品模板：点一下填好骨架。
 *
 * 名字来自 i18n（homeInventory.tpl.<key>），类别/单位/位置用固定键 —— 模板
 * 不该把中文名写死进数据，否则换个语言界面就会得到一堆中文商品。
 */
function wireTemplates(panel) {
  const box = panel.querySelector('.hi-templates');
  const chips = panel.querySelectorAll('.hi-tpl');
  for (const btn of chips) {
    btn.addEventListener('click', () => {
      const tpl = HOME_ITEM_TEMPLATES.find((x) => x.key === btn.dataset.tpl);
      if (!tpl) return;
      const nameInput = panel.querySelector('#hi-name');
      nameInput.value = t(`homeInventory.tpl.${tpl.key}`);
      panel.querySelector('#hi-category').value = tpl.category;
      panel.querySelector('#hi-unit').value = tpl.unit;
      panel.querySelector('#hi-location').value = tpl.location || '';
      const minInput = panel.querySelector('#hi-min');
      if (minInput && !minInput.value) minInput.value = String(tpl.min_quantity ?? 1);

      chips.forEach((b) => b.classList.remove('filter-chip--active'));
      btn.classList.add('filter-chip--active');
      // 选完就收起：模板是"一次性骨架"，填好之后那块列表只是挡路。
      if (box) box.open = false;
      nameInput.focus({ preventScroll: true });
      nameInput.select?.();
      nameInput.dispatchEvent(new Event('input', { bubbles: true }));
    });
  }
}

/**
 * 扫一扫：条码 → 表单。
 *
 * Drei Fälle: Gerät kann nicht scannen (Hinweis), Code ist neu (nur den Code
 * merken, Name bleibt Handarbeit), Code ist bekannt (Name/Kategorie/Einheit/
 * Lagerort aus dem letzten Datensatz übernehmen — genau die Felder, die man
 * sonst jedes Mal neu tippt).
 */
function openScanner(panel) {
  if (!('BarcodeDetector' in window)) {
    window.yuvomi?.showToast(t('homeInventory.scanUnsupported'), 'danger');
    panel.querySelector('#hi-barcode')?.focus();
    return;
  }

  const overlay = document.createElement('div');
  overlay.className = 'hi-scan';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.innerHTML = `
    <div class="hi-scan__panel">
      <video class="hi-scan__video" playsinline muted></video>
      <p class="hi-scan__hint">${esc(t('homeInventory.scanHint'))}</p>
      <button type="button" class="btn btn--secondary" data-act="close">${esc(t('homeInventory.scanClose'))}</button>
    </div>`;
  document.body.appendChild(overlay);

  const video = overlay.querySelector('video');
  let stream = null;
  let timer = null;
  let stopped = false;

  const stop = () => {
    stopped = true;
    clearTimeout(timer);
    stream?.getTracks().forEach((track) => track.stop());
    overlay.remove();
  };

  overlay.querySelector('[data-act="close"]').addEventListener('click', stop);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) stop(); });

  const detector = new window.BarcodeDetector({
    formats: ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128', 'code_39', 'qr_code'],
  });

  const tick = async () => {
    if (stopped) return;
    try {
      const codes = await detector.detect(video);
      if (codes.length && codes[0].rawValue) {
        const code = codes[0].rawValue;
        stop();
        applyScan(panel, code);
        return;
      }
    } catch {
      // Einzelne Fehlschläge sind normal (Bewegungsunschärfe) — weiter versuchen.
    }
    timer = setTimeout(tick, 300);
  };

  navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } })
    .then((s) => {
      stream = s;
      video.srcObject = s;
      video.play().catch(() => {});
      tick();
    })
    .catch(() => {
      stop();
      window.yuvomi?.showToast(t('homeInventory.scanUnsupported'), 'danger');
    });
}

/** Scan-Ergebnis in das Formular übernehmen. */
async function applyScan(panel, rawCode) {
  const code = normalizeHomeBarcode(rawCode);
  if (!code) {
    window.yuvomi?.showToast(t('homeInventory.scanFailed'), 'danger');
    return;
  }
  const barcodeInput = panel.querySelector('#hi-barcode');
  if (barcodeInput) barcodeInput.value = code;

  try {
    const res = await api.get(`/home-inventory/barcode/${encodeURIComponent(code)}`);
    const hit = res.data;
    panel.querySelector('#hi-name').value = hit.name;
    panel.querySelector('#hi-category').value = hit.category;
    panel.querySelector('#hi-unit').value = hit.unit;
    panel.querySelector('#hi-location').value = hit.location || '';
    if (hit.min_quantity != null) panel.querySelector('#hi-min').value = String(hit.min_quantity);
    window.yuvomi?.showToast(t('homeInventory.scanMatched', { name: hit.name }), 'success');
  } catch (err) {
    if (err?.status === 404) {
      window.yuvomi?.showToast(t('homeInventory.scanNoMatch'), 'info');
      panel.querySelector('#hi-name').focus({ preventScroll: true });
    } else {
      window.yuvomi?.showToast(err.data?.error ?? t('common.errorGeneric'), 'danger');
    }
  }
}

/** 最近变动：5 条流水 + 90 天用掉多少。 */
async function loadHistory(panel, item) {
  const box = panel.querySelector('#hi-history');
  if (!box) return;
  try {
    const res = await api.get(`/home-inventory/${item.id}/history?limit=5`);
    const { logs = [], consumed90 = 0 } = res.data || {};
    if (!logs.length) {
      box.hidden = true;
      return;
    }
    const labels = {
      create: 'historyCreated',
      edit: 'historyEdit',
      adjust: 'historyAdjust',
      shopping: 'historyShopping',
      restock: 'historyRestock',
    };
    box.hidden = false;
    box.innerHTML = `
      <h3 class="hi-manage__title">${esc(t('homeInventory.historyHeading'))}</h3>
      ${consumed90 ? `<p class="form-hint">${esc(t('homeInventory.consumed90', { count: fmtQty(consumed90) }))}</p>` : ''}
      <ul class="hi-history__list">
        ${logs.map((entry) => `<li class="hi-history__row">
          <span class="hi-history__delta ${entry.delta > 0 ? 'is-in' : 'is-out'}">${entry.delta > 0 ? '+' : ''}${fmtQty(entry.delta)}</span>
          <span class="hi-history__reason">${esc(t(`homeInventory.${labels[entry.reason] || 'historyAdjust'}`))}</span>
          <span class="hi-history__meta">${esc(formatDate(entry.created_at))}${entry.user_name ? ` · ${esc(entry.user_name)}` : ''}</span>
        </li>`).join('')}
      </ul>`;
  } catch {
    box.hidden = true;
  }
}

/**
 * Verwaltung der eigenen Kategorien/Einheiten/Lagerorte: umbenennen (zieht
 * Artikel mit), löschen (nur ohne Verwendung). Feste Einträge stehen hier nicht
 * — sie sind Teil des Codes und nicht löschbar.
 */
function openManageModal() {
  const section = (kind, heading, placeholder) => `
      <section class="hi-manage" data-kind="${kind}">
        <h3 class="hi-manage__title">${esc(heading)}</h3>
        <div class="hi-manage__list" id="hi-manage-${kind}"></div>
        <div class="hi-quickadd">
          <input id="hi-manage-${kind}-new" class="form-input" type="text"
                 maxlength="${homeOptionMaxLength(kind)}"
                 placeholder="${esc(placeholder)}">
          <button type="button" class="btn btn--secondary hi-quickadd__ok" id="hi-manage-${kind}-add">${esc(t('homeInventory.optAdd'))}</button>
        </div>
      </section>`;

  openSharedModal({
    title: t('homeInventory.manage'),
    size: 'md',
    content: `
      <p class="form-hint">${esc(t('homeInventory.optManageHint'))}</p>
      ${section('category', t('homeInventory.optCategoryHeading'), t('homeInventory.optCatPlaceholder'))}
      ${section('unit', t('homeInventory.optUnitHeading'), t('homeInventory.optUnitPlaceholder'))}
      ${section('location', t('homeInventory.optLocationHeading'), t('homeInventory.optLocPlaceholder'))}
      <div class="modal-panel__footer modal-panel__footer--plain">
        <button type="button" class="btn btn--primary" data-action="close-modal">${esc(t('common.close'))}</button>
      </div>`,
    onSave(panel) {
      for (const kind of ['category', 'unit', 'location']) {
        renderManageList(panel, kind);
        wireManageAdd(panel, kind);
      }
      if (window.lucide) window.lucide.createIcons({ el: panel });
    },
  });
}

/** Anzahl Artikel, die einen eigenen Eintrag benutzen (Löschsperre im UI). */
function usageOf(kind, key) {
  const field = itemFieldOf(kind);
  return state.items.filter((i) => String(i[field] ?? '') === key).length;
}

/** Feld im Artikel, das auf den Eintrag zeigt. */
function itemFieldOf(kind) {
  return kind === 'category' ? 'category' : kind === 'location' ? 'location' : 'unit';
}

function renderManageList(panel, kind) {
  const box = panel.querySelector(`#hi-manage-${kind}`);
  if (!box) return;
  // Altdaten-Orte (legacy) haben keine ID und stehen nicht in der DB — sie
  // gehören nur in die Auswahl des Formulars, nicht in die Verwaltung.
  const list = OPTION_UI[kind].list().filter((e) => e.custom && !e.legacy);

  if (!list.length) {
    box.innerHTML = `<p class="hi-manage__empty">${esc(t('homeInventory.optNone'))}</p>`;
    return;
  }

  box.innerHTML = list.map((entry) => {
    const used = usageOf(kind, entry.key);
    return `
      <div class="hi-option-row" data-id="${esc(entry.id)}" data-key="${esc(entry.key)}">
        <input class="form-input hi-option-row__input" type="text"
               maxlength="${homeOptionMaxLength(kind)}" value="${esc(entry.key)}"
               aria-label="${esc(entry.key)}">
        <span class="hi-option-row__usage">${esc(t('homeInventory.optUsage', { count: used }))}</span>
        <button type="button" class="hi-iconbtn" data-act="rename"
                title="${esc(t('common.save'))}" aria-label="${esc(t('common.save'))}">
          <i data-lucide="check" class="icon-sm" aria-hidden="true"></i>
        </button>
        <button type="button" class="hi-iconbtn hi-iconbtn--danger" data-act="delete"
                title="${esc(used ? t('homeInventory.optInUse', { count: used }) : t('common.delete'))}"
                aria-label="${esc(t('common.delete'))}"${used ? ' disabled' : ''}>
          <i data-lucide="trash-2" class="icon-sm" aria-hidden="true"></i>
        </button>
      </div>`;
  }).join('');
  if (window.lucide) window.lucide.createIcons({ el: box });

  for (const row of box.querySelectorAll('.hi-option-row')) {
    const id = row.dataset.id;
    const key = row.dataset.key;
    row.querySelector('[data-act="rename"]').addEventListener('click', () => {
      renameOption(panel, kind, id, row);
    });
    row.querySelector('[data-act="delete"]').addEventListener('click', () => {
      deleteOption(panel, kind, id, key);
    });
  }
}

function wireManageAdd(panel, kind) {
  const input = panel.querySelector(`#hi-manage-${kind}-new`);
  const btn = panel.querySelector(`#hi-manage-${kind}-add`);
  if (!input || !btn) return;
  const max = homeOptionMaxLength(kind);

  const submit = async () => {
    const name = normalizeHomeOptionName(input.value);
    const verdict = checkHomeOptionName(name, kind);
    if (verdict === 'required') return reportFieldError(input, t('homeInventory.optRequired'));
    if (verdict === 'too-long') {
      return reportFieldError(input, t('homeInventory.optTooLong', { max }));
    }
    if (verdict === 'reserved') return reportFieldError(input, t('homeInventory.optExists'));
    if (OPTION_UI[kind].list().some((e) => e.key.toLowerCase() === name.toLowerCase())) {
      return reportFieldError(input, t('homeInventory.optExists'));
    }

    btn.disabled = true;
    try {
      const entry = await createOption(kind, name);
      input.value = '';
      renderManageList(panel, kind);
      renderFilters();
      renderList();
      window.yuvomi?.showToast(t('homeInventory.optAdded', { name: entry.key }), 'success');
    } catch (err) {
      reportFieldError(input, err.data?.error ?? t('common.errorGeneric'));
    } finally {
      btn.disabled = false;
    }
  };

  btn.addEventListener('click', submit);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      submit();
    }
  });
}

async function renameOption(panel, kind, optionId, row) {
  const oldKey = row.dataset.key;
  const input = row.querySelector('.hi-option-row__input');
  const name = normalizeHomeOptionName(input.value);
  if (name === oldKey) return;

  const max = homeOptionMaxLength(kind);
  const verdict = checkHomeOptionName(name, kind);
  if (verdict === 'required') return reportFieldError(input, t('homeInventory.optRequired'));
  if (verdict === 'too-long') return reportFieldError(input, t('homeInventory.optTooLong', { max }));
  if (verdict === 'reserved') return reportFieldError(input, t('homeInventory.optExists'));

  try {
    await api.put(`${OPTION_UI[kind].endpoint}/${optionId}`, { name });
    // Lokal nachziehen: Eintrag + alle Artikel, die ihn benutzen.
    const entry = OPTION_UI[kind].list().find((e) => String(e.id) === String(optionId));
    if (entry) entry.key = name;
    const field = itemFieldOf(kind);
    for (const item of state.items) {
      if (String(item[field] ?? '') === oldKey) item[field] = name;
    }
    renderManageList(panel, kind);
    renderStatusFilters();
    renderFilters();
    renderList();
    window.yuvomi?.showToast(t('homeInventory.optRenamed', { name }), 'success');
  } catch (err) {
    reportFieldError(input, err.data?.error ?? t('common.errorGeneric'));
  }
}

async function deleteOption(panel, kind, optionId, key) {
  try {
    await api.delete(`${OPTION_UI[kind].endpoint}/${optionId}`);
    const list = OPTION_UI[kind].list();
    const idx = list.findIndex((e) => String(e.id) === String(optionId));
    if (idx !== -1) list.splice(idx, 1);
    renderManageList(panel, kind);
    renderStatusFilters();
    renderFilters();
    renderList();
    window.yuvomi?.showToast(t('homeInventory.optDeleted', { name: key }), 'success');
  } catch (err) {
    window.yuvomi?.showToast(err.data?.error ?? t('common.errorGeneric'), 'danger');
  }
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

  // 条码只收合法形状：误扫的收据号/网址不该进库，否则下次扫码会命中垃圾数据。
  const barcodeInput = panel.querySelector('#hi-barcode');
  const barcodeRaw = barcodeInput ? barcodeInput.value.trim() : '';
  if (barcodeRaw && !isValidHomeBarcode(barcodeRaw)) {
    reportFieldError(barcodeInput, t('homeInventory.scanFailed'));
    return;
  }

  const payload = {
    name,
    quantity: normalizeHomeQuantity(qtyNumber, { fallback: 0 }),
    unit: panel.querySelector('#hi-unit').value,
    category: panel.querySelector('#hi-category').value,
    expires_on: expiresOn || null,
    location: panel.querySelector('#hi-location').value.trim() || null,
    min_quantity: minRaw === '' ? null : normalizeHomeQuantity(minRaw, { fallback: 0 }),
    notes: panel.querySelector('#hi-notes').value.trim() || null,
    barcode: barcodeRaw ? normalizeHomeBarcode(barcodeRaw) : null,
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
