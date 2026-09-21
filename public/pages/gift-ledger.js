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

export async function render(container, { user } = {}) {
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
      <div class="gl-filters">
        <input id="gl-q" placeholder="${esc(t('giftLedger.searchPlaceholder'))}">
      </div>
      <div class="gl-summary" id="gl-summary" hidden></div>
      <div class="gl-stats-panel" id="gl-stats-panel" hidden></div>
      <div class="gl-list" id="gl-list"><div class="gl-empty">${esc(t('giftLedger.loading'))}</div></div>
      <div class="gl-bar" id="gl-bar">
        <span id="gl-bar-count">${esc(t('giftLedger.selected', { count: 0 }))}</span>
        <div class="gl-spacer" style="flex:1"></div>
        <button class="gl-btn ghost" id="gl-bar-cancel" style="border-color:#fff;color:#fff">${esc(t('giftLedger.cancelSelect'))}</button>
        <button class="gl-btn danger" id="gl-bar-del" style="background:#7f1d1d;border-color:#7f1d1d">${esc(t('giftLedger.batchDelete'))}</button>
      </div>
    </div>
  `;

  const state = { type: 'all', q: '', items: [], selectMode: false, selected: new Set() };
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
  container.querySelector('#gl-bar-del').addEventListener('click', () => doBatchDelete());
  container.querySelector('#gl-stats').addEventListener('click', () => toggleStats());

  // --------------------------------------------------------
  // Statistik: Monatsbalken + Jahressummen + Top-Beziehungen
  // --------------------------------------------------------
  const statsPanel = container.querySelector('#gl-stats-panel');
  const statsState = { open: false, year: new Date().getFullYear() };

  async function toggleStats() {
    statsState.open = !statsState.open;
    container.querySelector('#gl-stats').classList.toggle('active', statsState.open);
    statsPanel.hidden = !statsState.open;
    if (statsState.open) await loadStats();
  }

  async function loadStats() {
    statsPanel.innerHTML = `<div class="gl-empty">${esc(t('giftLedger.loading'))}</div>`;
    try {
      const d = (await api.get('/gift-ledger/summary?year=' + statsState.year)).data || {};
      const maxMonth = Math.max(1, ...d.months.map((m) => m.redTotal + m.whiteTotal));
      const yearOptions = [];
      if (d.years?.length) {
        for (const y of d.years) yearOptions.push(y.year);
        if (!yearOptions.includes(String(statsState.year))) yearOptions.push(String(statsState.year));
      }
      if (!yearOptions.includes(String(statsState.year))) yearOptions.push(String(statsState.year));
      yearOptions.sort().reverse();

      const fmt = (n) => formatAmount(Math.round(n * 100) / 100);
      const monthRows = d.months
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

      statsPanel.innerHTML = `
        <div class="gl-stats-head">
          <strong>${esc(t('giftLedger.statsYear', { year: statsState.year }))}</strong>
          <select id="gl-stats-year">${yearOptions.map((y) => `<option value="${esc(y)}" ${String(y) === String(statsState.year) ? 'selected' : ''}>${esc(y)}</option>`).join('')}</select>
          <span class="gl-spacer" style="flex:1"></span>
          <span class="gl-stat-kpi gl-stat-kpi--red">${esc(t('giftLedger.type.red'))} <strong>¥${esc(fmt(d.yearTotals?.redTotal || 0))}</strong><small>${d.yearTotals?.redCount || 0}</small></span>
          <span class="gl-stat-kpi gl-stat-kpi--white">${esc(t('giftLedger.type.white'))} <strong>¥${esc(fmt(d.yearTotals?.whiteTotal || 0))}</strong><small>${d.yearTotals?.whiteCount || 0}</small></span>
        </div>
        <div class="gl-stats-months">${monthRows || `<div class="gl-empty">${esc(t('giftLedger.empty'))}</div>`}</div>
        ${relRows ? `<div class="gl-stats-rels"><h4>${esc(t('giftLedger.statsTopRel'))}</h4>${relRows}</div>` : ''}
        ${yearList ? `<div class="gl-stats-years"><h4>${esc(t('giftLedger.statsByYear'))}</h4>${yearList}</div>` : ''}
      `;

      statsPanel.querySelector('#gl-stats-year').addEventListener('change', (e) => {
        statsState.year = parseInt(e.target.value, 10);
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

  function toggleSelectMode(force) {
    state.selectMode = typeof force === 'boolean' ? force : !state.selectMode;
    if (!state.selectMode) state.selected.clear();
    container.querySelector('#gl-select').textContent = state.selectMode
      ? t('giftLedger.cancelSelect')
      : t('giftLedger.selectMode');
    bar.classList.toggle('show', state.selectMode);
    updateBar();
    list.querySelectorAll('.gl-card').forEach((el) => {
      const id = parseInt(el.dataset.id, 10);
      el.classList.toggle('selected', state.selected.has(id));
      const cb = el.querySelector('.gl-card__check input');
      if (cb) cb.checked = state.selected.has(id);
    });
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
          ${lock}
        </div>
        <div class="gl-meta">
          ${it.event_date ? `<span class="gl-chip">📅 ${esc(it.event_date)}</span>` : ''}
          ${it.giver ? `<span class="gl-chip">🎁 ${esc(it.giver)}</span>` : ''}
          ${it.relationship ? `<span class="gl-chip">· ${esc(it.relationship)}</span>` : ''}
        </div>
        ${it.note ? `<div class="gl-note">${esc(it.note)}</div>` : ''}
      </div>
      <div class="gl-card__amount ${hasAmount ? '' : 'gl-card__amount--empty'}">${amount !== null ? `¥${esc(amount)}` : '—'}</div>
    </div>`;
  }

  async function load() {
    if (!state.selectMode) list.innerHTML = `<div class="gl-empty">${esc(t('giftLedger.loading'))}</div>`;
    try {
      const params = new URLSearchParams();
      if (state.type !== 'all') params.set('type', state.type);
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
            <button class="gl-btn" id="gl-empty-add">+ ${esc(t('giftLedger.add'))}</button>
          </div>`;
        list.querySelector('#gl-empty-add').addEventListener('click', () => openForm());
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
      alert(t('common.error') || 'Fehler');
    }
  }

  async function openForm(id) {
    const body = document.createElement('div');
    body.className = 'gl-modal-body';
    const editing = !!id;
    body.innerHTML = `
      <div class="gl-field"><label>${esc(t('giftLedger.type.label') || '类型')}</label>
        <div class="gl-radios" id="f-type">
          <label class="active-white" data-v="white"><input type="radio" name="gl-type" value="white" ${editing ? '' : 'checked'}> ${esc(t('giftLedger.type.white'))}</label>
          <label data-v="red"><input type="radio" name="gl-type" value="red"> ${esc(t('giftLedger.type.red'))}</label>
        </div>
      </div>
      <div class="gl-field"><label>${esc(t('giftLedger.eventName'))}</label><input id="f-name" placeholder="${esc(t('giftLedger.eventNamePh') || '')}"></div>
      <div class="gl-field"><label>${esc(t('giftLedger.eventDate'))}</label><input id="f-date" type="date"></div>
      <div class="gl-field"><label>${esc(t('giftLedger.giver'))}</label><input id="f-giver" placeholder=""></div>
      <div class="gl-field"><label>${esc(t('giftLedger.amount'))}</label><input id="f-amount" type="number" step="0.01" min="0" inputmode="decimal"></div>
      <div class="gl-field"><label>${esc(t('giftLedger.relationship'))}</label><input id="f-rel"></div>
      <div class="gl-field"><label>${esc(t('giftLedger.note'))}</label><textarea id="f-note" rows="3"></textarea></div>
      <div class="gl-field"><label><input type="checkbox" id="f-private"> ${esc(t('giftLedger.private'))}</label>
        <div style="font-size:11px;color:#888;margin-top:4px">${esc(t('giftLedger.privateHint') || '')}</div>
      </div>
      <div style="display:flex;gap:8px;margin-top:10px">
        ${editing ? `<button class="gl-btn ghost danger" id="f-del" style="background:#dc2626;border-color:#dc2626">${esc(t('giftLedger.delete'))}</button>` : ''}
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
    const syncRadio = () => {
      typeWrap.querySelectorAll('label').forEach((l) => {
        const checked = l.querySelector('input').checked;
        l.classList.toggle('active-red', l.dataset.v === 'red' && checked);
        l.classList.toggle('active-white', l.dataset.v === 'white' && checked);
      });
    };
    typeWrap.querySelectorAll('input').forEach((r) => r.addEventListener('change', syncRadio));

    if (editing) {
      let item;
      try {
        item = (await api.get('/gift-ledger/' + id)).data;
      } catch {
        return;
      }
      body.querySelector('input[name="gl-type"][value="' + item.type + '"]').checked = true;
      syncRadio();
      body.querySelector('#f-name').value = item.event_name || '';
      body.querySelector('#f-date').value = (item.event_date || '').slice(0, 10);
      body.querySelector('#f-giver').value = item.giver || '';
      body.querySelector('#f-amount').value = item.amount != null ? item.amount : '';
      body.querySelector('#f-rel').value = item.relationship || '';
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
        alert(t('giftLedger.eventNameRequired') || t('common.nameRequired') || 'Name erforderlich');
        return;
      }
      const amountRaw = body.querySelector('#f-amount').value.trim();
      const payload = {
        type: body.querySelector('input[name="gl-type"]:checked')?.value || 'white',
        event_name: name,
        event_date: body.querySelector('#f-date').value || null,
        giver: body.querySelector('#f-giver').value.trim() || null,
        amount: amountRaw === '' ? null : Number(amountRaw),
        relationship: body.querySelector('#f-rel').value.trim() || null,
        note: body.querySelector('#f-note').value.trim() || null,
        is_private: body.querySelector('#f-private').checked,
      };
      if (payload.amount !== null && !isFinite(payload.amount)) {
        alert(t('giftLedger.amountInvalid') || 'Betrag ungültig');
        return;
      }
      try {
        if (editing) await api.put('/gift-ledger/' + id, payload);
        else await api.post('/gift-ledger/add', payload);
        // force:true → nach erfolgreichem Speichern NICHT nach „Änderungen verwerfen?" fragen
        closeModal({ force: true });
        await load();
      } catch {
        alert(t('common.error') || 'Fehler');
      }
    });
  }

  await load();
}
