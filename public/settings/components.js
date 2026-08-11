import { t } from '/i18n.js';
import { esc } from '/utils/html.js';

let settingRowIdCounter = 0;

function appendContent(container, content) {
  if (content == null) return;
  if (typeof content === 'object' && typeof content.nodeType === 'number') {
    container.appendChild(content);
    return;
  }
  container.appendChild(document.createTextNode(String(content)));
}

export function createDisclosure({
  id,
  summary,
  expanded = false,
  content,
}) {
  const section = document.createElement('section');
  section.className = 'settings-disclosure';

  const trigger = document.createElement('button');
  trigger.type = 'button';
  trigger.id = `${id}-trigger`;
  trigger.className = 'settings-disclosure__trigger';
  trigger.setAttribute('aria-controls', `${id}-panel`);
  trigger.setAttribute('aria-expanded', String(expanded));
  appendContent(trigger, summary);

  const icon = document.createElement('i');
  icon.className = 'settings-disclosure__icon';
  icon.dataset.lucide = 'chevron-down';
  icon.setAttribute('aria-hidden', 'true');
  trigger.appendChild(icon);

  const panel = document.createElement('div');
  panel.id = `${id}-panel`;
  panel.className = 'settings-disclosure__panel';
  panel.setAttribute('aria-labelledby', trigger.id);
  panel.hidden = !expanded;
  appendContent(panel, content);

  trigger.addEventListener('click', () => {
    const nextExpanded = trigger.getAttribute('aria-expanded') !== 'true';
    trigger.setAttribute('aria-expanded', String(nextExpanded));
    panel.hidden = !nextExpanded;
  });

  section.append(trigger, panel);
  return section;
}

// Ein Schalter, eine Form. Vorher erfand jedes Blatt seine eigene: `toggle-row`,
// `settings-toggle`, der iOS-Switch aus `toggle`/`toggle__track` und nackte
// Checkboxen standen für dieselbe Boolean-Entscheidung nebeneinander (Critique
// 2026-07-27). `attrs` nimmt alles auf, was ein Aufrufer sonst hartkodieren
// müsste - id, name, value, data-*, aria-describedby -, sodass es genau einen
// Escape-Pfad gibt. `true` rendert ein Boolean-Attribut, `false`/`null` lässt es weg.
function attrsHtml(attrs) {
  return Object.entries(attrs)
    .filter(([, value]) => value !== false && value != null)
    .map(([name, value]) => (value === true ? ` ${name}` : ` ${name}="${esc(String(value))}"`))
    .join('');
}

export function toggleRowHtml({
  label,
  checked = false,
  disabled = false,
  className = '',
  // Icon vor dem Text (Lucide-Name); der Platzhalter braucht wie überall ein
  // `lucide.createIcons()` nach dem Einfügen.
  icon = null,
  // Zeilen, deren Kontext den Schalter schon benennt (Modul-Listen), tragen ihr
  // Label nur für Screenreader.
  labelVisible = true,
  attrs = {},
}) {
  const rowClass = ['toggle-row', className].filter(Boolean).join(' ');
  const iconHtml = icon ? `<i data-lucide="${esc(icon)}" aria-hidden="true"></i>` : '';
  const labelClass = labelVisible ? '' : ' class="sr-only"';
  return `<label class="${rowClass}">`
    + `<input type="checkbox"${attrsHtml({ ...attrs, checked, disabled })}>`
    + iconHtml
    + `<span${labelClass}>${esc(String(label ?? ''))}</span>`
    + '</label>';
}

export function createToggleRow(options) {
  const host = document.createElement('div');
  host.insertAdjacentHTML('afterbegin', toggleRowHtml(options));
  return host.firstElementChild;
}

export function createSettingRow({ label, description, control }) {
  const rowId = `settings-setting-row-${++settingRowIdCounter}`;
  const formControl = control?.matches?.('input, select, textarea, button')
    ? control
    : control?.querySelector?.('input, select, textarea, button') ?? null;

  if (formControl && !formControl.id) {
    formControl.id = `${rowId}-control`;
  }

  const row = document.createElement('div');
  row.className = 'settings-setting-row';

  const copy = document.createElement('div');
  copy.className = 'settings-setting-row__copy';

  const title = document.createElement(formControl ? 'label' : 'div');
  title.className = 'settings-setting-row__label';
  title.textContent = String(label ?? '');
  if (formControl) title.htmlFor = formControl.id;
  copy.appendChild(title);

  if (description) {
    const detail = document.createElement('p');
    detail.id = `${rowId}-description`;
    detail.className = 'settings-setting-row__description';
    detail.textContent = String(description);
    copy.appendChild(detail);

    if (formControl) {
      const describedBy = (formControl.getAttribute('aria-describedby') ?? '')
        .split(/\s+/)
        .filter(Boolean);
      if (!describedBy.includes(detail.id)) describedBy.push(detail.id);
      formControl.setAttribute('aria-describedby', describedBy.join(' '));
    }
  }

  const controlContainer = document.createElement('div');
  controlContainer.className = 'settings-setting-row__control';
  appendContent(controlContainer, control);

  row.append(copy, controlContainer);
  return row;
}

export function createStatusSummary({
  title,
  status,
  details = [],
  action = null,
  tone = 'neutral',
  // Überschriftenebene, nicht Größe: die trägt `settings-status-summary__title`.
  // Blätter, in denen die Zusammenfassung direkt unter dem Leaf-Titel sitzt,
  // brauchen 2, sonst springt das Outline von h1 auf h3.
  level = 3,
}) {
  const allowedTones = new Set(['neutral', 'success', 'warning', 'danger']);
  const resolvedTone = allowedTones.has(tone) ? tone : 'neutral';
  const summary = document.createElement('section');
  summary.className = `settings-status-summary settings-status-summary--${resolvedTone}`;

  const heading = document.createElement(level === 2 ? 'h2' : 'h3');
  heading.className = 'settings-status-summary__title';
  heading.textContent = String(title ?? '');

  const statusText = document.createElement('p');
  statusText.className = 'settings-status-summary__status';
  statusText.textContent = String(status ?? '');

  summary.append(heading, statusText);

  if (details.length) {
    const list = document.createElement('ul');
    list.className = 'settings-status-summary__details';
    for (const detail of details) {
      const item = document.createElement('li');
      // Details sind entweder ein String oder { text, key }. Der Key macht eine
      // Zeile adressierbar, damit Aufrufer sie später gezielt aktualisieren
      // können, ohne die Karte neu zu bauen.
      if (detail && typeof detail === 'object') {
        item.textContent = String(detail.text ?? '');
        if (detail.key) item.dataset.key = detail.key;
      } else {
        item.textContent = String(detail);
      }
      list.appendChild(item);
    }
    summary.appendChild(list);
  }

  if (action && typeof action.nodeType === 'number') {
    const actionContainer = document.createElement('div');
    actionContainer.className = 'settings-status-summary__action';
    actionContainer.appendChild(action);
    summary.appendChild(actionContainer);
  }

  return summary;
}

export function createInfoRow({ label, value, tone = null, code = false }) {
  const row = document.createElement('div');
  row.className = 'settings-info-row';

  const labelEl = document.createElement('span');
  labelEl.className = 'settings-info-label';
  labelEl.textContent = String(label ?? '');

  const valueEl = document.createElement('span');
  valueEl.className = 'settings-info-value';
  const allowedTones = new Set(['success', 'danger', 'warning']);
  if (allowedTones.has(tone)) valueEl.classList.add(`settings-info-value--${tone}`);

  if (value != null && typeof value === 'object' && typeof value.nodeType === 'number') {
    valueEl.appendChild(value);
  } else if (code) {
    const codeEl = document.createElement('code');
    codeEl.textContent = String(value ?? '');
    valueEl.appendChild(codeEl);
  } else {
    valueEl.textContent = String(value ?? '');
  }

  row.append(labelEl, valueEl);
  return row;
}

export function createInfoList(rows = []) {
  const grid = document.createElement('div');
  grid.className = 'settings-info-grid';
  for (const row of rows) {
    if (row == null) continue;
    grid.appendChild(typeof row.nodeType === 'number' ? row : createInfoRow(row));
  }
  return grid;
}

export function createInlineError(message) {
  const error = document.createElement('p');
  error.className = 'settings-inline-error';
  error.setAttribute('role', 'alert');
  error.textContent = String(message ?? '');
  return error;
}

export function createRetryState({ message, onRetry }) {
  const state = document.createElement('div');
  state.className = 'settings-retry-state';
  state.appendChild(createInlineError(message));

  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'btn btn--secondary settings-retry-state__button';
  button.textContent = t('settings.retry');
  button.addEventListener('click', async () => {
    button.disabled = true;
    try {
      await onRetry?.();
    } catch (error) {
      console.error('[Settings] Retry failed:', error);
    } finally {
      button.disabled = false;
    }
  });

  state.appendChild(button);
  return state;
}
