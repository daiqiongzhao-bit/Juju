---
name: Yuvomi
description: First-Party-Familienplaner in Apples Liquid-Glass-Sprache, WCAG AA als Invariante
colors:
  accent-indigo: "#4F4DC9"
  accent-indigo-hover: "#4340B8"
  accent-indigo-active: "#3A38A6"
  accent-indigo-dark: "#8A87FF"
  accent-light: "#EEEEFB"
  grouped-bg: "#F2F2F7"
  surface: "#FFFFFF"
  surface-dark: "#1C1C1E"
  surface-3: "#EBEBF0"
  fill-well: "#EBEBF0"
  bg-dark: "#0A0A0C"
  label: "#1C1C1E"
  text-secondary: "#636366"
  text-tertiary: "#68686F"
  text-quaternary: "#8E8E93"
  border: "#E5E5EA"
  border-subtle: "#EBEBF0"
  border-strong: "#D1D1D6"
  ink-on-vivid: "#FFFFFF"
  success: "#1E7B35"
  warning: "#A85D00"
  danger: "#D70015"
  info: "#0663C7"
  module-dashboard: "#4F4DC9"
  module-tasks: "#157F3D"
  module-calendar: "#6D28D9"
  module-meals: "#C2410C"
  module-recipes: "#0C7C5B"
  module-shopping: "#CF236F"
  module-pantry: "#4C7A0F"
  module-notes: "#9D6007"
  module-contacts: "#0969DA"
  module-birthdays: "#CE2A63"
  module-budget: "#0F766E"
  module-split-expenses: "#1975A5"
  module-documents: "#42587E"
  module-housekeeping: "#7C3AED"
  module-health: "#9E1E88"
  module-settings: "#677079"
  module-reminders: "#0E7490"
  module-rewards: "#BA4468"
typography:
  large-title:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Helvetica Neue', 'Segoe UI', Roboto, Arial, sans-serif"
    fontSize: "2.125rem"
    fontWeight: 700
    lineHeight: 1.21
    letterSpacing: "-0.015em"
  title-2:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Helvetica Neue', 'Segoe UI', Roboto, Arial, sans-serif"
    fontSize: "1.375rem"
    fontWeight: 700
    lineHeight: 1.21
    letterSpacing: "-0.015em"
  title-3:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Helvetica Neue', 'Segoe UI', Roboto, Arial, sans-serif"
    fontSize: "1.25rem"
    fontWeight: 600
    lineHeight: 1.3
    letterSpacing: "0"
  headline:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Helvetica Neue', 'Segoe UI', Roboto, Arial, sans-serif"
    fontSize: "1.0625rem"
    fontWeight: 600
    lineHeight: 1.3
  body:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Helvetica Neue', 'Segoe UI', Roboto, Arial, sans-serif"
    fontSize: "1.0625rem"
    fontWeight: 400
    lineHeight: 1.47
  subheadline:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Helvetica Neue', 'Segoe UI', Roboto, Arial, sans-serif"
    fontSize: "0.9375rem"
    fontWeight: 400
    lineHeight: 1.47
  footnote:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Helvetica Neue', 'Segoe UI', Roboto, Arial, sans-serif"
    fontSize: "0.8125rem"
    fontWeight: 500
    lineHeight: 1.21
  micro-label:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Helvetica Neue', 'Segoe UI', Roboto, Arial, sans-serif"
    fontSize: "0.75rem"
    fontWeight: 600
    lineHeight: 1.21
    letterSpacing: "0.05em"
  caption-2:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Helvetica Neue', 'Segoe UI', Roboto, Arial, sans-serif"
    fontSize: "0.6875rem"
    fontWeight: 600
    lineHeight: 1.21
  mono:
    fontFamily: "ui-monospace, 'SF Mono', 'Fira Code', 'Fira Mono', 'Roboto Mono', monospace"
    fontSize: "0.875rem"
    fontWeight: 400
rounded:
  2xs: "2px"
  xs: "4px"
  sm: "10px"
  md: "12px"
  lg: "16px"
  xl: "26px"
  2xl: "32px"
  full: "9999px"
  glass-card: "26px"
  glass-inner: "18px"
spacing:
  0h: "2px"
  1: "4px"
  2: "8px"
  3: "12px"
  4: "16px"
  5: "20px"
  6: "24px"
  8: "32px"
  10: "40px"
  12: "48px"
  16: "64px"
components:
  button-primary:
    backgroundColor: "color-mix(in srgb, var(--active-module-accent, #4F4DC9) 88%, #0D0D0F)"
    textColor: "{colors.ink-on-vivid}"
    rounded: "{rounded.full}"
    padding: "8px 16px"
    height: "48px"
  button-primary-hover:
    backgroundColor: "color-mix(in srgb, var(--active-module-accent, #4F4DC9) 76%, #0D0D0F)"
  button-icon:
    rounded: "{rounded.full}"
    size: "44px"
  segment-active:
    backgroundColor: "var(--module-accent, #4F4DC9)"
    textColor: "{colors.ink-on-vivid}"
    rounded: "{rounded.sm}"
  card:
    backgroundColor: "{colors.surface}"
    rounded: "{rounded.md}"
    padding: "16px"
  row-carrier:
    backgroundColor: "{colors.surface}"
    rounded: "{rounded.lg}"
    padding: "0px"
  inset-well:
    backgroundColor: "{colors.fill-well}"
    rounded: "{rounded.md}"
    padding: "12px"
  input:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.label}"
    rounded: "{rounded.sm}"
    padding: "8px 12px"
    height: "48px"
  fab-glass:
    backgroundColor: "color-mix(in srgb, var(--module-accent, #4F4DC9) 78%, transparent)"
    textColor: "{colors.ink-on-vivid}"
    rounded: "{rounded.full}"
    size: "52px"
  brand-tile:
    backgroundColor: "{colors.accent-indigo}"
    textColor: "{colors.ink-on-vivid}"
    rounded: "{rounded.lg}"
    size: "64px"
---

# Design System: Yuvomi

<!-- Neu aufgezeichnet 2026-08-06 aus dem GEBAUTEN Stand des HIG-Redesigns nach
     Fundament + Rest-Rollout Runde 1-3 und zwei Finish-Review-Durchlaeufen
     (feat/hig-redesign). Quelle der Wahrheit fuer JEDEN Wert: public/styles/tokens.css;
     die Kopf-Abgrenzung steht in public/styles/typography.css, die Buttonform in
     der .btn-Basisregel in public/styles/layout.css. -->

## Direction Contract

Stand bis 2026-08-08 als HTML-Kommentar am Body-Anfang von `public/index.html`
und wurde damit an jeden Browser ausgeliefert. Er gehoert hierher, wo die
uebrigen Designentscheidungen stehen.

**THESIS:** Yuvomi wird zur First-Party-App: der private Familien-Kommandostand
in Apples eigener Sprache. Verweigert wird der Kategorie-Standard (freundlicher
Pastell-Organizer) UND das bisherige Violett-Glas-Hybrid - stattdessen
Plattform-Kanon in voller Treue.

**OWN-WORLD:** Liquid-Glass-Designphilosophie (Lesbarkeit vor Transparenz:
diffuses, sattes Glas, Inhalte opak). SF-Pro-System-Stack, Apple-Typo-Skala
(Body 17, Large Title 34, Footnote 13). Kuehle System-Neutrale (#F2F2F7 grouped
/ Near-Black-Dark mit #1C1C1E-Flaechen). Globaler Tint Apple Indigo #5856D6;
17 Modul-Tints als AA-verifiziertes Apple-Farbvokabular. Glas nur als Chrome
(Tab-Bar, Sidebar, Sheets), Inhalte opak. Kapsel-Controls,
Inset-Grouped-Listen, Feder-Motion.

**STORY:** Ein Familienmitglied oeffnet die App und sie fuehlt sich an, als
waere sie mit dem Geraet ausgeliefert worden: Orientierung in zwei Sekunden,
heute zuerst, jedes Modul ein vertrauter Raum mit eigenem Tint.

**FIRST VIEWPORT:** Dashboard - Large-Title-Gruss, Heute-Programm als
Inset-Grouped-Listen, Glas-Tab-Bar (mobil) / Glas-Sidebar (Desktop), FAB als
getoente Glas-Kapsel.

**FORM:** User-pinned Kanon (Apple HIG, Liquid-Glass-Designphilosophie;
Messlatte Apple-Systemapps + Fantastical), ueberstimmt Kandidat 7 der
Runde-3-Liste.

## Overview

**Creative North Star: "Die First-Party-App"**

Yuvomi fuehlt sich an, als waere die App mit dem Geraet ausgeliefert worden: der private
Familien-Kommandostand in Apples eigener Sprache. Der Kanon ist die Apple Human Interface
Guidelines in der Liquid-Glass-Designphilosophie, in voller Treue; die Messlatte sind
Apple-Systemapps und Fantastical. Verweigert wird der Kategorie-Standard (freundlicher
Pastell-Organizer) ebenso wie das abgeloeste violette Glas-Hybrid. Diese Linie heisst
Lesbarkeit vor Transparenz: Glas ist diffus und satt statt roh-transparent, und es bleibt
striktes Chrome-Material (Tab-Bar, Sidebar, Sheets, FAB); alle Inhalte sind opak.

**Keine Versionsnummer in der Referenzzeile, und das ist eine gepruefte Angabe.** „iOS 27"
stand bis Runde 6 an neun Stellen im Quelltext und war nicht belegbar: die Suche auf
developer.apple.com findet die Liquid-Glass-Linie als **iOS 26 / macOS 26, eingefuehrt auf
der WWDC25** - das ist die Herkunft, und sie steht genau hier, einmal. Eine
Philosophie-Bezeichnung haelt auch, wenn Apple die naechste Fassung veroeffentlicht. Alles
Gebaute stimmt mit der belegten Linie ueberein; die kollabierende Large-Title-Leiste wird
von ihr sogar ausdruecklich bestaetigt. **Das war eine Korrektur der Referenzzeile, keine
Design-Revision.**

Jedes der 17 Module ist ein vertrauter Raum mit eigenem Tint (Apple-Systemapp-Muster:
jede App ihre Farbe), zusammengehalten von kuehlen System-Neutralen, dem System-Font-Stack
und der Apple-Typo-Skala. WCAG AA ist Invariante, nicht Ambition: Apple-Rohwerte, die AA
verfehlen, werden auf ihre Accessible-Variante vertieft (Apples eigenes
Increased-Contrast-Muster); alle Modul-Tints sind gegen ihre realen Hintergruende
verifiziert. Light und Dark Mode sind gleichrangig; die Dark-Architektur laeuft ueber
private Tokens (`--_name`), die oeffentliche Token-API bleibt stabil.

Rollout-Stand: die ganze App steht in der neuen Welt. Runde 1 zog die geteilten Grundlagen
(Glas nur noch Chrome, EINE Segment-Sprache, keine Akzentstreifen, randlose Karten),
Runde 2 das Kasten-in-Kasten-Vokabular samt Traeger-Regel, Runde 3 die Befunde des
Finish-Reviews: die Zeilenlisten-Regel, EINE Buttonform, EIN Toenungsrezept, das
Wetter-Widget als randlose Karte ohne Verlauf, Notizfarben nach der User-Farben-Regel und
die Anmeldeseite als Teil der Welt.

**Runde 6 (2026-08-07) hat die Regeln vollstaendig gemacht, statt neue Flaechen zu
gestalten** - und dabei den Satz gelernt, der ueber ihnen steht: **ein Guard ueber eine
Namensliste deckt keine Regel ab, sondern N Dateien.** Deshalb nennt jede Regel hier ab
sofort die EBENE, auf der sie pruefbar ist: Wert (existiert, statisch), Struktur (aus
deklarativen Quellen wie `ROUTES` abgeleitet, nie aus Dateilisten), Signatur (findet
Kandidaten ueber ihre Bauart im Quelltext, nicht ueber ihren Namen) und Dokument
(`npm run test:document-guards`, im gerenderten Zustand). Gebaut wurden: das Kopf-Fundament
und die Leisten-Regel als Kriterium, die vollendete Buttonform samt Label-Verlust- und
Zielgroessen-Regel, die bezahlten Namensschulden (`.list-row`, `.metric-card`, `.auth-*`),
die Zeilenlisten-Regel in Aufgaben und Agenda - und die Wischsemantik, deren Anlass kein
Konsistenzwunsch war, sondern die eine Stelle der App, an der eine Geste sofort und
endgueltig loeschte.

**Key Characteristics:**
- Plattform-Kanon statt Eigenwelt: Apple HIG, Liquid Glass, System-Font-Stack
- Glas nur als Chrome; Inhalte immer opak (Lesbarkeit vor Transparenz)
- 17 AA-verifizierte Modul-Tints auf kuehlen System-Neutralen
- Apple-Typo-Skala (Large Title 34 / Body 17 / Footnote 13), Kapsel-Controls, Inset-Grouped-Listen
- Eine Kernform fuer Zeilenfolgen: genau ein Traeger, Zeilen als Haarlinien
- Feder-Motion (Overshoot-Easing) fuer Glas-Elemente, dezente Dauern fuer alles andere
- WCAG AA als Invariante in Light UND Dark, inkl. prefers-reduced-transparency- und prefers-contrast-Fallbacks

## Colors

Kuehle Apple-System-Neutrale als Buehne, ein Indigo-Tint als globale Stimme, 17 Modul-Tints
als Orientierungsvokabular; alle Textfarben AA-vertieft. Es gibt keinen chromatischen
Verlauf auf Inhalt - die einzige verbliebene Farbdramatik der App sind die driftenden
Backdrop-Blobs hinter dem Glas (`--lg-blob-opacity` 0.16 light / 0.20 dark, in
reduced-transparency und prefers-contrast auf 0).

### Primary
- **Apple Indigo, AA-vertieft** (`accent-indigo`): der globale Akzent (Apples #5856D6 auf
  5.2:1 gegen Weiss, 4.7:1 gegen den Grouped-Grund vertieft). Brand-Naehe zur violetten
  Bildmarke, ohne das alte Violett zu wiederholen. Dark-Variante ~5:1 auf der dunklen
  Flaeche; Dashboard teilt diesen Wert bewusst als Modul-Tint. Der getoente Zwilling
  `accent-light` (Indigo-Tint 50) traegt Fokus-Glows und Heute-Chips.

### Secondary
- **17 Modul-Tints** (Frontmatter `module-*`): jedes Modul traegt seine eigene Akzentfarbe
  auf Nav-Icons, aktiven Segmenten, Chips und dem FAB. Der Router setzt
  `--active-module-accent` auf `<html>`; Komponenten greifen auf
  `var(--module-accent, var(--color-accent))` zu. Die Kuechen-Gruppe (Mahlzeiten, Rezepte,
  Einkaufen, Vorrat) ist im ROUTING vier Module mit vier eigenen `module:`-Werten und in
  NAVIGATION, AKZENT und STATUSBAR eines; sie teilt den Meals-Tint
  (`--module-kitchen: var(--_module-meals)`) - ein Farbwechsel beim Tabwechsel waere die staerkste
  "du hast den Kontext verlassen"-Botschaft der App; die vier Einzel-Tokens bleiben fuer
  Dashboard-Widgets und Nav-Icons bestehen. Alle Tints sind AA-verifiziert; sieben
  Light-Werte wurden gegen den kuehlen Grouped-Grund nachvertieft (jetzt >=4.55:1 auf bg,
  >=5:1 auf Weiss). Dark Mode kippt auf vivide Hell-Varianten mit dunkler Tinte
  (`--color-ink-on-vivid`).
- **Die Modul-Identitaet lebt in den Elementen, nicht in der Flaeche.** Die PWA-theme-color
  ist app-weit der Seitengrund (#F2F2F7 / #0A0A0C, also `--color-bg`), nicht der Modul-Tint.

### Tertiary
- **Semantik im Apple-Vokabular, AA-vertieft**: Success (Apple Green, 5.1:1), Warning
  (Amber-Braun, bewusst von Danger-Rot getrennt fuer Farbfehlsicht, 4.9:1), Danger
  (Apple Red, 5.4:1), Info (Apple Blue, 5.4:1, getrennt vom Contacts-Tint). Dark Mode:
  vivide Apple-Dark-Werte (#30D158 / #FF9F0A / #FF6961 / #409CFF) mit dunkler Tinte statt
  Weiss; die Toast-Textfarben kippen dafuer ueber eigene Tokens mit.
- **Chart-Serien** (`--chart-series-1..7`): eigene Datenreihen-Palette, bewusst KEINE
  geborgten Modul-Tints (Modulfarben tragen Bedeutung, die in einem Ausgaben-Donut falsch
  waere). Sieben Toene, im Dark aufgehellt auf >=3:1 Grafikkontrast; mehr Segmente werden
  zu "Sonstige" zusammengefasst.
- **Prioritaeten** (`--color-priority-low..urgent`): unveraendert aus dem Bestand, die
  Helligkeits-Trennung (High ~1,8x Urgent) ist farbfehlsicht-verifiziert. Die Badge-Fuellung
  ist immer eine 12-%-Toenung derselben Farbe.

### Neutral
- **Grouped Background** (`grouped-bg` = systemGray6): der App-Grund, Apples Grouped-Muster.
  Dark: Near-Black `bg-dark`.
- **Surface** (`surface`, dark `surface-dark`): Karten, Zellen, Arbeitsflaechen
  (`--color-surface-work` fuer lesbare Arbeitsbereiche, `--color-surface-raised` fuer
  subtile Erhoehung).
- **Inset-Well** (`fill-well` = `--color-surface-3`): die eine erlaubte Fuellung fuer eine
  Kachel INNERHALB einer Karte. Gemessen 1.19:1 light unter Weiss und 1.22:1 dark ueber
  #1C1C1E - in beiden Themes gleich weit abgehoben; Text darauf haelt AA (primary
  14.3/12.5, secondary 5.04/6.30, tertiary 4.65/4.86:1).
- **Label** (`label`): Primaertext. Sekundaer 5.75:1 auf Weiss, Tertiaer >=4.6:1 auf bg
  (auch Placeholder-Farbe), Quartaer nur dekorativ, nie Fliesstext.
- **Kanten** (`border` Standard, `border-subtle` Trenner, `border-strong` Hover): im Dark
  Mode eigenstaendig gesetzt (#3E3E42 / #2E2E31 / #5C5C62), weil die Neutral-Rampe dort zu
  dicht an der Flaechenfarbe liegt. Bekannte, dokumentierte Betreiber-Entscheidung: Kanten
  von Bedienelementen erreichen die 3:1 von WCAG 1.4.11 nicht (gemessen 1.26:1 hell auf
  Surface, 1.13:1 auf dem Grouped-Grund, 1.60:1 dunkel; Zielwert waere #949494), wie Apples
  eigene Grouped-List-Separatoren. Der TEXT-Kontrast ist ueberall ohne Verstoss.

### Named Rules
**Die Pro-Hintergrund-Regel.** AA gilt PRO Hintergrund, nicht pro Farbe. Ein Tint, der auf
Weiss besteht, kann auf dem Grouped-Grund reissen (sieben Modul-Tints taten genau das und
wurden nachvertieft). Jede neue Farb-Flaechen-Paarung wird gegen ihren realen Grund
gemessen, in Light und Dark - nicht geschaetzt und nicht aus einer fremden Palette
uebernommen. Als Guard im Repo steht die Messung in `test/test-document-guards.js`
(Sonde 2 misst den komponierten Kontrast am gerenderten Dokument).

**Die Akzent-auf-Toenung-Regel.** Akzent-TEXT auf akzent-getoentem Grund (Chips, Badges,
Avatare) nutzt `color-mix(in srgb, var(--module-accent) 70%, var(--color-text-primary))`;
bewusst kein Token, weil die Formel dort ausgewertet werden muss, wo `--module-accent`
gilt. Nur fuer Text; Icons tragen den vollen Akzent (dort gilt 3:1).
**Ihre Grenze:** die Formel gilt fuer KURATIERTE Modultoene, nicht fuer frei gewaehlte
Nutzerfarben. An den Enden der Helligkeitsachse bricht sie - weiss auf light 1.92:1,
schwarz auf dark 1.97:1, und selbst der graue Avatar-Fallback #8E8E93 landet bei 4.47:1.
Auf einer Nutzerfarben-Toenung traegt der Text deshalb ein TOKEN
(`--color-text-primary`: 9.3-17.0:1 ueber die ganze Palette und ueber Extremwerte).

**Die User-Farben-Regel.** Frei waehlbare Layer-/User-Farben (Kalender-Layer, Feiertage,
Notizzettel, Avatare) sind nie Textfarbe, nur Border oder Dot; Flaechen-Toenungen daraus
laufen ueber die gemessenen color-mix-Rezepte. Insbesondere traegt eine Nutzerfarbe nie
eine ganze Inhaltsflaeche: die Notizkarte tat das bis Runde 3 mit einer zur Laufzeit
gerechneten Textfarbe und war damit die einzige Stelle, an der die Lesbarkeit an einer
ungemessenen Farbe hing (und im Dark-Theme ein Feld heller Pastellbloecke).

**Die Toenungsskala-Regel** (loest die frühere Ein-Toenungsrezept-Regel ab, Runde 9).
Jede Toenung nimmt eine benannte Stufe aus `tokens.css` (Abschnitt 6b), keine schreibt eine
Zahl. Die alte Fassung sagte „16 %, EIN Rezept, app-weit" und beschrieb damit 23 von 214
gemessenen Stellen; die uebrigen 191 hatten keinen Wert zu greifen und schrieben ihren
eigenen hin - 37 Prozentstufen.

Die sieben Stufen und ihre Rollen: `--tint-wash` (8 %) untergreift FREMDEN Inhalt (Leisten,
Banner, ganze Zeilen, Kalenderfelder); `--tint-state` (12 %) ist ein Zustand auf ungetoenter
Flaeche; `--tint-surface` (16 %) ist die Toenung, die das Element SELBST ist (Chip, Badge,
Icon-Well, Notizkarte, Event-Bar); `--tint-raised` (24 %) ein Zustand darauf; `--tint-hint`
(50 %) eine Andeutung (Kante, Linie, Leerzustands-Icon); `--tint-ink` (70 %) Text auf
getoenter Flaeche; `--tint-shadow` (20 %) ein Schatten daraus.

Die vier Flaechenstufen sind eine LEITER, und ein Zustand steigt eine Sprosse. Die
Unterscheidung wash/surface ist gemessen und keine Stilwahl: die niedrigen Fundstellen sind
im gerenderten Dokument im Median 47.520 px2 gross, die hohen 1.764 px2 - Faktor 27. Eine
Leiste traegt bei 1,11:1 Farbe ins Bild, wo ein 24px-Badge bei demselben Verhaeltnis
verschwindet; 16 % traegt in beiden Themes (1,19-1,41:1 gegen den jeweiligen Grund).

Was KEINE Toenung ist: Deckwerte ab 45 % (die Farbe IST dort die Flaeche und wird
verdunkelt), Nutzerfarben als Text (dort gilt die User-Farben-Regel) und Animationsstufen in
`@keyframes`. Pruefebene: Signatur (`jede Toenung nimmt eine Stufe der Toenungsskala`,
`test:frontend-audit`).

## Typography

**Display/Body Font:** System-Stack (-apple-system, BlinkMacSystemFont, "SF Pro Text",
"Helvetica Neue", "Segoe UI", Roboto, Arial, sans-serif)
**Mono Font:** ui-monospace, 'SF Mono', 'Fira Code', 'Fira Mono', 'Roboto Mono', monospace

**Character:** SF Pro auf Apple-Geraeten, die ehrliche Plattform-Grotesk ueberall sonst.
Keine Webfonts, keine Displayschrift; die Stimme ist die des Betriebssystems. Jede Rolle
ist genau einmal definiert (typography.css); ein Element nimmt sie ueber die
`u-*`-Utility-Klasse oder ueber seinen dort registrierten BEM-Selektor an.

### Hierarchy
Apple-Skala: Large Title 34, Title 2 22, Title 3 20, Headline 17 semibold, Body 17,
Subheadline 15, Footnote 13, Caption 2 11.

- **Large Title** (bold, 34px, lh 1.21, Tracking -0.015em): Seitentitel, Dashboard-Gruss und
  seit Runde 3 auch der Anmelde-Titel; bleibt auf Desktop stabil 34px. Traegt IMMER
  Label-Farbe.
- **Title 2** (bold, 22px, Tracking -0.015em, `text-wrap: balance`): Modul-Kopf-Titel im
  Canonical Page Head - EINE Rolle fuer alle Module, Settings-Leaf und Split.
- **Title 3** (semibold, 20px, lh 1.3): Bereichs-Ueberschrift in Satzschreibung.
- **Headline** (semibold, 17px, lh 1.3): Karten-/Item-Titel. Die Dichte-Variante
  (`.u-compact`, 15px) macht hohe Informationsdichte zur bewussten Entscheidung statt zum
  Groessen-Override pro Selektor.
- **Body** (regular, 17px, lh 1.47 = Apples 17/25): Fliesstext, Listenzellen.
- **Subheadline** (regular, 15px): Sekundaerzeilen.
- **Footnote** (medium, 13px, lh 1.21): Metazeilen, Label ueber Feldern, das Versal-Datum
  ueber dem Gruss.
- **Versal-Mikro-Label** (semibold, 12px, Tracking 0.05em, uppercase): der Sektionskopf
  einer Grouped-Liste. 0.05em (`--tracking-label`) ist der EINE Tracking-Wert und hat sechs
  gestreute Werte abgeloest.
- **Caption 2** (semibold, 11px): Badges, Zaehler.
- **Navigations-Gruppierungslabel** (semibold, 12px, Satzschreibung): Sidebar-Sektionen,
  Settings-Domaenen, Aufgaben-Gruppen. Ganze Phrasen lesen in Versal + Tracking geschrien
  und laufen dem warmen Familien-Ton zuwider.
- Inputs nie unter 16px (`--text-base`, iOS-Zoom-Schwelle). Display-Stufen 48/72px existieren
  NUR fuer Anzeigewerte auf dem Wandtablet, nie fuer Ueberschriften; die
  Ueberschriften-Skala endet bewusst bei 34px.

### Named Rules
**Die Kopf-Abgrenzungs-Regel.** Zwei Kopfrollen, und was ein Kopf benennt entscheidet
welche: benennt er einen BEREICH der Seite ("Heute wichtig", "Punktestaende", "Nach
Kategorie", "Transaktionen"), ist er eine Ueberschrift in Satzschreibung. Wiederholt er
sich mit wechselndem Wert ueber EINE Liste (Kategorie in Kontakten, Mahlzeitentyp im
Wochenplan, Monat in einer Chronik), ist er ein Versal-Mikro-Label. Nicht der Traeger
entscheidet, sondern das Benannte. Ausgeschrieben in typography.css.

**Die Leisten-Regel.** Ob ein Seitentitel ueber einer Leiste steht, entscheidet der
`module:`-Wert der Zielroute (`ROUTES` in `router.js`). Wechselt die Leiste ihn, ist SIE die
Kopf-Navigation und traegt keinen Titel ueber sich - der Tab-Name IST der Modulname (Kueche:
vier eigenstaendige Module unter einer Leiste). Wechselt sie ihn nicht, oder wechselt sie gar
keine Route, gehoert sie unter den Large Title in den kanonischen `page-toolbar`-Kopf
(Gesundheit, Budget, Belohnungen, Haushaltshilfe). Sektionen mit eigener Shell
(Einstellungen) fuehren ihren Titel in ihrem eigenen Kopf; das ist der dritte Fall der Regel,
keine Ausnahme von ihr - als Ausnahme stuende er beim achtzehnten Modul wieder offen.

Nicht die Bauart entscheidet: `renderSubTabs` gegen `wireTablist` ist eine
Implementierungswahl, und bei der Gesundheit faellt beides auseinander - ihre Tabs sind echte
Routen und tragen trotzdem alle `module: 'health'`. Sie war deshalb bis Runde 6 das einzige
Modul mit Sichtwechsel ohne Seitentitel. An der Stelle, die das haette beantworten muessen,
stand „aus Layout-Gruenden": eine Beobachtung, kein Kriterium. Liegt die Leiste IM Kopf, gibt
sie dessen Rail-Verhalten ab (Sticky, Grund, Trennlinie, Hoehe) - derselbe Satz wie beim
Well: der Traeger entscheidet.

**Die Keine-sichtbare-Titelwiederholung-Regel.** Traegt eine Leiste den Namen eines Panels
bereits - Sub-Tabs in Gesundheit, die Navigation in den Einstellungen -, dann benennt eine
Ueberschrift direkt darunter keine Ebene, sondern verdoppelt Information. Alle sechs
Gesundheits-Panels taten das wortgleich ("Uebersicht" ueber "Uebersicht"), fuenf
Settings-Blaetter zuvor ebenso. Unsichtbar (`.sr-only`) darf und soll die Ueberschrift
stehen bleiben: sie haelt die Dokumentgliederung zwischen dem `h1` des Moduls und den `h3`
der Abschnitte, und ein `role="tabpanel"` traegt denselben Namen ohnehin im `aria-label`.
Verboten ist nur, sie zu ZEIGEN.

Dasselbe gilt eine Ebene tiefer: ein Abschnitt, der heisst wie sein Panel, benennt sich
gegen seine Geschwister nicht ("Medikamente" neben "Heute faellig" wurde "Alle
Medikamente"). Der Guard prueft JEDES Modul, das eine Leiste rendert, und leitet Leiste wie
Ueberschriften aus dem Markup ab. Zwei Vorfassungen waren Dateilisten: die erste kannte nur
die Einstellungen, die zweite nahm die Gesundheit dazu - eine Allowlist mit zwei Eintraegen.
Der erste Lauf der Regel fand sofort, was beide uebersahen: das Budget zeigte einen Tab
„Budget" unter dem Titel „Budget". Aufgeloest wurde das ueber den TAB, nicht ueber den Titel
(„Uebersicht") - das Budget hat sieben Tabs, von denen einer zufaellig den Modulnamen trug.

**Die Label-Farben-Regel.** Large Titles tragen immer `--color-text-primary`; kein
Gradient-Text und kein Akzent-Titel (beides gehoerte zur abgeloesten Welt; die Tageszeit
spricht allein ueber den Grusstext, die Marke allein ueber das Tile).

**Die Echte-Information-Regel.** Die Versal-Footnote ueber dem Large Title (Apple-News-
Muster, z. B. das Intl-formatierte Datum im Dashboard-Masthead) ist echte Information und
Kanon-Bestandteil. Dekorative Kicker und Eyebrows ohne Informationswert bleiben verboten;
die generische Opt-in-Klasse dafuer ist mit dem Rollout entfallen, weil ihr Name zur
Rueckkehr des Musters einlud.

## Layout

- **Grund-Raster:** 4px (`--space-1` = 4px bis `--space-16` = 64px). Content-Spalte max
  1280px (`--content-max-width`), schmale Lesespalte 720px (`--content-max-width-narrow`).
- **Seiten-Gutter:** ein kanonischer Wert `--page-gutter` (16px, ab 1024px 32px), damit
  Kopf und Inhalt dieselbe Fluchtlinie haben. Full-Bleed-Koepfe ruecken ihren Inhalt per
  `--page-inline-pad` auf die zentrierte Spalte - genau EINMAL pro Ahnenkette, sonst
  addieren sich die Raender (Guard `page-inline-pad contract`).
- **Breakpoints, verbindlich:** <=640 Mobile (eine Spalte, Bottom-Nav), 768 Tablet,
  >=1024 Desktop (Sidebar, mehrspaltig), >=1440 Wide. Komponenten-interne Umbrueche
  gehoeren in @container-Queries, nicht in neue Viewport-Breakpoints.
- **Navigation:** mobil eine schwebende Glas-Tab-Bar-Kapsel (60px hoch plus 8px Luft und
  safe-area; die Bar-Zone selbst ist transparent, das Glas traegt die Kapsel). Ab 1024px
  Glas-Sidebar (56px kollabiert / 220px expandiert) mit gleitender Aktiv-Pille.
- **Touch-Targets:** `--target-base` 44px auf Zeigergeraeten, waechst via
  `@media (hover: none)` auf 48px. Das Kriterium ist die Zeigerfaehigkeit, nicht die Breite;
  die 44pt der iOS-HIG sind ein Minimum, kein Ziel.
- **FAB-Geometrie:** 52px mobil, 48px ab Desktop; `--fab-safe-zone` verkuerzt den
  Scrollport, sodass unter dem FAB nie Inhalt durchlaeuft. Der FAB lebt in der Shell-Layer
  `#fab-layer`, nicht im Scrollport.
- **Icon-Stufen:** genau vier (12/16/20/24px, `--icon-sm..xl`); Lucide bleibt das Icon-Set,
  keine Glyphen-Fonts.
- **Motion:** Dauern kanonisch 80-400ms (`--duration-2xs..2xl`), immer in ms. `--ease-out`
  cubic-bezier(0.16,1,0.3,1) fuer Einblendungen; Feder mit Overshoot `--ease-glass`
  cubic-bezier(0.34,1.56,0.64,1) fuer Glas-Elemente; die Sidebar-Pille bekommt die sanftere
  Feder `--ease-sidebar-glide`, damit sie nicht ueber das Ziel-Item hinausschiesst.
  prefers-reduced-motion schaltet Signature-Animationen ab.
- **Scroll-Affordanz:** horizontal scrollende Leisten (Chip-Reihen, Filterzeilen) tragen
  eine Fade-Mask an der ueberlaufenden Kante (`has-fade-start`/`has-fade-end`, gesetzt von
  `wireScrollFade`) und 24px `scroll-padding-inline`, damit das erste sichtbare Element nicht
  an der Kante klebt.

## Elevation & Depth

Hybrid aus zurueckhaltenden, kuehlen iOS-Schatten fuer opake Inhalte und Glas-Material fuer
Chrome. Tiefe entsteht primaer ueber Material (Blur + Transluzenz + Specular-Kanten), nicht
ueber dramatische Schatten. Dark Mode verstaerkt die Schatten deutlich (Glas braucht dort
mehr Trennung vom Near-Black-Grund).

### Shadow Vocabulary
- **shadow-xs** (`0 1px 2px rgba(0,0,0,0.08)`): kleinste Abhebung.
- **shadow-sm** (`0 1px 2px rgba(0,0,0,0.04), 0 2px 6px rgba(0,0,0,0.04)`): Karten und
  Zeilen-Traeger in Ruhe.
- **shadow-md** (`0 2px 10px rgba(0,0,0,0.08), 0 1px 2px rgba(0,0,0,0.04)`): Dropdowns,
  Hover, Marken-Tile.
- **shadow-lg** (`0 8px 28px rgba(0,0,0,0.12), 0 2px 6px rgba(0,0,0,0.04)`): Modals, FAB.
- **shadow-xl** (`0 18px 56px rgba(0,0,0,0.18), 0 4px 12px rgba(0,0,0,0.06)`): hoechste Ebene.
- **glass-shadow-sm/md/lg**: Glas-Varianten mit eingebautem 1px-Weiss-Ring
  (z. B. `0 6px 24px rgba(0,0,0,0.10), 0 0 0 1px rgba(255,255,255,0.50)`). Ausnahme: die
  schwebende Tab-Bar-Kapsel traegt einen eigenen dunklen Halt, weil der weisse Ring auf dem
  hellen Grouped-Grund unsichtbar ist und die Kapsel sonst formlos schwimmt.
- **Specular-Insets**: `--glass-inset-soft..strong` (inset 0 1px 0 Weiss 0.18-0.32) als
  Oberrand-Lichtkante, komplementaer `--glass-inset-bottom-*` (dunkler Unterrand).
  `--glass-sheen` ist der gethemte Flaechen-Lichtfang der oberen Kapselhaelfte (light 0.35,
  dark bewusst nur auf 0.16 abgesenkt statt auf die 0.09 der Kanten-Highlights, damit
  getoentes Glas im Dark-Theme von einer opaken Flaeche unterscheidbar bleibt).

### Named Rules
**Die Glas-ist-Chrome-Regel.** backdrop-filter existiert nur auf Chrome-Elementen:
Tab-Bar-Kapsel, Sidebar, Sheets/Modals, Toast, Datepicker-Popover, FAB samt seinem
Backdrop und seinen Aktionen. Inhalte - Karten, Listen, Widgets, Text - sind opak.
Blur-Stufen kanonisch 2/6/10/20/32px (`--blur-2xs..lg`).

**Der Modulkopf traegt KEIN Glas, und das ist eine begruendete Abweichung vom Kanon, keine
Auslassung.** Die belegte Liquid-Glass-Linie fuehrt Navigationsleisten transparent; Yuvomi
stellt den Kopf nahtlos und opak auf den Seitengrund (`--color-bg`). Zwei Gruende, beide
gemessen: die kollabierende Large-Title-Leiste lebt davon - Glas zeigte am Scroll-Anfang
eine Flaeche, wo gerade keine sein soll, und haette die gewonnene Ruhe wieder aufgehoben -
und `position: sticky` plus `backdrop-filter` in einem `overflow: auto`-Container leert auf
iOS 26+ den ganzen Scrollport (WebKit-Compositor-Bug, der Kommentar steht an der Regel).
Der Guard `Der Modulkopf traegt kein Glas, und das bleibt so` haelt sie: er lernt die
Kopf-Klassen aus dem Markup, damit auch ein Modul auffaellt, das seiner EIGENEN Kopfklasse
Glas gaebe. Der letzte Rest der alten Annahme - ein
`prefers-reduced-transparency`-Fallback fuer fuenf Modul-Koepfe, der ein backdrop-filter
abschaltete, das keiner mehr trug, und sie dabei auf `--color-surface` umfaerbte - ist mit
Runde 6 entfallen.

**Die Fallback-Regel.** Jede Glas-Flaeche hat einen opaken Fallback. Nicht-Blur-Stile
(background, border, shadow) stehen AUSSERHALB von `@supports` und wirken ueberall; nur der
backdrop-filter steht drin (mit webkit-Zwilling fuer Safari < 18). prefers-reduced-
transparency kippt alle Glas-Tokens auf `--color-surface`-Werte und alle Blur-Stufen auf 0;
prefers-contrast: more haertet Kanten auf Textfarben, schaltet Blur und Backdrop-Blobs ab
und hebt den Notes-Tint auf 6.3:1.

## Shapes

Apple-Kurvatur, durchgehend gerundet, nie scharfkantig: Formfelder und Zellen 10px
(`--radius-sm`), Karten 12px (`--radius-md`), Zeilen-Traeger und grosse Flaechen 16px
(`--radius-lg`), Sheets und Glas-Chrome 26px+ (`--radius-xl`, `--radius-glass-card` 26 /
`--radius-glass-inner` 18), Kapseln und Pillen `--radius-full` (Tab-Bar-Kapsel, FAB, Chips,
ALLE Buttons). Sheets runden oben (`var(--radius-xl) var(--radius-xl) 0 0`). Ein
border-radius wird ausschliesslich ueber ein Radius-Token oder eine Prozentangabe gesetzt
(Guard in test-frontend-audit.js).

**Die Konzentrik-Regel.** Verschachtelte Rundungen sind konzentrisch: der innere Radius ist
der aeussere minus Abstand, ausgeschrieben als `calc(var(--radius-*) - Npx)` bzw. `+ Npx`
fuer Umhuellungen (belegt in tasks.css, documents.css, health.css). Nie denselben Radius
blind nach innen kopieren.

## Components

### Buttons
- **Shape:** die Kapsel (`--radius-full`) in der `.btn`-Basisregel, min-height 48px, Padding
  8px 16px, Label 14px medium. EINE Form fuer ALLE Varianten - primary, secondary, ghost,
  danger, icon, icon-sm. Bis Runde 3 stand `--radius-md` in der Basisregel, waehrend
  glass.css primary/secondary auf `--radius-full` zog: welche Form ein Button bekam,
  entschied die Ladereihenfolge. Die Kapsel gewinnt, weil der Direction Contract
  "Kapsel-Controls" ausdruecklich nennt.
- **Primary:** Modul-Akzent leicht abgedunkelt (88-%-Mix mit `--neutral-950`) mit
  `--color-ink-on-vivid` (light weiss, dark dunkle Tinte) und shadow-sm plus
  Specular-Inset. Auf modullosen Routen (Login, Setup) faellt der Akzent auf Indigo zurueck.
- **Hover:** vertieft auf 76-%-Mix, shadow-md, Transitions 150ms.
- **Fokus (app-weit):** 2px-Ring in `--focus-ring-color`
  (= `var(--active-module-accent, var(--color-accent))`), Offset 2px. Die zwei Zeilen werden
  ausgeschrieben, kein Shorthand-Token: ein Shorthand auf `:root` baeckt die Farbe ein und
  lokale Ueberschreibungen blieben wirkungslos. `--focus-ring-offset-inset` (-2px) ist nur
  fuer Elemente an einer geclippten Kante da.

**Die Eine-Buttonform-Regel.** Es gibt genau eine Buttonform, und sie steht genau an einer
Stelle. Der Guard `one button shape app-wide` prueft die Kapsel in der `.btn`-Basisregel und
verbietet JEDER weiteren Regel mit einer `.btn`-Variante im Selektor, einen border-radius zu
setzen. `--radius-glass-button` ist entfallen, weil ein eigener Token nahelegte, es gaebe
daneben noch eine zweite, nicht-glaeserne Buttonform.

**Die Regel gilt auch fuer Knoepfe, die keine `.btn` sind.** Ein Guard, der eine KLASSE
sucht, findet nur, wer sie schon traegt - und blind blieben ausgerechnet die drei Knoepfe,
die das Problem waren: "Aktuell" (Budget), "Heute" (Kalender) und "Heute" (Wochenplan)
beanspruchten `.btn` nie und standen deshalb in drei Formen und zwei Farbgrammatiken
nebeneinander, obwohl sie dieselbe Funktion tragen. Der Budget-Knopf war Deklaration fuer
Deklaration eine `.btn--secondary`, nur mit `--radius-sm` statt der Kapsel. Wer die
Grammatik einer geteilten Variante braucht, nimmt die KLASSE. Der Guard prueft das seit
Runde 5 ueber die SIGNATUR der Variante (ihre Kante `--color-border` plus ihre Tinte im
Modul-/App-Akzent), nicht ueber ihren Namen.

**Der Geltungsbereich ist positiv formuliert (Runde 6, Phase 3).** Er stand vorher als zwei
Negativlisten da und liess im gerenderten Dokument 41 Knoepfe ausserhalb - darunter
`.row-action`, die zweithaeufigste Buttonform der App, eine geteilte Shell-Klasse in sechs
Modulen, direkt neben Kapsel-Knoepfen im selben Kopf. Der Wortlaut:

> Es gibt EINE Buttonform: die Kapsel. Sie gilt fuer jedes Element, das eine Aktion
> ausloest und eine eigene Flaeche oder Kante traegt. Bei einem quadratischen Icon-Knopf
> ist die Kapsel ein Kreis.
> Ausgenommen sind Zustandsschalter (Checkbox, Toggle, Segment, Wochentagswaehler),
> Drop-Ziele, Zellen eines Rasters und ZEILEN einer Zeilenliste.
> Die Ausnahme ist eine Liste von KATEGORIEN, keine Liste von Selektoren.

**Die vierte Kategorie ist neu und keine neue Idee.** Eine ZEILE ist kein Kasten - das
sagt das Kasten-in-Kasten-Vokabular seit Runde 5 und die Zeilenlisten-Regel seit Runde 6.
Ihre Hervorhebung (Hover, Auswahl, Rang) folgt der Form ihres Traegers, nicht der eines
Knopfes; deshalb behalten `.rewards-widget-row`, `.rw-standing__id` und
`.meal-slot__add-more-btn` ihre Form. Ein Knopf IN einer Zeile ist davon nicht gedeckt:
`.row-action` ist rund. Wer die Kategorie nicht nennen kann, traegt die Kapsel.

**Geprueft auf zwei Ebenen, weil eine sie nicht traegt.** Im Stylesheet steht weder Tag
noch Rolle; was dort scharf ist, ist die Form eines umgrenzten Ziels. Ebene 3
(`ein quadratischer Icon-Knopf ist ein Kreis`, test-frontend-audit.js) prueft deshalb alle
Regeln mit gleicher Breite und Hoehe und fuehrt die Ausnahmen mit ihrer Kategorie. Ebene 4
(Sonde „Buttonform", test-document-guards.js) prueft den Rest im gerenderten Dokument, wo
Tag, Rolle und Nachbarschaft bekannt sind.

Zwei Einzelfaelle sind dabei mit erledigt: `.dashboard .weather-widget__refresh` hat seine
`border-radius`-Zeile verloren (sie ueberschrieb die Kapsel der Basisregel 1455 Zeilen
spaeter mit 0-2-0, direkt unter einem Kommentar, der vor genau dieser Spezifitaetsfalle
warnt), und `.cal-toolbar__view-btn` traegt jetzt die konzentrische Formel
`calc(var(--radius-sm) - 2px)` statt `--radius-xs` - sein Traeger ist deklarationsgleich
mit dem von `.group-toggle__btn`, das sie schon trug.

**Die Label-Verlust-Regel (Runde 6, Phase 3b).** Verliert ein beschriftetes Bedienelement
sein Label - weil der Viewport schmal wird oder weil es in seiner Icon-only-Variante steht -,
dann wechselt es in die Icon-Form seiner Familie, **behaelt die Zielgroesse `--target-base`**
und traegt seinen Zustand ueber getoente Flaeche PLUS gefuelltes Icon. Nie ueber die Kante
allein: eine Kante liest niemand als „eingeschaltet".

Der Kern ist die Zielgroesse: **ein Label zu verlieren darf ein Ziel nie verkleinern.** Genau
das war der Bestand, und zwar viermal mit vier eigenen Antworten - `.cal-toolbar__mine-btn`
schrumpfte unter 640px vom beschrifteten Chip auf 28x28, `.birthdays-toolbar__import` zog nur
seinen Innenabstand zusammen und blieb als 50x48-Oval in einer Form zurueck, die es sonst
nirgends gibt, `.perm-seg__opt` stand als Icon-Segment auf 34x30, und allein
`.documents-dms-link-btn` machte es richtig. Alle vier messen jetzt `--target-base`
(auf Touch `--target-lg`).

NICHT geregelt ist, WANN ein Label faellt: das entscheidet die Leiste, in der das Element
steht, denn es haengt daran, was sonst noch in ihr liegt. Kalender und Geburtstage geben ihr
Label bei 640px ab, die Dokumente bei 768px, und die Einstellungen genau umgekehrt - dort
faellt es auf dem BREITEN Viewport, weil am Zeiger der Tooltip die kompaktere Antwort ist.
Geregelt ist nur, was dann passiert.

**Geprueft auf Ebene 3** (`wer sein Label verliert, bleibt ein volles Ziel`,
test-frontend-audit.js): der Guard sucht die SIGNATUR des Label-Verlusts - eine Regel, die
ein `span` oder ein `__label`/`__text`/`__name`-Element auf `display: none` setzt - und
verlangt vom Traeger im SELBEN At-Block beide Achsen als Zielmass. Wer klickbar ist, kommt
dabei aus dem Markup (`<button>`, `role="button"`, `.btn`), nicht aus dem Klassennamen: die
erste Fassung fragte nur nach `cursor: pointer` und nach Namen auf `-btn` und war damit blind
fuer jeden Knopf, der seine Klickbarkeit von `.btn` erbt und sich nach seiner Funktion nennt.

**Die Zielgroessen-Regel (Runde 6, Phase 3c).** **Eine Reihe traegt ihre Dichte gemeinsam, ein
Einzelziel muss allein treffbar sein.** Daraus folgen genau zwei Faelle:

- **Freistehend** - kein gleichartiges Ziel engt es ein. Es haelt die Zielgroesse seiner
  Gerätewelt (`--target-md` am Zeiger, `--target-lg` am Finger; `--target-base` liefert
  beides) in **mindestens einer Achse** und erfuellt in der anderen WCAG 2.5.8.
- **In einer Reihe** - ein anderes Ziel, das mindestens eine Klasse mit ihm teilt, steht
  weniger als 16px entfernt. Fuer es gilt allein WCAG 2.5.8: 24x24, oder kein anderes
  Zielzentrum naeher als 24px.

Das Kriterium ist die **Einengung**, nicht die Anzahl: ein Ziel in einer Reihe kann nicht
wachsen, ohne seinen Nachbarn zu verdraengen - genau deshalb darf es dicht sein. Ein
freistehendes Ziel hat den Platz und keine Ausrede. Dieselbe Antwort gibt Fitts: ein
isoliertes Ziel wird einzeln angesteuert und braucht seine Flaeche; ein Ziel in einer Reihe
wird im Kontext angesteuert, und Vergroessern kostet dort die Uebersicht. Und die Einengung
ist eine Eigenschaft des **Bauteils**, nicht der Instanz - ein Tagfilter an einer Aufgabe mit
nur einem Tag steht allein da und bleibt ein Reihen-Bauteil.

**Keine Namensliste fuer Dichte.** Die Spacing-Ausnahme des Standards deckt jeden bewusst
dichten Fall mechanisch ab - gemessen: Monatsraster-Chips (Zentrumsabstand 31,5),
Aufgaben-Tagfilter (29,3), Sidebar-Umschalter (31,5). Die Ausnahmeliste des Guards ist leer.

**Gemessen wird die TREFFERFLAECHE, nicht die Box.** `.weather-widget__refresh` ist 34x34
gross und dehnt seine Flaeche per `::before` auf `--target-base` aus; eine Box-Messung meldet
ihn als Verstoss, obwohl der Finger 44px findet. Das ist zugleich das Rezept fuer „kompakt
aussehen, voll treffen".

**Die Groesse des Icon-Knopfs gehoert der Shell.** `.btn--icon` nimmt `--target-base` und
schaltet damit ueber `(hover: none)`. Vorher schaltete es ueber `@media (min-width: 1024px)`,
also nach der Breite - ein Tablet ab 1024px bekam 40px, und Aufgaben wie Abonnements hatten
den Shell-Fehler je fuer sich lokal repariert. Derselbe Kopf-Icon-Knopf mass dadurch 40px in
Kalender und Kontakten und 44px in Aufgaben und Dokumenten.

**Geprueft auf zwei Ebenen, weil es zwei Zusagen sind.** Die Zielgroessen-Regel haengt an
Nachbarschaft und Trefferflaeche und ist nur im Dokument pruefbar (**Ebene 4**, `Sonde 4` in
test-document-guards.js, beide Geraetewelten). Die Besitzfrage des Icon-Knopfs steht dagegen
offen im Stylesheet und waere im Dokument unsichtbar, weil beide Antworten die
Zielgroessen-Regel halten (**Ebene 3**, `die Groesse des Icon-Knopfs gehoert der Shell`).

### Segmented Controls
- **EINE Sprache shell-weit:** aktives Segment = Modul-Akzent gefuellt
  (`var(--module-accent, var(--color-accent))`) mit `--color-ink-on-vivid`; inaktiv
  Sekundaertext, Hover hebt nur die Textfarbe. Gilt identisch fuer Aufgaben-Gruppentoggle,
  Kalender-Ansichtswahl, Budget-Tabs, Sub-Tabs, Kuechen-Tabs, Dokumenten-View-Toggle und die
  Settings-Schalter. Innenradius konzentrisch (`calc(var(--radius-sm) - 2px)`). Kein
  3px-Akzentstreifen mehr unter aktiven Tabs - die Fuellung ist das Signal.

### Chips
- **Form:** Kapsel (`--radius-full`), Kante wie ein Bedienelement. Kalender-Layer-Chips
  tragen die User-Farbe als Border mit ~60 % Deckung (>=3:1), nie als Textfarbe; nur der
  Mir-zugewiesen-Chip traegt sein Label in der Layer-Farbe (AA-verifiziert),
  Feiertags-Chips bleiben Sekundaertext. Aktive Filter-Chips folgen der Segment-Sprache.
  Scrollende Chip-Reihen bekommen die Fade-Mask (siehe Layout).

### Cards / Containers
- **Corner Style:** 12px (`--radius-md`) fuer die Karte, 16px (`--radius-lg`) fuer den
  Zeilen-Traeger, 26px fuer Glas-nahe Container.
- **Background:** `--color-surface`, opak. Karten sind randlos auf dem Grouped-Grund - die
  Trennung leistet der Schatten, nicht eine Kante.
- **Shadow:** shadow-sm in Ruhe; Hover-Anhebung nur fuer interaktive Karten.
- **Inset-Grouped-Liste:** die Kernform der neuen Welt. "Heute wichtig" auf dem Dashboard ist
  EINE Inset-Grouped-Liste (ein Traeger, Zeilen mit Haarlinien, getoente Icon-Kachel plus
  Titel plus Modul-Untertitel plus trailing Count), nicht viele Einzelkarten.
- **Internal Padding:** 16px (`--space-4`), kompakt 12px.

### Named Rules
**Die Kasten-in-Kasten-Regel.** Karten sind randlos auf dem Grouped-Grund, also traegt
NICHTS in einer Karte eine eigene Kante - sonst stuende ein umrandeter Kasten in einer
kantenlosen Karte. Es gibt genau zwei Antworten, app-weit dieselben: eine ZEILE wird zur
Haarlinie (`+ selector { border-top: 1px solid var(--color-border-subtle) }`,
Container-`gap` auf 0, Padding vertikal, keine Flaeche, kein Radius); eine KACHEL wird zum
Inset-Well (`background: var(--color-fill-well)`, KEINE border, Radius bleibt). Echte
BEDIENELEMENTE - Inputs, Buttons, Chips, Checkboxen, Stepper, Drop-Ziele - behalten ihre
Kante: sie sind keine Kaesten, sondern Griffe.

**Die Traeger-Regel.** Der Well gilt nur INNERHALB einer Karte. Dieselbe Kachel auf dem
Grouped-Grund ist eine randlose Karte (`--color-surface` + `--shadow-sm`) - ein Well liegt
dort bei 1.06:1 und verschwindet; der Well sitzt bewusst auf der Surface-3-Rolle statt auf
dem Grouped-Grund, weil der Grund im Dark ein Loch zur Buehne risse (1.16:1 nach unten) und
im Light zu schwach traegt (1.12:1). Traegt eine Komponente beide Kontexte, steht der Well im
Kontextselektor der Karte, nie in der Basisregel (Muster
`.health-overview__card .health-metric-card`). LEERZUSTAENDE bekommen gar keine Flaeche:
zentrierter Sekundaertext, kein Rahmen, kein Well - sonst muesste jeder Leerzustand seinen
Traeger kennen.

**Die Zeilenlisten-Regel.** Die Kasten-in-Kasten-Regel sagt, wie eine Zeile INNEN aussieht;
diese sagt, worauf sie liegt. Eine Folge gleichartiger Zeilen liegt in GENAU EINEM Traeger:
einer randlosen Karte (`background: var(--color-surface)`, `--radius-lg`,
`box-shadow: var(--shadow-sm)`, `overflow: hidden`). Die Zeilen darin sind flaechen- und
kantenlos und trennen sich ueber den `+`-Kombinator, NIE per `border-bottom` je Zeile - das
zieht eine Linie unter die letzte und macht den Traegerrand doppelt. Der Kopf steht UEBER dem
Traeger auf dem Grund, nie in ihm (welche Kopfrolle, sagt die Kopf-Abgrenzungs-Regel). Es
gibt damit weder eine traegerlose Zeilenfolge auf dem Grund noch eine Karte pro Zeile; drei
Vokabulare koexistierten vorher (Geburtstage, Belohnungen, Kontakte, Budget,
Einstellungs-Uebersicht, Medikamente). Begruendung: eine Zeilenfolge direkt auf dem Grund hat
keinen linken Rand, an dem das Auge die Liste als EIN Objekt fasst; eine Karte pro Zeile hat
N Raender und damit N Objekte. Einzige Ausnahme: ein RASTER aus Objekten mit eigenem Medium
(Foto, Dokumentvorschau) - dort ist jede Kachel eine eigene Karte, weil sie nebeneinander
steht statt untereinander. Guard: `row lists sit in exactly one carrier` liest ALLE
Stylesheets und haelt jede Haarlinien-Zeile frei von Karten-Merkmalen (Schatten, Radius,
Surface-Fuellung).

**Die Wischsemantik-Regel.** Dieselbe Geste bedeutet in jeder Liste dasselbe. Der
Zeilenanfang traegt die primaere positive Aktion, das Zeilenende das Destruktive oder
Sekundaere; die Kante ist logisch, die Fingerbewegung dahin spiegelt in RTL. Zugeordnet
wird ein RANG, keine Rolle - `--edit` ist primaer, wo keine positive Aktion daneben steht,
und sekundaer, wo eine steht. Fest liegen die Enden: `--delete` steht nie am Zeilenanfang,
`--done` nie am Ende. **Und eine Geste, die loescht, hat einen Rueckweg** - nie ein direktes
`api.delete`. Der Anlass der Regel war kein Konsistenzwunsch, sondern die eine Stelle der
App, an der eine Geste sofort und endgueltig loeschte.

**Es gibt zwei Rueckwege, und die REICHWEITE der Tat entscheidet.** Laesst sie sich in einem
Satz zuruecknehmen, gehoert ihr der Undo-Toast (`scheduleUndoableDelete`): er unterbricht
nicht und haelt den Weg fuenf Sekunden offen - Geburtstag, Einkaufszeile, Buchung. Wirkt sie
UEBER IHR MODUL HINAUS, gehoert ihr die Bestaetigung (`confirmModal` mit `danger: true`),
denn dann muss der Rueckweg die Nebenwirkung BENENNEN, und das kann nur ein Dialog vor der
Tat: ein Abo zu loeschen nimmt seine Erinnerungen und die Budget-Buchung der naechsten
Zahlung mit. Keiner der beiden ist die Ausnahme des anderen - es ist dieselbe Trennung, die
der Kanon zwischen Undo und Action Sheet zieht. Eine Bestaetigung ohne `danger` zaehlt
nicht: die rote Taste ist das, was den Rueckweg erkennbar macht.

Zuordnung als Tabelle bei der Signature Component; Guards auf Ebene 3
(`Eine Wischgeste, die loescht, hat einen Rueckgaengig-Weg`) und Ebene 4 (Sonde 5), weil
nur das gerenderte Dokument sieht, ob eine Liste ueberhaupt verdrahtet ist.

### Inputs / Fields
- **Style:** 10px Radius (`--radius-sm`), 1.5px Border `--color-border`, Surface-Grund,
  Padding 8px 12px, min-height 48px (Desktop 40px), Schriftgroesse nie unter 16px,
  Placeholder `--color-text-placeholder` (= Tertiaer, gethemt; NIE die Disabled-Farbe, und
  als Elementselektor auf `input`/`textarea`, damit kein Feld auf Chromes UA-Default
  zurueckfaellt).
- **Feldkanon:** ein `select` bekommt zusaetzlich 32px Innenpolster rechts
  (`padding-inline-end: var(--space-8)`) plus `text-overflow: ellipsis`, weil sein Chevron
  INNERHALB der Box sitzt und lange Optionstexte sonst mittendrin gekappt werden. Das ist
  app-weiter Kanon, kein Modul-Detail.
- **Focus:** Akzentkante plus 3px Glow in `--color-accent-light`; interaktive Nicht-Felder
  tragen den app-weiten 2px-Ring.

### Navigation
- **Mobil:** schwebende Glas-Kapsel (`--glass-bg-elevated` + `--blur-md` + saturate,
  radius-full) mit gleitendem Aktiv-Indikator.
- **Desktop:** Glas-Sidebar mit gleitender Aktiv-Pille; Toolbar ohne Akzentstreifen, Titel in
  Title 2.
- Labels in 12px; lange Locales duerfen die Kapsel wachsen lassen, nie clippen.
- **Filled Variant, app-weit:** JEDER ausgewaehlte Zustand traegt sein Icon gefuellt
  (`fill: color-mix(in srgb, currentColor 30%, transparent)`) - Tab-Bar, Sub-Tabs,
  Listen-Tabs, Filterchips, Segmente, View-Toggles. Lucide bleibt Stroke-Bibliothek; die
  Fuellung entsteht unter vollem Stroke und wirkt nur auf geschlossene Pfade. 16 % las auf
  20px-Tab-Bar-Groesse noch als Outline, deshalb 30 %. Zweiter Kanal neben der Flaeche,
  nie ihr Ersatz.

### Modulkopf (Signature Component)
Eine `.page-toolbar` pro Modul, Titel links, Center-Slot (Suche oder Zeitraum-Navigation),
Aktionen rechts. In der KOMPAKTEN Groessenklasse (<1024px, die Welt mit Tab-Bar) steht der
Titel am Scroll-Anfang als **Large Title** (34px) auf eigener Zeile und faellt beim Scrollen
auf den Inline-Schnitt (22px) zurueck; die Trennlinie erscheint erst beim Andocken, davor
steht der Kopf nahtlos auf dem Seitengrund. Ab 1024px regiert die Sidebar - dort bleibt es
beim Inline-Titel, wie in Apples regulaerer Groessenklasse.

**Andocken kann nur ein Kopf mit Lead-Zone** - und eine hat nur, wessen Inhalt auf mehr als
einer Zeile steht. Wo keine ist, traegt die Leiste ihre Linie durchgehend und markiert
schlicht die Kopfkante. Das ist kein Sonderfall, sondern derselbe Satz von der anderen
Seite: ohne wegscrollende Zeile gibt es kein Andocken zu zeigen. Gemessen trifft das zwei
Lagen - die regulaere Groessenklasse ab 1024px (Inline-Titel, alles in EINER Zeile, alle 14
Koepfe) und mobil die drei einzeiligen Kuechen-Koepfe (Einkauf, Rezepte, Vorrat), wo die
Kuechen-Leiste den Modulnamen traegt, also kein Seitentitel darueber steht und der Kopf
allein seinen Center-Slot fuehrt. Der Essensplan ist unter den vieren die Ausnahme: seine
Zeitraum-Navigation und seine Aktionen brauchen zwei Zeilen, also hat er eine Lead-Zone.

Und **was als Zeile zaehlt, entscheidet die UEBERLAPPUNG der vertikalen Intervalle, nicht
die Oberkante.** Flex-Items unterschiedlicher Hoehe stehen mittig ausgerichtet nebeneinander
und beginnen dabei bis zu 15px auseinander; ein hoehenloser Slot, den ein Modul nur je nach
Zustand fuellt, macht gar keine Zeile auf. Beide Faelle sind einmal als Lead-Zone
durchgegangen und haben dabei genau die Linie verborgen, die zu zeigen war - auf Desktop bei
11 von 14 Koepfen folgenlos (jede Regel dazu steht in der kompakten Groessenklasse), bei den
Rezepten sichtbar.

**Was aus der Lead-Zone mitgeht, entscheidet der Inhalt des Slots** - dieselbe Abgrenzung
wie zwischen Bereich und Gruppe: eine SUCHE verschwindet (Apples
`hidesSearchBarWhenScrolling`), solange sie weder Fokus noch Wert hat; der ZEITRAUM einer
Seite (Monat im Budget, Datum im Kalender) bleibt stehen und beantwortet weiter „wo bin ich".

Die MECHANIK richtet sich nach der Scrollport-Architektur des Moduls, die Regel nicht:
- **Die Seite scrollt** (Aufgaben, Geburtstage, Dokumente, Belohnungen, Haushaltshilfe): der
  Kopf liegt im Scrollport und dockt ueber ein negatives `top` an (`--page-toolbar-lead` =
  Hoehe der Zeilen ueber der letzten). Seine Hoehe aendert sich NIE - ein Klassen-Umschalter
  wuerde hier ein Element im Fluss verkuerzen, den Scroll-Offset verschieben und den Kopf um
  seine eigene Schwelle pendeln lassen.
- **Eine innere Liste scrollt** (Budget, Kalender, Notizen, Kontakte): der Modul-Root ist
  `overflow: hidden`, der Kopf liegt ausserhalb und bewegt sich nie. Dort klappt die
  Titelzeile wirklich ein - gefahrlos, weil der Hoehenwechsel nur den inneren Port
  verlaengert, ohne dessen Offset anzufassen.

Der Kopf bleibt in ZEILENRICHTUNG - kein Modul setzt eine eigene Flex-Richtung auf einer
Kopf-Klasse. Eine Tab-Leiste im Kopf ist eine eigene, horizontal scrollende Zeile UNTER dem
Large Title; die Shell erkennt sie an `[role="tablist"]`, nicht an einem Klassennamen (die
vier heissen `.housekeeping-tabs`, `.rewards-tabs`, `.cal-toolbar__views`, `.budget-tabs` -
eine Regel ueber diese Liste fehlte beim fuenften). Wer dort steht, sagt die Leisten-Regel
oben.

Verdrahtet wird EINMAL, von der Shell (`wireCollapsingHeader` in `utils/ux.js`, aufgerufen
vom Router): der Kopf ist die eine Komponente, die alle Module teilen, und ein Opt-in, das
jedes Modul selbst setzen muesste, fehlt beim naechsten. Die Titelgroesse gehoert der
Canonical-Page-Head-Rolle in typography.css, der Umbruch layout.css.

### Wischbedienung (Signature Component)
Listenzeilen tragen ihre Aktionen auf Touch in zwei Wischrichtungen; auf Zeigergeraeten
bleiben die sichtbaren Knoepfe, denn dort gibt es keine Geste. Die Panels hinter der Karte
trennen **zwei Achsen**: die SEITE ist die Kante, an der das Panel liegt (`--leading` am
Zeilenanfang, `--trailing` am Zeilenende), die ROLLE traegt allein die Bedeutung (`--done`
success, `--edit` accent, `--delete` danger). Eine Klasse, die beides packt, ist beim
zweiten Nutzer verbraucht.

**Die Kante ist logisch, nicht links und rechts.** In `ar` und `fa` setzt die App
`dir=rtl`; die Panels stehen auf `inset-inline-start/-end` und den vier logischen
Eckradien, und `wireSwipeRows` leitet aus derselben Schreibrichtung ab, welche
Fingerbewegung welche Kante aufdeckt. Der Nudge-Hinweis und der permanente Chevron sind
Richtungsangaben und spiegeln mit.

**Dieselbe Geste bedeutet in jeder Liste dasselbe.** Der Zeilenanfang traegt die primaere
positive Aktion, das Zeilenende das Destruktive oder Sekundaere:

| Liste | Zeilenanfang (in LTR: Wisch nach rechts) | Zeilenende (in LTR: Wisch nach links) |
|---|---|---|
| Aufgaben | erledigt umschalten (`--done`), fliegt hinaus | Detailansicht (`--edit`), federt zurueck |
| Einkauf | abhaken (`--done`), fliegt hinaus | loeschen (`--delete`), federt zurueck, widerrufbar |
| Geburtstage | bearbeiten (`--edit`), federt zurueck | loeschen (`--delete`), federt zurueck, widerrufbar |
| Abonnements | Zahlung buchen (`--done`), federt zurueck, fragt nach | loeschen (`--delete`), federt zurueck, fragt nach |

Die Abo-Zeile ist die einzige, deren `--done` nicht abhakt, sondern BUCHT: sie schiebt das
Faelligkeitsdatum und legt einen Budget-Eintrag an. Ein zweiter Wisch nimmt das nicht
zurueck, anders als bei einer Aufgabe an derselben Kante - deshalb fragt sie nach, und
deshalb fliegt sie nicht hinaus. Bearbeiten liegt dort auf keiner Wischrichtung, sondern auf
dem Zeilenkoerper (`.list-row__main--interactive`), und der ist ein echter `<button>`: ein
blosser Tap-Handler haette den Bearbeiten-Knopf aus der Zeile genommen, ohne einen
Tastaturweg an seine Stelle zu setzen.

`--edit` steht in Aufgaben am Zeilenende und in Geburtstagen am Anfang, und das ist kein
Widerspruch: die Regel ordnet einen RANG zu, keine Rolle. Wo eine positive Aktion in der
Liste steht, ist Bearbeiten die sekundaere; wo keine steht, ist es die primaere. Fest
liegen die beiden Enden der Skala - `--delete` steht nie am Zeilenanfang, `--done` nie am
Ende. Genau das misst der Guard.

**Eine Geste, die loescht, hat einen Rueckweg**, nie ein direktes `api.delete`. Der Einkauf
war die eine Stelle, die sofort und endgueltig loeschte - wer die Geste in zwei Listen als
harmlos gelernt hat, verlor in der dritten Daten ohne Rueckweg. Welcher der beiden Rueckwege
richtig ist, entscheidet die Reichweite der Tat: der Undo-Toast, wo sie sich in einem Satz
zuruecknehmen laesst, die Bestaetigung, wo sie ueber ihr Modul hinaus wirkt (siehe „Die
Wischsemantik-Regel" bei Cards / Containers).

Die Karte fliegt nur dann hinaus, wenn die Zeile die Liste tatsaechlich verlaesst; ist die
Aktion widerrufbar oder oeffnet sie nur einen Dialog, federt die Karte zurueck. Eine
hinausgeflogene Karte behauptet, die Sache sei erledigt, waehrend das Undo-Fenster noch
offen steht. Die Geste selbst - Schwellwert 80px, Daempfung darueber, Scroll-Erkennung,
Haptik am Schwellwert, Ausnahme fuer den Sortiergriff, der einmalige Hinweis nach dem
Seitentausch - liegt geteilt in `utils/swipe-row.js`.

**Geprueft auf zwei Ebenen, weil jede etwas anderes sehen kann.** Ebene 3 (statisch, in
`test-frontend-audit.js`) folgt von jeder Wischrichtung mit `--delete` der Kante zu der
Funktion, die sie ruft, und verlangt dort den Rueckweg. Ebene 4 (`test:document-guards`,
Sonde 5) faehrt die Geste im gerenderten Dokument in `de` und `ar` und misst, welches
Panel sie aufdeckt - **ob eine Liste ueberhaupt verdrahtet ist, sieht nur diese Ebene.**
Der Einkauf verdrahtete seine Gesten nur im Nachlade-Pfad und antwortete beim ersten
Oeffnen der Seite auf gar nichts; im Quelltext stand alles richtig da.

### Anmeldeseite
Die erste Seite der App ist Teil derselben Welt, keine Ausnahme. Die Buehne ist der reine
Seitengrund ohne Verlauf (bis Runde 3 stand hier der letzte chromatische Verlauf der App).
Die Marke traegt allein das Tile: 64px, `--radius-lg`, gefuellt in Akzent, Zeichen in
`--color-ink-on-vivid` (6.06:1 light / 6.40:1 dark - nicht `--color-text-on-accent`, das
statisches Weiss ist und im Dark auf 2.72:1 faellt), shadow-md plus feine Lichtkante. Der
Titel ist ein Large Title in Label-Farbe wie jeder Seitentitel. Die Bildmarke selbst - drei
transluzente violette Kreise mit Sheen - ist als Marke gesetzt und unantastbar.

### FAB (Signature Component)
Getoente Glas-Kapsel: Modul-Akzent mit 78 % Deckung
(`color-mix(in srgb, var(--module-accent, var(--color-accent)) 78%, transparent)`) ueber
`--blur-md` + `saturate(var(--lg-glass-saturate))`, Specular-Kanten (`--glass-inset-strong`
plus Bottom-Inset) und `--glass-sheen` auf der oberen Kapselhaelfte als Materialbeweis -
unter dem FAB laeuft per `--fab-safe-zone` nie Inhalt durch, der Sheen ist dort der einzige
Beweis, dass die Flaeche Glas ist. Die 78 % sind eine Untergrenze: darunter faellt das
Plus-Glyph auf hellen Modul-Tints unter 3:1 (gemessen 78 % Tasks-Gruen auf Weiss = 3.4:1).
Hover geht auf Vollton, der Fallback ist opak. Einblendung als Feder (420ms `--ease-out`
plus Ring-Pulse), reduced-motion-sicher.

### Monatsgrid-Event-Bars (Signature Component, Kalender)
Flache Tint-Bars statt satter Farbfelder: Flaeche auf `--tint-surface` (Layer-Farbe auf
`--color-surface-work`, Hover eine Sprosse hoeher auf `--tint-raised`), Tinte
`color-mix(in srgb, var(--ev-color) 35%, var(--color-text-primary))`; gemessen 7.2-9.5:1
ueber die Layer-Farben. Keine Borders, Icons oder Avatar-Stacks im Monat (das "wer" traegt
das title-Attribut). "Heute" ist NUR ein gefuellter Akzent-Kreis auf der Ziffer;
Nachbarmonatstage dimmen ueber Flaeche UND Ziffer (AA-fest), nie ueber blosse Opacity auf
Text allein.

## Do's and Don'ts

### Do:
- **Do** jeden Design-Wert aus `public/styles/tokens.css` beziehen; hartkodierte Werte in
  Komponenten sind Bugs (Projekt-Invariante).
- **Do** Dark Mode ueber die privaten `--_name`-Tokens fuehren; die oeffentliche Token-API
  bleibt stabil und wird nie doppelt geaendert.
- **Do** jede neue Farb-Flaechen-Paarung gegen ihren REALEN Hintergrund auf AA messen
  (Pro-Hintergrund-Regel), in Light und Dark.
- **Do** eine Folge gleichartiger Zeilen in GENAU EINEN Traeger legen und ueber den
  `+`-Kombinator trennen (Zeilenlisten-Regel).
- **Do** in einer Karte zwischen ZEILE (Haarlinie) und KACHEL (Inset-Well) waehlen; nur
  Bedienelemente behalten ihre Kante.
- **Do** jede Toenung eine benannte Stufe der Toenungsskala nehmen lassen (`--tint-wash` 8 /
  `--tint-state` 12 / `--tint-surface` 16 / `--tint-raised` 24 / `--tint-hint` 50 /
  `--tint-ink` 70 / `--tint-shadow` 20), nie eine eigene Zahl; die vier Flaechenstufen sind
  eine Leiter, ein Zustand steigt eine Sprosse.
- **Do** verschachtelte Radien konzentrisch rechnen (`calc(var(--radius-*) - Npx)`).
- **Do** opake Fallbacks fuer jedes Glas-Element mitliefern (reduced-transparency,
  prefers-contrast, fehlender backdrop-filter).

### Don't:
- **Don't** einen zweiten Buttonradius einfuehren; die Kapsel steht in der `.btn`-Basisregel
  und gilt fuer alle Varianten inklusive Icon-Buttons.
- **Don't** Gradient-Text oder Akzent-Titel: Large Titles und Ueberschriften tragen immer
  Label-Farbe.
- **Don't** chromatische Verlaeufe auf Inhalt legen; auch nicht auf der Anmeldebuehne und
  nicht auf einem Widget.
- **Don't** Akzentstreifen an Toolbars, Tabs oder Koepfen; die gehoerten zur abgeloesten Welt.
- **Don't** dekorative Kicker/Eyebrows; eine Versal-Zeile ist nur als echte Information
  erlaubt (Apple-News-Muster, z. B. das Masthead-Datum).
- **Don't** Glas auf Inhalte legen; backdrop-filter gehoert ausschliesslich dem Chrome.
- **Don't** einer Zeile in einer Liste eine Karte anziehen (Schatten, Radius,
  Surface-Fuellung) und nie `border-bottom` je Zeile.
- **Don't** User-/Layer-Farben als Textfarbe verwenden; nur Border/Dot bzw. die gemessenen
  16-%/35-%-Mix-Rezepte, und nie eine ganze Inhaltsflaeche.
- **Don't** die Bildmarke anfassen (drei transluzente Kreise, Violett plus Sheen); sie ist
  als Marke gesetzt.
- **Don't** Ueberschriften ueber 34px; die Display-Stufen 48/72px sind exklusiv fuer
  Anzeigewerte (Wandtablet-Uhr).
- **Don't** neue Viewport-Breakpoints erfinden; die vier Grenzen sind verbindlich,
  komponenteninterne Umbrueche laufen ueber Container-Queries.
