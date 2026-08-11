/**
 * Modul: Einstellungen (Settings) — Schutz vor stillem Verwerfen
 * Zweck: Ein Klick in die Seitenleiste tauschte das Blatt sofort aus; halb
 *        ausgefüllte Formulare waren wortlos weg (Critique 2026-07-27). Der
 *        Guard merkt sich, in welchen Formularen der Nutzer gearbeitet hat, und
 *        fragt nach, bevor dieser Stand verloren geht.
 * Abhängigkeiten: /i18n.js, /components/modal.js
 */

import { t } from '/i18n.js';
import { confirmModal } from '/components/modal.js';

// Formular-Referenzen statt eines Flags: so bleibt erkennbar, ob der offene
// Stand ueberhaupt noch im Dokument haengt.
const dirtyForms = new Set();
let unloadBound = false;

/**
 * Nur Formulare mit eigenem Absenden koennen ungespeicherte Aenderungen haben.
 * Die vielen Schalter und Auswahlfelder der Einstellungen schreiben sofort -
 * eine Rueckfrage waere dort schlicht falsch.
 */
function savableForm(target) {
  const form = typeof target?.closest === 'function' ? target.closest('form') : null;
  if (!form) return null;
  return form.querySelector('button[type="submit"], input[type="submit"]') ? form : null;
}

// Verlaesst der Nutzer die Einstellungen, verschwindet die Shell aus dem
// Dokument. Die Pruefung auf isConnected raeumt den Zustand damit von selbst
// ab, ohne dass es einen "Settings verlassen"-Haken braeuchte.
function hasOpenEdits() {
  for (const form of dirtyForms) {
    if (!form.isConnected) dirtyForms.delete(form);
  }
  return dirtyForms.size > 0;
}

function onBeforeUnload(event) {
  if (!hasOpenEdits()) return;
  event.preventDefault();
  event.returnValue = '';
}

/**
 * Bindet das Tracking an den Blatt-Container. Der Container ist pro Blatt neu,
 * die Listener verschwinden also mit ihm.
 */
export function watchLeafForms(container) {
  clearLeafEdits();

  const mark = (event) => {
    // Nur echte Eingaben: programmatisch gesetzte Werte (Daten aus der API,
    // Re-Renders eines Blatts) duerfen nicht als Nutzerarbeit zaehlen.
    if (!event.isTrusted) return;
    const form = savableForm(event.target);
    if (form) dirtyForms.add(form);
  };
  const release = (event) => {
    const form = event.target?.closest?.('form');
    if (form) dirtyForms.delete(form);
  };

  container.addEventListener('input', mark, true);
  container.addEventListener('change', mark, true);
  container.addEventListener('submit', release, true);
  container.addEventListener('reset', release, true);

  if (!unloadBound) {
    window.addEventListener('beforeunload', onBeforeUnload);
    unloadBound = true;
  }
}

export function clearLeafEdits() {
  dirtyForms.clear();
}

/**
 * Vor jeder Navigation aus einem Blatt heraus aufrufen. Liefert true, wenn
 * weitergegangen werden darf.
 */
export async function confirmLeafExit() {
  if (!hasOpenEdits()) return true;
  const confirmed = await confirmModal(t('modal.unsavedChanges'), {
    danger: false,
    confirmLabel: t('modal.discardChanges'),
    detail: t('modal.unsavedChangesDetail'),
  });
  if (confirmed) clearLeafEdits();
  return confirmed;
}
