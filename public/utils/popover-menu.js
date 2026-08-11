/**
 * Geteiltes Überlaufmenü über die native Popover-API.
 *
 * WARUM GETEILT: Der Kopf der Einkaufsliste trug mobil fünf Bedienelemente in
 * 173px Höhe, drei davon unbeschriftete Icons - darunter „Liste löschen" für die
 * Liste des ganzen Haushalts (Critique 2026-07-30). Ein Überlaufmenü löst beides
 * auf einmal: eine Zeile Chrome statt drei, und jeder Eintrag trägt sein Label.
 *
 * WARUM HIER UND NICHT IN shopping.js: Kontakte (`.contact-more-menu__panel`)
 * und Dokumente (`.documents-context-menu`) haben je eine private Kopie derselben
 * Sache - gleiche Popover-Mechanik, gleiche Positionierungsrechnung, gleiche
 * Eintrags-Geometrie, drei Klassennamen. Eine dritte Kopie in der Küche wäre
 * genau der Befund, den dieser Umbau abstellt („inkonsistentes
 * Komponenten-Vokabular"). Die beiden Bestandskopien sind hier bewusst NICHT
 * mitmigriert: das sind zwei fremde Module, und der Auftrag ist die Küche. Wer
 * sie nachzieht, löscht rund 60 Zeilen CSS und diese Datei bleibt unverändert.
 *
 * WARUM NATIVE POPOVER UND KEIN EIGENES OVERLAY: Top-Layer, Light-Dismiss (Klick
 * daneben) und Esc kommen vom Browser, inklusive Fokusrückgabe an den Trigger.
 * Ein Eigenbau müsste all das nachbauen - und der Focus-Trap des Modals in diesem
 * Repo ist der Beweis, wie viel daran hängt.
 *
 * WARUM DIE POSITION PER JS: `position: fixed` im Top-Layer kennt den Trigger
 * nicht. CSS-Anchor-Positioning (`anchor-name`/`position-anchor`) wäre der
 * richtige Weg, ist aber in Safari noch nicht überall da - und dieses Projekt
 * hat mit WebKit schon zwei Layout-Bugs bezahlt (siehe overflow:clip in
 * shopping.css). Die Rechnung unten ist dieselbe wie in contacts.js.
 */

import { esc } from '/utils/html.js';

/**
 * Baut Trigger und Panel als HTML-String.
 *
 * Die Einträge tragen `data-action`, also genau die Attribute, die der
 * delegierte Klick-Handler der Seite schon kennt: das Menü braucht keine eigene
 * Verdrahtung, es ist eine zweite Darstellung derselben Aktionen.
 *
 * @param {object}   opts
 * @param {string}   opts.id             Eindeutige Panel-ID (popovertarget).
 * @param {string}   opts.label          Zugänglicher Name des Triggers.
 * @param {Array<{action: string, label: string, icon: string, id?: string|number, danger?: boolean}>} opts.items
 * @param {string}   [opts.triggerClass] Zusätzliche Klassen für den Trigger.
 * @returns {string}
 */
export function popoverMenuHtml({ id, label, items = [], triggerClass = 'btn btn--ghost btn--icon' }) {
  const entries = items.map((item) => `
    <button type="button" role="menuitem"
            class="popover-menu__item${item.danger ? ' popover-menu__item--danger' : ''}"
            data-action="${esc(item.action)}"${item.id == null ? '' : ` data-id="${esc(String(item.id))}"`}>
      <i data-lucide="${esc(item.icon)}" class="icon-md" aria-hidden="true"></i>
      <span>${esc(item.label)}</span>
    </button>`).join('');

  return `
    <button type="button" class="${triggerClass} popover-menu__trigger"
            popovertarget="${esc(id)}" aria-label="${esc(label)}" title="${esc(label)}">
      <i data-lucide="ellipsis" class="icon-md" aria-hidden="true"></i>
    </button>
    <div class="popover-menu" id="${esc(id)}" popover role="menu">${entries}</div>`;
}

/** Verhindert das Aufblitzen an der Standardposition, bevor die Rechnung greift. */
function onBeforeToggle(event) {
  const panel = event.target;
  if (!(panel instanceof HTMLElement) || !panel.matches('.popover-menu')) return;
  if (event.newState === 'open') panel.style.opacity = '0';
}

function onToggle(event) {
  const panel = event.target;
  if (!(panel instanceof HTMLElement) || !panel.matches('.popover-menu')) return;
  if (event.newState !== 'open') { panel.style.opacity = ''; return; }

  const trigger = document.querySelector(`[popovertarget="${panel.id}"]`);
  if (trigger) {
    const rect = trigger.getBoundingClientRect();
    const width = panel.offsetWidth || 200;
    const height = panel.offsetHeight || 48;
    const gap = 4;
    // Rechtskante am Trigger, aber niemals außerhalb des Viewports.
    const left = Math.min(Math.max(8, rect.right - width), window.innerWidth - width - 8);
    let top = rect.bottom + gap;
    // Nach oben kippen, wenn unten kein Platz ist - der Kopf der Einkaufsliste
    // sitzt oben, das Zeilenmenü kann überall stehen.
    if (top + height > window.innerHeight - 8) top = rect.top - height - gap;
    panel.style.left = `${Math.round(left)}px`;
    panel.style.top = `${Math.round(Math.max(8, top))}px`;
  }
  panel.style.opacity = '1';
}

/**
 * Ein Klick auf einen Eintrag schließt das Menü.
 *
 * Capture-Phase, damit das Panel zu ist, bevor der delegierte Handler der Seite
 * einen Dialog öffnet - zwei Elemente im Top-Layer streiten sich sonst um
 * Light-Dismiss und Esc. Der Knoten bleibt dabei im DOM (Popover blendet nur
 * aus), `closest('[data-action]')` findet ihn in der Bubble-Phase also weiter.
 */
function onItemClick(event) {
  const item = event.target?.closest?.('.popover-menu__item');
  if (!item) return;
  item.closest('.popover-menu')?.hidePopover?.();
}

/**
 * Verdrahtet Positionierung und Schließen an einer stabilen Wurzel.
 *
 * `toggle` und `beforetoggle` steigen NICHT auf; sie erreichen einen Vorfahren
 * nur in der Capture-Phase. Genau daran hing der erste Versuch in contacts.js.
 *
 * Idempotent über ein data-Attribut: die Wurzel überlebt Re-Renders, der
 * Listener darf nicht mehrfach hängen.
 *
 * @param {HTMLElement} root
 */
export function installPopoverMenus(root) {
  if (!root || root.dataset.popoverMenus) return;
  root.dataset.popoverMenus = 'true';
  root.addEventListener('beforetoggle', onBeforeToggle, { capture: true });
  root.addEventListener('toggle', onToggle, { capture: true });
  root.addEventListener('click', onItemClick, { capture: true });
}
