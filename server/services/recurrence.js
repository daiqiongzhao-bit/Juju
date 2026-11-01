/**
 * Modul: Wiederholungsregeln (Recurrence)
 * Zweck: RRULE-Subset-Parser (FREQ=DAILY/WEEKLY/MONTHLY, BYDAY, INTERVAL, UNTIL)
 *        + Berechnung des nächsten Fälligkeitsdatums für wiederkehrende Aufgaben
 * Abhängigkeiten: keine
 */

const DAY_MAP = { MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6, SU: 0 };

/**
 * Parsed einen RRULE-String in ein Objekt.
 * Beispiel: "FREQ=WEEKLY;BYDAY=MO,TH;INTERVAL=1;COUNT=10"
 * @param {string} rule
 * @returns {{ freq, interval, byday, until, count }|null}
 */
function parseRRule(rule) {
  if (!rule) return null;
  // Strip "RRULE:" prefix if present (ICS stores rules as "RRULE:FREQ=...")
  const raw = rule.startsWith('RRULE:') ? rule.slice(6) : rule;
  const parts = {};
  for (const segment of raw.split(';')) {
    const eq = segment.indexOf('=');
    if (eq === -1) continue;
    parts[segment.slice(0, eq).toUpperCase()] = segment.slice(eq + 1);
  }

  const freq     = parts.FREQ ?? null;
  const interval = parseInt(parts.INTERVAL ?? '1', 10) || 1;
  const byday    = (parts.BYDAY ?? '').split(',')
    .map((d) => DAY_MAP[d.trim().toUpperCase()])
    .filter((d) => d !== undefined);
  const until    = parts.UNTIL ? parseUntilDate(parts.UNTIL) : null;
  // COUNT begrenzt die Serie auf N Vorkommen (DTSTART = Vorkommen 1). Der
  // stateless nextOccurrence() kann COUNT nicht selbst durchsetzen – das
  // übernimmt die Expansion (expandRecurringEvents), die von DTSTART zählt.
  const countRaw = parts.COUNT ? parseInt(parts.COUNT, 10) : null;
  const count    = Number.isInteger(countRaw) && countRaw > 0 ? countRaw : null;

  if (!['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'].includes(freq)) return null;

  return { freq, interval, byday, until, count };
}

function parseUntilDate(str) {
  // Akzeptiert YYYYMMDD oder YYYYMMDDTHHmmssZ
  const clean = str.replace(/[TZ]/g, '');
  const y = parseInt(clean.slice(0, 4), 10);
  const m = parseInt(clean.slice(4, 6), 10) - 1;
  const d = parseInt(clean.slice(6, 8), 10);
  return new Date(Date.UTC(y, m, d));
}

/**
 * Berechnet das nächste Fälligkeitsdatum nach dem gegebenen Basisdatum.
 * @param {string} baseDateStr - ISO-Datums-String (YYYY-MM-DD)
 * @param {string} rrule       - RRULE-String
 * @returns {string|null}      - Nächstes Datum als YYYY-MM-DD oder null (Ende der Serie)
 */
function nextOccurrence(baseDateStr, rrule) {
  const parsed = parseRRule(rrule);
  if (!parsed || !baseDateStr) return null;

  const base = new Date(baseDateStr + 'T00:00:00Z');
  if (isNaN(base.getTime())) return null;

  const { freq, interval, byday, until } = parsed;
  const next = new Date(base);

  if (freq === 'DAILY' && byday.length === 0) {
    next.setUTCDate(next.getUTCDate() + interval);

  } else if (freq === 'WEEKLY' || (freq === 'DAILY' && byday.length > 0)) {
    if (byday.length === 0) {
      // Kein BYDAY → selber Wochentag, nächste Woche
      next.setUTCDate(next.getUTCDate() + 7 * interval);
    } else {
      // FREQ=DAILY;BYDAY zählt Tage, nicht Wochen: das nächste Vorkommen ist
      // schlicht der nächste passende Wochentag, ohne Wochen-Intervall-Sprung.
      // Apple/iOS serialisiert "jeden Werktag" so (#549).
      const weekInterval = freq === 'WEEKLY' ? interval : 1;
      // Finde den nächsten passenden Wochentag (nach heute)
      const currentDay = base.getUTCDay();
      const sorted = [...byday].sort((a, b) => {
        const da = (a - currentDay + 7) % 7 || 7;
        const db = (b - currentDay + 7) % 7 || 7;
        return da - db;
      });
      // Tage bis zum nächsten Vorkommen (mind. 1, damit nicht derselbe Tag)
      let daysUntil = (sorted[0] - currentDay + 7) % 7;
      if (daysUntil === 0) {
        // Selber Wochentag → ganzes Intervall überspringen
        daysUntil = 7 * weekInterval;
      } else if ((sorted[0] + 6) % 7 < (currentDay + 6) % 7) {
        // Wochengrenze überschritten (ISO-Woche MO–SO) → interval-1 Wochen extra überspringen
        daysUntil += 7 * (weekInterval - 1);
      }
      next.setUTCDate(next.getUTCDate() + daysUntil);
    }

  } else if (freq === 'MONTHLY') {
    const targetDay = base.getUTCDate();
    next.setUTCMonth(next.getUTCMonth() + interval);
    // Monatsüberlauf korrigieren (z.B. 31. März + 1 Monat → 30. April)
    const lastDay = new Date(Date.UTC(next.getUTCFullYear(), next.getUTCMonth() + 1, 0)).getUTCDate();
    next.setUTCDate(Math.min(targetDay, lastDay));

  } else if (freq === 'YEARLY') {
    const targetMonth = base.getUTCMonth();
    const targetDay   = base.getUTCDate();
    next.setUTCFullYear(next.getUTCFullYear() + interval);
    // Feb 29 in non-leap year → Feb 28
    next.setUTCMonth(targetMonth);
    const lastDay = new Date(Date.UTC(next.getUTCFullYear(), targetMonth + 1, 0)).getUTCDate();
    next.setUTCDate(Math.min(targetDay, lastDay));
  }

  // UNTIL-Grenze prüfen
  if (until && next > until) return null;

  return next.toISOString().slice(0, 10); // YYYY-MM-DD
}

/**
 * Wie nextOccurrence, überspringt aber alle Vorkommen vor `notBeforeStr`, bis das
 * erste Vorkommen >= notBeforeStr gefunden ist (Aufholen übersprungener Serien).
 * Gibt null zurück, wenn die Serie (UNTIL) vorher endet oder kein Basisdatum existiert.
 * @param {string} baseDateStr  - ISO-Datums-String (YYYY-MM-DD)
 * @param {string} rrule        - RRULE-String
 * @param {string} notBeforeStr - Untere Schranke (YYYY-MM-DD); Ergebnis ist >= dieser
 * @returns {string|null}       - Nächstes zukünftiges Datum als YYYY-MM-DD oder null
 */
function nextOccurrenceAfter(baseDateStr, rrule, notBeforeStr) {
  let current = nextOccurrence(baseDateStr, rrule);
  // Vergleich per lexikografischem YYYY-MM-DD-String (Format ist fix, daher sicher).
  let guard = 0;
  while (current && notBeforeStr && current < notBeforeStr && guard++ < 1000) {
    current = nextOccurrence(current, rrule);
  }
  return current;
}

/**
 * Das nächste Fälligkeitsdatum, nachdem etwas Wiederkehrendes erledigt wurde.
 *
 * Zwei Verankerungen, und die Wahl gehört dem einzelnen Vorgang (#658):
 *
 * - `fromCompletion: false` (Vorgabe): die Serie hängt am Fälligkeitsdatum. Das
 *   Raster bleibt stehen, egal wann jemand abhakt - richtig für alles, was an
 *   einem äußeren Takt hängt (Müllabfuhr, Miete, Vereinsabend). Übersprungene
 *   Vorkommen werden aufgeholt, damit die nächste Instanz nicht selbst schon
 *   überfällig entsteht.
 * - `fromCompletion: true`: die Serie hängt am Tag des Abhakens. Richtig für
 *   alles, dessen Intervall erst mit der Handlung beginnt (Filter reinigen,
 *   Pflanzen düngen). Ein Aufholen entfällt: das Ergebnis liegt bei jedem
 *   positiven Intervall ohnehin in der Zukunft.
 *
 * Bewusst hier und nicht in der Route: #647 will dieselbe „ab dem Moment, wo du
 * es angefasst hast"-Rechnung für zurücksetzbare Countdowns.
 *
 * @param {object}  opts
 * @param {string}  opts.anchorDate      Fälligkeitsdatum der erledigten Instanz (YYYY-MM-DD)
 * @param {string}  opts.rule            RRULE-String
 * @param {string}  opts.completedOn     Tag des Abhakens (YYYY-MM-DD)
 * @param {boolean} [opts.fromCompletion] true = ab Erledigungstag rechnen
 * @returns {string|null} Nächstes Datum als YYYY-MM-DD oder null (Serienende)
 */
function nextDueAfterCompletion({ anchorDate, rule, completedOn, fromCompletion = false }) {
  if (fromCompletion) return completedOn ? nextOccurrence(completedOn, rule) : null;
  return nextOccurrenceAfter(anchorDate, rule, completedOn);
}

/**
 * Prüft, ob ein Datum zum BYDAY-Wochentagsfilter der Regel passt.
 * Ohne BYDAY (oder ohne parsebare Regel) gilt jedes Datum als passend – dann
 * steuern allein DTSTART und nextOccurrence die Serie. Fängt Serien ab, deren
 * DTSTART nicht auf einen Regeltag fällt (z.B. Anker am Wochenende, #549).
 * @param {string} dateStr - YYYY-MM-DD
 * @param {string} rrule   - RRULE-String
 * @returns {boolean}
 */
function matchesRRuleByday(dateStr, rrule) {
  const parsed = parseRRule(rrule);
  if (!parsed || parsed.byday.length === 0) return true;
  const day = new Date(dateStr + 'T00:00:00Z');
  if (isNaN(day.getTime())) return true;
  return parsed.byday.includes(day.getUTCDay());
}

const DAY_MS = 86_400_000;

/**
 * Springt in einer täglichen oder wöchentlichen Serie grob bis kurz vor
 * `notBeforeStr` vor, statt jeden einzelnen Termin ab DTSTART durchzulaufen.
 *
 * Hintergrund: Die Expansion (calendar-events.js) beginnt beim Startdatum des
 * Masters und tastet sich mit nextOccurrence() vorwärts. Ein täglich
 * wiederkehrender Termin aus 2019 braucht bis heute über 2500 Schritte; die
 * dortige Notbremse (MAX_ITER = 1000) greift lange vorher, die Schleife bricht
 * ab und der Termin erscheint im Kalender überhaupt nicht mehr. Das ist kein
 * Performance-, sondern ein Sichtbarkeitsfehler.
 *
 * Der Sprung bleibt bewusst grob: Er landet höchstens eine Periode vor dem
 * Ziel, den Rest erledigt weiterhin die normale Expansion. Damit muss BYDAY,
 * EXDATE oder die Sommerzeit-Verschiebung hier nicht ein zweites Mal
 * nachgebaut werden.
 *
 * Serien mit COUNT werden nicht angefasst — dort zählt die Expansion die
 * Vorkommen ab DTSTART mit, ein Sprung würde die Zählung verfälschen.
 *
 * @param {string} baseDateStr  - Aktuelles Datum der Serie (YYYY-MM-DD)
 * @param {string} rrule        - RRULE-String
 * @param {string} notBeforeStr - Ziel: erstes interessantes Datum (YYYY-MM-DD)
 * @returns {string|null} Datum vor `notBeforeStr`, `baseDateStr` wenn kein Sprung
 *          sinnvoll ist, oder null wenn die Serie (UNTIL) vorher endet.
 */
function fastForwardOccurrences(baseDateStr, rrule, notBeforeStr) {
  if (!baseDateStr || !notBeforeStr) return baseDateStr;
  const parsed = parseRRule(rrule);
  if (!parsed) return baseDateStr;
  const { freq, interval, byday, count, until } = parsed;
  if (count !== null) return baseDateStr;
  // MONTHLY/YEARLY laufen höchstens ein paar Hundert Schritte pro Jahrhundert
  // auf — der Sonderfall lohnt dort nicht.
  if (freq !== 'DAILY' && freq !== 'WEEKLY') return baseDateStr;

  // Länge einer Phase in Tagen. Sobald BYDAY im Spiel ist, hängt die Serie am
  // Wochenraster (BYDAY verteilt sich innerhalb einer Woche), nicht am
  // Tagesintervall.
  const periodDays = freq === 'DAILY' && byday.length === 0
    ? interval
    : 7 * (freq === 'WEEKLY' ? interval : 1);

  const startMs  = Date.parse(baseDateStr + 'T00:00:00Z');
  const targetMs = Date.parse(notBeforeStr + 'T00:00:00Z');
  if (!Number.isFinite(startMs) || !Number.isFinite(targetMs) || targetMs <= startMs) {
    return baseDateStr;
  }

  const periodMs = periodDays * DAY_MS;
  // Eine volle Periode Abstand zum Ziel: so bleibt die Landung garantiert vor
  // dem Fenster, egal wie grob das Raster ist.
  const steps = Math.floor((targetMs - startMs) / periodMs) - 1;
  if (steps < 1) return baseDateStr;

  const landed = new Date(startMs + steps * periodMs).toISOString().slice(0, 10);
  if (until && new Date(landed + 'T00:00:00Z') > until) return null;
  return landed;
}

export {
  parseRRule, nextOccurrence, nextOccurrenceAfter, nextDueAfterCompletion, matchesRRuleByday,
  fastForwardOccurrences,
};
