/**
 * Modul: Settings – Datenimport (CSV/JSON)
 * Zweck: Notion / Feishu / Google Kalender / Notizen / andere Familien-Apps
 *        migrieren —— Datei hochladen → Vorschau (erste 20 Zeilen) →
 *        Spaltenzuordnung → Trockenlauf(dry run) → echter Import.
 *
 * Bedienprinzipien:
 *   - Jeder Schritt zeigt echte Daten, nie nur „Datei erhalten".
 *   - Ohne Vorschau kein Import: die Schaltflaeche bleibt gesperrt, solange
 *     Pflichtspalten nicht zugeordnet sind.
 *   - Fehler werden pro Zeile gemeldet (welche Zeile, welcher Grund), nicht als
 *     pauschales „Import fehlgeschlagen".
 *   - Das Parsen passiert serverseitig (services/import-csv.js); der Browser
 *     liest die Datei nur als Text (FileReader via Blob.text()).
 *
 * Abhängigkeiten: /api.js (dataImport), /i18n.js, /utils/html.js,
 *                 /settings/components.js
 */

import { dataImport } from '/api.js';
import { t } from '/i18n.js';
import { esc } from '/utils/html.js';
import { createInlineError, createInfoRow } from '/settings/components.js';

/** 失败明细最多展示多少行（再多就没有信息量，只会拖慢 DOM）。 */
const MAX_FAILURES_SHOWN = 50;

/** 渲染期状态：每次 render() 重新初始化，不跨页面泄漏。 */
const state = {
  modules: [],
  module: '',
  headers: [],
  rows: [],
  mapping: {},
  fileName: '',
  format: 'csv',
  hasHeader: true,
  sourceContent: '',
  totalRows: 0,
  busy: false,
};

/** 当前选中的模块定义。 */
function activeModule() {
  return state.modules.find((mod) => mod.key === state.module) ?? null;
}

/** 目标字段 → 源列下标的字符串形式；未映射返回空串（select 的空选项）。 */
function mappingValue(fieldKey) {
  const column = state.mapping[fieldKey];
  return column === undefined || column === null ? '' : String(column);
}

/** 尚未映射的必填字段数量 —— 决定「导入」按钮是否可用。 */
function missingRequired() {
  const module = activeModule();
  if (!module) return [];
  return module.fields.filter((field) => field.required && mappingValue(field.key) === '');
}

/** 提交给后端的 mapping（去掉未映射项，避免把 undefined 序列化丢掉）。 */
function cleanedMapping() {
  const mapping = {};
  for (const [key, column] of Object.entries(state.mapping)) {
    if (column === undefined || column === null || column === '') continue;
    mapping[key] = Number(column);
  }
  return mapping;
}

export async function render(container) {
  container.replaceChildren();
  container.insertAdjacentHTML('beforeend', `
    <section class="settings-section">
      <div class="settings-card">
        <p class="form-hint">${esc(t('import.purposeHint'))}</p>
        <div id="import-notice" role="status"></div>
        <form class="settings-form" id="import-form" novalidate>
          <div class="form-group">
            <label class="label" for="import-module">${esc(t('import.module'))}</label>
            <select class="input" id="import-module" name="module"></select>
            <p class="form-hint" id="import-module-hint"></p>
          </div>
          <div class="form-group">
            <label class="label" for="import-file">${esc(t('import.file'))}</label>
            <input class="input" id="import-file" type="file" accept=".csv,.json,text/csv,application/json" />
            <p class="form-hint">${esc(t('import.fileHint'))}</p>
          </div>
          <div class="form-group">
            <label class="label" for="import-content">${esc(t('import.paste'))}</label>
            <textarea class="input" id="import-content" name="content" rows="6"
              placeholder="title,due_date,priority&#10;Trash out,2026-04-01,high"></textarea>
            <p class="form-hint">${esc(t('import.pasteHint'))}</p>
          </div>
          <div class="settings-form-actions">
            <button type="button" class="btn btn--secondary" id="import-analyze" disabled>${esc(t('import.analyze'))}</button>
            <button type="button" class="btn btn--ghost" id="import-history">${esc(t('import.history'))}</button>
          </div>
        </form>
      </div>
      <div class="settings-card" id="import-mapping-card" hidden>
        <div id="import-preview"></div>
        <div id="import-mapping"></div>
        <div class="settings-form-actions">
          <button type="button" class="btn btn--secondary" id="import-dryrun">${esc(t('import.dryRun'))}</button>
          <button type="button" class="btn btn--primary" id="import-commit" disabled>${esc(t('import.commit'))}</button>
        </div>
        <div id="import-report"></div>
      </div>
      <div class="settings-card" id="import-history-card" hidden>
        <h3 class="settings-card__title">${esc(t('import.historyTitle'))}</h3>
        <div id="import-history-list"></div>
      </div>
    </section>
  `);

  const notice = container.querySelector('#import-notice');
  const moduleSelect = container.querySelector('#import-module');
  const moduleHint = container.querySelector('#import-module-hint');
  const fileInput = container.querySelector('#import-file');
  const contentInput = container.querySelector('#import-content');
  const analyzeBtn = container.querySelector('#import-analyze');
  const historyBtn = container.querySelector('#import-history');
  const mappingCard = container.querySelector('#import-mapping-card');
  const previewBox = container.querySelector('#import-preview');
  const mappingBox = container.querySelector('#import-mapping');
  const dryRunBtn = container.querySelector('#import-dryrun');
  const commitBtn = container.querySelector('#import-commit');
  const reportBox = container.querySelector('#import-report');
  const historyCard = container.querySelector('#import-history-card');
  const historyList = container.querySelector('#import-history-list');

  const clearNotice = () => notice.replaceChildren();
  const showError = (msg) => notice.replaceChildren(createInlineError(msg));
  const showToast = (msg) => {
    notice.replaceChildren();
    window.yuvomi?.showToast(msg, 'success');
  };

  // ---------------------------------------------------------------
  // Module laden
  // ---------------------------------------------------------------
  try {
    const res = await dataImport.modules();
    state.modules = res?.data ?? [];
  } catch (error) {
    showError(t('import.loadModulesFailed', { error: error?.message || t('common.errorGeneric') }));
    return;
  }
  if (state.modules.length === 0) {
    showError(t('import.noModules'));
    return;
  }

  moduleSelect.insertAdjacentHTML('beforeend', state.modules
    .map((mod) => `<option value="${esc(mod.key)}">${esc(t(`import.module.${mod.key}`))}</option>`)
    .join(''));
  state.module = state.modules[0].key;
  moduleSelect.value = state.module;
  moduleHint.textContent = t(`import.hint.${state.module}`);

  moduleSelect.addEventListener('change', () => {
    state.module = moduleSelect.value;
    moduleHint.textContent = t(`import.hint.${state.module}`);
    // Anderes Modul = andere Zielfelder: alte Zuordnung ist wertlos.
    mappingCard.hidden = true;
    reportBox.replaceChildren();
    state.mapping = {};
  });

  // ---------------------------------------------------------------
  // Quelle wählen: Datei oder Textarea
  // ---------------------------------------------------------------
  function updateAnalyze() {
    const hasSource = Boolean(fileInput.files?.[0]) || contentInput.value.trim().length > 0;
    analyzeBtn.disabled = !hasSource || state.busy;
  }
  fileInput.addEventListener('change', updateAnalyze);
  contentInput.addEventListener('input', updateAnalyze);

  async function readSource() {
    const file = fileInput.files?.[0];
    if (file) {
      state.format = /\.json$/i.test(file.name) ? 'json' : 'csv';
      state.fileName = file.name;
      state.sourceContent = await file.text();
    } else {
      const text = contentInput.value.trim();
      if (!text) return false;
      // 首尾字符是最便宜的格式探针：JSON 一定以 [ 或 { 开头。
      state.format = /^[[\s{]/.test(text) ? 'json' : 'csv';
      state.fileName = '';
      state.sourceContent = text;
    }
    return true;
  }

  // ---------------------------------------------------------------
  // Vorschau
  // ---------------------------------------------------------------
  analyzeBtn.addEventListener('click', async () => {
    clearNotice();
    state.busy = true;
    analyzeBtn.disabled = true;
    try {
      if (!await readSource()) {
        showError(t('import.errorNoSource'));
        return;
      }
      const res = await dataImport.preview({
        module: state.module,
        format: state.format,
        content: state.sourceContent,
        filename: state.fileName || null,
        hasHeader: true,
      });
      const data = res?.data ?? {};
      state.headers = data.headers ?? [];
      state.rows = data.rows ?? [];
      state.mapping = data.mapping ?? {};
      state.hasHeader = data.hasHeader !== false;
      state.totalRows = data.totalRows ?? 0;
      reportBox.replaceChildren();
      renderPreview(previewBox, data);
      renderMapping(mappingBox, commitBtn);
      mappingCard.hidden = false;
    } catch (error) {
      showError(t('import.previewFailed', { error: error?.message || t('common.errorGeneric') }));
    } finally {
      state.busy = false;
      updateAnalyze();
    }
  });

  // ---------------------------------------------------------------
  // Import ausführen (Trockenlauf und echt teilen sich denselben Pfad)
  // ---------------------------------------------------------------
  async function execute(dryRun, button) {
    clearNotice();
    state.busy = true;
    button.disabled = true;
    try {
      const res = await dataImport.run({
        module: state.module,
        format: state.format,
        content: state.sourceContent,
        filename: state.fileName || null,
        hasHeader: state.hasHeader,
        mapping: cleanedMapping(),
        dry_run: dryRun,
        skip_duplicates: true,
      });
      const report = res?.data;
      renderReport(reportBox, report);
      if (!report || report.failed === 0) {
        showToast(dryRun ? t('import.dryRunDone') : t('import.done'));
      }
    } catch (error) {
      showError(t('import.failed', { error: error?.message || t('common.errorGeneric') }));
    } finally {
      state.busy = false;
      button.disabled = false;
    }
  }

  dryRunBtn.addEventListener('click', () => execute(true, dryRunBtn));
  commitBtn.addEventListener('click', () => execute(false, commitBtn));

  // ---------------------------------------------------------------
  // Verlauf
  // ---------------------------------------------------------------
  historyBtn.addEventListener('click', async () => {
    historyCard.hidden = !historyCard.hidden;
    if (historyCard.hidden) return;
    try {
      const res = await dataImport.history(15);
      renderHistory(historyList, res?.data ?? []);
    } catch (error) {
      historyList.replaceChildren(createInlineError(error?.message || t('common.errorGeneric')));
    }
  });

  updateAnalyze();
}

/** 预览表格：真实的前 20 行。 */
function renderPreview(box, data) {
  if (!data || (data.headers ?? []).length === 0) {
    box.replaceChildren(createInlineError(t('import.errorEmptyFile')));
    return;
  }
  const head = data.headers.map((name) => `<th scope="col">${esc(name)}</th>`).join('');
  const body = (data.rows ?? [])
    .map((cells) => `<tr>${cells.map((cell) => `<td>${esc(String(cell ?? '').slice(0, 80))}</td>`).join('')}</tr>`)
    .join('');

  box.replaceChildren();
  box.insertAdjacentHTML('beforeend', `
    <h3 class="settings-card__title">${esc(t('import.previewTitle'))}</h3>
    <p class="form-hint">${esc(t('import.previewHint', { rows: data.totalRows ?? 0, columns: (data.headers ?? []).length }))}</p>
    <div class="table-scroll">
      <table class="data-table import-table">
        <thead><tr>${head}</tr></thead>
        <tbody>${body}</tbody>
      </table>
    </div>
    ${data.truncated ? `<p class="form-hint">${esc(t('import.previewTruncated', { count: (data.rows ?? []).length, total: data.totalRows ?? 0 }))}</p>` : ''}
  `);
}

/** 列映射：每个目标字段一个下拉，选项是源文件的所有列。 */
function renderMapping(box, commitBtn) {
  const module = activeModule();
  if (!module) { box.replaceChildren(); return; }

  const baseOptions = '<option value="">—</option>' + state.headers
    .map((name, index) => `<option value="${index}">${esc(name || `column ${index + 1}`)}</option>`)
    .join('');

  const groups = module.fields.map((field) => {
    const selected = mappingValue(field.key);
    const options = selected === ''
      ? baseOptions
      : baseOptions.replace(`value="${selected}"`, `value="${selected}" selected`);
    return `
      <div class="form-group">
        <label class="label" for="import-map-${esc(field.key)}">${esc(t(`import.field.${module.key}.${field.key}`))}${field.required ? ' *' : ''}</label>
        <select class="input" id="import-map-${esc(field.key)}" data-field="${esc(field.key)}">${options}</select>
      </div>`;
  }).join('');

  box.replaceChildren();
  box.insertAdjacentHTML('beforeend', `
    <h3 class="settings-card__title">${esc(t('import.mappingTitle'))}</h3>
    <p class="form-hint">${esc(t('import.mappingHint'))}</p>
    <div class="import-mapping-grid">${groups}</div>
    <p class="form-hint" id="import-mapping-warning"></p>
  `);

  const syncState = () => {
    for (const select of box.querySelectorAll('select[data-field]')) {
      state.mapping[select.dataset.field] = select.value === '' ? undefined : Number(select.value);
    }
    const missing = missingRequired();
    const warning = box.querySelector('#import-mapping-warning');
    if (warning) warning.textContent = missing.length ? t('import.missingRequired', { count: missing.length }) : '';
    commitBtn.disabled = missing.length > 0;
  };

  for (const select of box.querySelectorAll('select[data-field]')) {
    select.addEventListener('change', syncState);
  }
  syncState();
}

/** 导入报告：汇总 + 逐行失败明细。 */
function renderReport(box, report) {
  if (!report) {
    box.replaceChildren(createInlineError(t('common.errorGeneric')));
    return;
  }

  const rows = [
    createInfoRow({ label: t('import.reportRows'), value: String(report.total ?? 0) }),
    createInfoRow({
      label: report.dryRun ? t('import.reportWouldCreate') : t('import.reportCreated'),
      value: String(report.created ?? 0),
      tone: (report.created ?? 0) > 0 ? 'success' : null,
    }),
    createInfoRow({ label: t('import.reportSkipped'), value: String(report.skipped ?? 0) }),
    createInfoRow({
      label: t('import.reportFailed'),
      value: String(report.failed ?? 0),
      tone: (report.failed ?? 0) > 0 ? 'warning' : null,
    }),
  ];

  box.replaceChildren();
  for (const row of rows) box.appendChild(row);

  const warnings = report.warnings ?? [];
  if (warnings.length > 0) {
    box.insertAdjacentHTML('beforeend', `<p class="form-hint">${esc(warnings.join(' '))}</p>`);
  }

  const failures = report.failures ?? [];
  if (failures.length === 0) return;

  const shown = failures.slice(0, MAX_FAILURES_SHOWN);
  const items = shown
    .map((failure) => `<li><strong>${esc(t('import.rowLabel', { row: failure.row }))}</strong> — ${esc(failure.reason)}</li>`)
    .join('');
  const rest = failures.length > shown.length
    ? `<p class="form-hint">${esc(t('import.failuresTruncated', { count: failures.length - shown.length }))}</p>`
    : '';

  box.insertAdjacentHTML('beforeend', `
    <h3 class="settings-card__title">${esc(t('import.failuresTitle'))}</h3>
    <ul class="import-failures">${items}</ul>
    ${rest}
  `);
}

/** 历史批次列表。 */
function renderHistory(box, batches) {
  if (batches.length === 0) {
    box.replaceChildren();
    box.insertAdjacentHTML('beforeend', `<p class="form-hint">${esc(t('import.historyEmpty'))}</p>`);
    return;
  }
  box.replaceChildren();
  for (const batch of batches) {
    box.appendChild(createInfoRow({
      label: `${t(`import.module.${batch.module}`)} · ${batch.file_name || t('import.pasted')}`,
      value: t('import.historySummary', {
        total: batch.rows_total ?? 0,
        created: batch.created_rows ?? 0,
        skipped: batch.skipped_rows ?? 0,
        failed: batch.failed_rows ?? 0,
      }),
      tone: (batch.failed_rows ?? 0) > 0 ? 'warning' : null,
    }));
  }
}
