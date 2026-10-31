/**
 * Haushalts-Medizinschrank („药箱") — Sub-Tab von /health/cabinet.
 *
 * Familienweite Ansicht über alle sichtbaren medications-Zeilen mit Fokus auf
 * Bestand & Haltbarkeit (im Gegensatz zum Meds-Tab, der die Einnahme pro Person
 * verwaltet). Gleiche Datenbasis wie der Meds-Tab — hier erscheinen nur die
 * Schrank-Felder (v165): Kategorie, Kaufdatum, Haltbarkeit, Beipackzettel.
 *
 * Nachschlagen: eingebauter Katalog (drug-catalog.js) zuerst; findet der nichts,
 * fragt die KI (ai-drug.js). KI-Texte werden als „nur zur Orientierung" markiert.
 * Foto-Erkennung liest Packungsaufdrucke (Name/Form/Haltbarkeit), das Bild
 * selbst wird nie gespeichert.
 */

import { api } from '/api.js';
import { t } from '/i18n.js';
import { esc } from '/utils/html.js';
import { openModal, closeModal, reportFieldError } from '/components/modal.js';

const CATEGORY_KEYS = ['otc', 'prescription', 'external', 'firstaid', 'children', 'supplement', 'other'];
// 药品常用计量单位（严格下拉 + 自定义，用户反馈 2026-10-27：自由输入不直观）
const UNIT_PRESETS = ['盒', '瓶', '板', '片', '粒', '支', '袋', '包', '罐', '管', '贴', '瓶装', '毫升', '克'];
const UNIT_CUSTOM = '__unit_custom__';

function unitSelectOptions(selected) {
  const sel = String(selected || '').trim();
  const isPreset = UNIT_PRESETS.includes(sel);
  return ['<option value="">' + esc(t('health.cabinet.unitNone')) + '</option>']
    .concat(UNIT_PRESETS.map((u) => `<option value="${esc(u)}" ${u === sel ? 'selected' : ''}>${esc(u)}</option>`))
    .concat(`<option value="${UNIT_CUSTOM}" ${sel && !isPreset ? 'selected' : ''}>${esc(t('health.cabinet.unitCustom'))}</option>`)
    .join('');
}

/** 单位下拉 ↔ 自定义文本框联动；返回取值函数。 */
function wireUnitField(panel, initialValue) {
  const sel = panel.querySelector('#cab-unit-select');
  const input = panel.querySelector('#cab-unit');
  const sync = () => {
    const isCustom = sel.value === UNIT_CUSTOM;
    input.style.display = isCustom ? '' : 'none';
    if (isCustom && !input.value) {
      input.value = initialValue && !UNIT_PRESETS.includes(initialValue) ? initialValue : '';
    }
    if (!isCustom) input.value = '';
  };
  sel.addEventListener('change', sync);
  sync();
  return () => (sel.value === UNIT_CUSTOM ? input.value.trim() : sel.value || undefined);
}


/**
 * 统一「查询」按钮（用户反馈 2026-10-27）：不再边打字边自动填充——输入到一半
 * 就被带出来的内容会污染最终药名。改为输完药名或条码、点「查询」才填充：
 *   - 条码框有 ≥8 位数字 → 查商品库，带回名称/品牌/厂家/规格，命中内置药库再带说明书；
 *   - 否则按药名查（内置药库优先，缺失再用 AI），填说明书相关字段。
 * 条码路径不覆盖用户已手填的字段；药名路径按"主动点查询"意图整组覆盖说明书。
 */
// 免费 mxnzp 账户限 1 QPS。前端在条码查询上加 1.2s 节流，避免连点或连扫
// 撞限（后端也有缓存和限流提示兜底）。
let lastBcQueryTs = 0;

async function doQuery(panel, setStatus) {
  const barcode = panel.querySelector('#cab-barcode')?.value.replace(/[\s-]/g, '').trim() || '';
  const name = panel.querySelector('#cab-name')?.value.trim() || '';

  // 2) 药名查询（内置药库 + AI 兜底）。条码未收录时也会走这里（0.0.64 降级）。
  async function queryByName() {
    if (!name) {
      reportFieldError(panel.querySelector('#cab-name'), t('health.cabinet.nameFirst'));
      return;
    }
    setStatus(t('health.cabinet.lookingUp'));
    try {
      const res = await api.get(`/health/cabinet/drug-info?name=${encodeURIComponent(name)}`);
      const d = res?.data || {};
      if (d.category) panel.querySelector('#cab-category').value = d.category;
      if (d.form) panel.querySelector('#cab-form-field').value = d.form;
      if (d.efficacy) panel.querySelector('#cab-efficacy').value = d.efficacy;
      if (d.indications) panel.querySelector('#cab-indications').value = d.indications;
      if (d.usage_text) panel.querySelector('#cab-usage').value = d.usage_text;
      if (d.cautions) panel.querySelector('#cab-cautions').value = d.cautions;
      if (d.info_source === 'ai') panel.dataset.infoSource = 'ai';
      setStatus(d.info_source === 'ai' ? t('health.cabinet.lookupAi') : t('health.cabinet.lookupBuiltin'));
    } catch (err) {
      setStatus('');
      const msg = err?.data?.code === 'not-configured'
        ? t('health.cabinet.aiNotConfigured')
        : (err?.data?.error || t('health.cabinet.lookupFail'));
      window.yuvomi?.showToast(msg, 'danger');
    }
  }

  // 1) 条码优先
  if (/^\d{8,32}$/.test(barcode)) {
    // 药品追溯码是 20 位数字串，不是商品条码（EAN-8/UPC/EAN-13/GTIN-14 最多
    // 14 位）——商品库必然查不到，直接提示并降级按药名查，省一次 QPS 调用。
    if (barcode.length > 14) {
      setStatus(t('health.cabinet.traceCodeHint'));
      await queryByName();
      return;
    }
    // 1 QPS 节流：连点/连扫太快要撞免费账户限额，先本地拦一道。
    const now = Date.now();
    if (now - lastBcQueryTs < 1200) {
      setStatus(t('health.cabinet.queryTooFast'));
      return;
    }
    lastBcQueryTs = now;
    setStatus(t('health.cabinet.barcodeLookingUp'));
    try {
      const res = await api.get(`/health/cabinet/barcode?code=${encodeURIComponent(barcode)}`);
      const d = res?.data || {};
      const setIf = (id, value) => {
        const el = panel.querySelector(id);
        if (el && value && !el.value.trim()) el.value = value;
      };
      setIf('#cab-name', d.name);
      setIf('#cab-brand', d.brand);
      setIf('#cab-manufacturer', d.manufacturer);
      if (d.spec) setIf('#cab-form-field', d.spec);
      const lf = d.leaflet;
      if (lf) {
        if (lf.category) panel.querySelector('#cab-category').value = lf.category;
        setIf('#cab-efficacy', lf.efficacy);
        setIf('#cab-indications', lf.indications);
        setIf('#cab-usage', lf.usage_text);
        setIf('#cab-cautions', lf.cautions);
      }
      setStatus(lf
        ? t('health.cabinet.barcodeFilled', { name: d.matched || d.name })
        : t('health.cabinet.barcodeFoundNoLeaflet', { name: d.name }));
    } catch (err) {
      if (err?.data?.code === 'not-found') {
        // 0.0.64：免费商品库对药品条码覆盖有限。未收录时不再干等——
        // 药名已填就自动降级按药名查，把「不行」变成「还能查到」。
        if (name) {
          setStatus(t('health.cabinet.barcodeFallback'));
          await queryByName();
          return;
        }
        setStatus(t('health.cabinet.barcodeNotFound'));
        // 没填药名时，把光标移到药名框，引导手输而不是卡死。
        panel.querySelector('#cab-name')?.focus();
      } else if (err?.data?.code === 'not-configured') {
        // 之前静默（''），用户以为按钮坏了；现在明说。
        setStatus(t('health.cabinet.barcodeNotConfigured'));
      } else if (err?.data?.code === 'rate-limited') {
        // 后端兜底：仍撞到 1 QPS 限额时给人话提示（不报错）。.
        setStatus(err?.data?.error || t('health.cabinet.queryTooFast'));
      } else {
        // mxnzp 的其他业务错误原样简短提示，避免静默无反馈。
        setStatus(err?.data?.error ? String(err.data.error).slice(0, 40) : '');
      }
    }
    return;
  }

  await queryByName();
}

/**
 * 解析「支付宝/微信扫追溯码」复制过来的文字，提取药品字段。
 * 兼容两种版式：带「标签：值」的（如 药品名称：阿莫西林胶囊）和无标签的首行药名。
 * 只返回识别到的字段，调用方据此填充**空白**字段，不覆盖用户已手填内容。
 */
function parsePastedText(text) {
  const out = {};
  const lines = String(text || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  if (!lines.length) return out;

  const labelMap = [
    [/(药品名称|品名|商品名称|通用名称|药品名|药名|名称)\s*[:：]/, 'name'],
    [/(生产企业|生产厂家|生产单位|企业名称|生产厂商|厂家)\s*[:：]/, 'manufacturer'],
    [/(商标|品牌)\s*[:：]/, 'brand'],
    [/(包装规格|规格|包装)\s*[:：]/, 'spec'],
    [/(产品批号|生产批号|批号|批次)\s*[:：]/, 'batch'],
    [/(有效期至|有效期|失效日期|过期日期)\s*[:：]/, 'expiry'],
    [/(生产日期|制造日期)\s*[:：]/, 'production'],
    [/(追溯码|监管码|条形码|条码)\s*[:：]/, 'code'],
  ];
  for (const line of lines) {
    for (const [re, key] of labelMap) {
      const m = line.match(re);
      if (m) {
        const v = line.slice(m.index + m[0].length).trim().replace(/^[:：]/, '').trim();
        if (v && !out[key]) out[key] = v;
      }
    }
  }

  // 药名兜底：首行像药名的（含剂型词或较短）直接当作药名
  if (!out.name) {
    const formRe = /胶囊|片|颗粒|口服液|注射液|溶液|糖浆|膏|栓|丸|滴剂|喷雾|贴|合剂|散|冲剂|剂/;
    for (const line of lines) {
      if (line.length <= 20 && formRe.test(line)) { out.name = line; break; }
    }
    if (!out.name) out.name = lines[0];
  }

  // 日期规整为 yyyy-mm-dd（HTML date 输入要求）
  const normDate = (s) => {
    const m = String(s).match(/(\d{4})[-/年.](\d{1,2})[-/月.](\d{1,2})?/);
    if (m) return `${m[1]}-${String(m[2]).padStart(2, '0')}-${String(m[3] || 1).padStart(2, '0')}`;
    const m2 = String(s).match(/(\d{4})[-/年.](\d{1,2})/);
    if (m2) return `${m2[1]}-${String(m2[2]).padStart(2, '0')}-01`;
    return null;
  };
  out.expiry = normDate(out.expiry);
  out.production = normDate(out.production);
  return out;
}

/** 粘贴识别：把支付宝/微信扫码结果文字填进表单空白字段。 */
function runPasteRecognize(panel, setStatus) {
  const ta = panel.querySelector('#cab-paste');
  const text = ta?.value?.trim() || '';
  if (!text) { setStatus(t('health.cabinet.pasteEmpty')); ta?.focus(); return; }
  const d = parsePastedText(text);
  const note = panel.querySelector('#cab-note');
  const setIf = (id, value) => {
    const el = panel.querySelector(id);
    if (el && value && !el.value.trim()) el.value = value;
  };
  const filled = [];
  if (d.name) { setIf('#cab-name', d.name); filled.push(t('health.cabinet.field.name')); }
  if (d.manufacturer) { setIf('#cab-manufacturer', d.manufacturer); filled.push(t('health.cabinet.field.manufacturer')); }
  if (d.brand) { setIf('#cab-brand', d.brand); filled.push(t('health.cabinet.field.brand')); }
  if (d.spec) { setIf('#cab-form-field', d.spec); filled.push(t('health.cabinet.formPlaceholder')); }
  if (d.batch && note) {
    note.value = (note.value ? `${note.value}\n` : '') + t('health.cabinet.batchPrefix') + d.batch;
    filled.push(t('health.cabinet.batchPrefix').replace(/[：:\s]/g, ''));
  }
  if (d.expiry) { setIf('#cab-expiry', d.expiry); filled.push(t('health.cabinet.field.expiryDate')); }
  if (d.production) { setIf('#cab-purchase', d.production); filled.push(t('health.cabinet.field.purchaseDate')); }
  if (d.code) {
    if (/^\d{8,14}$/.test(d.code)) setIf('#cab-barcode', d.code);
    else if (note) note.value = (note.value ? `${note.value}\n` : '') + t('health.cabinet.tracePrefix') + d.code;
  }
  setStatus('');
  if (filled.length) {
    window.yuvomi?.showToast(t('health.cabinet.pasteDone', { fields: filled.join('、') }), 'success');
  } else {
    window.yuvomi?.showToast(t('health.cabinet.pasteNothing'), 'danger');
  }
}

/**
 * 「对比来源」：同一药名并行取「内置/商品库」与「AI」两套说明，逐条并列，
 * 让用户自己点「采用」认可的内容。不强覆盖，最终以保存为准。
 */
async function runCompare(panel, setStatus) {
  const name = panel.querySelector('#cab-name')?.value.trim();
  if (!name) { reportFieldError(panel.querySelector('#cab-name'), t('health.cabinet.nameFirst')); return; }
  const box = panel.querySelector('#cab-compare-result');
  if (!box) return;

  setStatus(t('health.cabinet.compareLoading'));
  box.innerHTML = `<p class="form-hint">${esc(t('health.cabinet.compareLoading'))}</p>`;

  const fields = [
    ['name', '#cab-name', t('health.cabinet.field.name')],
    ['efficacy', '#cab-efficacy', t('health.cabinet.field.efficacy')],
    ['indications', '#cab-indications', t('health.cabinet.field.indications')],
    ['usage_text', '#cab-usage', t('health.cabinet.field.usage')],
    ['cautions', '#cab-cautions', t('health.cabinet.field.cautions')],
  ];

  const fetchOne = async (forceAi) => {
    try {
      const res = await api.get(`/health/cabinet/drug-info?name=${encodeURIComponent(name)}${forceAi ? '&force=ai' : ''}`);
      return res?.data || null;
    } catch (err) {
      return { __err: err?.data?.code || 'error' };
    }
  };

  const [builtin, ai] = await Promise.all([fetchOne(false), fetchOne(true)]);

  // 内置只在真正命中目录时算「左源」；否则它也是 AI 兜底，与右源重复。
  const left = builtin && builtin.info_source === 'builtin' ? builtin : null;
  // 右源（force=ai）未配置时返回 not-configured
  const right = ai && ai.info_source === 'ai' ? ai : null;

  const sameAll = left && right && fields.every(([k]) => (left[k] || '') === (right[k] || ''));
  const leftHas = !!left;
  const rightHas = !!right;

  if (!leftHas && !rightHas) {
    box.innerHTML = `<p class="form-hint">${esc(t('health.cabinet.compareNoData'))}</p>`;
    setStatus('');
    return;
  }
  if (!rightHas && ai?.__err === 'not-configured') {
    box.innerHTML = `<p class="form-hint">${esc(t('health.cabinet.compareAiOff'))}</p>`;
    setStatus('');
  }

  const val = (src, key) => (src && src[key]) ? String(src[key]).trim() : '';
  const block = ([key, sel, label]) => `
    <div class="cab-cmp-block">
      <div class="cab-cmp-block__label">${esc(label)}</div>
      <div class="cab-cmp-block__cols">
        <div class="cab-cmp-side">
          <div class="cab-cmp-side__src">${esc(t('health.cabinet.compareBuiltin'))}</div>
          <div class="cab-cmp-side__val">${val(left, key) ? esc(val(left, key)) : '<span class="cab-cmp-empty">—</span>'}</div>
          ${val(left, key) ? `<button type="button" class="btn btn--ghost" style="padding:.25rem .6rem;font-size:.8rem" data-cmp-apply="left" data-cmp-key="${key}" data-cmp-sel="${sel}">${esc(t('health.cabinet.adoptThis'))}</button>` : ''}
        </div>
        <div class="cab-cmp-side">
          <div class="cab-cmp-side__src">${esc(t('health.cabinet.compareAi'))}</div>
          <div class="cab-cmp-side__val">${val(right, key) ? esc(val(right, key)) : '<span class="cab-cmp-empty">—</span>'}</div>
          ${val(right, key) ? `<button type="button" class="btn btn--ghost" style="padding:.25rem .6rem;font-size:.8rem" data-cmp-apply="right" data-cmp-key="${key}" data-cmp-sel="${sel}">${esc(t('health.cabinet.adoptThis'))}</button>` : ''}
        </div>
      </div>
    </div>`;

  box.innerHTML = `
    <div class="cab-compare">
      <p class="form-hint">${esc(t('health.cabinet.compareNote'))}</p>
      ${sameAll ? `<p class="form-hint">${esc(t('health.cabinet.compareSame'))}</p>` : ''}
      ${fields.map(block).join('')}
      <div class="cab-compare__all">
        ${leftHas ? `<button type="button" class="btn btn--secondary" style="padding:.3rem .8rem;font-size:.85rem" data-cmp-apply-all="left">${esc(t('health.cabinet.adoptAllLeft'))}</button>` : ''}
        ${rightHas ? `<button type="button" class="btn btn--secondary" style="padding:.3rem .8rem;font-size:.85rem" data-cmp-apply-all="right">${esc(t('health.cabinet.adoptAllRight'))}</button>` : ''}
      </div>
    </div>`;
  setStatus('');

  const data = { left, right };
  box.querySelectorAll('[data-cmp-apply]').forEach((btn) => btn.addEventListener('click', () => {
    const src = btn.dataset.cmpApply;
    const v = val(data[src], btn.dataset.cmpKey);
    const el = panel.querySelector(btn.dataset.cmpSel);
    if (el && v) { el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); }
  }));
  box.querySelectorAll('[data-cmp-apply-all]').forEach((btn) => btn.addEventListener('click', () => {
    const src = btn.dataset.cmpApplyAll;
    fields.forEach(([key, sel]) => {
      const v = val(data[src], key);
      const el = panel.querySelector(sel);
      if (el && v) { el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); }
    });
  }));
}

const FILTERS = ['all', 'expiring', 'expired', 'low'];

const state = {
  root: null,
  meId: null,
  items: [],
  stats: null,
  q: '',
  category: '',
  filter: 'all',
  loaded: false,
  error: false,
};

// --------------------------------------------------------
// Laden
// --------------------------------------------------------

async function load() {
  const params = new URLSearchParams();
  if (state.q) params.set('q', state.q);
  if (state.category) params.set('category', state.category);
  if (state.filter !== 'all') params.set('filter', state.filter);
  const res = await api.get(`/health/cabinet${params.toString() ? `?${params}` : ''}`);
  state.items = res.data || [];
  state.stats = res.stats || null;
}

async function reload() {
  try {
    await load();
    state.error = false;
  } catch (err) {
    console.error('[Cabinet] load error:', err);
    state.error = true;
  }
  render();
}

/** Vom FAB aus geöffnetes Modal gespeichert hat? Dann Liste auffrischen. */
export async function refreshIfVisible() {
  if (state.root?.isConnected && state.loaded) await reload();
}

// --------------------------------------------------------
// Mount + Render
// --------------------------------------------------------

export async function mountCabinet(root, { meId } = {}) {
  if (state.root === root && state.loaded && !state.error) {
    // Nur meId nachziehen (Profilwechsel ohne Neu-Render).
    if (meId != null) state.meId = meId;
    return;
  }
  state.root = root;
  if (meId != null) state.meId = meId;
  state.loaded = false;
  state.error = false;
  root.replaceChildren();
  root.insertAdjacentHTML('beforeend', `<div class="cabinet-loading">${esc(t('common.loading'))}</div>`);
  await reload();
  state.loaded = true;
}

function expiryBadge(item) {
  if (!item.expiry_date) return '';
  const today = new Date();
  const todayKey = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  const in30 = new Date(Date.now() + 30 * 86400000);
  const in30Key = `${in30.getFullYear()}-${String(in30.getMonth() + 1).padStart(2, '0')}-${String(in30.getDate()).padStart(2, '0')}`;
  if (item.expiry_date < todayKey) {
    return `<span class="cab-badge cab-badge--expired">${esc(t('health.cabinet.expired'))}</span>`;
  }
  if (item.expiry_date <= in30Key) {
    return `<span class="cab-badge cab-badge--soon">${esc(t('health.cabinet.expiringSoon'))}</span>`;
  }
  return '';
}

function stockBadge(item) {
  if (item.stock_qty == null || item.refill_threshold == null) return '';
  if (item.stock_qty <= item.refill_threshold) {
    return `<span class="cab-badge cab-badge--low">${esc(t('health.cabinet.needRestock'))}</span>`;
  }
  return '';
}

function itemCard(item) {
  const catKey = item.category || 'other';
  const catLabel = t(`health.cabinet.cat.${catKey}`);
  const qty = item.stock_qty != null
    ? `${item.stock_qty}${item.stock_unit ? ` ${esc(item.stock_unit)}` : ''}`
    : '';
  const canWrite = item.user_id === state.meId;
  return `
    <div class="cab-card" data-id="${item.id}" role="button" tabindex="0">
      <div class="cab-card__main">
        <div class="cab-card__head">
          <span class="cab-card__name">${esc(item.name)}</span>
          <span class="cab-cat cab-cat--${esc(catKey)}">${esc(catLabel)}</span>
        </div>
        <div class="cab-card__meta">
          ${item.dosage_text ? `<span>${esc(item.dosage_text)}</span>` : ''}
          ${qty ? `<span>${qty}</span>` : ''}
          ${item.expiry_date ? `<span>${esc(t('health.cabinet.expiryPrefix'))} ${esc(item.expiry_date)}</span>` : ''}
        </div>
      </div>
      <div class="cab-card__side">
        ${expiryBadge(item)}${stockBadge(item)}
        ${canWrite ? `<span class="cab-owner">${esc(t('health.cabinet.mine'))}</span>` : ''}
      </div>
    </div>`;
}

function render() {
  const root = state.root;
  if (!root?.isConnected) return;
  root.replaceChildren();

  if (state.error) {
    root.insertAdjacentHTML('beforeend', `
      <div class="empty-state">
        <i data-lucide="cloud-off" class="empty-state__icon" aria-hidden="true"></i>
        <div class="empty-state__title">${esc(t('health.cabinet.loadError'))}</div>
        <div class="empty-state__description">${esc(t('health.cabinet.loadErrorDesc'))}</div>
        <button class="btn btn--primary empty-state__cta" data-action="cab-retry">${esc(t('health.meds.retry'))}</button>
      </div>`);
    root.querySelector('[data-action="cab-retry"]')?.addEventListener('click', () => reload());
    if (window.lucide) window.lucide.createIcons({ el: root });
    return;
  }

  const s = state.stats || {};
  const chips = FILTERS.map((f) => {
    const n = f === 'all' ? s.total || 0 : s[f] || 0;
    return `<button type="button" class="cab-filter ${state.filter === f ? 'is-active' : ''}" data-filter="${f}">
      ${esc(t(`health.cabinet.filter.${f}`))}<small>${n}</small>
    </button>`;
  }).join('');
  const cats = [''].concat(CATEGORY_KEYS).map((c) => `
    <button type="button" class="cab-chip ${state.category === c ? 'is-active' : ''}" data-category="${c}">
      ${esc(c ? t(`health.cabinet.cat.${c}`) : t('health.cabinet.catAll'))}
    </button>`).join('');

  const cards = state.items.map(itemCard).join('');

  root.insertAdjacentHTML('beforeend', `
    <div class="cab-summary" role="group" aria-label="${esc(t('health.cabinet.summaryLabel'))}">
      ${chips}
    </div>
    <div class="cab-toolbar">
      <div class="cab-search">
        <i data-lucide="search" class="icon-sm" aria-hidden="true"></i>
        <input type="search" id="cab-q" placeholder="${esc(t('health.cabinet.searchPlaceholder'))}"
               value="${esc(state.q)}" autocomplete="off">
      </div>
      <div class="cab-cats" role="group" aria-label="${esc(t('health.cabinet.catAll'))}">${cats}</div>
    </div>
    ${state.items.length
      ? `<div class="cab-list">${cards}</div>`
      : `<div class="empty-state">
           <i data-lucide="briefcase-medical" class="empty-state__icon" aria-hidden="true"></i>
           <div class="empty-state__title">${esc(t('health.cabinet.emptyTitle'))}</div>
           <div class="empty-state__description">${esc(t('health.cabinet.emptyDesc'))}</div>
         </div>`}
    <p class="cab-disclaimer">${esc(t('health.cabinet.disclaimer'))}</p>
  `);

  let debounce;
  root.querySelector('#cab-q')?.addEventListener('input', (e) => {
    clearTimeout(debounce);
    debounce = setTimeout(() => {
      state.q = e.target.value.trim();
      load().then(render).catch(() => {});
    }, 250);
  });
  root.querySelectorAll('.cab-filter').forEach((el) =>
    el.addEventListener('click', () => {
      state.filter = el.dataset.filter;
      load().then(render).catch(() => {});
    }));
  root.querySelectorAll('.cab-chip').forEach((el) =>
    el.addEventListener('click', () => {
      state.category = el.dataset.category;
      load().then(render).catch(() => {});
    }));
  root.querySelectorAll('.cab-card').forEach((el) => {
    const open = () => {
      const item = state.items.find((i) => String(i.id) === el.dataset.id);
      if (item) showLeaflet(item);
    };
    el.addEventListener('click', open);
    el.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } });
  });

  if (window.lucide) window.lucide.createIcons({ el: root });
}

// --------------------------------------------------------
// Beipackzettel-Ansicht
// --------------------------------------------------------

function sourceBadge(med) {
  if (med.info_source === 'builtin') {
    return `<span class="cab-src cab-src--builtin">${esc(t('health.cabinet.srcBuiltin'))}</span>`;
  }
  if (med.info_source === 'ai') {
    return `<span class="cab-src cab-src--ai">${esc(t('health.cabinet.srcAi'))}</span>`;
  }
  return '';
}

function showLeaflet(item) {
  const canWrite = item.user_id === state.meId;
  const field = (label, text) => (text
    ? `<div class="form-field"><span class="label">${esc(label)}</span><p class="cab-leaflet__text">${esc(text)}</p></div>`
    : '');
  openModal({
    title: item.name,
    size: 'md',
    content: `
      <div class="cab-leaflet">
        ${sourceBadge(item)}
        <div class="cab-leaflet__meta">
          ${item.brand ? `<span>${esc(t('health.cabinet.field.brand'))}: ${esc(item.brand)}</span>` : ''}
          ${item.manufacturer ? `<span>${esc(t('health.cabinet.field.manufacturer'))}: ${esc(item.manufacturer)}</span>` : ''}
          ${item.barcode ? `<span>${esc(t('health.cabinet.field.barcode'))}: ${esc(item.barcode)}</span>` : ''}
          ${item.form ? `<span>${esc(item.form)}</span>` : ''}
          ${item.stock_qty != null ? `<span>${esc(t('health.cabinet.stockLabel'))} ${item.stock_qty}${item.stock_unit ? ` ${esc(item.stock_unit)}` : ''}</span>` : ''}
          ${item.expiry_date ? `<span>${esc(t('health.cabinet.expiryPrefix'))} ${esc(item.expiry_date)}</span>` : ''}
          ${item.owner_name ? `<span>@${esc(item.owner_name)}</span>` : ''}
        </div>
        ${field(t('health.cabinet.field.efficacy'), item.efficacy)}
        ${field(t('health.cabinet.field.indications'), item.indications)}
        ${field(t('health.cabinet.field.usage'), item.usage_text)}
        ${field(t('health.cabinet.field.cautions'), item.cautions)}
        ${field(t('health.meds.field.note'), item.note)}
        <div class="modal-actions">
          ${canWrite ? `<button type="button" class="btn btn--secondary" data-action="cab-edit">${esc(t('common.edit'))}</button>` : ''}
          <button type="button" class="btn btn--ghost" data-action="cab-leaflet-close">${esc(t('common.close'))}</button>
        </div>
      </div>`,
    onSave(panel) {
      panel.querySelector('[data-action="cab-leaflet-close"]')?.addEventListener('click', () => closeModal({ force: true }));
      panel.querySelector('[data-action="cab-edit"]')?.addEventListener('click', () => openCabinetMedModal(item));
    },
  });
}

// --------------------------------------------------------
// Formular (anlegen / bearbeiten)
// --------------------------------------------------------

const val = (v) => (v == null ? '' : String(v));

/**
 * Öffnet das Schrank-Formular (auch vom FAB des Tabs).
 * @param {object|null} med - bearbeiten, oder null für neu
 */
export function openCabinetMedModal(med = null) {
  const isEdit = !!med?.id;
  const catOptions = CATEGORY_KEYS.map((c) =>
    `<option value="${c}" ${val(med?.category) === c ? 'selected' : ''}>${esc(t(`health.cabinet.cat.${c}`))}</option>`).join('');

  openModal({
    title: isEdit ? t('health.cabinet.edit') : t('health.cabinet.add'),
    size: 'md',
    content: `
      <form id="cab-form" novalidate>
        <div class="cab-scan-row">
          <input type="file" id="cab-photo" accept="image/*" capture="environment" hidden>
          <button type="button" class="btn btn--secondary" data-action="cab-scan">
            <i data-lucide="camera" class="icon-sm" aria-hidden="true"></i>${esc(t('health.cabinet.scanButton'))}
          </button>
          <button type="button" class="btn btn--secondary" data-action="cab-lookup">
            <i data-lucide="search" class="icon-sm" aria-hidden="true"></i>${esc(t('health.cabinet.queryButton'))}
          </button>
          <button type="button" class="btn btn--secondary" data-action="cab-ai-lookup" title="${esc(t('health.cabinet.aiLookupHint'))}">
            <i data-lucide="sparkles" class="icon-sm" aria-hidden="true"></i>${esc(t('health.cabinet.aiLookupButton'))}
          </button>
          <button type="button" class="btn btn--secondary" data-action="cab-compare" title="${esc(t('health.cabinet.compareNote'))}">
            <i data-lucide="git-compare" class="icon-sm" aria-hidden="true"></i>${esc(t('health.cabinet.compareButton'))}
          </button>
          <span class="cab-scan-status form-hint" id="cab-scan-status" aria-live="polite"></span>
        </div>

        <details class="form-advanced cab-paste-box">
          <summary class="form-advanced__summary">
            <span>${esc(t('health.cabinet.pasteTitle'))}</span>
            <i data-lucide="chevron-down" class="form-advanced__chevron" aria-hidden="true"></i>
          </summary>
          <div class="form-advanced__body">
            <p class="form-hint">${esc(t('health.cabinet.pasteHint'))}</p>
            <textarea class="input" id="cab-paste" rows="3" maxlength="2000" placeholder="${esc(t('health.cabinet.pastePlaceholder'))}"></textarea>
            <button type="button" class="btn btn--secondary" data-action="cab-paste-recognize">
              <i data-lucide="clipboard-paste" class="icon-sm" aria-hidden="true"></i>${esc(t('health.cabinet.pasteButton'))}
            </button>
          </div>
        </details>
        <div id="cab-compare-result" class="cab-compare-result"></div>

        <div class="form-field">
          <label class="label" for="cab-name">${esc(t('health.cabinet.field.name'))} *</label>
          <input class="input" id="cab-name" maxlength="120" value="${esc(val(med?.name))}" autocomplete="off">
        </div>
        <div class="cab-grid-2">
          <div class="form-field">
            <label class="label" for="cab-category">${esc(t('health.cabinet.field.category'))}</label>
            <select class="input" id="cab-category">${catOptions}</select>
          </div>
          <div class="form-field">
            <label class="label" for="cab-form-field">${esc(t('health.meds.field.form'))}</label>
            <input class="input" id="cab-form-field" maxlength="30" value="${esc(val(med?.form))}" placeholder="${esc(t('health.cabinet.formPlaceholder'))}">
          </div>
        </div>
        <div class="cab-grid-3">
          <div class="form-field">
            <label class="label" for="cab-brand">${esc(t('health.cabinet.field.brand'))}</label>
            <input class="input" id="cab-brand" maxlength="60" value="${esc(val(med?.brand))}" autocomplete="off">
          </div>
          <div class="form-field">
            <label class="label" for="cab-manufacturer">${esc(t('health.cabinet.field.manufacturer'))}</label>
            <input class="input" id="cab-manufacturer" maxlength="60" value="${esc(val(med?.manufacturer))}" autocomplete="off">
          </div>
          <div class="form-field">
            <label class="label" for="cab-barcode">${esc(t('health.cabinet.field.barcode'))}</label>
            <input class="input" id="cab-barcode" maxlength="64" inputmode="numeric" value="${esc(val(med?.barcode))}" autocomplete="off">
          </div>
        </div>
        <div class="cab-grid-3">
          <div class="form-field">
            <label class="label" for="cab-stock">${esc(t('health.meds.field.stockQty'))}</label>
            <input class="input" id="cab-stock" type="number" step="any" min="0" value="${val(med?.stock_qty)}">
          </div>
          <div class="form-field">
            <label class="label" for="cab-unit-select">${esc(t('health.meds.field.stockUnit'))}</label>
            <select class="input" id="cab-unit-select">${unitSelectOptions(med?.stock_unit)}</select>
            <input class="input" id="cab-unit" maxlength="30" style="display:none;margin-top:8px" placeholder="${esc(t('health.cabinet.unitCustomPh'))}">
          </div>
          <div class="form-field">
            <label class="label" for="cab-refill">${esc(t('health.meds.field.refillThreshold'))}</label>
            <input class="input" id="cab-refill" type="number" step="any" min="0" value="${val(med?.refill_threshold)}">
          </div>
        </div>
        <div class="cab-grid-2">
          <div class="form-field">
            <label class="label" for="cab-purchase">${esc(t('health.cabinet.field.purchaseDate'))}</label>
            <input class="input" id="cab-purchase" type="date" value="${esc(val(med?.purchase_date))}">
          </div>
          <div class="form-field">
            <label class="label" for="cab-expiry">${esc(t('health.cabinet.field.expiryDate'))}</label>
            <input class="input" id="cab-expiry" type="date" value="${esc(val(med?.expiry_date))}">
          </div>
        </div>

        <div class="cab-leaflet-fields">
          <div class="form-field">
            <label class="label" for="cab-efficacy">${esc(t('health.cabinet.field.efficacy'))}</label>
            <input class="input" id="cab-efficacy" maxlength="120" value="${esc(val(med?.efficacy))}">
          </div>
          <div class="form-field">
            <label class="label" for="cab-indications">${esc(t('health.cabinet.field.indications'))}</label>
            <textarea class="input" id="cab-indications" rows="2" maxlength="1000">${esc(val(med?.indications))}</textarea>
          </div>
          <div class="form-field">
            <label class="label" for="cab-usage">${esc(t('health.cabinet.field.usage'))}</label>
            <textarea class="input" id="cab-usage" rows="2" maxlength="1000">${esc(val(med?.usage_text))}</textarea>
          </div>
          <div class="form-field">
            <label class="label" for="cab-cautions">${esc(t('health.cabinet.field.cautions'))}</label>
            <textarea class="input" id="cab-cautions" rows="2" maxlength="1000">${esc(val(med?.cautions))}</textarea>
          </div>
        </div>
        <div class="form-field">
          <label class="label" for="cab-note">${esc(t('health.meds.field.note'))}</label>
          <textarea class="input" id="cab-note" rows="2" maxlength="5000">${esc(val(med?.note))}</textarea>
        </div>

        <p class="form-hint">${esc(t('health.cabinet.aiHint'))}</p>

        <div class="modal-actions">
          ${isEdit ? `<button type="button" class="btn btn--danger btn--ghost" data-action="cab-delete">${esc(t('common.delete'))}</button>` : ''}
          <button type="button" class="btn btn--ghost" data-action="cab-cancel">${esc(t('common.cancel'))}</button>
          <button type="submit" class="btn btn--primary">${esc(t('common.save'))}</button>
        </div>
      </form>`,
    onSave(panel) {
      const statusEl = panel.querySelector('#cab-scan-status');
      const setStatus = (text) => { if (statusEl) statusEl.textContent = text; };

      panel.querySelector('[data-action="cab-cancel"]')?.addEventListener('click', () => closeModal({ force: true }));

      // 单位下拉联动（名称/条码改为点「查询」按钮才填充，不再边打字边带出）
      const getUnitValue = wireUnitField(panel, med?.stock_unit);

      // ------- Foto-Erkennung (Bild bleibt im Browser, wird nie gespeichert)
      const fileInput = panel.querySelector('#cab-photo');
      panel.querySelector('[data-action="cab-scan"]')?.addEventListener('click', () => fileInput.click());
      fileInput?.addEventListener('change', async () => {
        const file = fileInput.files?.[0];
        if (!file) return;
        fileInput.value = '';
        setStatus(t('health.cabinet.scanning'));
        try {
          const dataUrl = await compressImage(file, 1280);
          const res = await api.post('/health/cabinet/scan', { image: dataUrl });
          const d = res.data || {};
          if (d.name) panel.querySelector('#cab-name').value = d.name;
          if (d.form) panel.querySelector('#cab-form-field').value = d.form;
          if (d.brand) panel.querySelector('#cab-brand').value = d.brand;
          if (d.manufacturer) panel.querySelector('#cab-manufacturer').value = d.manufacturer;
          if (d.barcode) panel.querySelector('#cab-barcode').value = d.barcode;
          if (d.expiry_date) panel.querySelector('#cab-expiry').value = d.expiry_date;
          if (d.note) panel.querySelector('#cab-note').value = d.note;
          setStatus(t('health.cabinet.scanDone'));
          // 拍照带回的条码自动触发一次查询（mxnzp 商品库免费），补品牌/厂家/规格
          // 与说明书；无条码则跳过，避免重复打扰。
          if (d.barcode) {
            try { await doQuery(panel, setStatus); } catch { /* 查询失败不阻断拍照结果 */ }
          }
        } catch (err) {
          setStatus('');
          const msg = err?.data?.code === 'not-configured'
            ? t('health.cabinet.aiNotConfigured')
            : (err?.data?.error || t('health.cabinet.scanFail'));
          window.yuvomi?.showToast(msg, 'danger');
        }
      });

      // ------- 统一「查询」按钮（药名或条码，点一下才填充，见 doQuery）
      panel.querySelector('[data-action="cab-lookup"]')?.addEventListener('click', () => {
        doQuery(panel, setStatus);
      });

      // ------- 「AI 核对」按钮：跳过内置库用 AI 重新生成说明（内置可能有误/不全时）
      // 结果填进表单供用户核对选择，未配置 AI 时明确提示。
      panel.querySelector('[data-action="cab-ai-lookup"]')?.addEventListener('click', async () => {
        const name = panel.querySelector('#cab-name')?.value.trim();
        if (!name) {
          reportFieldError(panel.querySelector('#cab-name'), t('health.cabinet.nameFirst'));
          return;
        }
        setStatus(t('health.cabinet.aiLookingUp'));
        try {
          const res = await api.get(`/health/cabinet/drug-info?name=${encodeURIComponent(name)}&force=ai`);
          const d = res?.data || {};
          if (d.category) panel.querySelector('#cab-category').value = d.category;
          if (d.form) panel.querySelector('#cab-form-field').value = d.form;
          if (d.efficacy) panel.querySelector('#cab-efficacy').value = d.efficacy;
          if (d.indications) panel.querySelector('#cab-indications').value = d.indications;
          if (d.usage_text) panel.querySelector('#cab-usage').value = d.usage_text;
          if (d.cautions) panel.querySelector('#cab-cautions').value = d.cautions;
          if (d.info_source === 'ai') panel.dataset.infoSource = 'ai';
          setStatus(t('health.cabinet.aiFilled'));
        } catch (err) {
          setStatus('');
          const msg = err?.data?.code === 'not-configured'
            ? t('health.cabinet.aiNotConfigured')
            : (err?.data?.error || t('health.cabinet.lookupFail'));
          window.yuvomi?.showToast(msg, 'danger');
        }
      });

      // ------- 粘贴扫码结果识别（支付宝/微信追溯码文字 → 自动填表）
      panel.querySelector('[data-action="cab-paste-recognize"]')?.addEventListener('click', () => {
        runPasteRecognize(panel, setStatus);
      });

      // ------- 对比来源（内置/商品库 vs AI，逐条采用）
      panel.querySelector('[data-action="cab-compare"]')?.addEventListener('click', () => {
        runCompare(panel, setStatus);
      });

      // ------- 删除
      panel.querySelector('[data-action="cab-delete"]')?.addEventListener('click', async () => {
        if (!isEdit) return;
        try {
          await api.delete(`/health/medications/${med.id}`);
          closeModal({ force: true });
          window.yuvomi?.showToast(t('health.meds.deleted'), 'success');
          await refreshIfVisible();
        } catch (err) {
          window.yuvomi?.showToast(err?.data?.error || t('health.meds.deleteError'), 'danger');
        }
      });

      // ------- 保存
      panel.querySelector('#cab-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        const submitBtn = panel.querySelector('[type="submit"]');
        const name = panel.querySelector('#cab-name').value.trim();
        if (!name) {
          reportFieldError(panel.querySelector('#cab-name'), t('health.cabinet.nameRequired'));
          return;
        }
        const num = (sel) => {
          const raw = panel.querySelector(sel)?.value;
          return raw !== '' && raw != null ? Number(raw) : null;
        };
        const str = (sel) => panel.querySelector(sel)?.value?.trim() || undefined;
        const date = (sel) => panel.querySelector(sel)?.value || undefined;
        const body = {
          name,
          category: panel.querySelector('#cab-category')?.value || undefined,
          form: str('#cab-form-field'),
          brand: str('#cab-brand'),
          manufacturer: str('#cab-manufacturer'),
          barcode: str('#cab-barcode'),
          stock_qty: num('#cab-stock'),
          stock_unit: getUnitValue(),
          refill_threshold: num('#cab-refill'),
          purchase_date: date('#cab-purchase'),
          expiry_date: date('#cab-expiry'),
          efficacy: str('#cab-efficacy'),
          indications: str('#cab-indications'),
          usage_text: str('#cab-usage'),
          cautions: str('#cab-cautions'),
          note: str('#cab-note'),
          info_source: panel.dataset.infoSource || undefined,
        };
        submitBtn.disabled = true;
        try {
          if (isEdit) await api.patch(`/health/medications/${med.id}`, body);
          else await api.post('/health/medications', { ...body, visibility: 'family', active: 1 });
          closeModal({ force: true });
          window.yuvomi?.showToast(t('health.meds.saved'), 'success');
          await refreshIfVisible();
        } catch (err) {
          submitBtn.disabled = false;
          window.yuvomi?.showToast(err?.data?.error || t('health.meds.saveError'), 'danger');
        }
      });
    },
  });
}

/** Verkleinert ein Foto auf maxSide und liefert eine JPEG-dataURL. */
function compressImage(file, maxSide = 1280) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('read failed'));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error('decode failed'));
      img.onload = () => {
        const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
        const canvas = document.createElement('canvas');
        canvas.width = Math.round(img.width * scale);
        canvas.height = Math.round(img.height * scale);
        canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL('image/jpeg', 0.85));
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}
