/**
 * Dependency-freier V8-Coverage-Reporter.
 *
 * Liest ein NODE_V8_COVERAGE-Verzeichnis (rohe coverage-*.json aus einem oder
 * mehreren Node-Prozessen), aggregiert die Script-Coverage pro Quelldatei und
 * berechnet Funktions- sowie Zeilen-Coverage. Kein c8/istanbul, keine externe
 * Abhängigkeit - nur das native V8-Format (functions[].ranges[] mit Byte-Offsets
 * und count).
 *
 * Methodik (bewusst konservativ, damit Unterdeckung nicht überzeichnet wird):
 *  - Ein Byte gilt als NICHT ausgeführt, wenn es in mindestens einem Range mit
 *    count===0 liegt (V8 legt count===0-Ranges nur für nicht ausgeführte Blöcke
 *    an; ausgeführte Sub-Blöcke liegen nie darin). Die Vereinigung aller
 *    count===0-Ranges ist damit die maßgebliche "uncovered"-Byte-Menge.
 *  - Über mehrere Prozesse wird gemerged: ein Byte ist abgedeckt, sobald IRGEND
 *    ein Prozess es ausgeführt hat (uncovered nur, wenn in ALLEN Prozessen
 *    uncovered).
 *  - Eine Zeile zählt als "relevant", wenn sie Nicht-Whitespace enthält und
 *    nicht rein Kommentar/Klammer ist. Sie zählt als "uncovered", wenn ihr
 *    erstes Nicht-Whitespace-Zeichen in der uncovered-Byte-Menge liegt.
 *  - Funktions-Coverage ist exakt aus V8: Funktion abgedeckt <=> ranges[0].count>0.
 *
 * Aufruf:
 *   node test/coverage-report.mjs <covDir> [--prefix server/services] [--json out.json] [--top N]
 *
 * Ohne --prefix werden server/ und public/ berücksichtigt.
 */
import { readdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function parseArgs(argv) {
  const args = { covDir: null, prefixes: [], json: null, top: 60, full: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--prefix') args.prefixes.push(argv[++i]);
    else if (a === '--json') args.json = argv[++i];
    else if (a === '--top') args.top = Number(argv[++i]);
    else if (a === '--full') args.full = true;
    else if (!args.covDir) args.covDir = a;
  }
  if (args.prefixes.length === 0) args.prefixes = ['server/', 'public/'];
  return args;
}

// url -> relativer Projektpfad, oder null wenn außerhalb / node_modules / test.
function toRel(url) {
  if (!url.startsWith('file://')) return null;
  let abs;
  try { abs = fileURLToPath(url); } catch { return null; }
  if (!abs.startsWith(ROOT)) return null;
  const rel = relative(ROOT, abs);
  if (rel.startsWith('node_modules/')) return null;
  if (rel.startsWith('test/')) return null;
  if (rel.includes('/node_modules/')) return null;
  return rel;
}

function matchesPrefix(rel, prefixes) {
  return prefixes.some((p) => rel === p || rel.startsWith(p));
}

// Liest alle coverage-*.json und gruppiert Script-Coverage-Einträge pro Datei.
function loadCoverage(covDir, prefixes) {
  const files = readdirSync(covDir).filter((f) => f.startsWith('coverage-') && f.endsWith('.json'));
  // rel -> Array von Script-Coverage-Objekten (evtl. mehrere Prozesse/Instanzen)
  const perFile = new Map();
  for (const f of files) {
    let parsed;
    try { parsed = JSON.parse(readFileSync(join(covDir, f), 'utf8')); } catch { continue; }
    for (const script of parsed.result || []) {
      const rel = toRel(script.url);
      if (!rel) continue;
      if (!matchesPrefix(rel, prefixes)) continue;
      if (!rel.endsWith('.js') && !rel.endsWith('.mjs')) continue;
      if (!perFile.has(rel)) perFile.set(rel, []);
      perFile.get(rel).push(script);
    }
  }
  return { perFile, processCount: files.length };
}

// Vereinigung der count===0-Byte-Ranges eines einzelnen Script-Eintrags.
function uncoveredRangesOf(script) {
  const zero = [];
  for (const fn of script.functions) {
    for (const r of fn.ranges) {
      if (r.count === 0) zero.push([r.startOffset, r.endOffset]);
    }
  }
  return zero;
}

// Schnitt der uncovered-Mengen über mehrere Script-Instanzen (byte covered,
// sobald EIN Prozess es ausführte). Rückgabe: sortierte, gemergte Intervalle
// der Bytes, die in ALLEN Instanzen uncovered sind.
function intersectUncovered(scripts) {
  // Beginne mit "alles uncovered" der ersten Instanz, schneide iterativ.
  let acc = null;
  for (const s of scripts) {
    const cur = mergeIntervals(uncoveredRangesOf(s));
    acc = acc === null ? cur : intersectIntervalLists(acc, cur);
    if (acc.length === 0) break;
  }
  return acc || [];
}

function mergeIntervals(list) {
  if (list.length === 0) return [];
  const sorted = list.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const out = [sorted[0].slice()];
  for (let i = 1; i < sorted.length; i++) {
    const last = out[out.length - 1];
    const [s, e] = sorted[i];
    if (s <= last[1]) last[1] = Math.max(last[1], e);
    else out.push([s, e]);
  }
  return out;
}

function intersectIntervalLists(a, b) {
  const out = [];
  let i = 0, j = 0;
  while (i < a.length && j < b.length) {
    const s = Math.max(a[i][0], b[j][0]);
    const e = Math.min(a[i][1], b[j][1]);
    if (s < e) out.push([s, e]);
    if (a[i][1] < b[j][1]) i++; else j++;
  }
  return out;
}

// Funktions-Coverage über mehrere Instanzen: Funktion abgedeckt, wenn in
// irgendeiner Instanz ranges[0].count>0. Zuordnung über startOffset der Funktion.
function functionCoverage(scripts) {
  const covered = new Map(); // startOffset -> bool
  for (const s of scripts) {
    for (const fn of s.functions) {
      const start = fn.ranges[0]?.startOffset ?? 0;
      const isCov = (fn.ranges[0]?.count ?? 0) > 0;
      covered.set(start, (covered.get(start) || false) || isCov);
    }
  }
  let total = 0, hit = 0;
  for (const v of covered.values()) { total++; if (v) hit++; }
  return { total, hit };
}

// true, wenn Zeile nur Whitespace / Klammern / Kommentar-Rahmen ist (nicht
// als ausführbar gewertet). Bewusst grob, konservativ Richtung "nicht relevant".
function isNonExecutableLine(line) {
  const t = line.trim();
  if (t === '') return true;
  if (t === '{' || t === '}' || t === '})' || t === '};' || t === '),' || t === ')' || t === '],' || t === ']' || t === '(' || t === '{}' ) return true;
  if (t.startsWith('//')) return true;
  if (t.startsWith('*') || t.startsWith('/*') || t.startsWith('*/')) return true;
  if (t === 'try {' || t === '} else {' || t === 'else {') return true;
  return false;
}

// Ist Offset in einer der (sortierten) uncovered-Intervalle?
function inIntervals(intervals, off) {
  let lo = 0, hi = intervals.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const [s, e] = intervals[mid];
    if (off < s) hi = mid - 1;
    else if (off >= e) lo = mid + 1;
    else return true;
  }
  return false;
}

function lineCoverage(rel, scripts) {
  let src;
  try { src = readFileSync(join(ROOT, rel), 'utf8'); } catch { return null; }
  // V8-Offsets sind Byte-Offsets in UTF-8; unsere String-Indizes sind UTF-16.
  // Für ASCII-lastigen Code stimmen sie überein. Um korrekt zu sein, arbeiten
  // wir auf einem Buffer und mappen über Byte-Offsets.
  const buf = Buffer.from(src, 'utf8');
  const uncovered = intersectUncovered(scripts);
  // Zeilenstarts in BYTE-Offsets
  const starts = [0];
  for (let i = 0; i < buf.length; i++) if (buf[i] === 0x0a) starts.push(i + 1);
  const lineText = src.split('\n');

  let relevant = 0, covered = 0;
  const uncoveredLines = [];
  for (let ln = 0; ln < starts.length; ln++) {
    const lineStart = starts[ln];
    const lineEnd = ln + 1 < starts.length ? starts[ln + 1] - 1 : buf.length;
    const text = lineText[ln] ?? '';
    if (isNonExecutableLine(text)) continue;
    // erstes Nicht-WS-Byte
    let off = -1;
    for (let i = lineStart; i < lineEnd; i++) {
      const b = buf[i];
      if (b !== 0x20 && b !== 0x09 && b !== 0x0d) { off = i; break; }
    }
    if (off === -1) continue;
    relevant++;
    if (inIntervals(uncovered, off)) uncoveredLines.push(ln + 1);
    else covered++;
  }
  // unabgedeckte Zeilen zu Bereichen zusammenfassen
  const ranges = [];
  for (const l of uncoveredLines) {
    const last = ranges[ranges.length - 1];
    if (last && l === last[1] + 1) last[1] = l;
    else ranges.push([l, l]);
  }
  return { relevant, covered, uncoveredLines, ranges, totalLines: lineText.length };
}

function pct(hit, total) {
  if (total === 0) return 100;
  return (hit / total) * 100;
}

function fmtRanges(ranges, max = 8) {
  const parts = ranges.map(([a, b]) => (a === b ? `${a}` : `${a}-${b}`));
  if (parts.length <= max) return parts.join(', ');
  return parts.slice(0, max).join(', ') + `, … (+${parts.length - max})`;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.covDir) {
    console.error('Usage: node test/coverage-report.mjs <covDir> [--prefix <p>]... [--json out] [--top N] [--full]');
    process.exit(2);
  }
  try { statSync(args.covDir); } catch {
    console.error(`Coverage-Verzeichnis nicht gefunden: ${args.covDir}`);
    process.exit(2);
  }
  const { perFile, processCount } = loadCoverage(args.covDir, args.prefixes);

  const rows = [];
  let aggFnHit = 0, aggFnTotal = 0, aggLineCov = 0, aggLineRel = 0;
  for (const [rel, scripts] of perFile) {
    const fn = functionCoverage(scripts);
    const ln = lineCoverage(rel, scripts);
    if (!ln) continue;
    aggFnHit += fn.hit; aggFnTotal += fn.total;
    aggLineCov += ln.covered; aggLineRel += ln.relevant;
    rows.push({
      rel,
      fnPct: pct(fn.hit, fn.total), fnHit: fn.hit, fnTotal: fn.total,
      linePct: pct(ln.covered, ln.relevant), lineCov: ln.covered, lineRel: ln.relevant,
      ranges: ln.ranges, uncovered: ln.relevant - ln.covered,
    });
  }

  rows.sort((a, b) => a.linePct - b.linePct || b.uncovered - a.uncovered);

  const shown = args.full ? rows : rows.slice(0, args.top);
  console.log(`\nV8-Coverage-Report  (${processCount} Prozess-Dumps, ${rows.length} Quelldateien, Prefixe: ${args.prefixes.join(' ')})`);
  console.log('='.repeat(96));
  console.log(`${'Datei'.padEnd(52)} ${'Zeilen%'.padStart(8)} ${'abg/rel'.padStart(11)} ${'Fkt%'.padStart(6)}`);
  console.log('-'.repeat(96));
  for (const r of shown) {
    const name = r.rel.length > 51 ? '…' + r.rel.slice(-50) : r.rel;
    console.log(
      `${name.padEnd(52)} ${r.linePct.toFixed(1).padStart(7)}% ` +
      `${(r.lineCov + '/' + r.lineRel).padStart(11)} ${r.fnPct.toFixed(0).padStart(5)}%`,
    );
  }
  console.log('-'.repeat(96));
  console.log(
    `${'GESAMT'.padEnd(52)} ${pct(aggLineCov, aggLineRel).toFixed(1).padStart(7)}% ` +
    `${(aggLineCov + '/' + aggLineRel).padStart(11)} ${pct(aggFnHit, aggFnTotal).toFixed(0).padStart(5)}%`,
  );

  if (args.json) {
    const out = {
      generatedFrom: args.covDir,
      processCount,
      prefixes: args.prefixes,
      aggregate: {
        linePct: pct(aggLineCov, aggLineRel), lineCovered: aggLineCov, lineRelevant: aggLineRel,
        fnPct: pct(aggFnHit, aggFnTotal), fnHit: aggFnHit, fnTotal: aggFnTotal,
      },
      files: rows.map((r) => ({
        file: r.rel, linePct: r.linePct, lineCovered: r.lineCov, lineRelevant: r.lineRel,
        fnPct: r.fnPct, fnHit: r.fnHit, fnTotal: r.fnTotal, uncoveredRanges: r.ranges,
      })),
    };
    writeFileSync(args.json, JSON.stringify(out, null, 2));
    console.log(`\nJSON geschrieben: ${args.json}`);
  }
  console.log('');
}

main();
