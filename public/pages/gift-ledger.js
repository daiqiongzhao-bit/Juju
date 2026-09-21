/**
 * Seite: Geschenk-/Geld-Register (Gift Ledger)
 * 红事 (white) / 白事 (red) Anlässe mit Datum, Schenker, Betrag, Verhältnis, Notiz.
 */

import { api } from '/api.js';
import { t } from '/i18n.js';
import { esc } from '/utils/html.js';
import { openModal, closeModal, confirmModal } from '/components/modal.js';

const TYPES = [
  { key: 'all', label: () => t('giftLedger.tabAll') },
  { key: 'white', label: () => t('giftLedger.type.white') },
  { key: 'red', label: () => t('giftLedger.type.red') },
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
      <style>
        .gl-page{max-width:1000px;margin:0 auto;padding:18px}
        .gl-head{display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:14px}
        .gl-head h2{margin:0;font-size:20px}
        .gl-spacer{flex:1}
        .gl-tabs{display:flex;gap:6px;margin-bottom:12px;flex-wrap:wrap}
        .gl-tab{padding:6px 14px;border:1px solid var(--border,#ddd);border-radius:20px;cursor:pointer;background:var(--bg,#fff);color:var(--text,#222);display:flex;gap:6px;align-items:center}
        .gl-tab.active{background:var(--accent,#3b82f6);color:#fff;border-color:var(--accent,#3b82f6)}
        .gl-tab .gl-count{font-size:11px;opacity:.8}
        .gl-filters{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:14px}
        .gl-filters input{padding:7px 10px;border:1px solid var(--border,#ddd);border-radius:8px;background:var(--bg,#fff);color:var(--text,#222);min-width:220px}
        .gl-list{display:flex;flex-direction:column;gap:10px}
        .gl-card{background:var(--bg,#fff);border:1px solid var(--border,#ddd);border-radius:12px;padding:12px 14px;position:relative;display:flex;gap:12px;align-items:flex-start;cursor:pointer;transition:.15s}
        .gl-card:hover{transform:translateY(-1px);box-shadow:0 4px 14px rgba(0,0,0,.10)}
        .gl-card.selected{outline:2px solid var(--accent,#3b82f6);outline-offset:-2px}
        .gl-card__check{margin-top:3px}
        .gl-card__body{flex:1;min-width:0}
        .gl-card__title{font-weight:600;font-size:15px;display:flex;gap:8px;align-items:center;flex-wrap:wrap}
        .gl-type{display:inline-block;padding:1px 9px;border-radius:10px;font-size:11px}
        .gl-type.red{background:#fef2f2;color:#b91c1c}
        .gl-type.white{background:#fff7ed;color:#c2410c}
        .gl-lock{font-size:12px;color:#888}
        .gl-meta{font-size:12px;color:#888;margin-top:4px;display:flex;gap:12px;flex-wrap:wrap}
        .gl-note{font-size:13px;color:var(--text,#333);white-space:pre-wrap;margin-top:6px}
        .gl-empty{text-align:center;color:#999;padding:40px}
        button.gl-btn{padding:7px 14px;border-radius:8px;border:1px solid var(--accent,#3b82f6);background:var(--accent,#3b82f6);color:#fff;cursor:pointer;font-size:13px}
        button.gl-btn.ghost{background:transparent;color:var(--accent,#3b82f6)}
        button.gl-btn.danger{background:#dc2626;border-color:#dc2626}
        .gl-bar{position:sticky;bottom:12px;display:none;align-items:center;gap:10px;background:var(--accent,#3b82f6);color:#fff;padding:10px 16px;border-radius:12px;box-shadow:0 6px 20px rgba(0,0,0,.2);margin-top:14px}
        .gl-bar.show{display:flex}
        .gl-modal-body{padding:16px;max-width:560px;max-height:80vh;overflow:auto}
        .gl-field{margin-bottom:12px}
        .gl-field label{display:block;font-size:12px;color:#777;margin-bottom:4px}
        .gl-field input,.gl-field textarea,.gl-field select{width:100%;padding:8px;border:1px solid var(--border,#ddd);border-radius:8px;background:var(--bg,#fff);color:var(--text,#222);box-sizing:border-box}
        .gl-radios{display:flex;gap:10px}
        .gl-radios label{display:flex;gap:6px;align-items:center;font-size:14px;border:1px solid var(--border,#ddd);border-radius:8px;padding:8px 12px;cursor:pointer}
        .gl-radios label.active-red{border-color:#dc2626;background:#fef2f2}
        .gl-radios label.active-white{border-color:#ea580c;background:#fff7ed}
      </style>
      <div class="gl-head">
        <h2>${esc(t('giftLedger.title'))}</h2>
        <div class="gl-spacer"></div>
        <button class="gl-btn ghost" id="gl-select">${esc(t('giftLedger.selectMode'))}</button>
        <button class="gl-btn" id="gl-add">+ ${esc(t('giftLedger.add'))}</button>
      </div>
      <div class="gl-tabs" id="gl-tabs"></div>
      <div class="gl-filters">
        <input id="gl-q" placeholder="${esc(t('giftLedger.searchPlaceholder'))}">
      </div>
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

  function countFor(key) {
    if (key === 'all') return state.items.length;
    return state.items.filter((it) => it.type === key).length;
  }
  function refreshCounts() {
    tabsEl.querySelectorAll('.gl-count').forEach((el) => {
      const c = countFor(el.dataset.count);
      el.textContent = c ? ` ${c}` : '';
    });
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
    const lock = it.is_private ? `<span class="gl-lock">🔒</span>` : '';
    const amount = formatAmount(it.amount);
    return `<div class="gl-card ${state.selectMode && state.selected.has(it.id) ? 'selected' : ''}" data-id="${it.id}">
      ${check}
      <div class="gl-card__body">
        <div class="gl-card__title">
          ${esc(it.event_name)}
          <span class="gl-type ${it.type}">${esc(typeLabel(it.type))}</span>
          ${lock}
        </div>
        <div class="gl-meta">
          ${it.event_date ? `<span>📅 ${esc(it.event_date)}</span>` : ''}
          ${it.giver ? `<span>🎁 ${esc(it.giver)}</span>` : ''}
          ${it.relationship ? `<span>· ${esc(it.relationship)}</span>` : ''}
          <span>💰 ${esc(amount)}</span>
        </div>
        ${it.note ? `<div class="gl-note">${esc(it.note)}</div>` : ''}
      </div>
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
        list.innerHTML = `<div class="gl-empty">${esc(t('giftLedger.empty'))}</div>`;
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
