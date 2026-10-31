/**
 * Seite: Geschenk-/Geld-Register (Gift Ledger)
 * 红事 (red, freudiger Anlass) / 白事 (white, Trauerfall) mit Datum, Schenker,
 * Betrag, Verhältnis, Notiz.
 *
 * Konvention: `red` = 红事/喜事 (Hochzeit, Geburt) — `white` = 白事/丧事 (Trauerfeier).
 * Die DB-CHECK-Constraint erlaubt genau diese beiden Werte.
 */

import { api } from '/api.js';
import { t } from '/i18n.js';
import { esc } from '/utils/html.js';
import { openModal, closeModal, confirmModal } from '/components/modal.js';

const TYPES = [
  { key: 'all', label: () => t('giftLedger.tabAll') },
  // 红事 (red) zuerst — der häufigere Anlass und die Standardauswahl im Formular.
  { key: 'red', label: () => t('giftLedger.type.red') },
  { key: 'white', label: () => t('giftLedger.type.white') },
];

const DIRECTIONS = [
  { key: 'all', label: () => t('giftLedger.tabAll') },
  { key: 'received', label: () => t('giftLedger.dir.received') },
  { key: 'given', label: () => t('giftLedger.dir.given') },
];

function dirLabel(direction) {
  return direction === 'given'
    ? t('giftLedger.dir.given')
    : t('giftLedger.dir.received');
}

function typeLabel(type) {
  return type === 'red'
    ? t('giftLedger.type.red')
    : type === 'white'
    ? t('giftLedger.type.white')
    : type;
}

function formatAmount(n) {
  if (n === null || n === undefined || n === '') return '—';
  const num = Number(n);
  if (!isFinite(num)) return '—';
  return num.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

// 关联联系人（#relationships）：giver/related contact id → 姓名映射（懒加载一次）
let _user = null;
let _contactNames = new Map();
// 家庭成员（送礼人/收礼人）——v164：人员字段是家庭成员，不再是外部姓名
let _members = [];

async function ensureMembers() {
  if (_members.length) return;
  try {
    const res = await api.get('/auth/users');
    _members = (res?.data || []).filter((u) => !u.is_worker);
  } catch { /* 降级：空列表，编辑旧记录时仍可显示原文本 */ }
}

function memberOptions(selectedId, legacyName) {
  const opts = _members
    .map((m) => `<option value="${m.id}" data-name="${esc(m.display_name || m.username)}" ${String(m.id) === String(selectedId) ? 'selected' : ''}>${esc(m.display_name || m.username)}</option>`)
    .join('');
  // 旧记录只有姓名文本：保留为可选项，避免编辑时丢失
  const legacy = legacyName && !_members.some((m) => (m.display_name || m.username) === legacyName)
    ? `<option value="legacy:${esc(legacyName)}" data-name="${esc(legacyName)}" selected>${esc(legacyName)}</option>`
    : '';
  return opts + legacy;
}

async function ensureContactNames() {
  if (_contactNames.size) return;
  try {
    const res = await api.get('/contacts');
    const all = Array.isArray(res?.data) ? res.data : [];
    const admin = _user?.role === 'admin' || _user?.is_admin === true || _user?.isAdmin === true;
    for (const c of all) {
      if (!admin && c.hidden) continue; // Phase D: 隐藏联系人仅管理员可见
      _contactNames.set(c.id, c.name || '?');
    }
  } catch { /* 联系人不可用时静默降级为自由文本 */ }
}

function contactName(id) {
  return _contactNames.get(id) || null;
}

function contactOptions(selectedId) {
  return [..._contactNames.entries()]
    .sort((a, b) => a[1].localeCompare(b[1]))
    .map(([id, name]) => `<option value="${id}" ${id === selectedId ? 'selected' : ''}>${esc(name)}</option>`)
    .join('');
}

// 送礼人输入框的候选：直接用联系人姓名（datalist 只提供建议，输入框仍可
// 自由编辑）。选中后由 wireGiver 反查 id 建立联系。
function contactDatalist() {
  return [...new Set(_contactNames.values())]
    .sort((a, b) => a.localeCompare(b))
    .map((name) => `<option value="${esc(name)}"></option>`)
    .join('');
}

// 关系预设：复用 relationships 模块已有的类型翻译键，避免再维护一套
// 24 语言的重复文案。选中即写入输入框，仍可自由输入新关系。
const REL_PRESET_KEYS = ['family', 'friend', 'colleague', 'classmate', 'neighbor', 'partner', 'acquaintance'];
function relationshipPresets() {
  return REL_PRESET_KEYS.map((k) => t('relationships.type.' + k));
}
/**
 * 关系改为严格下拉（用户反馈：datalist 悬浮提示挡住下方字段、且要清空文字
 * 才能再次触发）。预设 + 「自定义」；选中自定义时显示文本输入框。
 */
const REL_CUSTOM = '__custom__';

function relSelectOptions(selectedValue) {
  const presets = relationshipPresets();
  const isPreset = presets.includes(selectedValue);
  return ['<option value="">' + esc(t('giftLedger.relNone')) + '</option>']
    .concat(presets.map((label) =>
      `<option value="${esc(label)}" ${label === selectedValue ? 'selected' : ''}>${esc(label)}</option>`))
    .concat(`<option value="${REL_CUSTOM}" ${selectedValue && !isPreset ? 'selected' : ''}>${esc(t('giftLedger.relCustom'))}</option>`)
    .join('');
}

/** 下拉与自定义文本框联动：编辑回显自定义值时切到自定义模式。 */
function wireRelField(body, initialValue) {
  const sel = body.querySelector('#f-rel-select');
  const input = body.querySelector('#f-rel');
  const sync = () => {
    const isCustom = sel.value === REL_CUSTOM;
    input.style.display = isCustom ? '' : 'none';
    if (isCustom && !input.value) input.value = initialValue && !relationshipPresets().includes(initialValue) ? initialValue : '';
    if (!isCustom) input.value = '';
  };
  sel.addEventListener('change', sync);
  sync();
  return () => (sel.value === REL_CUSTOM ? input.value.trim() : sel.value || null);
}

export async function render(container, { user } = {}) {
  _user = user || null;
  container.innerHTML = `
    <div class="gl-page">
      <div class="gl-head">
        <h2>${esc(t('giftLedger.title'))}</h2>
        <div class="gl-spacer"></div>
        <button class="gl-btn ghost" id="gl-stats">${esc(t('giftLedger.stats'))}</button>
        <button class="gl-btn ghost" id="gl-select">${esc(t('giftLedger.selectMode'))}</button>
        <button class="gl-btn" id="gl-add">+ ${esc(t('giftLedger.add'))}</button>
      </div>
      <div class="gl-tabs" id="gl-tabs"></div>
      <div class="gl-dir" id="gl-dir"></div>
      <div class="gl-filters">
        <input id="gl-q" placeholder="${esc(t('giftLedger.searchPlaceholder'))}">
      </div>
      <div class="gl-summary" id="gl-summary" hidden></div>
      <div class="gl-stats-panel" id="gl-stats-panel" hidden></div>
      <div class="gl-list" id="gl-list"><div class="gl-empty">${esc(t('giftLedger.loading'))}</div></div>
      <div class="gl-bar" id="gl-bar">
        <span id="gl-bar-count">${esc(t('giftLedger.selected', { count: 0 }))}</span>
        <div class="gl-spacer" style="flex:1"></div>
        <button class="gl-btn ghost" id="gl-bar-all">${esc(t('giftLedger.selectAll'))}</button>
        <button class="gl-btn ghost" id="gl-bar-cancel">${esc(t('giftLedger.cancelSelect'))}</button>
        <button class="gl-btn danger" id="gl-bar-del">${esc(t('giftLedger.batchDelete'))}</button>
      </div>
    </div>
  `;

  const state = { type: 'all', direction: 'all', q: '', items: [], selectMode: false, selected: new Set() };
  const list = container.querySelector('#gl-list');
  const tabsEl = container.querySelector('#gl-tabs');
  const bar = container.querySelector('#gl-bar');
  const qEl = container.querySelector('#gl-q');
  const summaryEl = container.querySelector('#gl-summary');

  // Tabs
  tabsEl.innerHTML = TYPES.map(
    (tb) =>
      `<div class="gl-tab ${tb.key === state.type ? 'active' : ''}" data-type="${tb.key}">${esc(tb.label())}<span class="gl-count" data-count="${tb.key}"></span></div>`
  ).join('');
  tabsEl.querySelectorAll('.gl-tab').forEach((el) =>
    el.addEventListener('click', () => {
      state.type = el.dataset.type;
      tabsEl.querySelectorAll('.gl-tab').forEach((x) => x.classList.toggle('active', x === el));
      load();
    })
  );

  // 方向筛选（收礼/送礼）与红白事标签相互独立
  const dirEl = container.querySelector('#gl-dir');
  dirEl.innerHTML = DIRECTIONS.map(
    (d) =>
      `<button type="button" class="gl-dir-chip ${d.key === state.direction ? 'active' : ''}" data-direction="${d.key}">${esc(d.label())}</button>`
  ).join('');
  dirEl.querySelectorAll('.gl-dir-chip').forEach((el) =>
    el.addEventListener('click', () => {
      state.direction = el.dataset.direction;
      dirEl.querySelectorAll('.gl-dir-chip').forEach((x) => x.classList.toggle('active', x === el));
      load();
    })
  );

  let debounce;
  qEl.addEventListener('input', () => {
    clearTimeout(debounce);
    debounce = setTimeout(() => {
      state.q = qEl.value.trim();
      load();
    }, 300);
  });

  container.querySelector('#gl-add').addEventListener('click', () => openForm());
  container.querySelector('#gl-select').addEventListener('click', () => toggleSelectMode());
  container.querySelector('#gl-bar-cancel').addEventListener('click', () => toggleSelectMode(false));
  container.querySelector('#gl-bar-all').addEventListener('click', () => {
    const all = state.items.map((it) => it.id);
    const every = all.every((id) => state.selected.has(id));
    state.selected = new Set(every ? [] : all);
    list.querySelectorAll('.gl-card').forEach((el) => {
      const id = parseInt(el.dataset.id, 10);
      const cb = el.querySelector('.gl-card__check input');
      if (cb) cb.checked = state.selected.has(id);
      el.classList.toggle('selected', state.selected.has(id));
    });
    updateBar();
  });
  container.querySelector('#gl-bar-del').addEventListener('click', () => doBatchDelete());
  container.querySelector('#gl-stats').addEventListener('click', () => toggleStats());

  // --------------------------------------------------------
  // Statistik: Monatsbalken + Jahressummen + Top-Beziehungen
  // --------------------------------------------------------
  const statsPanel = container.querySelector('#gl-stats-panel');
  // 默认“全部”：统计首先回答“总共收/送了多少”，年度是可选细分。
  const statsState = { open: false, year: 'all' };

  async function toggleStats() {
    statsState.open = !statsState.open;
    container.querySelector('#gl-stats').classList.toggle('active', statsState.open);
    statsPanel.hidden = !statsState.open;
    if (statsState.open) await loadStats();
  }

  async function loadStats() {
    statsPanel.innerHTML = `<div class="gl-empty">${esc(t('giftLedger.loading'))}</div>`;
    try {
      // 默认“全部”（跨年份）：用户关心的是“这个人一共收了多少、送了多少”，
      // 年度只是可选的细分视图（Feedback 2026-10-25）。
      const period = statsState.year === 'all' ? 'all' : statsState.year;
      const d = (await api.get('/gift-ledger/summary?year=' + encodeURIComponent(period))).data || {};
      const allTime = d.allTime === true;
      const fmt = (n) => formatAmount(Math.round(n * 100) / 100);
      // 结余可能为负：符号放货币符号前（-¥1,234，而不是 ¥-1,234）。
      const fmtSigned = (n) => `${n < 0 ? '-' : ''}¥${formatAmount(Math.abs(Math.round(n * 100) / 100))}`;

      const yearOptions = ['all', ...(d.years || []).map((y) => String(y.year))];
      if (!yearOptions.includes(String(statsState.year))) yearOptions.push(String(statsState.year));

      const maxMonth = Math.max(1, ...(d.months || []).map((m) => m.redTotal + m.whiteTotal));
      const monthRows = (d.months || [])
        .map((m) => {
          const total = m.redTotal + m.whiteTotal;
          if (!total && !m.redCount && !m.whiteCount) return '';
          const redW = maxMonth ? (m.redTotal / maxMonth) * 100 : 0;
          const whiteW = maxMonth ? (m.whiteTotal / maxMonth) * 100 : 0;
          return `<div class="gl-stat-month">
            <span class="gl-stat-month__label">${esc(m.month.slice(5))}月</span>
            <span class="gl-stat-month__bars">
              <span class="gl-stat-bar gl-stat-bar--red" style="width:${redW.toFixed(1)}%"></span>
              <span class="gl-stat-bar gl-stat-bar--white" style="width:${whiteW.toFixed(1)}%"></span>
            </span>
            <span class="gl-stat-month__total">¥${esc(fmt(total))}<small> (${m.redCount + m.whiteCount})</small></span>
          </div>`;
        })
        .join('');

      // 按人：同一个人可能既有收礼又有送礼，合成一行显示 收/送/结余。
      const personMap = new Map();
      for (const g of d.givers || []) {
        const cur = personMap.get(g.giver) || { name: g.giver, inTotal: 0, outTotal: 0, count: 0 };
        if (g.direction === 'given') cur.outTotal += g.total;
        else cur.inTotal += g.total;
        cur.count += g.count;
        personMap.set(g.giver, cur);
      }
      const personRows = [...personMap.values()]
        .sort((a, b) => (b.inTotal + b.outTotal) - (a.inTotal + a.outTotal))
        .slice(0, 30)
        .map((p) => {
          const net = Math.round((p.inTotal - p.outTotal) * 100) / 100;
          return `<div class="gl-person">
            <div class="gl-person__name">${esc(p.name)}</div>
            <div class="gl-person__figures">
              <span class="gl-person__in">${esc(t('giftLedger.dir.received'))} <b>¥${esc(fmt(p.inTotal))}</b></span>
              <span class="gl-person__out">${esc(t('giftLedger.dir.given'))} <b>¥${esc(fmt(p.outTotal))}</b></span>
              <span class="gl-person__net ${net >= 0 ? 'is-pos' : 'is-neg'}">${esc(t('giftLedger.net'))} <b>${esc(fmtSigned(net))}</b></span>
            </div>
          </div>`;
        })
        .join('');

      const relRows = (d.relationships || [])
        .map(
          (r) => `<div class="gl-stat-rel">
            <span class="gl-type ${r.type}">${esc(typeLabel(r.type))}</span>
            <span class="gl-stat-rel__name">${esc(r.relationship)}</span>
            <span class="gl-stat-rel__meta">${r.count}</span>
            <span class="gl-stat-rel__total">¥${esc(fmt(r.total))}</span>
          </div>`
        )
        .join('');

      const yearList = (d.years || [])
        .map(
          (y) => `<div class="gl-stat-year ${String(y.year) === String(statsState.year) ? 'active' : ''}" data-year="${esc(y.year)}">
            <span class="gl-stat-year__label">${esc(y.year)}</span>
            <span class="gl-stat-year__red">红 ¥${esc(fmt(y.redTotal))}</span>
            <span class="gl-stat-year__white">白 ¥${esc(fmt(y.whiteTotal))}</span>
          </div>`
        )
        .join('');

      const periodLabel = allTime
        ? t('giftLedger.statsAllTime')
        : t('giftLedger.statsYear', { year: statsState.year });

      statsPanel.innerHTML = `
        <div class="gl-stats-head">
          <strong>${esc(periodLabel)}</strong>
          <select id="gl-stats-year">${yearOptions
            .map((y) => `<option value="${esc(y)}" ${String(y) === String(statsState.year) ? 'selected' : ''}>${y === 'all' ? esc(t('giftLedger.statsAllTime')) : esc(y)}</option>`)
            .join('')}</select>
        </div>
        <div class="gl-kpis">
          <div class="gl-kpi gl-kpi--in">
            <span class="gl-kpi__label">${esc(t('giftLedger.dir.received'))}</span>
            <strong class="gl-kpi__value">¥${esc(fmt(d.yearTotals?.receivedTotal || 0))}</strong>
            <span class="gl-kpi__meta">${d.yearTotals?.receivedCount || 0} ${esc(t('giftLedger.statsEntries'))}</span>
          </div>
          <div class="gl-kpi gl-kpi--out">
            <span class="gl-kpi__label">${esc(t('giftLedger.dir.given'))}</span>
            <strong class="gl-kpi__value">¥${esc(fmt(d.yearTotals?.givenTotal || 0))}</strong>
            <span class="gl-kpi__meta">${d.yearTotals?.givenCount || 0} ${esc(t('giftLedger.statsEntries'))}</span>
          </div>
          <div class="gl-kpi gl-kpi--net ${(d.yearTotals?.net || 0) >= 0 ? 'is-pos' : 'is-neg'}">
            <span class="gl-kpi__label">${esc(t('giftLedger.net'))}</span>
            <strong class="gl-kpi__value">${esc(fmtSigned(d.yearTotals?.net || 0))}</strong>
            <span class="gl-kpi__meta">${esc(t('giftLedger.netHint'))}</span>
          </div>
        </div>
        <div class="gl-typekpis">
          <span class="gl-typekpi gl-typekpi--red">${esc(t('giftLedger.type.red'))} · ${d.yearTotals?.redCount || 0} · ¥${esc(fmt(d.yearTotals?.redTotal || 0))}</span>
          <span class="gl-typekpi gl-typekpi--white">${esc(t('giftLedger.type.white'))} · ${d.yearTotals?.whiteCount || 0} · ¥${esc(fmt(d.yearTotals?.whiteTotal || 0))}</span>
        </div>
        ${allTime ? '' : `<div class="gl-stats-months">${monthRows || `<div class="gl-empty">${esc(t('giftLedger.empty'))}</div>`}</div>`}
        ${personRows ? `<div class="gl-stats-rels"><h4>${esc(t('giftLedger.statsByPerson'))}</h4>${personRows}</div>` : ''}
        ${relRows ? `<div class="gl-stats-rels"><h4>${esc(allTime ? t('giftLedger.statsTopRelAll') : t('giftLedger.statsTopRel'))}</h4>${relRows}</div>` : ''}
        ${yearList ? `<div class="gl-stats-years"><h4>${esc(t('giftLedger.statsByYear'))}</h4>${yearList}</div>` : ''}
      `;

      statsPanel.querySelector('#gl-stats-year').addEventListener('change', (e) => {
        statsState.year = e.target.value === 'all' ? 'all' : parseInt(e.target.value, 10);
        loadStats();
      });
      statsPanel.querySelectorAll('.gl-stat-year').forEach((el) =>
        el.addEventListener('click', () => {
          statsState.year = parseInt(el.dataset.year, 10);
          loadStats();
        })
      );
    } catch {
      statsPanel.innerHTML = `<div class="gl-empty">${esc(t('common.error') || 'Fehler')}</div>`;
    }
  }

  function countFor(key) {
    if (key === 'all') return state.items.length;
    return state.items.filter((it) => it.type === key).length;
  }
  function refreshCounts() {
    tabsEl.querySelectorAll('.gl-count').forEach((el) => {
      const c = countFor(el.dataset.count);
      el.textContent = c ? ` ${c}` : '';
    });
    // Zusammenfassung nur ueber die aktuell sichtbaren Zeilen (kein
    // Server-Aggregat über fremde/private Einträge).
    const sum = state.items.reduce((acc, it) => acc + (typeof it.amount === 'number' ? it.amount : 0), 0);
    const withAmount = state.items.filter((it) => typeof it.amount === 'number').length;
    if (!state.items.length) {
      summaryEl.hidden = true;
      summaryEl.innerHTML = '';
      return;
    }
    summaryEl.hidden = false;
    summaryEl.innerHTML = `
      <span class="gl-summary__item"><strong>${state.items.length}</strong> ${esc(t('giftLedger.summaryEntries'))}</span>
      <span class="gl-summary__dot">·</span>
      <span class="gl-summary__item">${esc(t('giftLedger.summarySum'))} <strong class="gl-summary__sum">¥${esc(formatAmount(Math.round(sum * 100) / 100))}</strong></span>
      ${withAmount < state.items.length ? `<span class="gl-summary__hint">${esc(t('giftLedger.summaryPartial', { count: state.items.length - withAmount }))}</span>` : ''}
    `;
  }

  async function toggleSelectMode(force) {
    state.selectMode = typeof force === 'boolean' ? force : !state.selectMode;
    if (!state.selectMode) state.selected.clear();
    container.querySelector('#gl-select').textContent = state.selectMode
      ? t('giftLedger.cancelSelect')
      : t('giftLedger.selectMode');
    bar.classList.toggle('show', state.selectMode);
    updateBar();
    // 关键：checkbox 只在 selectMode 下渲染，必须重绘列表，
    // 否则工具条出现了但卡片上没有勾选框（用户 2026-10-26 反馈）。
    await load();
  }

  function updateBar() {
    container.querySelector('#gl-bar-count').textContent = t('giftLedger.selected', { count: state.selected.size });
  }

  function itemHtml(it) {
    const check = state.selectMode
      ? `<div class="gl-card__check"><input type="checkbox" data-id="${it.id}" ${state.selected.has(it.id) ? 'checked' : ''}></div>`
      : '';
    const lock = it.is_private ? `<span class="gl-lock" title="${esc(t('giftLedger.private'))}">🔒</span>` : '';
    const hasAmount = it.amount !== null && it.amount !== undefined && it.amount !== '';
    const amount = hasAmount ? formatAmount(it.amount) : null;
    return `<div class="gl-card gl-card--${it.type} ${state.selectMode && state.selected.has(it.id) ? 'selected' : ''}" data-id="${it.id}">
      <span class="gl-card__accent" aria-hidden="true"></span>
      ${check}
      <div class="gl-card__body">
        <div class="gl-card__title">
          ${esc(it.event_name)}
          <span class="gl-type ${it.type}">${esc(typeLabel(it.type))}</span>
          <span class="gl-chip gl-chip--${it.direction === 'given' ? 'given' : 'received'}">${esc(dirLabel(it.direction))}</span>
          ${lock}
        </div>
        <div class="gl-meta">
          ${it.event_date ? `<span class="gl-chip">📅 ${esc(it.event_date)}</span>` : ''}
          ${it.giver ? `<span class="gl-chip">🎁 ${esc(it.giver)}</span>` : ''}
          ${it.giver_contact_id ? `<span class="gl-chip">👤 ${esc(contactName(it.giver_contact_id) || '#' + it.giver_contact_id)}</span>` : ''}
          ${it.related_contact_id ? `<span class="gl-chip">🎉 ${esc(contactName(it.related_contact_id) || '#' + it.related_contact_id)}</span>` : ''}
          ${it.relationship ? `<span class="gl-chip">· ${esc(it.relationship)}</span>` : ''}
          ${it.returned ? `<span class="gl-chip gl-chip--returned">↩️ ${esc(t('giftLedger.returnedBadge'))}</span>` : ''}
        </div>
        ${it.note ? `<div class="gl-note">${esc(it.note)}</div>` : ''}
      </div>
      <div class="gl-card__amount ${hasAmount ? '' : 'gl-card__amount--empty'}">${amount !== null ? `¥${esc(amount)}` : '—'}</div>
    </div>`;
  }

  async function load() {
    if (!state.selectMode) list.innerHTML = `<div class="gl-empty">${esc(t('giftLedger.loading'))}</div>`;
    await ensureContactNames();
    try {
      const params = new URLSearchParams();
      if (state.type !== 'all') params.set('type', state.type);
      if (state.direction !== 'all') params.set('direction', state.direction);
      if (state.q) params.set('q', state.q);
      const r = (await api.get('/gift-ledger/list?' + params.toString())).data || [];
      state.items = r;
      refreshCounts();
      if (!r.length) {
        list.innerHTML = `
          <div class="gl-empty">
            <div class="gl-empty__icon" aria-hidden="true">🎁</div>
            <div class="gl-empty__title">${esc(t('giftLedger.empty'))}</div>
            <div class="gl-empty__desc">${esc(t('giftLedger.emptyDesc'))}</div>
          </div>`;
        return;
      }
      list.innerHTML = r.map(itemHtml).join('');
      list.querySelectorAll('.gl-card').forEach((el) => {
        const id = parseInt(el.dataset.id, 10);
        if (state.selectMode) {
          el.addEventListener('click', (e) => {
            // Klick auf die Checkbox selbst lässt deren change-Handler wirken
            if (e.target.closest('.gl-card__check')) return;
            const cb = el.querySelector('.gl-card__check input');
            cb.checked = !cb.checked;
            cb.dispatchEvent(new Event('change'));
          });
        } else {
          el.addEventListener('click', () => openForm(id));
        }
      });
      if (state.selectMode) {
        list.querySelectorAll('.gl-card__check input').forEach((cb) => {
          cb.addEventListener('change', () => {
            const id = parseInt(cb.dataset.id, 10);
            if (cb.checked) state.selected.add(id);
            else state.selected.delete(id);
            cb.closest('.gl-card').classList.toggle('selected', cb.checked);
            updateBar();
          });
        });
      }
    } catch {
      list.innerHTML = `<div class="gl-empty">${esc(t('common.error') || 'Fehler')}</div>`;
    }
  }

  async function doBatchDelete() {
    if (!state.selected.size) return;
    if (!(await confirmModal(t('giftLedger.confirmDeleteBatch', { count: state.selected.size })))) return;
    try {
      await api.post('/gift-ledger/batch-delete', { ids: [...state.selected] });
      toggleSelectMode(false);
      await load();
    } catch {
      window.yuvomi?.showToast?.(t('common.error') || 'Fehler', 'danger');
    }
  }

  async function openForm(id) {
    await Promise.all([ensureContactNames(), ensureMembers()]);
    const body = document.createElement('div');
    body.className = 'gl-modal-body';
    const editing = !!id;
    body.innerHTML = `
      <div class="gl-field"><label>${esc(t('giftLedger.direction'))}</label>
        <div class="gl-seg" id="f-direction" role="radiogroup" aria-label="${esc(t('giftLedger.direction'))}">
          <label class="gl-seg__opt" data-v="received"><input type="radio" name="gl-dir" value="received">${esc(t('giftLedger.dir.received'))}</label>
          <label class="gl-seg__opt" data-v="given"><input type="radio" name="gl-dir" value="given" ${editing ? '' : 'checked'}>${esc(t('giftLedger.dir.given'))}</label>
        </div>
      </div>
      <div class="gl-field"><label>${esc(t('giftLedger.type.label') || '类型')}</label>
        <div class="gl-seg gl-seg--type" id="f-type" role="radiogroup" aria-label="${esc(t('giftLedger.type.label') || '类型')}">
          <label class="gl-seg__opt" data-v="red"><input type="radio" name="gl-type" value="red" ${editing ? '' : 'checked'}>${esc(t('giftLedger.type.red'))}</label>
          <label class="gl-seg__opt" data-v="white"><input type="radio" name="gl-type" value="white">${esc(t('giftLedger.type.white'))}</label>
        </div>
      </div>
      <div class="gl-field"><label>${esc(t('giftLedger.eventName'))}</label><input id="f-name" placeholder="${esc(t('giftLedger.eventNamePh') || '')}"></div>
      <div class="gl-field"><label>${esc(t('giftLedger.eventDate'))}</label><input id="f-date" type="date"></div>
      <div class="gl-field">
        <label><input type="checkbox" id="f-anniv" checked> ${esc(t('giftLedger.addToAnniversary'))}</label>
        <div class="gl-hint" id="f-anniv-hint">${esc(t('giftLedger.addToAnniversaryHint'))}</div>
      </div>
      <div class="gl-field"><label id="f-giver-label">${esc(t('giftLedger.giver'))} *</label>
        <select id="f-giver-user" class="form-input" required>${memberOptions(null, null)}</select>
      </div>
      <div class="gl-field"><label>${esc(t('giftLedger.eventObject'))}</label>
        <select id="f-related-contact"><option value="">${esc(t('giftLedger.noContact'))}</option>${contactOptions(null)}</select>
        <div class="gl-hint">${esc(t('giftLedger.eventObjectHint'))}</div>
      </div>
      <div class="gl-field"><label>${esc(t('giftLedger.amount'))} *</label><input id="f-amount" type="number" step="0.01" min="0" inputmode="decimal" required></div>
      <div class="gl-field"><label>${esc(t('giftLedger.relationship'))}</label>
        <select id="f-rel-select">${relSelectOptions(null)}</select>
        <input id="f-rel" style="display:none" maxlength="20" placeholder="${esc(t('giftLedger.relCustomPh'))}">
      </div>
      <div class="gl-field"><label>${esc(t('giftLedger.note'))}</label><textarea id="f-note" rows="3"></textarea></div>
      <div class="gl-field"><label><input type="checkbox" id="f-returned"> ${esc(t('giftLedger.returned'))}</label></div>
      <div class="gl-field"><label><input type="checkbox" id="f-private"> ${esc(t('giftLedger.private'))}</label>
        <div class="gl-hint">${esc(t('giftLedger.privateHint') || '')}</div>
      </div>
      <div style="display:flex;gap:8px;margin-top:10px">
        ${editing ? `<button class="gl-btn ghost danger" id="f-del">${esc(t('giftLedger.delete'))}</button>` : ''}
        <div class="gl-spacer" style="flex:1"></div>
        <button class="gl-btn" id="f-save">${esc(t('giftLedger.save') || t('common.save'))}</button>
      </div>
    `;
    openModal({
      title: editing ? t('giftLedger.edit') : t('giftLedger.add'),
      content: '',
      onSave: (panel) => panel.querySelector('.modal-panel__body').replaceChildren(body),
    });

    // Radio-Highlight
    const typeWrap = body.querySelector('#f-type');
    const syncSeg = (wrap) => {
      wrap.querySelectorAll('.gl-seg__opt').forEach((l) => {
        l.classList.toggle('is-active', l.querySelector('input').checked);
      });
    };
    const syncRadio = () => syncSeg(typeWrap);
    typeWrap.querySelectorAll('input').forEach((r) => r.addEventListener('change', syncRadio));
    syncRadio();

    // 人员是家庭成员（下拉）；外部当事人在「事件对象」里选联系人。
    const giverSel = body.querySelector('#f-giver-user');
    const relatedSel = body.querySelector('#f-related-contact');

    // 关系下拉与自定义文本框联动；getRelValue() 供提交时取值。
    const getRelValue = wireRelField(body, editing ? (item?.relationship || '') : '');

    // 同步纪念日：anniversaries 必须有联系人 + 日期，因此两者齐备才可用；
    // 纪念日挂在「事件对象」名下（例如朋友婚礼），不是家庭成员自己。
    const annivEl = body.querySelector('#f-anniv');
    const annivHint = body.querySelector('#f-anniv-hint');
    let annivTouched = false;
    annivEl.addEventListener('change', () => { annivTouched = true; });
    const syncAnniv = () => {
      const eligible = !!relatedSel.value && !!body.querySelector('#f-date').value;
      if (annivEl.dataset.locked === '1') return; // 编辑已同步记录：保持锁定
      annivEl.disabled = !eligible;
      if (!eligible) annivEl.checked = false;
      else if (!annivTouched) annivEl.checked = true;
      annivHint.textContent = eligible
        ? t('giftLedger.addToAnniversaryHint')
        : t('giftLedger.addToAnniversaryNeeds');
    };
    relatedSel.addEventListener('change', syncAnniv);
    body.querySelector('#f-date').addEventListener('change', syncAnniv);
    body.querySelector('#f-date').addEventListener('input', syncAnniv);
    syncAnniv();

    // 方向决定“对方”的称呼：收礼时是送礼人，送礼时是收礼人。
    const dirWrap = body.querySelector('#f-direction');
    const giverLabelEl = body.querySelector('#f-giver-label');
    // 人员是家庭成员：送礼时“我”是送礼人，收礼时“我”是收礼人。
    const syncDirLabel = () => {
      const isGiven = dirWrap.querySelector('input:checked')?.value === 'given';
      giverLabelEl.textContent =
        (isGiven ? t('giftLedger.giver') : t('giftLedger.recipient')) + ' *';
    };
    dirWrap.querySelectorAll('input').forEach((r) =>
      r.addEventListener('change', () => {
        syncDirLabel();
        syncSeg(dirWrap);
      })
    );
    syncDirLabel();
    syncSeg(dirWrap);

    if (editing) {
      let item;
      try {
        item = (await api.get('/gift-ledger/' + id)).data;
      } catch {
        return;
      }
      body.querySelector('input[name="gl-dir"][value="' + (item.direction || 'received') + '"]').checked = true;
      syncDirLabel();
      body.querySelector('input[name="gl-type"][value="' + item.type + '"]').checked = true;
      syncRadio();
      body.querySelector('#f-name').value = item.event_name || '';
      body.querySelector('#f-date').value = (item.event_date || '').slice(0, 10);
      if (item.anniversary_id) {
        annivEl.dataset.locked = '1';
        annivEl.checked = true;
        annivEl.disabled = true;
        annivHint.textContent = t('giftLedger.anniversaryLinked');
      }
      syncAnniv();
      // 家庭成员下拉：优先 giver_user_id；旧记录回退到姓名文本
      const giverSel = body.querySelector('#f-giver-user');
      if (item.giver_user_id && _members.some((m) => m.id === item.giver_user_id)) {
        giverSel.value = String(item.giver_user_id);
      } else if (item.giver && !_members.some((m) => (m.display_name || m.username) === item.giver)) {
        const opt = document.createElement('option');
        opt.value = 'legacy:' + item.giver;
        opt.dataset.name = item.giver;
        opt.textContent = item.giver;
        giverSel.appendChild(opt);
        giverSel.value = opt.value;
      }
      body.querySelector('#f-related-contact').value = item.related_contact_id || '';
      body.querySelector('#f-returned').checked = !!item.returned;
      body.querySelector('#f-amount').value = item.amount != null ? item.amount : '';
      const relSel = body.querySelector('#f-rel-select');
      relSel.value = relationshipPresets().includes(item.relationship) ? item.relationship
        : (item.relationship ? REL_CUSTOM : '');
      relSel.dispatchEvent(new Event('change'));
      body.querySelector('#f-note').value = item.note || '';
      body.querySelector('#f-private').checked = !!item.is_private;

      body.querySelector('#f-del').addEventListener('click', async () => {
        if (!(await confirmModal(t('giftLedger.confirmDelete')))) return;
        try {
          await api.delete('/gift-ledger/' + id);
          closeModal({ force: true });
          await load();
        } catch {}
      });
    }

    body.querySelector('#f-save').addEventListener('click', async () => {
      const name = body.querySelector('#f-name').value.trim();
      if (!name) {
        window.yuvomi?.showToast?.(t('giftLedger.eventNameRequired') || t('common.nameRequired') || 'Name erforderlich', 'danger');
        return;
      }
      // 送礼人/收礼人（家庭成员）与金额为必填
      const giverSel = body.querySelector('#f-giver-user');
      const giverOpt = giverSel.selectedOptions[0];
      const giverRaw = giverSel.value || '';
      const giver = (giverOpt?.dataset.name || '').trim();
      if (!giver) {
        window.yuvomi?.showToast?.(t('common.required'), 'danger');
        giverSel.focus();
        return;
      }
      const giverUserId = giverRaw && !giverRaw.startsWith('legacy:') ? Number(giverRaw) : null;
      const amountRaw = body.querySelector('#f-amount').value.trim();
      if (amountRaw === '') {
        window.yuvomi?.showToast?.(t('common.required'), 'danger');
        body.querySelector('#f-amount').focus();
        return;
      }
      const payload = {
        direction: body.querySelector('input[name="gl-dir"]:checked')?.value || 'given',
        addToAnniversary: !annivEl.disabled && annivEl.checked,
        type: body.querySelector('input[name="gl-type"]:checked')?.value || 'red',
        event_name: name,
        event_date: body.querySelector('#f-date').value || null,
        giver,
        giverUserId,
        relatedContactId: body.querySelector('#f-related-contact').value ? Number(body.querySelector('#f-related-contact').value) : null,
        returned: body.querySelector('#f-returned').checked,
        amount: Number(amountRaw),
        relationship: getRelValue(),
        note: body.querySelector('#f-note').value.trim() || null,
        is_private: body.querySelector('#f-private').checked,
      };
      if (payload.amount !== null && !isFinite(payload.amount)) {
        window.yuvomi?.showToast?.(t('giftLedger.amountInvalid') || 'Betrag ungültig', 'danger');
        return;
      }
      try {
        if (editing) await api.put('/gift-ledger/' + id, payload);
        else await api.post('/gift-ledger/add', payload);
        // force:true → nach erfolgreichem Speichern NICHT nach „Änderungen verwerfen?" fragen
        closeModal({ force: true });
        await load();
      } catch {
        window.yuvomi?.showToast?.(t('common.error') || 'Fehler', 'danger');
      }
    });
  }

  await load();
}
