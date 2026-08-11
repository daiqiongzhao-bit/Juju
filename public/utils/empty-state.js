/**
 * Geteilter Leerzustands-Renderer.
 *
 * Die `.empty-state`-CSS-Grammatik (layout.css) ist seit langem vollständig:
 * `__icon`, `__title`, `__description`, `__hint`, `__cta`. Was fehlte, war eine
 * Stelle, die die KOMPOSITION erzwingt. Folge: 18 Seiten setzten die Teile frei
 * zusammen, und allein in der Küche entstanden drei Varianten desselben
 * Zustands - Rezepte mit doppelter Aussage in Description und Hint, Einkaufen
 * ganz ohne Hint und vertikal in 787px zentriert statt oben angesetzt, Vorrat
 * als einziger vollständig (Critique 2026-07-29).
 *
 * Der Renderer bleibt absichtlich i18n-frei: Aufrufer übergeben schon
 * aufgelöste Strings aus ihrem eigenen `t()`. Eine zweite Übersetzungsschicht
 * hier würde nur Key-Namen über Modulgrenzen schleppen.
 *
 * Die drei Varianten und ihre ARIA-Rollen sind aus `pantry.js` übernommen, das
 * sie als einziges Modul korrekt unterschieden hat:
 *
 *   'empty'      Noch nichts angelegt. Keine Rolle - das ist gewöhnlicher
 *                Seiteninhalt, keine Meldung. Primärer CTA.
 *   'no-results' Filter/Suche ohne Treffer. `role="status"`, weil der Zustand
 *                als Reaktion auf eine Nutzereingabe erscheint und angesagt
 *                werden muss. Sekundärer CTA (Zurücksetzen).
 *   'error'      Laden fehlgeschlagen. `role="alert"`. Primärer CTA (Erneut).
 *
 * Für die Variante 'error' ist `mountLoadError()` der richtige Einstieg, nicht
 * `mountEmptyState({ variant: 'error' })` - siehe dort.
 */

import { esc } from '/utils/html.js';

const VARIANTS = {
  'empty':      { role: null,     icon: 'inbox',          tone: 'primary'   },
  'no-results': { role: 'status', icon: 'search',         tone: 'secondary' },
  'error':      { role: 'alert',  icon: 'triangle-alert', tone: 'primary'   },
};

/**
 * Baut das Leerzustands-Element, ohne es einzuhängen.
 *
 * @param {object}   opts
 * @param {'empty'|'no-results'|'error'} [opts.variant='empty']
 * @param {string}   [opts.icon]         Lucide-Name; Default je Variante.
 * @param {string}    opts.title         Aufgelöster Titel (Pflicht).
 * @param {string}   [opts.description]  Aufgelöster Beschreibungstext.
 * @param {string}   [opts.hint]         Aufgelöster Hinweis. In der Küche nennt
 *                                       er die nächste Station des Kreislaufs.
 * @param {object}   [opts.action]       { label, onClick, icon?, tone? } - ein
 *                                       CTA. `icon` ist ein Lucide-Name, der
 *                                       dem Label vorangestellt wird.
 * @returns {HTMLDivElement}
 */
export function emptyStateEl({ variant = 'empty', icon, title, description, hint, action } = {}) {
  const spec = VARIANTS[variant] ?? VARIANTS.empty;

  // Alle Textfelder laufen durch plainText(). `esc()` würde ein durchgereichtes
  // Objekt klaglos als „[object Object]" darstellen - genau das stand im
  // Fehlerzustand des Vorrats auf dem Bildschirm, weil ein Aufrufer den rohen
  // Fehler statt einer Meldung übergab (Critique P0, 2026-07-30). Ein Nicht-Text
  // hier ist immer ein Aufruferfehler; ihn zu verschlucken ist besser, als ihn
  // dem Nutzer zu zeigen.
  title       = plainText(title);
  description = plainText(description);
  hint        = plainText(hint);

  const box = document.createElement('div');
  box.className = 'empty-state';
  if (spec.role) box.setAttribute('role', spec.role);

  // Feste Reihenfolge Icon → Titel → Beschreibung → Hinweis. Genau die
  // Freiheit, hier umzusortieren oder Teile zu überspringen, hat die vier
  // Küchen-Grammatiken erzeugt.
  const parts = [
    `<i data-lucide="${esc(icon || spec.icon)}" class="empty-state__icon" aria-hidden="true"></i>`,
    // <h2>, nicht <div>: der Leerzustand ist auf einer leeren Seite der einzige
    // Inhalt, und ohne Überschriften-Semantik ist der erste Bildschirm des
    // Moduls für einen Screenreader strukturlos (Critique 2026-07-30). h2, weil
    // jede Seite ihr h1 schon als sr-only-Modultitel führt.
    `<h2 class="empty-state__title">${esc(title ?? '')}</h2>`,
  ];
  if (description) parts.push(`<div class="empty-state__description">${esc(description)}</div>`);
  if (hint) parts.push(`<p class="empty-state__hint">${esc(hint)}</p>`);
  box.insertAdjacentHTML('beforeend', parts.join(''));

  if (plainText(action?.label)) {
    const cta = document.createElement('button');
    cta.type = 'button';
    cta.className = `btn btn--${action.tone || spec.tone} empty-state__cta`;
    if (action.icon) {
      cta.insertAdjacentHTML('afterbegin',
        `<i data-lucide="${esc(action.icon)}" aria-hidden="true" class="icon-md"></i>`);
    }
    // Label als Textknoten, nicht via textContent: sonst würde ein schon
    // eingefügtes Icon wieder entfernt.
    cta.append(document.createTextNode(plainText(action.label)));
    if (typeof action.onClick === 'function') cta.addEventListener('click', action.onClick);
    box.appendChild(cta);
  }

  return box;
}

/**
 * Baut den Leerzustand und ersetzt damit den Inhalt von `target`.
 *
 * `lucide.createIcons` muss NACH dem Einhängen laufen, sonst findet es die
 * `<i data-lucide>`-Platzhalter nicht - deshalb dieser Weg statt eines
 * Aufrufs in `emptyStateEl`.
 *
 * @param {HTMLElement} target
 * @param {object} opts  wie `emptyStateEl`
 * @returns {HTMLDivElement|null}
 */
export function mountEmptyState(target, opts) {
  if (!target) return null;
  const box = emptyStateEl(opts);
  target.replaceChildren(box);
  if (window.lucide) window.lucide.createIcons({ el: box });
  return box;
}

/**
 * Fehlerzustand nach einem fehlgeschlagenen Ladevorgang.
 *
 * Der vierte Zustand jeder Liste. Für „leer", „gefüllt" und „ladend" gab es je
 * einen geteilten Renderer, für „fehlgeschlagen" keinen - mit dem Ergebnis, dass
 * die vier Küchen-Tabs bei HTTP 500 vier verschiedene Dinge taten: Einkauf und
 * Essensplan zeigten ihren LEERZUSTAND samt anlegendem CTA (bei 31 vorhandenen
 * Artikeln bzw. 28 geplanten Mahlzeiten), der Vorrat einen korrekten Fehler mit
 * „[object Object]" als Erklärung, die Rezepte rissen die App in den globalen
 * Fehlerbildschirm (Critique P0, 2026-07-30).
 *
 * Ein Leerzustand ist die schädlichste der vier Antworten: er behauptet
 * Datenverlust und bietet als einzige Handlung eine an, die den Zustand
 * tatsächlich verändert. Deshalb ist die Regel an den Aufrufstellen: den
 * Leerzustand nur rendern, wenn die Antwort erfolgreich UND leer war.
 *
 * Diese Funktion erzwingt gegenüber `mountEmptyState({ variant: 'error' })` zwei
 * Dinge, die einzeln immer wieder vergessen wurden:
 *
 *   1. **Einen Ausweg.** Ohne `onRetry` + `retryLabel` gibt es keinen CTA und
 *      damit eine Sackgasse; der Aufruf ist dann unvollständig.
 *   2. **Die technische Zeile.** Sie kommt aus dem Fehlerobjekt, nie aus einem
 *      Servertext: `data.error` ist bei allen Routen ein unlokalisiertes
 *      englisches „Internal server error." und hätte in einer deutschen
 *      Oberfläche nichts verloren. Der Statuscode dagegen ist sprachneutral und
 *      für den Selbsthoster - der hier oft der Nutzer selbst ist - die einzig
 *      brauchbare Information.
 *
 * Bleibt i18n-frei wie der Rest der Datei: Aufrufer übergeben aufgelöste Strings.
 *
 * @param {HTMLElement} target
 * @param {object}      opts
 * @param {string}      opts.title        Aufgelöst, modulspezifisch („Vorrat
 *                                        konnte nicht geladen werden").
 * @param {string}      opts.description  Aufgelöst, was der Nutzer tun kann.
 * @param {unknown}     [opts.error]      Das gefangene Fehlerobjekt. Nur der
 *                                        Statuscode wird gelesen.
 * @param {string}      opts.retryLabel   Aufgelöstes CTA-Label.
 * @param {Function}    opts.onRetry      Wiederholt den Ladevorgang.
 * @returns {HTMLDivElement|null}
 */
export function mountLoadError(target, { title, description, error, retryLabel, onRetry } = {}) {
  return mountEmptyState(target, {
    variant: 'error',
    title,
    description,
    hint: errorDetail(error),
    action: typeof onRetry === 'function'
      ? { label: retryLabel, icon: 'refresh-cw', onClick: onRetry }
      : undefined,
  });
}

/**
 * Sprachneutrale Kurzform der Ursache, oder `null`.
 *
 * `status === 0` ist in `api.js` der Netzfehler ohne Antwort - dafür gibt es
 * keinen Code zu nennen, und „HTTP 0" wäre schlechter als nichts.
 */
function errorDetail(error) {
  const status = Number(error?.status);
  return Number.isInteger(status) && status > 0 ? `HTTP ${status}` : null;
}

/**
 * Lässt nur echten Anzeigetext durch; alles andere wird zu `null`.
 * Zahlen sind erlaubt (Zähler in Hinweisen), Objekte und Fehler nicht.
 */
function plainText(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value !== 'string') return null;
  return value.trim() ? value : null;
}
