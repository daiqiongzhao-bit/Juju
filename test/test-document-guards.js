/**
 * Modul: Dokument-Guards (Guard-Ebene 4 des Redesigns)
 * Zweck: Invarianten pruefen, die nur das GERENDERTE Dokument kennt. Das
 *        Stylesheet zeigt sie nicht: ein Ueberlauf kann von
 *        `overflow-x: hidden` verdeckt sein, eine Zielgroesse misst keine
 *        Textsuche, und ein Kontrastverstoss kann erst durch die Komposition
 *        zweier Regeln entstehen, deren Token-Paare je fuer sich AA halten.
 * Ausfuehren: npm run test:document-guards   (braucht Browser + Serverprozess)
 *
 * NICHT in `npm test`: die uebrige Kette ist netzfrei und serverlos und soll
 * das bleiben. test-suite-chain.js kennt die Zweiteilung als Regel (eine Suite,
 * die `puppeteer` importiert, gehoert in die Browser-Kette), nicht als
 * Namensausnahme.
 *
 * Der Harness (test/document-guards-harness.js) faehrt Server und Browser hoch.
 * Waehrend der Entwicklung zeigt `DOCUMENT_GUARDS_BASE_URL` auf einen bereits
 * laufenden Preview-Server und spart Migration + Seed.
 */

import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import {
  ROUTES,
  ANON_ROUTES,
  SETTINGS_ROUTES,
  startHarness,
  openPage,
  openAnonPage,
  gotoRoute,
  gotoAnonRoute,
  parseColor,
  composite,
  contrastRatio,
  toHex,
} from './document-guards-harness.js';
import { eachRule } from './css-rules.js';

const ROUTE_NAMES = Object.keys(ROUTES);
const SETTINGS_NAMES = Object.keys(SETTINGS_ROUTES);
const ALL_ROUTES = { ...ROUTES, ...SETTINGS_ROUTES };
let harness;

/* ────────────────────────────────────────────────────────────────────────────
 * Welche Sonde faehrt die 23 Settings-Blaetter - und welche nicht
 *
 * Die Blaetter kommen aus der Registry (siehe `SETTINGS_ROUTES` im Harness).
 * Sie an JEDE Sonde zu haengen waere bequem und falsch: die Suite liegt bei
 * ~26 Minuten, und 23 zusaetzliche Zustaende mal elf Sonden sind nicht gratis.
 *
 * DIE VOREINSTELLUNG IST „JA". Wer ein Blatt auslaesst, traegt hier ein, WARUM
 * die Regel dort nichts zu messen hat - das ist eine Aussage ueber die Regel,
 * keine Bequemlichkeit (Sonde 8 faehrt aus genau diesem Grund seit jeher nur
 * mobil). Eine neu gebaute Sonde sieht die Blaetter damit automatisch; das
 * Vergessen faellt auf die Seite der Vollstaendigkeit, nicht auf die der Luecke.
 *
 * Jeder Eintrag ist gegen den Bestand geprueft, nicht vermutet.
 * ──────────────────────────────────────────────────────────────────────────── */
const LEAVES_SKIPPED = new Map([
  ['Sonde 1', 'misst `.page-toolbar`. Ein Settings-Blatt traegt keine - sein Kopf ist '
    + '`.settings-leaf-header` (settings/shell.js:509), und das ist die Leisten-Regel (§2) '
    + 'und keine Auslassung: `/settings` fuehrt der Router als EINE Route mit einem '
    + 'Modulkopf, die Blaetter darunter sind Detailseiten. Die Sonde faende dort null '
    + 'Leisten und meldete 69 gruene Zustaende, die nie gemessen wurden. Den '
    + 'Dokument-Ueberlauf der Blaetter misst Sonde 10, und die faehrt sie.'],
  ['Sonde 5', 'faehrt eine Wischgeste auf `.swipe-row`. In `public/settings/**` kommt die '
    + 'Klasse nicht vor (geprueft, 0 Treffer); die Sonde ueberspringt einen Zustand ohne '
    + 'Wischzeile ohnehin. 23 Blaetter mal zwei Sprachen waeren reine Ladezeit ohne eine '
    + 'einzige Messung.'],
  ['Sonde 6', 'misst `.metric-grid`. Kommt in `public/settings/**` nicht vor (0 Treffer). '
    + 'Kennzahlreihen sind eine Bauform der Module, nicht der Einstellungen.'],
  ['Sonde 8', 'prueft das Andocken eines Kopfes MIT `--page-toolbar-lead`. Den setzt nur '
    + '`.page-toolbar`, und die gibt es auf einem Blatt nicht (siehe Sonde 1). Ohne '
    + 'Lead-Zone faellt jedes Blatt in die triviale Haelfte der Regel, die die Sonde dann '
    + '23-mal bestaetigt.'],
  ['Sonde 12', 'misst Glasflaechen, und die sitzen in der SHELL - Tab-Bar, Sidebar, Sheets, '
    + 'Toast, Datepicker-Popover, FAB. Die ist auf jeder Route dieselbe, also kaeme ein Befund '
    + 'dort 39-mal statt 16-mal. (Hier stand „dieselbe Begruendung wie bei Sonde 11" - Sonde 11 '
    + 'steht gar nicht in dieser Map, sie FAEHRT die Blaetter. Der Kopf oben verspricht „gegen '
    + 'den Bestand geprueft, nicht vermutet"; dieser Verweis war es nicht.) Gegengeprueft, dass '
    + 'die Blaetter keine eigene Glasflaeche mitbringen: `public/settings/**` setzt nirgends '
    + '`backdrop-filter`, und der einzige Glastraeger ihrer Shell ist die Sidebar der App.'],
  ['Sonde 13', 'oeffnet Modals ueber den FAB, und die Einstellungen haben keinen - weder die '
    + 'Uebersicht noch eines der 23 Blaetter. Die Sonde wuerde 23 Zustaende laden und '
    + '23-mal „kein FAB" in den Uebersprungsbeleg schreiben. Der Eintrag steht hier, weil sie '
    + 'bis Session 24 `ROUTE_NAMES` direkt nahm und die Blaetter damit STILLSCHWEIGEND '
    + 'ausliess: die Auslassung war richtig, aber nicht an der Stelle begruendet, an der '
    + 'jemand sie sucht - und genau dafuer gibt es diese Map.'],
]);

/** Die Zustaende, die eine Sonde abfaehrt: die 16 Routen, dazu die Blaetter. */
function sweep(probe) {
  return LEAVES_SKIPPED.has(probe) ? ROUTE_NAMES : [...ROUTE_NAMES, ...SETTINGS_NAMES];
}

/**
 * Auf einem Settings-Blatt wird NICHT durch die Sichten geklickt.
 *
 * `visitViews` faehrt jede exklusive Auswahl, die eine Seite deklariert - in den
 * Modulen ist das ein Sichtwechsel. In `public/settings/**` sind es drei
 * Gruppen, und zwei davon SCHREIBEN: der Themenschalter
 * (personal-appearance.js:165, setzt die Farbwelt fuer alles danach) und der
 * Wochenstart (modules-calendar.js:88, eine haushaltweite Einstellung in der
 * Datenbank). Nur der Modus-Umschalter der Rechtevergabe
 * (admin-permissions.js:547) ist ein reiner Sichtwechsel.
 *
 * Eine Sonde, die zwei von drei Gruppen umstellt, schreibt in den Seed und misst
 * beim naechsten Lauf eine andere App - genau die Grenze, die `visitViews` fuer
 * das `<select>` schon zieht. Die Signatur unterscheidet die drei nicht: ein
 * Themenknopf und ein Sicht-Umschalter tragen beide `aria-pressed`. Deshalb hier
 * die Regel und keine Ausnahmeliste; der Preis ist die zweite Sicht der
 * Rechtevergabe, deren erste (Rollen) im Standardzustand gemessen wird.
 */
const isLeaf = (name) => name.startsWith('settings/');

test('die Auslassungen der Settings-Blaetter nennen eine Sonde, die es gibt', () => {
  // Eine Begruendung fuer eine Sonde, die niemand mehr faehrt, ist eine
  // Allowlist, die keiner liest - dieselbe Stale-Pruefung wie bei SHAPE_EXEMPT
  // und TARGET_EXEMPT, nur ueber die eigene Datei.
  //
  // GESUCHT WIRD DER AUFRUF, NICHT DER NAME. Ein `includes('Sonde 1 -')` waere
  // gruen auf dem Kommentar, der das Entfallen der Sonde begruendet - genau die
  // Bauart, mit der der Eyebrow-Guard drei Runden lang das Gegenteil seiner
  // Regel bestaetigt hat. Ein Kommentar ist kein Aufruf von `test`/`describe`.
  const source = readFileSync(new URL(import.meta.url), 'utf8');
  const stale = [...LEAVES_SKIPPED.keys()]
    .filter((probe) => !new RegExp(`(?:test|describe)\\(\\s*'${probe} -`).test(source));
  assert.deepEqual(stale, [],
    'LEAVES_SKIPPED begruendet eine Auslassung fuer eine Sonde, die es nicht mehr gibt.');

  // Und die Gegenrichtung: die Ableitung muss ueberhaupt etwas liefern. Keine
  // feste Zahl - die Registry ist die Quelle, und ein neues Blatt soll die Suite
  // erweitern statt sie rot zu faerben (dieselbe Zusicherung wie „eine Sonde,
  // die nichts gemessen hat, darf nicht urteilen").
  assert.ok(SETTINGS_NAMES.length >= 20,
    `Nur ${SETTINGS_NAMES.length} Settings-Blaetter aus der Registry abgeleitet - `
    + 'die Ableitung greift nicht mehr, und die Sonden faehren wieder nur `/settings`.');
});

/* ────────────────────────────────────────────────────────────────────────────
 * Die Stylesheet-Quelle der Stale-Pruefungen
 *
 * Drei Ausnahmelisten dieser Datei fragen „gibt es die Klasse noch?". Bis
 * 2026-08-09 fragten zwei davon `allCss.includes('.' + cls)` ueber
 * zusammengehaengte, KOMMENTARBEHAFTETE Quellen - dieselbe Falle, die den
 * CSS-Regelscanner ueberhaupt erst noetig gemacht hat, in ihrer Schwesterform:
 *
 *   1. Eine Klasse, die nur noch in einem Kommentar steht („frueher trug
 *      `.item-check` hier…"), behaelt ihre Ausnahme fuer immer.
 *   2. `includes('.item-check')` ist auf `.item-checkbox` gruen. Eine
 *      Teilzeichenkette ist kein Klassenname.
 *
 * `eachRule()` (test/css-rules.js) ist seit Session 25 DER eine Regelscanner -
 * er strippt Kommentare und liefert Selektoren. Die Klassen kommen aus dem
 * SELEKTOR und als ganze Token, damit beide Fallen zu sind.
 * ──────────────────────────────────────────────────────────────────────────── */

/** Jede Regel aller App-Stylesheets, mit ihrer Datei. */
function allStyleRules() {
  const styles = new URL('../public/styles/', import.meta.url);
  const out = [];
  for (const entry of readdirSync(styles).filter((name) => name.endsWith('.css'))) {
    const css = readFileSync(new URL(entry, styles), 'utf8');
    for (const rule of eachRule(css)) out.push({ ...rule, file: entry });
  }
  return out;
}

/** Jeder Klassenname, den irgendein Selektor nennt - als ganzes Token. */
function selectorClasses(rules = allStyleRules()) {
  const out = new Set();
  for (const rule of rules) {
    for (const match of rule.selector.matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)) out.add(match[1]);
  }
  return out;
}

/**
 * Die aktuelle Route besuchen UND jede SICHT, die sie selbst als umschaltbar
 * deklariert. `visit(where)` laeuft in jedem Zustand einmal.
 *
 * WARUM DAS SEIN MUSS: eine Route ist nicht dasselbe wie eine Sicht. Von sieben
 * Kennzahlreihen der App liegt genau eine auf einer eigenen Route, die
 * Abo-Wischliste auf gar keiner, und die Listenansicht der Dokumente ebenso
 * wenig - Standard ist dort das Raster. Wer nur `ROUTES` abfaehrt, bekommt
 * seinen Guard gruen und hat die Haelfte der App nie gesehen. Die Leisten-Regel
 * (§2) sagt es von der anderen Seite: ein Untertab wechselt die SICHT, nicht
 * die Route.
 *
 * DIE SICHTEN KOMMEN AUS DEM MARKUP, NICHT AUS EINER LISTE: gefahren wird, was
 * die Seite selbst als exklusive Auswahl auszeichnet - `role="tab"` in einer
 * Tablist und Gruppen von `aria-pressed`-Knoepfen unter einem Traeger. Das ist
 * dieselbe Ableitung wie beim Glas-Guard (Session 16): die Zusage steht im
 * Element, nicht in einem Namen. Damit erreicht der Helfer alle vier Bauarten,
 * die es heute gibt (Budget-Untertabs, Health-Routen, Housekeeping-Tabs, der
 * Raster/Listen-Umschalter der Dokumente) und die, die noch kommen.
 *
 * NICHT ANGEFASST WIRD EIN `<select>`: das ist ein Eingabefeld. Eine Sonde, die
 * eines umstellt, schreibt in den Seed - genau die Grenze, die Sonde 5 fuer die
 * Wischgeste zieht.
 *
 * ZURUECKGESTELLT WIRD IMMER: `localStorage` haengt am Origin, nicht an der
 * Page. Ein hier umgeschalteter Zustand (die Dokumente merken sich ihre
 * Ansicht) fuende sich sonst in der naechsten Sonde wieder, und die maesse dann
 * eine Seite, die so nie jemand oeffnet.
 */
async function visitViews(page, where, visit) {
  await visit(where);

  const groups = await page.evaluate(() => {
    const vis = (el) => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    };
    const out = [];
    for (const list of document.querySelectorAll('[role="tablist"]')) {
      const tabs = [...list.querySelectorAll('[role="tab"]')].filter(vis);
      const cls = [...list.classList][0];
      if (tabs.length > 1 && cls) out.push({ sel: `.${cls} [role="tab"]`, n: tabs.length });
    }
    const byParent = new Map();
    for (const btn of document.querySelectorAll('[aria-pressed]')) {
      if (!vis(btn) || btn.closest('[role="tablist"]')) continue;
      const parent = btn.parentElement;
      if (!parent) continue;
      if (!byParent.has(parent)) byParent.set(parent, []);
      byParent.get(parent).push(btn);
    }
    for (const [parent, btns] of byParent) {
      const cls = [...parent.classList][0];
      if (btns.length > 1 && cls) out.push({ sel: `.${cls} > [aria-pressed]`, n: btns.length });
    }
    return out;
  });

  const active = (sel) => page.evaluate((s) => [...document.querySelectorAll(s)]
    .findIndex((e) => e.getAttribute('aria-selected') === 'true' || e.getAttribute('aria-pressed') === 'true'), sel);
  const clickAt = (sel, idx) => page.evaluate((s, i) => {
    const el = document.querySelectorAll(s)[i];
    if (!el) return false;
    el.click();
    return true;
  }, sel, idx);

  for (const group of groups) {
    const before = await active(group.sel);
    for (let i = 0; i < group.n; i += 1) {
      if (!(await clickAt(group.sel, i))) continue;
      // Der Wechsel laedt seine Daten nach; ohne das Warten misst die Sonde die
      // VORIGE Sicht (dieselbe Falle wie in Session 11, „eine Sonde misst nur,
      // was zum Messzeitpunkt existiert").
      await new Promise((resolve) => setTimeout(resolve, 1000));
      await visit(`${where}:${i}`);
    }
    if (before >= 0) {
      await clickAt(group.sel, before);
      await new Promise((resolve) => setTimeout(resolve, 600));
    }
  }
}

before(async () => {
  harness = await startHarness();
});

after(async () => {
  await harness?.close();
});

/* ────────────────────────────────────────────────────────────────────────────
 * Sonde 1: Kopf-Ueberlauf
 *
 * Der Modulkopf ist die einzige Komponente, die alle 17 Module teilen, und die
 * Stelle, an der ein Ueberlauf unsichtbar bleibt: `main.app-content` traegt
 * `overflow-x: hidden`, also wird abgeschnitten statt scrollbar. Gemessen im
 * Architektur-Audit: der Kopf der Haushaltshilfe ragte bei 375px 79px ueber die
 * rechte Kante, Titel und rechte Tabs waren teilweise unerreichbar.
 *
 * Die Regel prueft NACHFAHREN, nicht nur Kinder: eine Tab-Leiste im Kopf darf
 * ihre Tabs ueberlaufen lassen, WENN sie selbst scrollt oder clippt. Deshalb
 * wird jeder Nachfahre uebersprungen, dessen Weg zur Toolbar durch einen
 * Container mit nicht-sichtbarem overflow-x fuehrt - genau die Bauart, die die
 * Shell-Regel vorschreibt.
 *
 * Sprachen: `de` als Referenz, `uk` und `vi` als die beiden Locales mit den
 * laengsten Modulnamen. Ein Kopf, der in allen dreien passt, passt.
 * ──────────────────────────────────────────────────────────────────────────── */

const OVERFLOW_LOCALES = ['de', 'uk', 'vi'];

async function measureHeadOverflow(page) {
  return page.evaluate(() => {
    const out = [];
    const vw = document.documentElement.clientWidth;
    const selector = (el) => {
      const cls = [...el.classList].filter((c) => !c.startsWith('is-')).join('.');
      return `${el.tagName.toLowerCase()}${cls ? `.${cls}` : ''}`;
    };
    for (const bar of document.querySelectorAll('.page-toolbar')) {
      const barRect = bar.getBoundingClientRect();
      if (!barRect.width || !barRect.height) continue;
      const walk = (el, clipped) => {
        for (const child of el.children) {
          const cs = getComputedStyle(child);
          if (cs.display === 'none' || cs.visibility === 'hidden') continue;
          const r = child.getBoundingClientRect();
          if (!r.width && !r.height) continue;
          if (!clipped) {
            const over = Math.round(Math.max(r.right - vw, -r.left));
            if (over > 1) {
              out.push({
                toolbar: selector(bar),
                el: selector(child),
                over,
                width: Math.round(r.width),
              });
            }
          }
          const clips = cs.overflowX !== 'visible';
          walk(child, clipped || clips);
        }
      };
      const barOver = Math.round(Math.max(barRect.right - vw, -barRect.left));
      if (barOver > 1) {
        out.push({ toolbar: selector(bar), el: '(die Leiste selbst)', over: barOver, width: Math.round(barRect.width) });
      }
      walk(bar, false);
    }
    return out;
  });
}

describe('Sonde 1 - kein Modulkopf laeuft bei 375px ueber die Viewport-Kante', () => {
  for (const locale of OVERFLOW_LOCALES) {
    test(`Locale ${locale}`, async () => {
      const page = await openPage(harness, { device: 'mobile', theme: 'light', locale });
      const findings = [];
      for (const name of sweep('Sonde 1')) {
        await gotoRoute(page, ALL_ROUTES[name]);
        for (const f of await measureHeadOverflow(page)) {
          findings.push(`${name}/${locale}: ${f.el} in ${f.toolbar} ragt ${f.over}px hinaus (Breite ${f.width}px)`);
        }
      }
      await page.close();
      assert.deepEqual(
        findings,
        [],
        `Kopf-Ueberlauf bei 375px. Die Shell-Regel lautet: eine .page-toolbar bleibt in ` +
          `Zeilenrichtung, und eine Tab-Leiste im Kopf ist eine eigene, horizontal ` +
          `scrollende Zeile darunter (layout.css, Sektion "Tab-Leiste im Modulkopf").\n  ` +
          findings.join('\n  '),
      );
    });
  }
});

/* ────────────────────────────────────────────────────────────────────────────
 * Sonde 2: komponierter Textkontrast
 *
 * Der bestehende Guard `Textfarbe auf vividen Fuellflaechen haelt WCAG AA in
 * beiden Themes` (test-frontend-audit.js) prueft TOKEN-PAARE. Er kann einen
 * Verstoss nicht sehen, der erst im Dokument entsteht - etwa wenn ein
 * Nachfahren-Selektor mit hoeherer Spezifitaet Sekundaertext in einen
 * gefuellten Knopf hineinschreibt (gemessen: 1.13:1 im Light, 1.29:1 im Dark,
 * seit Runde 1 live).
 *
 * Gemessen wird der EFFEKTIVE Hintergrund: die Kette der Vorfahren wird
 * komponiert, bis eine deckende Flaeche erreicht ist. Alpha und `color-mix`
 * zaehlen dabei mit - `color-mix()` rendert als `color(srgb …)` und nicht als
 * `rgba()`, ein naiver Parser meldet hier Fehltreffer.
 *
 * Verlaeufe zaehlen als Kandidaten (siehe evaluateSample); bliebe die Sonde an
 * ihnen stehen, hoerte sie bei `.app-shell` auf zu messen - dreissig Elemente
 * je Route. Deaktivierte Bedienelemente sind ausgenommen, die nimmt WCAG 1.4.3
 * aus. Nur ein echtes Bild bleibt unrechenbar, und die Zahl steht im
 * Fehlertext, damit ein Anstieg auffaellt.
 * ──────────────────────────────────────────────────────────────────────────── */

async function collectTextSamples(page) {
  return page.evaluate(() => {
    const out = [];
    const selector = (el) => {
      const cls = [...el.classList].filter((c) => !c.startsWith('is-')).join('.');
      return `${el.tagName.toLowerCase()}${cls ? `.${cls}` : ''}`;
    };
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
    let el = walker.currentNode;
    while (el) {
      el = walker.nextNode();
      if (!el) break;
      if (el.closest('[aria-hidden="true"], .sr-only, yuvomi-install-prompt')) continue;
      if (el.matches(':disabled') || el.closest(':disabled, [aria-disabled="true"]')) continue;
      const text = [...el.childNodes]
        .filter((n) => n.nodeType === Node.TEXT_NODE)
        .map((n) => n.textContent.trim())
        .join(' ')
        .trim();
      if (!text) continue;
      const cs = getComputedStyle(el);
      if (cs.visibility === 'hidden' || cs.display === 'none' || parseFloat(cs.opacity) < 0.5) continue;
      const rect = el.getBoundingClientRect();
      if (rect.width < 2 || rect.height < 2) continue;

      // Die VOLLE Untergrund-Kette bis zum Wurzelelement einsammeln, roh. Wo
      // sie deckend wird und ob ein Verlauf dazwischenliegt, entscheidet Node -
      // so existiert der Farbparser genau einmal (im Harness) statt zweimal in
      // zwei Sprachen.
      //
      // BEKANNTE GRENZE, gemessen statt vermutet: die Kette ist der BAUM. Eine
      // Flaeche, die unter dem Text liegt, ohne ihn zu enthalten - die absolut
      // positionierte Pille der Tab-Bar gleitet als GESCHWISTER des aktiven
      // Eintrags -, faellt heraus. Gegen den gerenderten Pixel geprueft: die
      // Sonde meldet dort 4.20:1, das Bild zeigt 3.41:1. Sie findet den Fall
      // also, urteilt aber zu milde. Ein Versuch ueber `elementsFromPoint`
      // machte es SCHLECHTER statt besser (die Pille traegt
      // `pointer-events: none` und faellt aus dem Stapel, dafuer verschwand der
      // Befund ganz) - der ehrliche naechste Schritt waere der gerenderte
      // Pixel, nicht der Elementstapel.
      const layers = [];
      let node = el;
      while (node) {
        const ncs = getComputedStyle(node);
        layers.push({ bg: ncs.backgroundColor, image: ncs.backgroundImage });
        node = node.parentElement;
      }
      out.push({
        selector: selector(el),
        text: text.slice(0, 40),
        color: cs.color,
        size: parseFloat(cs.fontSize),
        weight: Number(cs.fontWeight) || 400,
        layers,
      });
    }
    return out;
  });
}

/**
 * Zerlegt einen `background-image`-Wert in seine Farbstops.
 * @returns {null|string[]} null, wenn ein echtes Bild im Spiel ist (dann ist
 *          der Untergrund nicht rechenbar), sonst die Stops eines Verlaufs.
 */
function gradientStops(image) {
  if (!image || image === 'none') return [];
  if (/url\(/i.test(image)) return null;
  return [...image.matchAll(/color\(srgb[^)]*\)|rgba?\([^)]*\)|#[0-9a-f]{3,8}/gi)].map((m) => m[0]);
}

/**
 * Komponiert den effektiven Untergrund eines Textelements und liefert den
 * SCHLECHTESTEN Kontrast, den er dort haben kann.
 *
 * WARUM EIN SCHLECHTESTER FALL UND KEIN EINZELWERT: `.app-shell` trägt
 * radiale Verläufe über dem Seitengrund. Eine Sonde, die bei einem Verlauf
 * aufgibt, hört genau dort auf zu messen, wo die meisten Texte stehen - rund
 * dreissig Elemente je Route, also die Hälfte des Dokuments. Deshalb werden
 * die Farbstops als Kandidaten behandelt: jeder wird auf den bisherigen
 * Untergrund komponiert, und es zählt der ungünstigste. Das ist eine
 * NÄHERUNG (die Stops werden auf das Endergebnis statt auf ihre eigene Ebene
 * gerechnet), aber eine konservative - sie kann strenger urteilen als die
 * Wirklichkeit, nie milder.
 *
 * @returns {null|{ratio: number, min: number, bg: number[], fg: number[]}}
 *          null nur noch bei einem echten Bild (`url(...)`).
 */
function evaluateSample(sample, pageBase) {
  // Erste deckende Ebene suchen; alles darunter ist wirkungslos.
  let opaqueAt = sample.layers.length - 1;
  for (let i = 0; i < sample.layers.length; i += 1) {
    if (parseColor(sample.layers[i].bg)[3] >= 1) {
      opaqueAt = i;
      break;
    }
  }
  let bg = pageBase;
  const candidates = [];
  for (let i = opaqueAt; i >= 0; i -= 1) {
    const layer = parseColor(sample.layers[i].bg);
    if (layer[3] > 0) bg = composite(layer, bg);
    const stops = gradientStops(sample.layers[i].image);
    if (stops === null) return null;
    candidates.push(...stops);
  }

  const fgRaw = parseColor(sample.color);
  const large = sample.size >= 24 || (sample.size >= 18.66 && sample.weight >= 700);
  const min = large ? 3 : 4.5;

  let worst = { ratio: Infinity, bg, fg: composite(fgRaw, bg) };
  for (const variant of [null, ...candidates]) {
    const under = variant === null ? bg : composite(parseColor(variant), bg);
    const fg = composite(fgRaw, under);
    const ratio = contrastRatio(fg, under);
    if (ratio < worst.ratio) worst = { ratio, bg: under, fg };
  }
  return { ...worst, min };
}

describe('Sonde 2 - jeder sichtbare Text haelt WCAG AA auf seinem KOMPONIERTEN Untergrund', () => {
  for (const theme of ['light', 'dark']) {
    for (const device of ['mobile', 'desktop']) {
      test(`${theme} / ${device}`, async () => {
        const page = await openPage(harness, { device, theme, locale: 'de' });
        const base = parseColor(
          await page.evaluate(() => getComputedStyle(document.documentElement).backgroundColor),
        );
        const pageBase = base[3] > 0 ? composite(base, [255, 255, 255]) : [255, 255, 255];
        const findings = [];
        let unpainted = 0;
        let measured = 0;
        for (const name of sweep('Sonde 2')) {
          await gotoRoute(page, ALL_ROUTES[name]);
          for (const sample of await collectTextSamples(page)) {
            const result = evaluateSample(sample, pageBase);
            if (!result) {
              unpainted += 1;
              continue;
            }
            // Der Zaehler steht an DERSELBEN Stelle, an der auch ein Finding
            // entstehen koennte - siehe der Nachweis unten.
            measured += 1;
            const { ratio, min, bg, fg } = result;
            if (ratio + 0.005 < min) {
              findings.push(
                `${name}/${theme}/${device}: ${ratio.toFixed(2)}:1 (soll ${min})  ` +
                  `${toHex(fg)} auf ${toHex(bg)}  ${sample.size}px/${sample.weight}  ` +
                  `${sample.selector}  "${sample.text}"`,
              );
            }
          }
        }
        await page.close();
        // EINE SONDE, DIE NICHTS GEMESSEN HAT, DARF NICHT URTEILEN. Sie war bis
        // 2026-08-09 die einzige der 14 ohne diesen Nachweis - ausgerechnet die,
        // die die ganze Guard-Ebene rechtfertigt. `unpainted` stand nur im
        // Meldungstext und zaehlte die NICHT rechenbaren Proben; liefert
        // `collectTextSamples()` auf jeder Route `[]` (umbenanntes
        // `#main-content`, `settle()`-Regress, abgelaufene Sitzung), sind beide
        // Zahlen null und alle vier Theme/Device-Tests gruen.
        assert.ok(
          measured >= 600,
          `Nur ${measured} Textproben im ganzen Dokument gerechnet - die Sonde hat nichts ` +
            'gemessen, statt nichts gefunden. Seiten nicht aufgebaut?',
        );
        assert.deepEqual(
          findings,
          [],
          `Textkontrast unter AA im gerenderten Dokument (${unpainted} Elemente standen ` +
            `hinter einem echten Bild und waren nicht rechenbar):\n  ${findings.join('\n  ')}`,
        );
      });
    }
  }
});

/* ────────────────────────────────────────────────────────────────────────────
 * Sonde 3: Buttonform im gerenderten Dokument
 *
 * Es gibt EINE Buttonform: die Kapsel. Das Stylesheet kann diese Regel nur zur
 * Haelfte pruefen - dort steht weder Tag noch Rolle, und ein Knopf kann seine
 * Form von einer Regel bekommen, deren Selektor ihn gar nicht nennt. Was das
 * Stylesheet scharf sieht (gleiche Breite und Hoehe = umgrenztes Ziel), prueft
 * `ein quadratischer Icon-Knopf ist ein Kreis` auf Ebene 3. Hier steht der Rest.
 *
 * Die vier Ausnahme-KATEGORIEN stehen im Sektionskommentar von tokens.css:
 * Zustandsschalter, Drop-Ziele, Rasterzellen und ZEILEN einer Zeilenliste.
 * Unten stehen ihre Vertreter - jeder mit seiner Kategorie. Das ist die
 * Umkehrung einer Allowlist: gemessen wird JEDER Knopf des Dokuments, benannt
 * sind nur die begruendeten Ausnahmen, und alles Neue faellt durch.
 *
 * FORMLOS zaehlt nicht als zweite Form: ein Knopf ohne Radius, ohne Flaeche und
 * ohne Kante ist eine Textaktion, kein Kasten.
 * ──────────────────────────────────────────────────────────────────────────── */

// Klassenname -> Kategorie. Der Eintrag ist nur gueltig, wenn seine Kategorie
// eine der vier ist; wer eine fuenfte braucht, aendert erst tokens.css.
const SHAPE_EXEMPT = new Map([
  // 1. Zustandsschalter
  ['item-check', 'Zustandsschalter: Checkbox der Einkaufsliste'],
  ['group-toggle__btn', 'Zustandsschalter: Segment der Aufgaben-Gruppierung'],
  ['cal-toolbar__view-btn', 'Zustandsschalter: Segment der Kalender-Ansicht'],
  ['ydp__trigger', 'Griff: Feld-Oeffner des Datepickers, traegt Feldkante'],
  ['more-sheet__search', 'Griff: Suchfeld des More-Sheets, traegt Feldkante'],
  ['theme-toggle__btn', 'Zustandsschalter: Segment der Farbwelt-Wahl'],
  // 3. Zellen eines Rasters
  ['month-day', 'Rasterzelle: Tag im Kalender-Monat'],
  ['more-action', 'Rasterzelle: Kachel im More-Sheet-Raster'],
  ['health-metric-card', 'Rasterzelle: Kennzahlkachel der Gesundheit'],
  // 4. Zeilen einer Zeilenliste
  ['nav-item', 'Zeile: Eintrag der Sidebar-Navigation'],
  ['settings-shell__navigation-toggle', 'Zeile: Domaenenkopf der Settings-Navigation (Akkordeon)'],
  ['note-item', 'Zeile: Notiz im Dashboard-Widget'],
  ['rewards-widget-row', 'Zeile: Rang im Belohnungs-Widget'],
  ['rw-standing__id', 'Zeile: Oeffner einer Mitglieds-Zeile'],
  ['documents-folder-item__select', 'Zeile: Ordner in der Dokumentenliste'],
]);

test('Sonde 3 - es gibt EINE Buttonform, und die Ausnahmen sind Kategorien', async () => {
  const page = await openPage(harness, { device: 'desktop', theme: 'light', locale: 'de' });
  const found = new Map();
  const seen = new Set();

  for (const name of sweep('Sonde 3')) {
    await gotoRoute(page, ALL_ROUTES[name]);
    const rows = await page.evaluate(() => {
      const out = [];
      for (const el of document.querySelectorAll('button, a.btn, [role="button"]')) {
        const rect = el.getBoundingClientRect();
        if (!rect.width || !rect.height) continue;
        const style = getComputedStyle(el);
        const radius = parseFloat(style.borderTopLeftRadius);
        // Kapsel = Radius >= halbe Hoehe. So rendert --radius-full, und bei
        // gleicher Breite und Hoehe ist das genau der Kreis.
        const pill = radius >= rect.height / 2 - 1;
        // Formlos: kein Radius, keine Flaeche, kein KASTEN -> Textaktion oder
        // Zeile, keine zweite Buttonform.
        //
        // Eine Kante zaehlt nur RINGSUM als Kasten. Das Messwerkzeug fragte
        // `borderTopWidth` allein und stufte damit jede Zeile einer
        // Zeilenliste als Kasten ein - deren `X + X { border-top }` ist die
        // vorgeschriebene Trennung, also gerade das Merkmal einer ZEILE
        // (`.budget-entry` war der Fall, der es zeigte).
        const boxed = ['Top', 'Right', 'Bottom', 'Left']
          .every((side) => parseFloat(style[`border${side}Width`]) > 0);
        const flat = radius === 0
          && style.backgroundColor === 'rgba(0, 0, 0, 0)'
          && !boxed;
        // ALLE Knoepfe werden gemeldet, mit ihrem Urteil - sonst kann die
        // Pruefung unten nicht zwischen „Ausnahme entfaellt" und „Knopf haelt
        // die Regel jetzt" unterscheiden.
        const shaped = !pill && !flat;
        const key = [...el.classList].filter((cls) => !cls.startsWith('is-')).join('.')
          || `(klassenlos:${el.id || el.tagName})`;
        out.push({ key, radius, height: Math.round(rect.height), shaped });
      }
      return out;
    });
    for (const row of rows) {
      row.key.split('.').forEach((cls) => seen.add(cls));
      if (!row.shaped) continue;
      if (!found.has(row.key)) found.set(row.key, { ...row, pages: new Set() });
      found.get(row.key).pages.add(name);
    }
  }
  await page.close();

  // Eine Sonde, die nichts gemessen hat, darf nicht urteilen. Ohne diese
  // Zusicherung ist ein leeres Dokument (abgelaufene Sitzung, nicht
  // aufgebaute Route) von „alles in Ordnung" nicht zu unterscheiden - und die
  // Stale-Pruefung unten meldet dann ihre gesamte Liste als verschwunden.
  assert.ok(seen.size >= 20,
    `Nur ${seen.size} Knopf-Klassen im ganzen Dokument gesehen - die Sonde hat `
    + 'nichts gemessen, statt nichts gefunden. Seiten nicht aufgebaut?');

  const offenders = [];
  for (const [key, value] of found) {
    const classes = key.split('.');
    if (classes.some((cls) => SHAPE_EXEMPT.has(cls))) continue;
    offenders.push(
      `${key} (${value.radius}px auf h=${value.height}) auf ${[...value.pages].join(', ')}`,
    );
  }

  assert.deepEqual(offenders.sort(), [],
    'Knoepfe mit eigener Form ausserhalb der vier Ausnahme-Kategorien. Entweder '
    + 'die Kapsel tragen oder in SHAPE_EXEMPT stehen - mit der Kategorie, nicht '
    + 'mit dem Grund „gewachsen".');
});

/* ────────────────────────────────────────────────────────────────────────────
 * Sonde 4: Zielgroessen
 *
 * Die Regel steht im Sektionskommentar von tokens.css („Die Zielgroessen-
 * Regel"): eine REIHE traegt ihre Dichte gemeinsam, ein EINZELZIEL muss allein
 * treffbar sein.
 *
 *   freistehend  -> volle Zielgroesse in mindestens einer Achse, die andere
 *                   erfuellt WCAG 2.5.8
 *   in der Reihe -> allein WCAG 2.5.8 (24x24 oder Spacing-Ausnahme)
 *
 * WARUM DIESE EBENE UND KEINE ANDERE. Im Stylesheet steht weder, wer neben wem
 * liegt, noch was ein Pseudo-Element zur Flaeche beitraegt - beides entscheidet
 * hier ueber Verstoss oder nicht. Die zwei bisherigen Guards
 * (test-frontend-audit.js) pruefen benannte Selektoren und finden damit nur,
 * wer die Regel schon anerkennt; das ist die Allowlist-Signatur, die diese
 * Runde abschafft.
 *
 * DREI FALLEN, DIE BEIM BAU GEMESSEN WURDEN:
 *
 *   (1) DIE BOX IST NICHT DIE TREFFERFLAECHE. `.weather-widget__refresh` ist
 *       34x34 gross und dehnt sich per ::before auf --target-base aus. Eine
 *       Box-Messung meldet ihn als Verstoss, obwohl der Finger 44px findet -
 *       und haette damit ausgerechnet das Rezept fuer „kompakt aussehen, voll
 *       treffen" zum Fehler erklaert. Getastet wird deshalb mit
 *       elementFromPoint vom Zentrum nach aussen.
 *   (2) DAS TASTEN ENDET AN JEDER KANTE, AUCH AN DER FALSCHEN. Am unteren
 *       Viewport-Rand und an der Clip-Kante eines `overflow: hidden`-Moduls
 *       (Kueche, Budget) liefert elementFromPoint den Shell-Container - vier
 *       Ziele sahen dadurch aus, als waeren sie zu einem Drittel verdeckt.
 *       Deshalb gilt `max(Box, getastet)`: die Box ist die Untergrenze, das
 *       Tasten zaehlt nur, was sie ERWEITERT.
 *   (3) DIE ANZAHL IST NICHT DIE EINENGUNG. „Wie oft kommt die Klasse vor"
 *       misst den Seed: bei einer einzigen Aufgabe waere .task-card__title ein
 *       Einzelziel, bei zweien eine Reihe. Die Einengung steht im Layout.
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Klassenname -> Begruendung. Die UMKEHRUNG einer Allowlist: gemessen wird
 * jedes Ziel des Dokuments, benannt sind nur die begruendeten Ausnahmen.
 *
 * Sie ist leer, und das ist das Ergebnis von Phase 3c: die Spacing-Ausnahme des
 * Standards deckt jeden bewusst dichten Fall mechanisch ab - Monatsraster-Chips
 * (Zentrumsabstand 31,5), Aufgaben-Tagfilter (29,3), Sidebar-Umschalter (31,5).
 * Wer hier etwas eintraegt, hat in Wahrheit ein Abstandsproblem.
 */
const TARGET_EXEMPT = new Map([]);

/** Ein Ziel gilt als eingeengt, wenn ein gleichartiges naeher steht als das. */
const CROWDING_GAP = 16;

async function measureTargets(page, min) {
  return page.evaluate(({ min, gap }) => {
    const SEL = 'button, a[href], [role="button"], input:not([type=hidden]), select, textarea, summary, [tabindex]:not([tabindex="-1"])';
    const key = (el) => [...el.classList].filter((c) => !c.startsWith('is-')).join('.')
      || `(${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''})`;

    const els = [];
    for (const el of document.querySelectorAll(SEL)) {
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden' || cs.pointerEvents === 'none') continue;
      if (el.closest('.sr-only, [aria-hidden="true"], yuvomi-install-prompt')) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) continue;
      els.push(el);
    }
    const rects = els.map((el) => el.getBoundingClientRect());
    const classes = els.map((el) => new Set([...el.classList].filter((c) => !c.startsWith('is-'))));

    const out = [];
    els.forEach((el, i) => {
      const r = rects[i];
      const cx = Math.round(r.left + r.width / 2);
      const cy = Math.round(r.top + r.height / 2);
      // Ein Ziel, dessen eigenes Zentrum es nicht selbst trifft, ist verdeckt
      // oder ausserhalb des Viewports - dort misst die Sonde nichts, statt
      // etwas Falsches zu messen.
      const mine = (x, y) => {
        const hit = document.elementFromPoint(x, y);
        return !!hit && (hit === el || el.contains(hit));
      };
      if (!mine(cx, cy)) return;
      const reach = (dx, dy) => {
        let n = 0;
        while (n < min && mine(cx + dx * (n + 1), cy + dy * (n + 1))) n += 1;
        return n;
      };
      // max(Box, getastet): die Box ist die Untergrenze (Falle 2), das Tasten
      // zaehlt nur, was ein Pseudo-Element hinzufuegt (Falle 1).
      let w = Math.max(r.width, reach(-1, 0) + reach(1, 0) + 1);
      let h = Math.max(r.height, reach(0, -1) + reach(0, 1) + 1);

      // FALLE 4, gemessen an den Settings-Blaettern: EIN BEDIENELEMENT IN
      // EINEM LABEL IST SO GROSS WIE SEIN LABEL. `toggleRowHtml`
      // (settings/components.js) baut `<label class="toggle-row"><input
      // type="checkbox" 18x18>…<span>Text</span></label>`; die Zeile traegt
      // `min-height: var(--target-lg)` und volle Breite, und ein Klick
      // irgendwo darauf schaltet. Die Sonde mass den INPUT und meldete
      // 18x19 - dreissigmal, quer ueber die Blaetter, und jedes Mal falsch.
      //
      // Das Tasten allein rettet sie nicht: `elementFromPoint` liefert
      // ausserhalb des Inputs das LABEL, nicht den Input, also endet `reach`
      // an der Kante der Checkbox. Was hier fehlt, ist keine Geometrie,
      // sondern eine HTML-Beziehung - und die ist eine Regel, keine
      // Ausnahmeliste: `label.control` bzw. `label[for]` sagt verbindlich,
      // welches Element das Label bedient.
      const label = el.closest('label') ?? (el.id ? document.querySelector(`label[for="${CSS.escape(el.id)}"]`) : null);
      if (label && (label.control === el || label.contains(el))) {
        const lr = label.getBoundingClientRect();
        if (lr.width > 0 && lr.height > 0) {
          w = Math.max(w, lr.width);
          h = Math.max(h, lr.height);
        }
      }

      // Eingeengt: ein Ziel, das mindestens eine Klasse teilt, steht naeher als
      // CROWDING_GAP. Nur DAS ist der Grund, aus dem ein Ziel dicht sein darf -
      // es kann nicht wachsen, ohne seinen Nachbarn zu verdraengen.
      let crowded = false;
      // Fuer die Spacing-Ausnahme (WCAG 2.5.8): naechstes Zielzentrum.
      let nearestCenter = Infinity;
      for (let j = 0; j < els.length && !(crowded && nearestCenter < 24); j += 1) {
        if (j === i || els[j].contains(el) || el.contains(els[j])) continue;
        const o = rects[j];
        const dEdge = Math.hypot(
          Math.max(o.left - r.right, r.left - o.right, 0),
          Math.max(o.top - r.bottom, r.top - o.bottom, 0),
        );
        if (dEdge < gap && [...classes[i]].some((c) => classes[j].has(c))) crowded = true;
        const dCenter = Math.hypot(
          o.left + o.width / 2 - cx,
          o.top + o.height / 2 - cy,
        );
        if (dCenter < nearestCenter) nearestCenter = dCenter;
      }

      // WCAG 2.5.8: 24x24, oder kein anderes Zielzentrum naeher als 24.
      const wcag = (w >= 24 && h >= 24) || nearestCenter >= 24;
      // Volle Zielgroesse in mindestens einer Achse - nur fuer freistehende.
      const full = w >= min || h >= min;
      // Das Urteil faellt NICHT hier: ob ein Bauteil in Reihen gebaut wird,
      // entscheidet sich ueber alle Routen zusammen (siehe unten).
      out.push({
        key: key(el),
        w: Math.round(w),
        h: Math.round(h),
        crowded,
        wcag,
        full,
        center: Math.round(nearestCenter),
      });
    });
    return out;
  }, { min, gap: CROWDING_GAP });
}

/**
 * Misst die Route an jeder Scrollposition und liefert die Messungen einzeln.
 *
 * Die App hat ZWEI Scrollport-Architekturen (Handoff §6): meist scrollt die
 * Seite, in Kueche und Budget ist der Modul-Root `overflow: hidden` und ein
 * Container darin scrollt. Gesucht wird deshalb der Container mit dem groessten
 * Ueberhang, nicht ein fester Knoten.
 */
async function measureScrolled(page, min, maxSteps = 6) {
  const pick = () => {
    const el = document.scrollingElement;
    let best = el;
    let bestOver = el.scrollHeight - el.clientHeight;
    for (const node of document.querySelectorAll('*')) {
      const cs = getComputedStyle(node);
      if (!/auto|scroll/.test(cs.overflowY)) continue;
      const over = node.scrollHeight - node.clientHeight;
      if (over > bestOver) { best = node; bestOver = over; }
    }
    return best;
  };
  const out = [];
  await page.evaluate(pick).catch(() => {});
  for (let step = 0; step < maxSteps; step += 1) {
    out.push(await measureTargets(page, min));
    const moved = await page.evaluate((pickSrc) => {
      // eslint-disable-next-line no-new-func
      const el = new Function(`return (${pickSrc})()`)();
      const before = el.scrollTop;
      // 70 % statt 100 %: was genau auf der Falz sitzt, wuerde sonst in keiner
      // der beiden Messungen vollstaendig im Bild stehen.
      el.scrollTop = before + el.clientHeight * 0.7;
      return el.scrollTop > before + 1;
    }, pick.toString());
    if (!moved) break;
    // Der kollabierende Kopf und die Sticky-Leisten brauchen einen Frame, sonst
    // misst die Sonde eine Zwischenposition.
    await new Promise((r) => { setTimeout(r, 250); });
  }
  return out;
}

describe('Sonde 4 - eine Reihe traegt ihre Dichte, ein Einzelziel ist allein treffbar', () => {
  // Beide Geraetewelten, denn --target-base schaltet ueber (hover: none): am
  // Zeiger 44px, am Finger 48px. Ein Guard, der nur eine Welt misst, prueft
  // genau die Haelfte einer Regel, deren Kern der Wechsel ist.
  for (const [device, min] of [['mobile', 48], ['desktop', 40]]) {
    test(`${device} (Minimum ${min}px)`, async () => {
      const page = await openPage(harness, { device, theme: 'light', locale: 'de' });
      const found = new Map();
      // DIE SONDE MUSS SCROLLEN. elementFromPoint kennt nur den Viewport - ein
      // Ziel unterhalb der Falz meldet sein eigenes Zentrum als verdeckt und
      // wird stillschweigend uebersprungen. Die Gegenprobe hat das aufgedeckt:
      // .ydp__trigger auf 40x40 zurueckgedreht liess den Guard GRUEN, weil er
      // auf /health unter der Falz liegt. Gemessen wird deshalb an jeder
      // Scrollposition, so wie ein Nutzer die Seite durchgeht.
      // Bauteile, die IRGENDWO in einer Reihe stehen. Siehe die Auswertung
      // darunter - erst mit dieser Menge ist das Urteil vollstaendig.
      const rowBuilt = new Set();
      let seen = 0;
      for (const name of sweep('Sonde 4')) {
        await gotoRoute(page, ALL_ROUTES[name]);
        for (const rows of await measureScrolled(page, min)) {
          for (const row of rows) {
            // DER ZAEHLER STEHT IN DER MESSUNG, NICHT DAVOR. Bis 2026-08-09
            // zaehlte er `querySelectorAll(...).length` - rohe DOM-Knoten, in
            // den Tausenden. `measureTargets()` steigt aber pro Element bei
            // `if (!mine(cx, cy)) return;` aus: bricht `elementFromPoint`, ist
            // `offenders` leer und der alte Nachweis hielt trotzdem muehelos.
            // Eine Zeile weiter oben zu zaehlen war der ganze Unterschied
            // zwischen „nichts gefunden" und „nichts gemessen".
            seen += 1;
            if (row.crowded) rowBuilt.add(row.key);
            if (row.wcag && row.full) continue;
            const id = `${row.key}|${row.w}x${row.h}`;
            if (!found.has(id)) found.set(id, { ...row, pages: new Set() });
            found.get(id).pages.add(name);
          }
        }
      }
      await page.close();

      // Eine Sonde, die nichts gemessen hat, darf nicht urteilen (dieselbe
      // Zusicherung wie bei Sonde 3). Gezaehlt sind GETASTETE Ziele, also
      // Messungen - dasselbe wie bei Sonde 14, wo der Zaehler ebenfalls in der
      // Schleife steht, aus der die Findings kommen.
      assert.ok(seen >= 600,
        `Nur ${seen} Ziele im ganzen Dokument getastet - die Sonde hat nichts `
        + 'gemessen, statt nichts gefunden. Bricht elementFromPoint?');

      // DIE EINENGUNG IST EINE EIGENSCHAFT DES BAUTEILS, NICHT DER INSTANZ.
      // Die erste Fassung urteilte je Instanz und meldete prompt einen
      // .task-tag--filter, der als einziger Tag an seiner Aufgabe hing: ein
      // Reihen-Bauteil, das in dieser einen Zeile allein stand. Ob ein Bauteil
      // in Reihen gebaut wird, steht nicht in einer Zeile, sondern im Bauteil -
      // und ueber sechzehn Routen gemessen ist das eine stabile Aussage, waehrend
      // die einzelne Instanz den Seed misst.
      const offenders = [];
      for (const value of found.values()) {
        if (value.key.split('.').some((cls) => TARGET_EXEMPT.has(cls))) continue;
        if (value.wcag && rowBuilt.has(value.key)) continue;
        offenders.push(
          `${value.key}: ${value.w}x${value.h} - `
          + `${!value.wcag ? 'unter 24x24 ohne Spacing-Abstand' : 'freistehend und in KEINER Achse voll'}`
          + ` (naechstes Zielzentrum ${value.center}px) auf ${[...value.pages].join(', ')}`,
        );
      }

      assert.deepEqual(offenders.sort(), [],
        `Ziele unter der Zielgroesse bei ${device}. Die Regel steht in tokens.css `
        + '(„Die Zielgroessen-Regel"): ein freistehendes Ziel haelt die volle '
        + 'Zielgroesse in mindestens einer Achse, ein eingeengtes erfuellt WCAG '
        + '2.5.8. Wer kompakt aussehen und voll treffen will, dehnt seine Flaeche '
        + 'per ::before aus - .weather-widget__refresh ist der Musterfall.');
    });
  }
});

test('Sonde 3+4 - keine Form- und keine Zielgroessen-Ausnahme ueberlebt ihre Klasse', () => {
  // EINE Pruefung fuer beide Listen, und zwar aus einem Grund, der ueber
  // Sparsamkeit hinausgeht: `TARGET_EXEMPT` ist heute leer (Phase 3c), und eine
  // eigene Assertion darueber ist tautologisch - sie kann nicht rot werden und
  // zaehlte trotzdem als eine der gemeldeten Zusicherungen dieser Suite. Zusammen
  // mit `SHAPE_EXEMPT` und dem Reichweiten-Nachweis unten prueft sie etwas.
  //
  // Gemessen wird gegen das STYLESHEET, nicht gegen das Dokument: ein Element,
  // das nur unter bestimmten Daten erscheint, waere sonst je nach Seed
  // „verschwunden" - die Pruefung urteilte dann ueber Timing statt ueber
  // Ehrlichkeit. Der Klassenname im Selektor ist die stabile Quelle.
  const classes = selectorClasses();

  // Eine Pruefung, die nichts gelesen hat, darf nicht urteilen: liefert der
  // Scanner nichts, waere JEDE Ausnahme „veraltet" - und die Assertion meldete
  // ihre gesamte Liste statt ihres Defekts.
  assert.ok(classes.size >= 500,
    `Nur ${classes.size} Klassennamen aus den Stylesheets gelesen - der Regelscanner `
    + 'hat nichts gefunden, statt nichts zu finden.');

  const stale = [];
  for (const [label, list] of [['SHAPE_EXEMPT', SHAPE_EXEMPT], ['TARGET_EXEMPT', TARGET_EXEMPT]]) {
    for (const cls of list.keys()) if (!classes.has(cls)) stale.push(`${label}: .${cls}`);
  }
  assert.deepEqual(stale, [],
    'Eine Ausnahme fuer einen Knopf, den es nicht mehr gibt, ist eine Allowlist, die '
    + 'niemand mehr liest. Diese Klassen nennt kein Selektor mehr.');
});

/* ────────────────────────────────────────────────────────────────────────────
 * Sonde 5: Wischsemantik
 *
 * Die Wischbedienung ist die einzige Bedienung der App, die im Stylesheet und
 * im Quelltext vollstaendig richtig aussehen und im Dokument trotzdem gar nicht
 * stattfinden kann. Genau das war der Fall: der Einkauf verdrahtete seine
 * Gesten nur in `updateItemsList`, also erst, wenn die Liste ein zweites Mal
 * gebaut wurde - beim ersten Oeffnen der Seite antwortete keine Zeile. Der
 * Aufruf stand seit dem Tag falsch, an dem die Geste eingefuehrt wurde.
 *
 * Deshalb faehrt diese Sonde die Geste wirklich, statt eine Zuordnung zu lesen.
 * Sie misst dabei ZWEI Zusagen auf einmal:
 *
 *   (a) eine Liste mit Wischzeilen antwortet auf die Geste, und zwar beim
 *       ersten Aufbau der Seite;
 *   (b) die Rolle liegt an der vereinbarten Kante - das Zeilenende traegt das
 *       Destruktive, der Zeilenanfang das Primaere und Positive (§2).
 *
 * Und sie faehrt beides in `de` UND `ar`: die Kante ist logisch, die
 * Fingerbewegung dahin ist in RTL die andere. Eine Sonde, die nur LTR misst,
 * wuerde die Spiegelung nie bemerken.
 *
 * SIE LOEST NICHTS AUS: der Finger geht vor dem Loslassen unter die Schwelle
 * zurueck. Eine Sonde, die abhakt und loescht, misst beim zweiten Lauf einen
 * anderen Seed.
 * ──────────────────────────────────────────────────────────────────────────── */

// Die Rollen benennen ihre Bedeutung selbst (layout.css, „ZWEI ACHSEN"). Das
// ist keine Allowlist ueber Dateien, sondern die Regel in Code: `--edit` fehlt
// hier bewusst, weil sein RANG von der Liste abhaengt - primaer, wo es die
// einzige nicht-destruktive Aktion ist, sekundaer neben einer positiven.
const ROLE_SIDE = { 'swipe-reveal--delete': 'trailing', 'swipe-reveal--done': 'leading' };

async function uncoveredPanel(page, sign) {
  // ERST IN DEN VIEWPORT HOLEN. `page.touchscreen` setzt Viewport-Koordinaten;
  // eine Zeile unter der Falz bekaeme einen Finger, der ausserhalb des Bildes
  // aufsetzt, und die Sonde meldete „nicht verdrahtet", wo in Wahrheit nur
  // niemand hingefasst hat. Auf den Hauptrouten steht die erste Wischzeile weit
  // oben, im Abo-Tab liegt sie hinter Kennzahlen und Auswertung.
  //
  // Gemessen wird NACH dem Warten: der kollabierende Kopf verschiebt beim
  // Scrollen alles unter sich, und ein Rechteck von vorher zeigt daneben.
  const scrolled = await page.evaluate(() => {
    const row = document.querySelector('.swipe-row');
    if (!row) return false;
    row.scrollIntoView({ block: 'center' });
    return true;
  });
  if (!scrolled) return null;
  await new Promise((resolve) => setTimeout(resolve, 250));

  const box = await page.evaluate(() => {
    const row = document.querySelector('.swipe-row');
    if (!row) return null;
    const r = row.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  if (!box) return null;

  await page.touchscreen.touchStart(box.x, box.y);
  for (const step of [20, 60, 120]) {
    await page.touchscreen.touchMove(box.x + sign * step, box.y);
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  const shown = await page.evaluate(() => [...document.querySelectorAll('.swipe-row:first-of-type .swipe-reveal')]
    .filter((el) => Number(el.style.opacity) > 0.5)
    .map((el) => [...el.classList].filter((c) => c !== 'swipe-reveal')));
  // Zurueck unter die Schwelle, damit das Loslassen keine Aktion ausloest.
  await page.touchscreen.touchMove(box.x, box.y);
  await page.touchscreen.touchEnd();
  await new Promise((resolve) => setTimeout(resolve, 250));
  return shown[0] ?? [];
}

describe('Sonde 5 - eine Wischzeile antwortet, und jede Rolle liegt an ihrer Kante', () => {
  for (const locale of ['de', 'ar']) {
    test(`Locale ${locale}`, async () => {
      const page = await openPage(harness, { device: 'mobile', theme: 'light', locale });
      const rtl = locale === 'ar';
      const findings = [];
      let listsSeen = 0;

      const measure = async (name) => {
        const hasRows = await page.evaluate(() => Boolean(document.querySelector('.swipe-row .swipe-reveal')));
        if (!hasRows) return;
        listsSeen += 1;

        // In RTL deckt derselbe Finger die andere Kante auf - die Erwartung
        // spiegelt mit, die Kante bleibt dieselbe.
        for (const [sign, side] of [[1, rtl ? 'trailing' : 'leading'], [-1, rtl ? 'leading' : 'trailing']]) {
          const classes = await uncoveredPanel(page, sign);
          const move = sign > 0 ? 'nach rechts' : 'nach links';

          if (!classes?.length) {
            findings.push(`${name}: der Wisch ${move} deckt nichts auf - die Zeilen sind nicht verdrahtet.`);
            continue;
          }
          if (!classes.includes(`swipe-reveal--${side}`)) {
            findings.push(`${name}: der Wisch ${move} deckt ${classes.join('.')} auf, erwartet war die ${side}-Kante.`);
            continue;
          }
          for (const cls of classes) {
            if (ROLE_SIDE[cls] && ROLE_SIDE[cls] !== side) {
              findings.push(`${name}: die Rolle ${cls} liegt an der ${side}-Kante, app-weit gehoert sie an die ${ROLE_SIDE[cls]}-Kante.`);
            }
          }
        }
      };

      for (const name of sweep('Sonde 5')) {
        await gotoRoute(page, ALL_ROUTES[name]);
        // Auch die Sichten hinter den Leisten: die Abo-Liste liegt hinter einem
        // Untertab und waere sonst die einzige Wischliste der App, die nie
        // gefahren wird.
        await visitViews(page, name, measure);
      }
      await page.close();

      // Eine Sonde, die nichts gemessen hat, darf nicht urteilen (dieselbe
      // Zusicherung wie bei Sonde 3 und 4).
      assert.ok(listsSeen >= 4,
        `Nur ${listsSeen} Wischlisten gesehen - erwartet sind mindestens Aufgaben, Einkauf, Geburtstage `
        + 'und Abonnements. Entweder hat der Seed keine Zeilen geliefert, oder die Bauart hat sich geaendert.');

      assert.deepEqual(findings, [],
        'Wischsemantik im gerenderten Dokument. Die Regel lautet: rechts (zum Zeilenanfang hin) '
        + 'traegt die primaere positive Aktion, links das Destruktive oder Sekundaere - und in RTL '
        + 'spiegelt die Fingerbewegung, nicht die Kante.\n  ' + findings.join('\n  '));
    });
  }
});

/* ────────────────────────────────────────────────────────────────────────────
 * Sonde 6: gleiche Hoehe in einer Kennzahlreihe
 *
 * Die Kacheln EINER Kennzahlreihe sind gleich hoch. Die Hoehe gehoert dem
 * TRAEGER, nicht dem laengsten Text einer Zelle - dieselbe Grammatik wie beim
 * Well („der Traeger entscheidet") und beim Lesemass.
 *
 * WARUM EBENE 4 UND NICHT DAS STYLESHEET: im CSS steht `grid-auto-rows: 1fr`,
 * also eine Deklaration. Die ZUSAGE ist „gleich hoch", und ob sie ankommt,
 * haengt daran, wieviele Zeilen das Raster bei dieser Breite bildet und ob eine
 * Host-Stufe die Spaltenzahl aendert. Genau so entstand der Befund: die
 * Abo-Reihe bricht unter 720px Containerbreite auf zwei mal zwei um, und die
 * beiden Rasterzeilen streckten sich unabhaengig - 78px oben, 95px unten, weil
 * eine einzige Fussnote umbrach. Im Stylesheet sah nichts davon falsch aus.
 *
 * SIE PRUEFT DIE ZUSAGE, NICHT IHREN FUNDORT: gesucht wird jede `.metric-grid`
 * auf jeder Route - und zusaetzlich hinter jedem Budget-Untertab, weil die
 * Reihen dort hinter einer Leiste liegen, die keine Route wechselt. Damit
 * findet sie auch eine Kennzahlreihe, die es heute noch gar nicht gibt.
 * ──────────────────────────────────────────────────────────────────────────── */

/** Alle Kennzahlreihen der aktuellen Ansicht mit den Hoehen ihrer Kacheln. */
async function metricRowHeights(page) {
  return page.evaluate(() => [...document.querySelectorAll('.metric-grid')]
    .map((grid) => ({
      grid: grid.className,
      // Sub-Pixel runden: das Raster verteilt Restpixel, und ein halber Pixel
      // Unterschied ist keine Unruhe, sondern Layout-Arithmetik.
      heights: [...grid.querySelectorAll('.metric-card')].map((c) => Math.round(c.getBoundingClientRect().height)),
    }))
    .filter((row) => row.heights.length > 1));
}

describe('Sonde 6 - die Kacheln einer Kennzahlreihe sind gleich hoch', () => {
  for (const device of ['mobile', 'desktop']) {
    test(`Geraet ${device}`, async () => {
      const page = await openPage(harness, { device, theme: 'light', locale: 'de' });
      const findings = [];
      let rowsSeen = 0;

      const check = (where, rows) => {
        for (const row of rows) {
          rowsSeen += 1;
          const spread = Math.max(...row.heights) - Math.min(...row.heights);
          if (spread > 0) {
            findings.push(`${where} · ${row.grid}: Hoehen ${row.heights.join(', ')} (Streuung ${spread}px).`);
          }
        }
      };

      // Auch die Sichten hinter den Leisten: sie wechseln nach der
      // Leisten-Regel (§2) die SICHT innerhalb eines Moduls, nicht die Route.
      // Ohne sie saehe die Sonde von sieben Kennzahlreihen genau eine.
      for (const name of sweep('Sonde 6')) {
        await gotoRoute(page, ALL_ROUTES[name]);
        await visitViews(page, name, async (where) => check(where, await metricRowHeights(page)));
      }
      await page.close();

      // Eine Sonde, die nichts gemessen hat, darf nicht urteilen (dieselbe
      // Zusicherung wie bei Sonde 3, 4 und 5).
      assert.ok(rowsSeen >= 4,
        `Nur ${rowsSeen} Kennzahlreihen gesehen - erwartet sind mindestens Budget, Abos, Aufteilen und Darlehen. `
        + 'Entweder hat der Seed keine Zahlen geliefert, oder die Bauart hat sich geaendert.');

      assert.deepEqual(findings, [],
        'Kennzahlreihen im gerenderten Dokument. Gleichartige Kacheln nebeneinander sind gleich hoch, '
        + 'auch wenn die Reihe umbricht - die Hoehe gehoert dem Traeger (.metric-grid, panel.css), '
        + 'nicht dem laengsten Text einer Zelle.\n  ' + findings.join('\n  '));
    });
  }
});

/* ────────────────────────────────────────────────────────────────────────────
 * Sonde 7: keine gap-getrennte Kartenspalte
 *
 * Die Zeilenlisten-Regel (§2, Session 6) sagt: eine Folge gleichartiger Zeilen
 * liegt in GENAU EINEM Traeger, und die Zeilen darin sind flaechenlos und
 * trennen sich ueber den `+`-Kombinator. Phase 5 hat die statisch pruefbare
 * Haelfte gezogen - eine Zeile, die ihre Flaeche UND ihren Stapelabstand selbst
 * mitbringt. Die hier gemeinte Bauart ist dieselbe Regelverletzung, nur mit dem
 * Abstand am TRAEGER: die Karte traegt Flaeche, Radius und Schatten, getrennt
 * wird ueber dessen `gap`.
 *
 * WARUM EBENE 4 UND NICHT DAS STYLESHEET: der Traeger ist in dieser Codebasis
 * statisch nicht auflösbar (§2, Session 15). `list.insertAdjacentHTML(...)`
 * bindet ihn an eine JS-Variable; ein Rueckwaerts-Tag-Lauf fand ihn fuer vier
 * Module gar nicht. Wo das `gap` steht, weiss erst das Dokument.
 *
 * WAS EINE KARTENSPALTE IST, UND WAS NICHT - jedes Merkmal gemessen, keines
 * benannt:
 *   - Eine SPALTE IN JEDER GROESSENKLASSE. Mobil bricht jedes mehrspaltige
 *     Raster auf eine Spalte um; wer nur dort misst, meldet die Kennzahlraster
 *     der Gesundheit, die Notiz-Masonry und die Dashboard-Widgets - allesamt
 *     Raster aus Objekten mit eigenem Medium, also die benannte Ausnahme der
 *     Regel. Gemeldet wird deshalb nur, was in BEIDEN Geraetewelten ein
 *     vertikaler Stapel ist. Gemessen: 16 Kandidaten mobil, 6 im Schnitt.
 *   - EINE KARTE HAT EINEN RADIUS. `.week-gutter-label` traegt Flaeche und
 *     Schatten bei Radius 0 - eine Rasterbeschriftung, keine Karte.
 *   - EINE KAPSEL IST EIN GRIFF. Die Buttonform-Regel sagt es positiv: die
 *     Kapsel ist die EINE Form fuer Elemente, die eine Aktion ausloesen.
 *   - EINE BUEHNE TRAEGT EINE ZEILE, KEINE STRUKTUR. `.subscription-card` liegt
 *     in einer `.swipe-row`, die bewusst flaechenlos ist; ohne Durchgriff waere
 *     jede Wischliste unsichtbar. Der Durchgriff greift durch genau EIN Kind im
 *     Fluss - `.list-group` hat zwei (Gruppenkopf und Zeilenliste) und ist
 *     damit das Gegenteil eines Verstosses.
 *   - WAS MAN ZIEHT, IST EIN OBJEKT. `.kanban-card` ist `draggable`; ein Board
 *     ist keine Liste.
 *   - EIN DROP-ZIEL BEHAELT SEINE KANTE (§2, Kasten-in-Kasten). `.meal-slot`
 *     traegt sie gestrichelt und sitzt per `grid-row` in einem Wochenraster.
 * ──────────────────────────────────────────────────────────────────────────── */

/** Jede Folge gleichartiger Karten, die ihre Trennung dem `gap` ihres Traegers ueberlaesst. */
async function cardColumns(page) {
  return page.evaluate(() => {
    const shown = (n) => {
      const r = n.getBoundingClientRect();
      return r.width > 1 && r.height > 1;
    };
    const opaque = (bg) => bg && bg !== 'rgba(0, 0, 0, 0)' && !/\/\s*0?\.\d+\)/.test(bg);
    const inFlow = (el) => [...el.children].filter((c) => {
      const pos = getComputedStyle(c).position;
      return pos !== 'absolute' && pos !== 'fixed';
    });
    const hits = [];
    const seen = new Set();

    for (const el of document.querySelectorAll('*')) {
      const parent = el.parentElement;
      if (!parent) continue;
      const cls = [...el.classList][0];
      if (!cls) continue;
      const key = `${parent.className}>${cls}`;
      if (seen.has(key)) continue;

      // Eine FOLGE, kein Einzelfall - und sichtbar, nicht bloss im DOM: ein
      // inaktives Tab-Panel bleibt stehen, und seine Karten messen 0x0.
      const sibs = [...parent.children].filter((s) => s.classList.contains(cls) && shown(s));
      if (sibs.length < 3) continue;

      // Die Trennung liegt am TRAEGER. Ohne `row-gap` trennt etwas anderes.
      const rowGap = parseFloat(getComputedStyle(parent).rowGap) || 0;
      if (!(rowGap > 0)) continue;

      // Ein vertikaler Stapel: das zweite Geschwister steht UNTER dem ersten,
      // an derselben Kante. Nebeneinander ist ein Raster.
      const first = sibs[0].getBoundingClientRect();
      const second = sibs[1].getBoundingClientRect();
      if (!(second.top >= first.bottom - 1 && Math.abs(second.left - first.left) < 2)) continue;

      let card = el;
      let via = '';
      if (!opaque(getComputedStyle(el).backgroundColor)) {
        const kids = inFlow(el).filter(shown);
        if (kids.length !== 1) continue;
        [card] = kids;
        via = `${cls} > .`;
      }
      const cs = getComputedStyle(card);
      if (!opaque(cs.backgroundColor)) continue;
      if (cs.breakInside === 'avoid') continue;
      if (el.draggable || card.draggable) continue;
      if (cs.borderTopStyle === 'dashed') continue;

      const rect = card.getBoundingClientRect();
      const radius = parseFloat(cs.borderTopLeftRadius) || 0;
      if (radius <= 0) continue;
      if (radius >= rect.height / 2 - 0.5) continue;

      seen.add(key);
      hits.push({
        cls: `${via}${[...card.classList][0]}`,
        parent: parent.className.split(' ')[0] || parent.tagName.toLowerCase(),
        count: sibs.length,
        gap: rowGap,
      });
    }
    return hits;
  });
}

test('Sonde 7 - eine Zeilenfolge ist keine Spalte aus Karten', async () => {
  const perDevice = new Map();
  let viewsSeen = 0;

  for (const device of ['desktop', 'mobile']) {
    const page = await openPage(harness, { device, theme: 'light', locale: 'de' });
    const found = new Map();
    const note = async (where) => {
      viewsSeen += 1;
      for (const hit of await cardColumns(page)) {
        if (!found.has(hit.cls)) found.set(hit.cls, { ...hit, where });
      }
    };
    for (const name of sweep('Sonde 7')) {
      await gotoRoute(page, ALL_ROUTES[name]);
      // Auf einem Blatt nur der Zustand selbst - siehe `isLeaf`: zwei der drei
      // Umschaltergruppen in den Einstellungen schreiben eine Einstellung.
      if (isLeaf(name)) await note(name);
      else await visitViews(page, name, note);
    }
    await page.close();
    perDevice.set(device, found);
  }

  // Der SCHNITT beider Groessenklassen: was mobil untereinander steht und auf
  // dem Desktop nebeneinander, ist ein Raster, das umbricht.
  const desktop = perDevice.get('desktop');
  const mobile = perDevice.get('mobile');
  const findings = [...desktop.entries()]
    .filter(([cls]) => mobile.has(cls))
    .map(([cls, hit]) => `${hit.where} · .${cls}: ${hit.count} Karten in .${hit.parent}, getrennt ueber gap ${hit.gap}px.`);

  // Eine Sonde, die nichts gesehen hat, darf nicht urteilen (dieselbe
  // Zusicherung wie bei Sonde 3, 4, 5 und 6) - und hier ist es die REICHWEITE,
  // die belegt werden muss, nicht die Zahl der Befunde. Gemessen sind es 92 je
  // Geraet: 16 Routen plus die Sichten dahinter. Faellt der Helfer auf die
  // blossen Routen zurueck, ist ein gruener Lauf keine Aussage mehr, sondern
  // genau die Luecke, wegen der es diese Sonde gibt.
  const reach = ROUTE_NAMES.length + SETTINGS_NAMES.length;
  assert.ok(viewsSeen >= 2 * (reach + 30),
    `Nur ${viewsSeen} Sichten besucht (erwartet: deutlich mehr als die ${2 * reach} Zustaende). `
    + 'Der Reichweiten-Helfer erreicht die Sichten hinter den Leisten nicht mehr - '
    + 'Budget-Untertabs, Health-Routen, Housekeeping-Tabs, Raster/Liste der Dokumente - '
    + 'oder die Settings-Blaetter fallen wieder aus der Ableitung.');

  assert.deepEqual(findings, [],
    'Kartenspalten im gerenderten Dokument. Eine Folge gleichartiger Zeilen liegt in GENAU EINEM '
    + 'Traeger (randlose Karte, `overflow: hidden`); die Zeilen darin sind flaechenlos und trennen '
    + 'sich ueber `> * + *`. Eine Karte je Zeile sagt „jedes davon ist ein eigenes Objekt", wo die '
    + 'Gruppe gemeint ist - und ein Schatten je Zeile erzeugt in einer langen Liste Streifen.\n  '
    + findings.join('\n  '));
});

/* ────────────────────────────────────────────────────────────────────────────
 * Sonde 8: ein Kopf mit Lead-Zone dockt beim Scrollen auch an
 *
 * Die Regel (§2, Session 7, praezisiert Session 19): die Trennlinie erscheint
 * beim Andocken - und andocken kann nur ein Kopf mit Lead-Zone. Die eine
 * Haelfte ist trivial und stimmte immer: ohne Lead-Zone traegt die Leiste ihre
 * Linie durchgehend. Die andere lag DREI RUNDEN falsch, ohne dass ein Test es
 * sah: drei Koepfe mit Lead-Zone (Gesundheit, Belohnungen, Haushaltshilfe)
 * dockten mobil nie an und trugen damit in KEINEM Zustand eine Kante.
 *
 * WARUM EBENE 4: der Fehler stand in keinem Stylesheet und in keinem
 * Modulcode. Er entstand aus einer Geometrie, die genau aufgeht - der
 * beobachtete Zeuge der ersten Zeile ist ein Kind des KLEBENDEN Kopfes und
 * wandert nur so weit, wie das negative `top` ihn hochzieht, also exakt
 * `--page-toolbar-lead`. Bei einem ZWEIZEILIGEN Kopf ist das die Unterkante
 * der ersten Zeile: sie endet buendig auf der Port-Kante, beruehrt sie also,
 * statt sie zu ueberschreiten. Ob eine Kante beruehrt oder ueberschritten
 * wird, weiss erst das Dokument.
 *
 * WARUM NUR MOBIL: die kollabierende Leiste ist eine Regel der KOMPAKTEN
 * Groessenklasse. Ab 1024px steht jeder Kopf einzeilig und traegt seine Linie
 * durchgehend - dort gibt es kein Andocken zu pruefen.
 *
 * WARUM KEIN `visitViews`: die Regel gilt am MODULKOPF, und davon hat jedes
 * Modul genau einen; er ueberlebt den Sichtwechsel. Das ist eine Aussage ueber
 * die Regel, keine Bequemlichkeit - und sie haelt diese Sonde bei rund zwei
 * Minuten statt bei zwanzig.
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Liest Lead-Zone, Andock-Zustand, Linienfarbe UND die echte Zeiligkeit des
 * Modulkopfs.
 *
 * Die Zeiligkeit wird hier unabhaengig von `wireCollapsingHeader` bestimmt -
 * eine Sonde, die dessen eigene Rechnung nachspricht, prueft nichts. Zwei
 * Kaesten stehen auf derselben Zeile, wenn sich ihre vertikalen Intervalle
 * ueberlappen; ein Kasten ohne Hoehe macht keine Zeile auf.
 */
async function headDocking(page) {
  return page.evaluate(() => {
    const head = document.querySelector('.page-toolbar');
    if (!head) return null;
    const cs = getComputedStyle(head);
    const visible = (c) => !/rgba\(0, 0, 0, 0\)|\/\s*0\)/.test(c);
    const boxes = [...head.children]
      .filter((c) => c.offsetParent !== null || c.getClientRects().length)
      .map((c) => c.getBoundingClientRect())
      .filter((r) => r.height > 0)
      .sort((a, b) => a.top - b.top);
    const lines = [];
    for (const r of boxes) {
      const line = lines.find((l) => r.top < l.bottom - 1 && r.bottom > l.top + 1);
      if (line) { line.top = Math.min(line.top, r.top); line.bottom = Math.max(line.bottom, r.bottom); }
      else lines.push({ top: r.top, bottom: r.bottom });
    }
    return {
      lead: parseFloat(cs.getPropertyValue('--page-toolbar-lead')) || 0,
      rows: lines.length,
      docked: head.classList.contains('is-docked'),
      line: visible(cs.borderBottomColor) && parseFloat(cs.borderBottomWidth) > 0,
    };
  });
}

/** Scrollt jeden Port bis ans Ende und meldet die groesste gefundene Reserve. */
async function scrollEveryPort(page) {
  return page.evaluate(() => {
    let most = 0;
    for (const el of document.querySelectorAll('*')) {
      const oy = getComputedStyle(el).overflowY;
      const reserve = el.scrollHeight - el.clientHeight;
      if ((oy === 'auto' || oy === 'scroll') && reserve > 8) {
        el.scrollTop = reserve;
        most = Math.max(most, reserve);
      }
    }
    return most;
  });
}

test('Sonde 8 - ein Kopf mit Lead-Zone traegt seine Linie erst angedockt, und dockt auch an', async () => {
  const page = await openPage(harness, { device: 'mobile', theme: 'light', locale: 'de' });
  const findings = [];
  let headsSeen = 0;
  let leadHeads = 0;

  for (const name of sweep('Sonde 8')) {
    await gotoRoute(page, ALL_ROUTES[name]);
    // Der Kopf misst sich ueber ResizeObserver und MutationObserver, und der
    // IntersectionObserver feuert asynchron - eine Messung direkt nach dem
    // Aufbau liest den Zwischenstand.
    await new Promise((r) => setTimeout(r, 700));
    const before = await headDocking(page);
    if (!before) continue;
    headsSeen += 1;

    // Ohne Lead-Zone gilt die andere Haelfte der Regel: die Linie steht
    // durchgehend. Ein Kopf, der DANN keine traegt, hat gar keine Kante - das
    // war der Zustand der Rezepte, verursacht von einem leeren Slot, den die
    // Zeilenmessung fuer eine zweite Zeile hielt.
    if (!before.lead) {
      if (!before.line) {
        findings.push(`${name}: ohne Lead-Zone und ohne Linie - der Kopf hat in keinem Zustand eine Kante.`);
      }
      continue;
    }
    leadHeads += 1;

    // EINE LEAD-ZONE AUF EINEM EINZEILIGEN KOPF IST KEINE. Sie kostet dann
    // nicht nur nichts, sie verbirgt die Linie dauerhaft: `--stacked` schaltet
    // `border-bottom-color: transparent`, und ohne Zeile, die wegwandern kann,
    // gibt es kein Andocken, das sie zurueckholt. Genau so stand der
    // Rezepte-Kopf da - ein leerer Slot ohne Hoehe galt als zweite Zeile.
    if (before.rows < 2) {
      findings.push(
        `${name}: Lead-Zone ${before.lead}px, aber der Kopfinhalt steht in EINER Zeile - `
        + 'eine Lead-Zone ohne zweite Zeile verbirgt die Linie dauerhaft.',
      );
      continue;
    }

    // Mit Lead-Zone: am Scroll-Anfang nahtlos. Ein Kopf, der beim Aufbau schon
    // gescrollt ist (der Essensplan springt auf „jetzt"), ist zu Recht
    // angedockt und wird hier nicht beurteilt.
    if (!before.docked && before.line) {
      findings.push(`${name}: Lead-Zone ${before.lead}px, nicht angedockt, traegt aber schon die Linie.`);
    }

    const reserve = await scrollEveryPort(page);
    await new Promise((r) => setTimeout(r, 700));
    // Ein Kopf, unter dem nichts wegscrollt, MUSS nicht andocken - sonst misst
    // die Sonde den Seed statt der Regel. Die Schwelle ist die Lead-Zone
    // selbst: erst dahinter gibt es ueberhaupt etwas zu beobachten.
    if (reserve <= before.lead) continue;
    const after = await headDocking(page);
    if (!after.docked || !after.line) {
      findings.push(
        `${name}: Lead-Zone ${before.lead}px und ${reserve}px Scroll-Reserve, aber nach dem Scrollen `
        + `${after.docked ? 'angedockt ohne Linie' : 'nicht angedockt'} - die Kopfkante erscheint nie.`,
      );
    }
  }
  await page.close();

  // Eine Sonde, die nichts gesehen hat, darf nicht urteilen (dieselbe
  // Zusicherung wie bei Sonde 3 bis 7). Hier braucht es BEIDES: Koepfe
  // ueberhaupt, und Koepfe MIT Lead-Zone - sonst belegt ein gruener Lauf nur
  // die triviale Haelfte der Regel, und genau die andere war kaputt.
  assert.ok(headsSeen >= ROUTE_NAMES.length - 3,
    `Nur ${headsSeen} Modulkoepfe von ${ROUTE_NAMES.length} Routen gesehen - die Sonde erreicht die Koepfe nicht mehr.`);
  assert.ok(leadHeads >= 5,
    `Nur ${leadHeads} Koepfe mit Lead-Zone gesehen (gemessen: 10). Ohne sie prueft diese Sonde nur, `
    + 'dass einzeilige Koepfe eine Linie tragen.');

  assert.deepEqual(findings, [],
    'Die Trennlinie erscheint beim Andocken, und andocken kann nur ein Kopf mit Lead-Zone - wer eine '
    + 'hat, muss es dann aber auch tun. Wo keine ist, steht die Linie durchgehend und markiert die '
    + 'Kopfkante.\n  '
    + findings.join('\n  '));
});

// ============================================================
// Sonde 9 - Compositor-Ebenen im Ruhezustand
// ============================================================

/**
 * ZWEI NACHBARFRAGEN BLEIBEN HIER BEWUSST UNGEPRUEFT, und beide stehen hier,
 * weil das die Stelle ist, an der jemand nach „ist die Laufzeit abgesichert"
 * sucht (Guard-Abdeckung 2026-08-08, Befund G und die Positivbefund-Tabelle):
 *
 *   KEIN LAYOUT-THRASHING. Gemessen im Implementierungs-Audit: 4 Layout-
 *   Lesungen innerhalb von Schleifen in 61.274 Zeilen, keine Lese-Schreib-
 *   Kaskade. Ein statischer Guard muesste den DATENFLUSS verfolgen - welche
 *   Schreiboperation invalidiert welches Layout -, und jede Naeherung darunter
 *   („eine Layout-Lesung in einer Schleife") meldet Fehltreffer an genau den
 *   vier Stellen, die heute begruendet dastehen. Auf Ebene 4 waere es auch
 *   keine Regel: ein `PerformanceObserver` misst, wie lang der SEED ist, nicht,
 *   ob der Code kaskadiert - eine leere Liste ist immer schnell.
 *
 *   DIE BEGRUENDUNGSDICHTE DER LAYOUT-TRANSITIONS. Sechs Regeln animieren eine
 *   echte Layout-Eigenschaft (detail-view.css:222, layout.css:165/1765/1789/2017,
 *   settings.css:163), und jede traegt im Code, warum `transform` es dort nicht
 *   kann, und ist im passenden `prefers-reduced-motion`-Block abgeschaltet. Ein
 *   Guard koennte die Fundstellen zaehlen und den Reduced-Motion-Block pruefen -
 *   die ZUSAGE ist aber, dass die BEGRUENDUNG traegt, und das ist eine Aussage
 *   ueber einen Prosatext. Ein Guard, der die Existenz eines Kommentars prueft,
 *   erzieht zum Kommentar, nicht zur Begruendung; er waere gruen an dem Tag, an
 *   dem jemand „// bewusst" darueberschreibt. Beim Nachzaehlen fuer diesen
 *   Eintrag fehlte die Begruendung an genau einer Stelle (settings.css:163) und
 *   ist jetzt da - gefunden durch Lesen, nicht durch einen Guard, und das ist
 *   der ehrliche Weg fuer diese Zusage.
 *
 * Zaehlt im Ruhezustand jedes Element mit einem `will-change`, das eine eigene
 * Compositor-Ebene erzwingt, und gruppiert nach Klassensignatur.
 *
 * DIE SIGNATUR IST DER MASSSTAB, NICHT EINE OBERGRENZE. Die Frage ist nicht
 * „wie viele Ebenen sind zu viele", sondern „waechst die Zahl mit dem Inhalt".
 * Ein einmaliges Chrome-Element (die Sidebar-Pille, der Tab-Indikator, ein
 * Backdrop-Blob) darf sein Versprechen dauerhaft halten - es gibt genau eins
 * davon, egal wie lang die Liste wird. Eine Zeile darf es nicht: dieselbe
 * Signatur zweimal heisst, sie kommt auch 200-mal.
 *
 * Genau diese Unterscheidung sieht ein Stylesheet-Scanner nicht: `.lg-blob--1`
 * und `.task-card` tragen dieselbe Deklaration.
 */
// Nur Versprechen, die tatsaechlich eine eigene Ebene erzwingen. `will-change:
// opacity` allein tut das in Blink nicht zwingend, `transform` und `filter`
// schon - und das sind die Faelle, um die es geht.
const LAYER_PROPS = ['transform', 'filter', 'backdrop-filter'];

async function restingLayers(page) {
  return page.evaluate((props) => {
    const out = [];
    for (const el of document.querySelectorAll('*')) {
      const wc = getComputedStyle(el).willChange;
      if (!wc || wc === 'auto') continue;
      if (!props.some((p) => wc.includes(p))) continue;
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      const cls = (typeof el.className === 'string' ? el.className : '').trim().replace(/\s+/g, '.');
      out.push({ sig: `${el.tagName.toLowerCase()}${cls ? `.${cls}` : ''}`, wc });
    }
    return out;
  }, LAYER_PROPS);
}

test('Sonde 9 - ein Compositor-Versprechen im Ruhezustand ist einmalig, nie eine Zeile', async () => {
  const page = await openPage(harness, { device: 'mobile', theme: 'light', locale: 'de' });
  const findings = [];
  let routesSeen = 0;
  let layersSeen = 0;

  const routes = sweep('Sonde 9');
  for (const name of routes) {
    await gotoRoute(page, ALL_ROUTES[name]);
    // Die Zeilenlisten bauen sich nach dem ersten Frame auf; eine Messung
    // direkt danach faende die leere Seite und waere immer gruen.
    await new Promise((r) => setTimeout(r, 500));
    routesSeen += 1;

    const counts = new Map();
    for (const { sig, wc } of await restingLayers(page)) {
      layersSeen += 1;
      const entry = counts.get(sig) ?? { count: 0, wc };
      entry.count += 1;
      counts.set(sig, entry);
    }

    for (const [sig, { count, wc }] of counts) {
      if (count < 2) continue;
      findings.push(`${name}: ${count}x ${sig} traegt "will-change: ${wc}" im Ruhezustand.`);
    }
  }
  await page.close();

  // Eine Sonde, die nichts gesehen hat, darf nicht urteilen (dieselbe
  // Zusicherung wie bei Sonde 3 bis 8). Hier zaehlt BEIDES: die Routen, und
  // dass ueberhaupt Ebenen gefunden werden - die Shell traegt drei einmalige
  // (Sidebar-Pille, Sidebar-Hover, Tab-Indikator) plus die Backdrop-Blobs.
  // Findet die Sonde gar keine, misst sie den Selektor falsch statt die App.
  assert.ok(routesSeen >= routes.length - 1,
    `Nur ${routesSeen} von ${routes.length} Zustaenden gesehen.`);
  assert.ok(layersSeen >= routesSeen,
    `Nur ${layersSeen} Ebenen ueber ${routesSeen} Routen gefunden - die Shell allein traegt `
    + 'mehrere je Seite. Die Sonde misst nicht mehr, was sie messen soll.');

  assert.deepEqual(findings, [],
    'Wiederholte Compositor-Versprechen im Ruhezustand. Eine Signatur, die zweimal vorkommt, kommt '
    + 'auch 200-mal: die Ebenen-Last waechst dann mit der Zeilenzahl, auf genau den aelteren '
    + 'Telefonen, die laut PRODUCT.md die Hauptszene sind. Das Versprechen gehoert an die GESTE '
    + '(.swipe-row--armed in layout.css), nicht an die Zeile.\n  '
    + findings.join('\n  '));
});

// ============================================================
// Sonde 10 - die Struktur jedes Dokuments, angemeldet wie davor
// ============================================================

/**
 * Die A11y-Grundlage als GUARD statt als einmalige Messung.
 *
 * Genau ein `h1`, genau ein `main`, ein `lang`, ein beschreibender Titel, ein
 * Name an jedem Ziel, ein Label an jedem Feld, keine doppelte ID, kein
 * Ueberschriftensprung, kein ARIA-Verweis ins Leere, kein Ueberlauf.
 *
 * ZWEI LUECKEN AUF EINMAL. Erstens: `ROUTES` sind angemeldete Zustaende, und
 * `openPage` reicht dafuer ein Cookie durch - Anmelden, Passwort vergessen,
 * Passwort zuruecksetzen, Einladung annehmen, Ersteinrichtung und die
 * Offline-Huelle hatten nie eine Sonde gesehen (Audit 2026-08-08, P2-5).
 * Zweitens: fuer die angemeldete App war diese Grundlage zwar GEMESSEN, aber
 * nie abgesichert - der Audit fuehrte sie unter „Was traegt", und ein
 * Positivbefund ohne Guard ist eine Momentaufnahme. Der Beleg kam sofort: die
 * Nachmessung fand einen 47. toten ARIA-Verweis (`#cal-search` zeigte auf eine
 * Suchleiste, die erst beim Oeffnen entsteht), den der Audit selbst uebersehen
 * hatte. Die Sonde faehrt deshalb BEIDE Welten mit denselben Fragen.
 *
 * ZIELGROESSEN NUR VOR DER ANMELDUNG: dahinter gehoeren sie Sonde 4, und die
 * misst die TREFFERFLAECHE an jeder Scrollposition und unterscheidet
 * freistehende von eingeengten Zielen. Eine zweite, groebere Messung daneben
 * wuerde genau die Fehltreffer melden, die Sonde 4 gelernt hat zu vermeiden
 * (ein 34x34-Knopf, der per `::before` auf 44px ausdehnt). Vor der Anmeldung
 * hat Sonde 4 keine Reichweite - dort ist die grobe Messung besser als keine.
 */
/**
 * Wartet, bis keine ENDLICHE Animation mehr laeuft.
 *
 * `settle()` wartet auf den Aufbau, nicht auf die Ruhe: der Router blendet
 * jede Seite mit einer 200ms-Slide-Animation ein, und waehrend dieser
 * Animation steht der Seiteninhalt auf `opacity: 0`. Genau dort hat diese
 * Sonde einmal gemessen und `desktop/notes: 0 h1` gemeldet - der Titel steht
 * im synchronen Markup, war aber im Sinne der Sichtbarkeitspruefung nicht da.
 * Ein Guard, der von einer Animation abhaengt, meldet Zufall statt Regel.
 *
 * NUR ENDLICHE Animationen: die Backdrop-Blobs laufen mit
 * `animation: lg-drift 26s infinite alternate` und werden NIE fertig - ein
 * naives `Promise.all(getAnimations().map(a => a.finished))` haengt bis zum
 * Timeout der Suite.
 */
async function settleAnimations(page) {
  try {
    await page.evaluate(() => {
      const finite = document.getAnimations().filter((a) => {
        try { return a.effect?.getTiming().iterations !== Infinity; } catch { return false; }
      });
      return Promise.race([
        Promise.all(finite.map((a) => a.finished.catch(() => {}))),
        new Promise((r) => setTimeout(r, 1500)),
      ]);
    });
  } catch {
    /* Kontext beim Navigieren zerstoert - der naechste Aufruf misst ohnehin neu. */
  }
}

async function documentStructure(page) {
  return page.evaluate(() => {
    const path = (el) => {
      const parts = [];
      for (let n = el; n && n.nodeType === 1 && parts.length < 3; n = n.parentElement) {
        let s = n.tagName.toLowerCase();
        if (n.id) { parts.unshift(`${s}#${n.id}`); break; }
        const cls = (typeof n.className === 'string' ? n.className : '').trim().split(/\s+/).filter(Boolean).slice(0, 2);
        if (cls.length) s += `.${cls.join('.')}`;
        parts.unshift(s);
      }
      return parts.join(' > ');
    };
    const visible = (el) => {
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none'
        && cs.opacity !== '0' && !el.closest('[hidden],[aria-hidden="true"]');
    };
    const accName = (el) => {
      const a = el.getAttribute('aria-label'); if (a?.trim()) return a.trim();
      const lb = el.getAttribute('aria-labelledby');
      if (lb) {
        const txt = lb.split(/\s+/).map((id) => document.getElementById(id)?.textContent || '').join(' ').trim();
        if (txt) return txt;
      }
      const ti = el.getAttribute('title'); if (ti?.trim()) return ti.trim();
      const tx = (el.textContent || '').replace(/\s+/g, ' ').trim(); if (tx) return tx;
      return el.querySelector('img[alt]')?.alt.trim() || '';
    };

    const out = { nameless: [], inputsNoLabel: [], dupIds: [], headings: [], badRefs: [], smallTargets: [] };

    for (const el of document.querySelectorAll('button, a[href], [role="button"], summary, input[type="submit"]')) {
      if (visible(el) && !accName(el)) out.nameless.push(path(el));
    }
    for (const el of document.querySelectorAll('input:not([type="hidden"]), select, textarea')) {
      if (!visible(el)) continue;
      const labelled = (el.id && document.querySelector(`label[for="${CSS.escape(el.id)}"]`)) || el.closest('label');
      if (!labelled && !el.getAttribute('aria-label') && !el.getAttribute('aria-labelledby')) {
        out.inputsNoLabel.push(`${path(el)} (${el.getAttribute('type') || el.tagName.toLowerCase()})`);
      }
    }
    const seen = new Map();
    for (const el of document.querySelectorAll('[id]')) seen.set(el.id, (seen.get(el.id) || 0) + 1);
    for (const [id, n] of seen) if (n > 1) out.dupIds.push(`#${id} (${n}x)`);

    const hs = [...document.querySelectorAll('h1,h2,h3,h4,h5,h6')].filter(visible);
    let prev = 0;
    for (const h of hs) {
      const lvl = Number(h.tagName[1]);
      if (prev && lvl > prev + 1) out.headings.push(`${path(h)}: h${prev} -> h${lvl}`);
      prev = lvl;
    }
    // Dieselbe Pruefung, die die zehn toten aria-controls gefunden hat.
    for (const el of document.querySelectorAll('[aria-labelledby],[aria-describedby],[aria-controls]')) {
      for (const attr of ['aria-labelledby', 'aria-describedby', 'aria-controls']) {
        const v = el.getAttribute(attr);
        if (!v) continue;
        const missing = v.split(/\s+/).filter((id) => id && !document.getElementById(id));
        if (missing.length) out.badRefs.push(`${path(el)} ${attr}="${missing.join(' ')}"`);
      }
    }

    const min = window.innerWidth < 768 ? 44 : 24;
    for (const el of document.querySelectorAll('button, a[href], [role="button"], input[type="checkbox"], input[type="radio"], select')) {
      if (!visible(el)) continue;
      const r = el.getBoundingClientRect();
      if (r.width < min && r.height < min) {
        out.smallTargets.push(`${path(el)} ${Math.round(r.width)}x${Math.round(r.height)} (min ${min})`);
      }
    }


    return {
      ...out,
      h1: hs.filter((h) => h.tagName === 'H1').length,
      main: document.querySelectorAll('main,[role="main"]').length,
      lang: document.documentElement.lang || null,
      title: document.title,
      overflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    };
  });
}

test('Sonde 10 - jedes Dokument traegt dieselbe Struktur, angemeldet wie davor', async () => {
  const anonNames = Object.keys(ANON_ROUTES);
  const authNames = sweep('Sonde 10');
  const findings = [];
  let seen = 0;

  const judge = (at, r, { targets }) => {
    seen += 1;

    // Genau EIN h1 und EIN main: eine Seite braucht einen Namen und eine
    // Landmarke, sonst laeuft ein Screenreader sie von oben durch.
    if (r.h1 !== 1) findings.push(`${at}: ${r.h1} h1 (erwartet: genau eins)`);
    if (r.main !== 1) findings.push(`${at}: ${r.main} main-Landmarken (erwartet: genau eine)`);
    if (!r.lang) findings.push(`${at}: kein lang-Attribut am Dokument`);

    // Der Titel ist in einer SPA die einzige Ansage beim Seitenwechsel
    // (WCAG 2.4.2, Level A). „Yuvomi · Yuvomi" war der gemessene Verstoss.
    const parts = r.title.split('·').map((s) => s.trim());
    if (!r.title.trim()) findings.push(`${at}: leerer Dokumenttitel`);
    else if (parts.length > 1 && parts[0] === parts[1]) {
      findings.push(`${at}: Dokumenttitel "${r.title}" wiederholt nur den App-Namen`);
    }

    for (const sel of r.nameless) findings.push(`${at}: Ziel ohne zugaenglichen Namen - ${sel}`);
    for (const sel of r.inputsNoLabel) findings.push(`${at}: Eingabefeld ohne Label - ${sel}`);
    for (const id of r.dupIds) findings.push(`${at}: doppelte ID ${id}`);
    for (const h of r.headings) findings.push(`${at}: Ueberschriftensprung ${h}`);
    for (const ref of r.badRefs) findings.push(`${at}: ARIA-Verweis ins Leere - ${ref}`);
    if (targets) {
      for (const s of r.smallTargets) findings.push(`${at}: Zielgroesse unter dem Minimum - ${s}`);
    }
    if (r.overflowX > 1) findings.push(`${at}: ${r.overflowX}px horizontaler Ueberlauf`);
  };

  for (const device of ['mobile', 'desktop']) {
    // Vor der Anmeldung: eigene Seite ohne Cookie (openPage wuerde von genau
    // diesen Routen wegleiten).
    const anon = await openAnonPage(harness, { device, theme: 'light' });
    for (const name of anonNames) {
      await gotoAnonRoute(anon, ANON_ROUTES[name]);
      await settleAnimations(anon);
      judge(`${device}/${name}`, await documentStructure(anon), { targets: true });
    }
    await anon.close();

    // Dahinter: dieselben Fragen, ohne die Zielgroessen (die gehoeren Sonde 4).
    const auth = await openPage(harness, { device, theme: 'light', locale: 'de' });
    for (const name of authNames) {
      await gotoRoute(auth, ALL_ROUTES[name]);
      await settleAnimations(auth);
      judge(`${device}/${name}`, await documentStructure(auth), { targets: false });
    }
    await auth.close();
  }

  // Eine Sonde, die nichts gesehen hat, darf nicht urteilen (dieselbe
  // Zusicherung wie bei Sonde 3 bis 9).
  const expected = 2 * (anonNames.length + authNames.length);
  assert.equal(seen, expected, `Nur ${seen} von ${expected} Zustaenden gesehen.`);

  assert.deepEqual(findings, [],
    'Struktur-Befunde im gerenderten Dokument. Die Seiten VOR der Anmeldung sind der Erstkontakt '
    + 'und der Weg jedes neuen Familienmitglieds; die dahinter halten dieselbe Grundlage.\n  '
    + findings.join('\n  '));
});

/**
 * Sonde 11 - was klickbar ist, ist auch mit der Tastatur erreichbar.
 *
 * WARUM DAS EINE SONDE IST UND KEIN SCANNER. Der Cursor sagt es nicht:
 * `cursor: pointer` vererbt, also sieht jedes Kind einer klickbaren Karte
 * klickbar aus. Der Klassenname sagt es auch nicht - `.birthdays-toolbar__import`
 * ist ein Knopf und heisst nach seiner Funktion (Session 12). Gefragt ist die
 * LISTENER-REGISTRY DER ENGINE, und die kennt nur der laufende Browser:
 * `DOMDebugger.getEventListeners` ueber CDP. Puppeteer bringt den Zugang mit,
 * es kommt kein Fremdcode dazu.
 *
 * DER POSITIVBEFUND WAR DER ANLASS. Der Implementierungs-Audit vom 2026-08-08
 * fuehrte unter „Was traegt": *Tastaturbedienung: 0 Befunde. Alle 29 Elemente
 * mit click-Listener ohne eigenen Tastaturzugang sind Container mit
 * Event-Delegation ueber echte Buttons.* Gemessen, gestimmt, nie abgesichert -
 * und ein Positivbefund ohne Guard ist eine Momentaufnahme. Dieselbe Bauform
 * hat bei Sonde 10 sofort einen 47. toten ARIA-Verweis geliefert, den der Audit
 * selbst uebersehen hatte.
 *
 * WAS SIE DURCHLAESST, UND WARUM DAS DIE REGEL IST: ein Container, der einen
 * click-Listener traegt und im Inneren ein echtes Bedienelement hat, ist
 * EVENT-DELEGATION - das Muster, mit dem diese App ihre Listen verdrahtet, und
 * die Tastatur erreicht das Ziel ueber den Knopf darin. Gemeldet wird der
 * Container OHNE inneres Ziel: dort endet der Klick, und die Tastatur kommt
 * nirgends an.
 *
 * SIE FAEHRT NUR DEN SEITENINHALT (`#main-content`). Die Shell ist auf jeder
 * Route dieselbe; ein Befund dort kaeme sechzehnmal.
 *
 * EIN TRAEGER OHNE ZIEL VERSCHLUCKT KEINEN KLICK - es ist keines da. Gemessen
 * an den Settings-Blaettern: die Einladungs- und die Token-Liste
 * (`ul.settings-members`) bekommen ihren delegierenden Listener beim Aufbau der
 * Seite, ihre Zeilen kommen per API danach. Wo der Seed keine liefert, steht
 * dort ein einzelnes `<p class="form-hint">` mit „noch nichts vorhanden" - und
 * die Sonde meldete eine Tastatur-Sackgasse, obwohl jede echte Zeile ihren
 * eigenen Knopf traegt (`button.row-action`) und die Delegation genau richtig
 * gebaut ist. Der Unterschied ist nicht Timing, sondern Bedeutung: ein
 * Sackgassen-Befund braucht etwas, das in der Sackgasse steht.
 *
 * GEPRUEFT WIRD DIE FORM, NICHT DIE KLASSE. Ein Guard auf `.empty-state` oder
 * `.form-hint` faende nur, wer den Namen schon traegt (die Session-8-Lehre).
 * Die Form eines Leerzustands ist: gar kein Kind, oder GENAU EIN kinderloses
 * Element mit Text darin. Alles andere - eine Zeile, ein Raster, irgendetwas
 * mit Struktur - bleibt ein Befund.
 *
 * KOSTEN: rund eine Minute. Sie nimmt `visitViews` NICHT - aus demselben Grund
 * wie Sonde 8: die Verdrahtung einer Liste haengt an ihrem Modul, nicht an der
 * Sicht, und die 16 Routen erreichen jedes Modul einmal.
 */
async function keyboardlessClickTargets(page) {
  const cdp = await page.createCDPSession();
  try {
    // DOMDebugger hat kein `enable` - die Domain ist ohne Aktivierung nutzbar.
    await cdp.send('DOM.enable');
    await cdp.send('Runtime.enable');

    const { result } = await cdp.send('Runtime.evaluate', {
      expression: `
        (() => {
          const scope = document.querySelector('#main-content') || document.body;
          window.__kbCandidates = [...scope.querySelectorAll('*')].filter((el) => {
            const r = el.getBoundingClientRect();
            const cs = getComputedStyle(el);
            return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden'
              && !el.closest('[hidden],[aria-hidden="true"]');
          });
          return window.__kbCandidates.length;
        })()
      `,
      returnByValue: true,
    });

    const findings = [];
    // Der Reichweiten-Nachweis dieser Sonde: NICHT die besuchten Routen, sondern
    // die Elemente, aus denen hier ueberhaupt ein Finding entstehen kann. Das
    // sind die mit einem click-Listener - alles davor ist Vorauswahl, alles
    // danach Freispruch. Degradiert der CDP-Pfad (DOMDebugger weg, Handles tot),
    // bleibt `withClick` null, waehrend `result.value` und die Routenzahl
    // unveraendert aussehen.
    let withClick = 0;
    for (let i = 0; i < result.value; i += 1) {
      const { result: handle } = await cdp.send('Runtime.evaluate', { expression: `window.__kbCandidates[${i}]` });
      try {
        const { listeners } = await cdp.send('DOMDebugger.getEventListeners', { objectId: handle.objectId, depth: 0 });
        if (!listeners.some((l) => l.type === 'click')) continue;
        withClick += 1;
        const hasKeyListener = listeners.some((l) => l.type === 'keydown' || l.type === 'keypress');

        const { result: meta } = await cdp.send('Runtime.callFunctionOn', {
          objectId: handle.objectId,
          returnByValue: true,
          functionDeclaration: `function () {
            const native = this.matches('a[href],button,input,select,textarea,summary,[contenteditable]');
            const tabindex = this.getAttribute('tabindex');
            return {
              tag: this.tagName.toLowerCase(),
              cls: (typeof this.className === 'string' ? this.className : '').trim().slice(0, 60),
              focusable: native || (tabindex !== null && Number(tabindex) >= 0),
              delegates: Boolean(this.querySelector('a[href],button,input,select,textarea,summary,[tabindex]:not([tabindex="-1"])')),
              // Ein Traeger OHNE ZIEL verschluckt keinen Klick - es ist keines
              // da. Siehe den Absatz "Ein Traeger ohne Ziel" im Sondenkommentar.
              // Zwei Formen, beide gemessen: gar kein Kind, oder genau ein
              // kinderloses Textelement (der Leerzustand).
              targetless: this.childElementCount === 0
                || (this.childElementCount === 1
                  && this.firstElementChild.childElementCount === 0
                  && this.firstElementChild.textContent.trim().length > 0),
            };
          }`,
        });
        const el = meta.value;
        if (el.focusable || hasKeyListener || el.delegates || el.targetless) continue;
        findings.push(`<${el.tag}${el.cls ? ` class="${el.cls}"` : ''}>`);
      } finally {
        await cdp.send('Runtime.releaseObject', { objectId: handle.objectId });
      }
    }
    return { findings, withClick };
  } finally {
    await cdp.detach();
  }
}

test('Sonde 11 - was einen Klick annimmt, nimmt auch eine Taste an', async () => {
  const findings = [];
  let seen = 0;
  let withClick = 0;

  const routes = sweep('Sonde 11');
  const page = await openPage(harness, { device: 'desktop', theme: 'light', locale: 'de' });
  for (const name of routes) {
    await gotoRoute(page, ALL_ROUTES[name]);
    await settleAnimations(page);
    seen += 1;
    const probed = await keyboardlessClickTargets(page);
    withClick += probed.withClick;
    for (const el of probed.findings) {
      findings.push(`${name}: ${el}`);
    }
  }
  await page.close();

  // Eine Sonde, die nichts gesehen hat, darf nicht urteilen - und „gesehen" heisst
  // hier nicht „besucht". Der Routenzaehler steht VOR der Messung: er haelt auch
  // dann, wenn die CDP-Schleife in `keyboardlessClickTargets()` nie laeuft.
  // Deshalb steht der zweite Nachweis daneben, und der zaehlt in der Messung.
  assert.equal(seen, routes.length, `Nur ${seen} von ${routes.length} Zustaenden gesehen.`);
  assert.ok(withClick >= 250,
    `Nur ${withClick} Elemente mit click-Listener gefunden - der CDP-Pfad misst nicht `
    + '(DOMDebugger.getEventListeners tot, Handles nicht aufloesbar?), statt nichts zu finden.');

  assert.deepEqual(findings, [],
    'Element mit click-Listener, ohne eigenen Tastaturzugang UND ohne inneres Bedienelement, '
    + 'an das es delegieren koennte - hier endet der Klick und die Tastatur kommt nicht an '
    + '(WCAG 2.1.1, Level A).\n  '
    + findings.join('\n  '));
});

/* ────────────────────────────────────────────────────────────────────────────
 * Sonde 12: die Glas-Familie - wo Glas sitzt, und was ohne es bleibt
 *
 * Zwei Regeln, eine Sonde, weil beide dieselbe Menge brauchen: alle Flaechen,
 * die im Dokument `backdrop-filter` tragen.
 *
 * (F) DIE GLAS-IST-CHROME-REGEL. Der Architektur-Audit mass 54
 *     `backdrop-filter`-Instanzen, ausnahmslos an Navigation und Knoepfen -
 *     gemessen, gestimmt, nie abgesichert. Im STYLESHEET ist die Aussage nicht
 *     scharf: ob ein Selektor Chrome oder Inhalt adressiert, weiss erst das
 *     Dokument. Hier ist sie es: liegt das Element innerhalb von
 *     `#main-content`, ist es Inhalt.
 *
 *     WAS DIE ROT-PROBE ANS LICHT BRACHTE, und es ist der eigentliche Befund:
 *     ein eingebauter Verstoss (`backdrop-filter` auf `.list-rows`) liess die
 *     Sonde GRUEN. Der Grund ist `.app-content *` in glass.css - eine
 *     Blanket-Regel, die `backdrop-filter` im Scroll-Container mit
 *     `!important` abraeumt. Sie steht dort NICHT wegen dieser Regel, sondern
 *     gegen den Blank-Screen-Bug (#166, iOS/Android-Compositor). Erst mit
 *     `!important` im Verstoss wurde die Sonde rot.
 *     Die Glas-ist-Chrome-Regel wird im Dokument also von einer Regel
 *     getragen, die es aus einem ganz anderen Grund gibt. Solange beide
 *     bestehen, ist sie doppelt gesichert; faellt die
 *     Compositor-Gegenmassnahme irgendwann weg, ist diese Sonde die einzige,
 *     die es merkt. Genau deshalb bleibt sie stehen, obwohl sie heute nur
 *     bestaetigt.
 *
 *     ZWEITE EBENE (2026-08-08), und sie kann rot werden, wo die erste es nie
 *     kann: `declaredGlassInMain()` liest das CSSOM statt der berechneten
 *     Werte, sieht also, was GESCHRIEBEN steht, bevor `.app-content *` es
 *     abraeumt. Damit ist die Rot-Probe von oben nicht mehr auf ein
 *     `!important` im Verstoss angewiesen.
 *
 *     SIE HAT BEIM ERSTEN LAUF SOFORT ETWAS GEFUNDEN, und der Befund war
 *     groesser als die Glas-Regel: `.fab-action__btn` und `.fab-action__label`
 *     deklarierten Glas und lagen in `#main-content`. Sie waren kein verirrtes
 *     Glas im Inhalt - sie waren CHROME AM FALSCHEN ORT. Das Dashboard baute
 *     seinen Speed-Dial als eigenen `.fab-container` und hatte gar keine
 *     `.page-fab`; `adoptPageFab()` in router.js sucht aber genau die, um den
 *     FAB in die Shell-Layer `#fab-layer` zu ziehen. Die Haertung aus #634
 *     griff auf der Startseite also nicht.
 *
 *     DIE SONDE BLIEB ROT, BIS DER ANLASS FIEL, statt sich eine Dauerausnahme
 *     zu geben: der Dial ist seit dem Folgevorgang zu #634 eine
 *     `.page-fab-group` mit einem `.page-fab` darin, sein Glas sitzt in der
 *     Shell, und die benannte Ausnahme ist ersatzlos entfallen. Was hier
 *     bleibt, ist die Lehre - eine Ausnahme braucht ein Verfallsdatum an
 *     BEIDEN Enden, am Anlass wie am Verstoss.
 *
 * (B) DIE FALLBACK-REGEL, ihre zweite Haelfte. `jeder Blur kommt aus der
 *     --blur-Skala` (Ebene 3) sichert, dass jede Glasflaeche einen Blur nimmt,
 *     der unter `prefers-reduced-transparency` und `prefers-contrast: more` auf
 *     `blur(0px)` kippt. Was er NICHT sehen kann, ist, ob die Regel im DOKUMENT
 *     ankommt - „im Stylesheet vorhanden, im Dokument wirkungslos" ist derselbe
 *     Fehlertyp wie B-13, und der Handoff notiert ihn seit dem Architektur-Audit
 *     als bekannte Pruefluecke.
 *
 *     GEPRUEFT WIRD NICHT NUR DER BLUR, SONDERN DIE DECKKRAFT. Ein Blur, der
 *     ausgeht, ist die halbe Regel; die andere Haelfte entscheidet ueber
 *     Lesbarkeit. Eine Glasflaeche ohne Blur, die weiter halbdurchsichtig ist,
 *     laesst den Inhalt darunter UNVERWISCHT durchscheinen - der Text davor
 *     steht dann vor allem, was gerade vorbeiscrollt, und sein Kontrast ist
 *     keine Zahl mehr, sondern eine Wette. Genau deshalb kippt tokens.css unter
 *     beiden Zustaenden die `--glass-bg-*` auf `--color-surface`-Werte. Ob das
 *     ankommt, sieht nur das Dokument.
 *
 * KEINE TOLERANZ, und das ist der Grund, warum diese zwei Fragen gebaut sind
 * und die Konzentrik-Frage nicht: „liegt drin" und „Alpha ist 1" sind scharf.
 *
 * DER MEDIENZUSTAND KOMMT UEBER CDP, NICHT UEBER PUPPETEER.
 * `page.emulateMediaFeatures` fuehrt eine Allowlist und kennt
 * `prefers-reduced-transparency` nicht (`Unsupported media feature`) - was den
 * Handoff-Vorschlag „Puppeteer kann beide Medienzustaende emulieren" fuer
 * genau den Zustand widerlegt, um den es hier geht. `Emulation.setEmulatedMedia`
 * kann es, und die Sonde prueft mit `matchMedia`, dass der Zustand wirklich
 * anliegt, statt ihn anzunehmen.
 *
 * SIE FAEHRT DIE 16 ROUTEN, NICHT DIE BLAETTER - siehe LEAVES_SKIPPED.
 * ──────────────────────────────────────────────────────────────────────────── */

/** Setzt einen Medienzustand ueber CDP und belegt, dass er anliegt. */
async function withMedia(page, features) {
  const cdp = await page.createCDPSession();
  await cdp.send('Emulation.setEmulatedMedia', { features });
  const applied = await page.evaluate(
    (list) => list.map((f) => matchMedia(`(${f.name}: ${f.value})`).matches),
    features,
  );
  return { cdp, applied };
}

/**
 * Jede Flaeche, deren GRUND aus einem `--glass-bg-*`-Token kommt.
 *
 * DAS TOKEN IST DIE SIGNATUR, nicht `backdrop-filter`. Die Fallback-Regel sagt
 * woertlich: `prefers-reduced-transparency` kippt „alle Glas-Tokens auf
 * --color-surface-Werte" - sie spricht also ueber die Flaechen, die ihren Grund
 * von dort beziehen, nicht ueber alles, was einen Blur traegt.
 *
 * Der Unterschied ist gemessen und kein Detail: die erste Fassung fragte nach
 * `backdrop-filter` und meldete elf FABs, die unter beiden Zustaenden bei
 * alpha 0,78 bleiben. Das ist kein Verstoss, sondern ihre Bauart - ein
 * `.page-fab` traegt seine MODULFARBE zu 78 % und keinen Glasgrund; sein
 * `backdrop-filter` ist ein Specular, kein Lesegrund. Die Regel meinte ihn nie.
 */
async function glassBackedSurfaces(page) {
  return page.evaluate(() => {
    const path3 = (el) => {
      const parts = [];
      for (let n = el; n && n.nodeType === 1 && parts.length < 3; n = n.parentElement) {
        let s = n.tagName.toLowerCase();
        if (n.id) { parts.unshift(`${s}#${n.id}`); break; }
        const cls = (typeof n.className === 'string' ? n.className : '').trim().split(/\s+/).filter(Boolean).slice(0, 2);
        if (cls.length) s += `.${cls.join('.')}`;
        parts.unshift(s);
      }
      return parts.join(' > ');
    };
    const selectors = new Set();
    const walk = (rules) => {
      for (const rule of rules) {
        // `rule.cssRules` ist seit CSS Nesting KEIN Verzweigungskriterium mehr:
        // jede CSSStyleRule traegt eine leere CSSRuleList, und die ist truthy.
        if (rule.cssRules?.length) { walk(rule.cssRules); continue; }
        if (!rule.style || !rule.selectorText) continue;
        if (/background(-color)?:[^;]*var\(--glass-bg-/.test(rule.cssText)) selectors.add(rule.selectorText);
      }
    };
    for (const sheet of document.styleSheets) {
      try { walk(sheet.cssRules); } catch { /* fremde Herkunft - hier gibt es keine */ }
    }

    const out = [];
    const seen = new Set();
    for (const selector of selectors) {
      let hits = [];
      try { hits = [...document.querySelectorAll(selector)]; } catch { continue; }
      for (const el of hits) {
        if (seen.has(el)) continue;
        seen.add(el);
        const cs = getComputedStyle(el);
        const r = el.getBoundingClientRect();
        if (r.width < 2 || r.height < 2) continue;
        if (cs.visibility === 'hidden' || cs.display === 'none') continue;
        const bf = cs.backdropFilter && cs.backdropFilter !== 'none' ? cs.backdropFilter : cs.webkitBackdropFilter;
        const blur = [...String(bf || '').matchAll(/blur\(\s*([\d.]+)px\s*\)/g)].map((m) => Number(m[1])).filter((v) => v > 0);
        out.push({ sel: path3(el), blur: blur.length ? Math.max(...blur) : 0, bg: cs.backgroundColor });
      }
    }
    return out;
  });
}

/** Jede Flaeche, die Glas traegt - samt Ort im Baum und Deckkraft. */
/**
 * Jede Flaeche, an der eine Regel Glas DEKLARIERT - unabhaengig davon, ob es
 * ankommt.
 *
 * `glassSurfaces()` liest `getComputedStyle`, und genau dort kann die
 * Glas-ist-Chrome-Regel nie rot werden: `.app-content *` in glass.css raeumt
 * `backdrop-filter` im Scroll-Container mit `!important` ab (gegen den
 * Blank-Screen-Bug #166), und `#main-content` IST `.app-content`. Jeder
 * Nachfahre kommt als `none` heraus, also ist `inMain` fuer nichts wahr - der
 * eingebaute Verstoss der Rot-Probe blieb deshalb gruen.
 *
 * Diese Ebene liest stattdessen das CSSOM: sie sieht, was JEMAND GESCHRIEBEN
 * hat. Ein Glas, das in den Seiteninhalt geschrieben und nur von einer fremden
 * Gegenmassnahme neutralisiert wird, ist der Verstoss, den die Regel meint - er
 * wirkt in dem Moment, in dem das Element aus `.app-content` wandert oder die
 * Compositor-Regel faellt. Beide Ebenen zusammen: die eine wacht ueber den
 * Effekt, die andere ueber die Absicht.
 */
async function declaredGlassInMain(page) {
  return page.evaluate(() => {
    const selectors = new Set();
    const walk = (rules) => {
      for (const rule of rules) {
        // Wie in glassBackedSurfaces: `rule.cssRules` ist seit CSS Nesting kein
        // Verzweigungskriterium, jede CSSStyleRule traegt eine leere Liste.
        if (rule.cssRules?.length) { walk(rule.cssRules); continue; }
        if (!rule.style || !rule.selectorText) continue;
        // Ueber cssText und nicht ueber rule.style.backdropFilter: die App
        // schreibt den Blur als TOKEN (`backdrop-filter: var(--blur-md)
        // saturate(120%)`), nie als Literal. Ein Muster auf `blur(Npx)` fand
        // deshalb null Regeln - der Reichweiten-Nachweis unten hat genau das
        // beim ersten Lauf gemeldet.
        const declared = /backdrop-filter:\s*([^;}]+)/i.exec(rule.cssText)?.[1] ?? '';
        if (/^\s*none\s*$/i.test(declared)) continue;          // das Abraeumen selbst
        const viaToken = /var\(\s*--blur-/.test(declared);
        const viaLiteral = [...declared.matchAll(/blur\(\s*([\d.]+)px\s*\)/g)].some((m) => Number(m[1]) > 0);
        if (!viaToken && !viaLiteral) continue;                 // u.a. blur(0px)
        selectors.add(rule.selectorText);
      }
    };
    for (const sheet of document.styleSheets) {
      try { walk(sheet.cssRules); } catch { /* fremde Herkunft - hier gibt es keine */ }
    }

    const main = document.querySelector('#main-content');
    const out = [];
    for (const selector of selectors) {
      let hits = [];
      try { hits = [...document.querySelectorAll(selector)]; } catch { continue; }
      // Das Abraeum-Ziel selbst ist kein Verstoss: `.app-content` traegt die
      // Regel, es liegt nicht IN ihr.
      if (main && hits.some((el) => el !== main && main.contains(el))) out.push(selector);
    }
    return { selectorsSeen: selectors.size, offenders: out };
  });
}

async function glassSurfaces(page) {
  return page.evaluate(() => {
    const path3 = (el) => {
      const parts = [];
      for (let n = el; n && n.nodeType === 1 && parts.length < 3; n = n.parentElement) {
        let s = n.tagName.toLowerCase();
        if (n.id) { parts.unshift(`${s}#${n.id}`); break; }
        const cls = (typeof n.className === 'string' ? n.className : '').trim().split(/\s+/).filter(Boolean).slice(0, 2);
        if (cls.length) s += `.${cls.join('.')}`;
        parts.unshift(s);
      }
      return parts.join(' > ');
    };
    const main = document.querySelector('#main-content');
    const out = [];
    for (const el of document.querySelectorAll('*')) {
      const cs = getComputedStyle(el);
      const bf = cs.backdropFilter && cs.backdropFilter !== 'none' ? cs.backdropFilter : cs.webkitBackdropFilter;
      if (!bf || bf === 'none') continue;
      const r = el.getBoundingClientRect();
      if (r.width < 2 || r.height < 2) continue;
      if (cs.visibility === 'hidden' || cs.display === 'none') continue;
      // Ein Blur mit einem Wert > 0 - `blur(0px)` ist der abgeschaltete Zustand
      // und kein Verstoss.
      const blur = [...bf.matchAll(/blur\(\s*([\d.]+)px\s*\)/g)].map((m) => Number(m[1])).filter((v) => v > 0);
      out.push({
        sel: path3(el),
        inMain: Boolean(main && main.contains(el)),
        blur: blur.length ? Math.max(...blur) : 0,
        bg: cs.backgroundColor,
      });
    }
    return out;
  });
}

test('Sonde 12 - Glas sitzt auf Chrome, nie im Seiteninhalt', async () => {
  const findings = [];
  const declaredFindings = [];
  const seen = new Set();
  let declaredSeen = 0;
  for (const device of ['mobile', 'desktop']) {
    const page = await openPage(harness, { device, theme: 'light', locale: 'de' });
    for (const name of sweep('Sonde 12')) {
      await gotoRoute(page, ALL_ROUTES[name]);
      await settleAnimations(page);
      // Ebene 1 - der EFFEKT. Sie bestaetigt heute nur (siehe Kopf): die
      // Compositor-Gegenmassnahme raeumt jeden backdrop-filter im Scrollport ab.
      // Sie bleibt, weil sie die einzige ist, die es merkt, wenn diese Regel faellt.
      for (const g of await glassSurfaces(page)) {
        seen.add(g.sel);
        if (g.inMain) findings.push(`${device}/${name}: ${g.sel}`);
      }
      // Ebene 2 - die ABSICHT. Sie kann rot werden, wo Ebene 1 es nie kann.
      const declared = await declaredGlassInMain(page);
      declaredSeen = Math.max(declaredSeen, declared.selectorsSeen);
      // Ohne Ausnahmen. Die eine, die es hier gab, hatte einen Anlass - der
      // Speed-Dial des Dashboards stand als `.fab-container` im Scrollport - und
      // ist mit ihm entfallen (Folgevorgang zu #634): der Dial ist jetzt eine
      // `.page-fab-group`, `adoptPageFab()` hebt ihn samt Glas in die Shell.
      for (const sel of declared.offenders) declaredFindings.push(`${device}/${name}: ${sel}`);
    }
    await page.close();
  }
  // Eine Sonde, die nichts gesehen hat, darf nicht urteilen - je Ebene einzeln,
  // sonst deckt der Reichweiten-Nachweis der einen die Blindheit der anderen zu.
  assert.ok(seen.size >= 5,
    `Nur ${seen.size} Glasflaechen im Dokument gesehen - Ebene 1 hat nichts gemessen.`);
  assert.ok(declaredSeen >= 5,
    `Nur ${declaredSeen} Regeln mit deklariertem Blur gefunden - Ebene 2 hat nichts gemessen. `
    + 'Traegt das CSSOM die Regeln noch, oder ist die Blur-Schreibweise eine andere?');

  assert.deepEqual([...findings, ...declaredFindings], [],
    'backdrop-filter INNERHALB von #main-content. Glas ist Chrome: Tab-Bar, Sidebar, Sheets, '
    + 'Toast, Datepicker-Popover, FAB samt Backdrop. Inhalte - Karten, Listen, Widgets, Text - '
    + 'sind opak (Die Glas-ist-Chrome-Regel).\n'
    + 'Treffer aus der zweiten Ebene sind DEKLARIERT und heute womoeglich wirkungslos, weil '
    + '`.app-content *` sie mit !important abraeumt - sie wirken, sobald das Element aus dem '
    + `Scrollport wandert oder jene Regel faellt.\n  ${[...findings, ...declaredFindings].join('\n  ')}`);
});

for (const [label, features] of [
  ['reduzierter Transparenz', [{ name: 'prefers-reduced-transparency', value: 'reduce' }]],
  ['erhoehtem Kontrast', [{ name: 'prefers-contrast', value: 'more' }]],
]) {
  test(`Sonde 12 - unter ${label} bleibt keine Glasflaeche durchsichtig`, async () => {
    const page = await openPage(harness, { device: 'mobile', theme: 'light', locale: 'de' });
    const { cdp, applied } = await withMedia(page, [
      { name: 'prefers-color-scheme', value: 'light' },
      ...features,
    ]);
    // Der Zustand wird BELEGT, nicht angenommen: eine Emulation, die still
    // nicht greift, macht diese Sonde gruen und blind zugleich.
    assert.ok(applied.every(Boolean),
      `Der Medienzustand liegt nicht an (${JSON.stringify(applied)}) - die Sonde misst den Normalfall.`);

    const findings = [];
    let blurred = 0;
    let backed = 0;
    for (const name of sweep('Sonde 12')) {
      await gotoRoute(page, ALL_ROUTES[name]);
      await settleAnimations(page);
      // (1) KEIN wirksamer Blur mehr - ueber alles, was `backdrop-filter` traegt.
      for (const g of await glassSurfaces(page)) {
        blurred += 1;
        if (g.blur > 0) findings.push(`${name}: ${g.sel} traegt weiter blur(${g.blur}px)`);
      }
      // (2) Und die Flaechen, deren GRUND ein Glas-Token ist, sind opak.
      for (const g of await glassBackedSurfaces(page)) {
        backed += 1;
        const alpha = parseColor(g.bg)[3];
        if (alpha < 1) {
          findings.push(`${name}: ${g.sel} bleibt durchsichtig (alpha ${alpha.toFixed(2)}) - `
            + 'ohne Blur scheint der Inhalt darunter unverwischt durch');
        }
      }
    }
    await cdp.detach();
    await page.close();

    assert.ok(blurred > 0, 'Keine Glasflaeche gesehen - die Sonde hat nichts gemessen.');
    assert.ok(backed > 0, 'Keine Flaeche mit Glas-Grund gesehen - die CSSOM-Suche greift nicht mehr.');
    assert.deepEqual(findings, [],
      `Die Fallback-Regel kommt im Dokument nicht an (${label}). Das Stylesheet kippt `
      + '--blur-2xs..lg auf blur(0px) und die --glass-bg-* auf --color-surface-Werte; '
      + `gemessen wird, ob das die Flaeche erreicht.\n  ${findings.join('\n  ')}`);
  });
}

/* ────────────────────────────────────────────────────────────────────────────
 * Sonde 13: die Modals - die Formulare der App, die keine Sonde je gesehen hat
 *
 * DIE REICHWEITENLUECKE. Alle zwoelf Sonden davor messen ROUTEN. Ein Modal ist
 * keine Route - es kommt auf Klick, und dort stehen die Formulare: 20
 * unterscheidbare Dialoge mit 2 bis 12 Feldern und 3 bis 17 Knoepfen. Das ist
 * dieselbe Klasse Luecke wie die 23 Settings-Blaetter vor Session 22, nur eine
 * Ebene tiefer - und der Ort, an dem jede neue Funktion ihr Feld einbaut.
 *
 * DER WEG HINEIN IST DER FAB, weil er der einzige app-weite ist
 * (`findPageFab()`, seit #634 in der Shell-Layer). Vier Module haben keinen,
 * der ein Modal oeffnet, und Einstellungen hat gar keinen - die Sonde
 * ueberspringt sie und sagt es im Reichweiten-Beleg, statt sie stillschweigend
 * zu zaehlen.
 *
 * SIE PRUEFT NICHT DIE DOKUMENTSTRUKTUR, und das ist kein Versehen: ein Modal
 * liegt IM Dokument, das seine `h1`, seine `main`-Landmarke und seinen Titel
 * schon hat. Sonde 10 wuerde dort dreimal dasselbe melden. Was im Modal NEU
 * ist, sind Formularfelder, und die haben ihre eigene Regel (WCAG 3.3.2,
 * Level A).
 *
 * DIE ZWEI FILTER SIND DER UNTERSCHIED ZWISCHEN EINEM BEFUND UND 32
 * FEHLTREFFERN. Beim Messen meldete die erste Fassung 32 Felder ohne Label.
 * Keines davon war eines: der Datepicker haelt ein `input[type=date]` mit
 * `tabindex="-1" aria-hidden="true"` vor, das nur den nativen Picker oeffnet,
 * und der Foto-Upload ist ein `.sr-only`-Feld hinter einem Knopf mit
 * `aria-label`. Beide sind fuer die Zugaenglichkeitsschicht unsichtbar und
 * brauchen kein Label. Sonde 10 filtert genau diese zwei seit jeher.
 *
 * DIE REICHWEITE WIRD BELEGT, NICHT GEZAEHLT (die Sonde-10-Lehre): geprueft
 * wird, dass die geoeffneten Modals sich UNTERSCHEIDEN. Zwei Module, die
 * denselben Titel mit derselben Feld- und Knopfzahl liefern, waeren ein
 * Verdacht auf einen Dialog, der ueberall derselbe ist.
 * ──────────────────────────────────────────────────────────────────────────── */

async function openFabModal(page) {
  return page.evaluate(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    // Ein Selektor genuegt seit dem Folgevorgang zu #634: auch der Speed-Dial
    // des Dashboards ist ein `.page-fab` und haengt in der Shell-Layer.
    const fab = document.querySelector('#fab-layer .page-fab, .page-fab');
    if (!fab) return { skipped: 'kein FAB' };
    fab.click();
    await wait(700);
    // Ein FAB oeffnet entweder ein Modal ODER ein Aktionsmenue.
    let panel = document.querySelector('.modal-panel');
    if (!panel) {
      const action = document.querySelector('.fab-action__btn, .fab-actions button');
      if (!action) return { skipped: 'kein Modal und kein Aktionsmenue' };
      action.click();
      await wait(700);
      panel = document.querySelector('.modal-panel');
    }
    if (!panel) return { skipped: 'Aktionsmenue oeffnete kein Modal' };

    const path3 = (el) => {
      const parts = [];
      for (let n = el; n && n.nodeType === 1 && parts.length < 3; n = n.parentElement) {
        let s = n.tagName.toLowerCase();
        if (n.id) { parts.unshift(`${s}#${n.id}`); break; }
        const cls = (typeof n.className === 'string' ? n.className : '').trim().split(/\s+/).filter(Boolean).slice(0, 2);
        if (cls.length) s += `.${cls.join('.')}`;
        parts.unshift(s);
      }
      return parts.join(' > ');
    };
    // Dieselben zwei Ausnahmen wie in Sonde 10 - siehe Sondenkommentar.
    const vis = (el) => {
      if (el.closest('[aria-hidden="true"], .sr-only')) return false;
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      return r.width > 1 && r.height > 1 && cs.visibility !== 'hidden' && cs.display !== 'none';
    };

    const fields = [...panel.querySelectorAll('input:not([type=hidden]), select, textarea')].filter(vis);
    const targets = [...panel.querySelectorAll('button, [role="button"], a[href], input[type=checkbox], input[type=radio], select')].filter(vis);
    const min = window.innerWidth < 768 ? 44 : 24;

    return {
      title: (panel.querySelector('.modal-panel__title, h2, h3')?.textContent || '').trim().slice(0, 40),
      fields: fields.length,
      targets: targets.length,
      unlabelled: fields.filter((el) => {
        const lab = (el.id && document.querySelector(`label[for="${CSS.escape(el.id)}"]`)) || el.closest('label');
        return !lab && !el.getAttribute('aria-label') && !el.getAttribute('aria-labelledby');
      }).map((el) => `${path3(el)} (${el.getAttribute('type') || el.tagName.toLowerCase()})`),
      badRefs: [...panel.querySelectorAll('[aria-labelledby],[aria-describedby],[aria-controls]')].flatMap((el) =>
        ['aria-labelledby', 'aria-describedby', 'aria-controls'].flatMap((attr) => {
          const v = el.getAttribute(attr);
          if (!v) return [];
          const missing = v.split(/\s+/).filter((id) => id && !document.getElementById(id));
          return missing.length ? [`${path3(el)} ${attr}="${missing.join(' ')}"`] : [];
        })),
      small: targets.filter((el) => {
        const r = el.getBoundingClientRect();
        // DAS LABEL IST DAS ZIEL, nicht die Checkbox darin - dieselbe
        // HTML-Beziehung, die Sonde 4 in Session 22 gekostet hat. Ohne sie
        // meldet diese Sonde die vier 20x20-Haken der Mahlzeitentypen im
        // Rezept-Modal, die in einem `label.form-check` ueber die volle
        // Zeilenbreite sitzen. Gesucht wird die BEZIEHUNG (`label.control`),
        // nicht eine Klasse.
        const label = el.closest('label') ?? (el.id ? document.querySelector(`label[for="${CSS.escape(el.id)}"]`) : null);
        const box = label && (label.control === el || label.contains(el)) ? label.getBoundingClientRect() : r;
        const w = Math.max(r.width, box.width);
        const h = Math.max(r.height, box.height);
        return w < min && h < min;
      }).map((el) => {
        const r = el.getBoundingClientRect();
        return `${path3(el)} ${Math.round(r.width)}x${Math.round(r.height)} (min ${min})`;
      }),
    };
  });
}

test('Sonde 13 - die Formulare hinter dem FAB halten dieselbe Grundlage wie die Seiten', async () => {
  const findings = [];
  const shapes = new Set();
  let opened = 0;
  const skipped = [];

  for (const device of ['mobile', 'desktop']) {
    const page = await openPage(harness, { device, theme: 'light', locale: 'de' });
    for (const name of sweep('Sonde 13')) {
      await gotoRoute(page, ALL_ROUTES[name]);
      await settleAnimations(page);
      const r = await openFabModal(page);
      if (r.skipped) { skipped.push(`${device}/${name}: ${r.skipped}`); continue; }
      opened += 1;
      shapes.add(`${device}|${r.title}|${r.fields}|${r.targets}`);
      const at = `${device}/${name} „${r.title}"`;
      for (const f of r.unlabelled) findings.push(`${at}: Eingabefeld ohne Label - ${f}`);
      for (const b of r.badRefs) findings.push(`${at}: ARIA-Verweis ins Leere - ${b}`);
      for (const s of r.small) findings.push(`${at}: Zielgroesse unter dem Minimum - ${s}`);
    }
    await page.close();
  }

  // Die REICHWEITE wird belegt, nicht gezaehlt: eine Sonde, die 22-mal
  // denselben Dialog oeffnet, waere gruen und haette nichts gesehen.
  assert.ok(opened >= 18, `Nur ${opened} Modals geoeffnet (uebersprungen: ${skipped.join(', ')}).`);
  assert.ok(shapes.size >= 16,
    `${opened} Modals geoeffnet, aber nur ${shapes.size} unterscheidbare - die Sonde misst `
    + 'moeglicherweise mehrfach denselben Dialog.');

  assert.deepEqual(findings, [],
    'Befund in einem Modal. Dort stehen die Formulare der App, und bis Session 23 hat sie '
    + 'keine Sonde gesehen - ein Feld ohne Label ist WCAG 3.3.2 (Level A).\n  '
    + findings.join('\n  '));
});

/* ────────────────────────────────────────────────────────────────────────────
 * Sonde 14: ein Icon auf getoentem Grund haelt 3:1
 *
 * DIE LUECKE, DIE PAKET 5 WIRKLICH HAT. Die Akzent-auf-Toenung-Konvention endet
 * mit einem Satz, der bisher auf KEINER Ebene einen Guard hatte: „NUR fuer
 * Text. Icons tragen weiter den vollen Akzent - dort gilt 3:1."
 *
 *   - Ebene 3 (`jede Regel, die Farbe UND Untergrund setzt`) ueberspringt
 *     `color-mix`-Untergruende ausdruecklich, und zu Recht: eine Toenung hat
 *     keinen Untergrund ohne die Flaeche darunter. Das sind 152 Regeln.
 *   - Sonde 2 misst TEXTKNOTEN. Ein `<svg>` hat keine, faellt also heraus.
 *
 * Ein Icon auf einer Toenung SEINER EIGENEN FARBE ist damit der eine Fall, den
 * beide Ebenen einander zuschieben - und es ist derselbe Fall, an dem Sonde 2
 * als „zu milde" notiert ist: die Tab-Bar-Pille traegt ein Icon, gemessen
 * 3.41:1 am Bild gegen 4.20:1 im Baum, also 0,41 Reserve auf die 3:1 fuer
 * grafische Objekte (WCAG 1.4.11). Ein Token-Wechsel rutschte dort unbemerkt
 * darunter, und genau davor schuetzt diese Sonde - nicht an einer Stelle,
 * sondern ueber jedes Icon der App.
 *
 * DIE GESCHWISTER-FLAECHE GEHOERT DAZU, UND NUR HIER. Sonde 2 komponiert die
 * VORFAHRENKETTE; eine Flaeche, die unter dem Icon liegt, ohne es zu enthalten
 * (die gleitende Pille ist ein Geschwister), faellt heraus. Ueber alle Texte
 * gemessen ist diese Signatur unbrauchbar - 221 Fundstellen, und die Mehrzahl
 * ist Glas ueber scrollendem Inhalt, wo es gar keinen festen Untergrund gibt
 * (`.impeccable/redesign-tools/overlap-probe.mjs`). Ueber ICONS ist sie eng:
 * gesucht wird eine Flaeche im SELBEN Container, die das Icon ueberlappt und
 * im Dokument vor ihm steht. Das ist die Bauform der Pille und nicht die einer
 * Bar ueber einem Scrollport.
 *
 * DEAKTIVIERTE UND DEKORATIVE ICONS SIND AUSGENOMMEN, beides Kategorien aus
 * dem Standard: WCAG 1.4.11 gilt fuer Objekte, die INFORMATION tragen, und
 * 1.4.3 nimmt Deaktiviertes aus.
 * ──────────────────────────────────────────────────────────────────────────── */

async function collectIconSamples(page) {
  return page.evaluate(() => {
    const path3 = (el) => {
      const parts = [];
      for (let n = el; n && n.nodeType === 1 && parts.length < 3; n = n.parentElement) {
        let s = n.tagName.toLowerCase();
        if (n.id) { parts.unshift(`${s}#${n.id}`); break; }
        const cls = (typeof n.className === 'string' ? n.className : n.className?.baseVal || '').trim().split(/\s+/).filter(Boolean).slice(0, 2);
        if (cls.length) s += `.${cls.join('.')}`;
        parts.unshift(s);
      }
      return parts.join(' > ');
    };

    // Alle gemalten Flaechen einmal einsammeln - fuer die Geschwister-Frage.
    const painted = [];
    for (const el of document.querySelectorAll('*')) {
      const cs = getComputedStyle(el);
      if (!cs.backgroundColor || cs.backgroundColor === 'rgba(0, 0, 0, 0)') continue;
      const r = el.getBoundingClientRect();
      if (r.width < 2 || r.height < 2) continue;
      if (cs.visibility === 'hidden' || cs.display === 'none') continue;
      painted.push({ el, r, bg: cs.backgroundColor });
    }

    const out = [];
    for (const icon of document.querySelectorAll('svg')) {
      // Dekoratives und Deaktiviertes nimmt der Standard aus.
      if (icon.closest('[aria-hidden="true"] > *') && !icon.closest('button, a[href], [role="button"]')) continue;
      if (icon.closest(':disabled, [aria-disabled="true"], .sr-only, yuvomi-install-prompt')) continue;
      const cs = getComputedStyle(icon);
      if (cs.visibility === 'hidden' || cs.display === 'none' || parseFloat(cs.opacity) < 0.5) continue;
      const r = icon.getBoundingClientRect();
      if (r.width < 6 || r.height < 6) continue;
      // Ein Icon ohne eigene Farbe erbt sie - dann ist es der Textfall, den
      // Sonde 2 schon misst.
      const stroke = cs.stroke && cs.stroke !== 'none' ? cs.stroke : null;
      const fill = cs.fill && cs.fill !== 'none' && cs.fill !== 'rgba(0, 0, 0, 0)' ? cs.fill : null;
      const ink = stroke || fill || cs.color;
      if (!ink) continue;

      // PSEUDOELEMENTE ZAEHLEN MIT. `.item-check` traegt seine gefuellte
      // Kastenflaeche in einem `::before` - das Element selbst hat
      // `background: none`, und eine Sonde, die nur echte Elemente kettet,
      // rechnet dort „weisses Haken auf weiss" (1.00:1) und meldet zwoelfmal
      // einen Verstoss, den es nicht gibt. Dieselbe Falle wie bei Sonde 4, wo
      // `.weather-widget__refresh` seine Trefferflaeche per `::before` dehnt:
      // in dieser App ist ein Pseudoelement regelmaessig der Traeger.
      const layers = [];
      for (let n = icon.parentElement; n; n = n.parentElement) {
        const ncs = getComputedStyle(n);
        for (const pseudo of ['::before', '::after']) {
          const ps = getComputedStyle(n, pseudo);
          if (!ps.content || ps.content === 'none') continue;
          if (!ps.backgroundColor || ps.backgroundColor === 'rgba(0, 0, 0, 0)') continue;
          // Nur was das Icon wirklich unterlegt - ein Pseudoelement daneben
          // (Badge, Punkt, Specular) ist kein Untergrund.
          const pr = { w: parseFloat(ps.width), h: parseFloat(ps.height) };
          if (!(pr.w >= r.width && pr.h >= r.height)) continue;
          layers.push({ bg: ps.backgroundColor, image: ps.backgroundImage });
        }
        layers.push({ bg: ncs.backgroundColor, image: ncs.backgroundImage });
      }

      // Die Geschwister-Flaeche: im selben Container, ueberlappend, im Dokument
      // VOR dem Icon - die Bauform der gleitenden Pille.
      let sibling = null;
      for (const p of painted) {
        if (p.el === icon || p.el.contains(icon) || icon.contains(p.el)) continue;
        if (!(p.r.left < r.right && p.r.right > r.left && p.r.top < r.bottom && p.r.bottom > r.top)) continue;
        if (!(p.el.compareDocumentPosition(icon) & Node.DOCUMENT_POSITION_FOLLOWING)) continue;
        // ENG, und das ist der ganze Zuschnitt: der gemeinsame Vorfahre liegt
        // hoechstens drei Ebenen ueber dem Icon UND die Flaeche ist sein
        // DIREKTES Kind. Das ist die Bauform der gleitenden Pille
        // (`.nav-bottom__items` > `.nav-bottom__indicator` neben
        // `a.nav-item` > `svg`) und nicht die einer Liste unter einem FAB:
        // dort ist der gemeinsame Vorfahre `#app`, und die erste Fassung liess
        // ihn durch, weil sie nur die Tiefe zaehlte und nicht die Bindung. Sie
        // legte daraufhin die Liste UEBER den FAB-Grund und meldete elf
        // Plus-Icons mit „#FFFFFF auf #FFFFFF".
        let depth = 0;
        let common = icon.parentElement;
        while (common && !common.contains(p.el) && depth < 3) { common = common.parentElement; depth += 1; }
        if (!common || !common.contains(p.el) || depth >= 3) continue;
        if (p.el.parentElement !== common) continue;
        sibling = { bg: p.bg, sel: path3(p.el) };
        break;
      }

      out.push({ sel: path3(icon), ink, layers, sibling });
    }
    return out;
  });
}

test('Sonde 14 - ein Icon auf getoentem Grund haelt 3:1', async () => {
  const findings = [];
  let seen = 0;
  let withSibling = 0;

  for (const theme of ['light', 'dark']) {
    for (const device of ['mobile', 'desktop']) {
      const page = await openPage(harness, { device, theme, locale: 'de' });
      const base = parseColor(
        await page.evaluate(() => getComputedStyle(document.documentElement).backgroundColor),
      );
      const pageBase = base[3] > 0 ? composite(base, [255, 255, 255]) : [255, 255, 255];
      for (const name of sweep('Sonde 14')) {
        await gotoRoute(page, ALL_ROUTES[name]);
        await settleAnimations(page);
        for (const s of await collectIconSamples(page)) {
          // Untergrund komponieren - dieselbe Mechanik wie Sonde 2, bis zur
          // ersten deckenden Ebene.
          let opaqueAt = s.layers.length - 1;
          for (let i = 0; i < s.layers.length; i += 1) {
            if (parseColor(s.layers[i].bg)[3] >= 1) { opaqueAt = i; break; }
          }
          let bg = pageBase;
          // DIE GESCHWISTER-FLAECHE LIEGT UNTER DER EIGENEN KETTE, nicht ueber
          // ihr - sie steht im Dokument VOR dem Icon und wird deshalb zuerst
          // komponiert. Die erste Fassung legte sie zuletzt auf und rechnete
          // damit den Grund des Icons weg.
          if (s.sibling) {
            withSibling += 1;
            const sib = parseColor(s.sibling.bg);
            if (sib[3] > 0) bg = composite(sib, bg);
          }
          let unpaintable = false;
          for (let i = opaqueAt; i >= 0; i -= 1) {
            if (/url\(/i.test(s.layers[i].image || '')) { unpaintable = true; break; }
            const layer = parseColor(s.layers[i].bg);
            if (layer[3] > 0) bg = composite(layer, bg);
          }
          if (unpaintable) continue;
          seen += 1;
          const fg = composite(parseColor(s.ink), bg);
          const ratio = contrastRatio(fg, bg);
          if (ratio + 0.005 < 3) {
            findings.push(
              `${name}/${theme}/${device}: ${ratio.toFixed(2)}:1 (soll 3)  ${toHex(fg)} auf ${toHex(bg)}  `
              + `${s.sel}${s.sibling ? `  [ueber ${s.sibling.sel}]` : ''}`,
            );
          }
        }
      }
      await page.close();
    }
  }

  assert.ok(seen >= 200, `Nur ${seen} Icons gemessen - die Sonde hat nichts gesehen.`);
  // Die Geschwister-Ergaenzung ist der Grund, aus dem es diese Sonde gibt.
  // Findet sie keinen einzigen Fall, misst sie dasselbe wie die Vorfahrenkette.
  assert.ok(withSibling > 0,
    'Keine einzige Geschwister-Flaeche gefunden - die Bauform, wegen der Sonde 2 an der '
    + 'Tab-Bar-Pille zu milde urteilt, wird nicht mehr erkannt.');

  assert.deepEqual(findings, [],
    `Icon unter 3:1 auf seinem komponierten Untergrund (WCAG 1.4.11, grafische Objekte; `
    + `${withSibling} davon auf einer Flaeche, die die Vorfahrenkette nicht sieht).\n  `
    + findings.join('\n  '));
});
