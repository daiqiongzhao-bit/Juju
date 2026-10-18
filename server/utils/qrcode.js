/**
 * Modul: QR-Code-Generator (QR Code Generator)
 * Zweck: QR-Code (ISO/IEC 18004) ohne externe Abhängigkeit erzeugen — der
 *        TOTP-Einrichtungsdialog braucht ein scannbares Bild, und das Projekt
 *        bleibt bewusst dependency-light.
 *
 * Umfang: Byte-Modus (8-bit), Fehlerkorrektur-Level M, Versionen 1–10.
 * Das deckt otpauth://-URIs (typisch 80–170 Zeichen) ab; längere Eingaben
 * werfen einen Fehler statt still einen unlesbaren Code zu liefern.
 *
 * Abhängigkeiten: keine (nur Buffer)
 */

// --------------------------------------------------------
// GF(256) — Arithmetik für die Reed-Solomon-Fehlerkorrektur
// --------------------------------------------------------
// Primitives Polynom x^8 + x^4 + x^3 + x^2 + 1 (0x11D).
const GF_EXP = new Uint8Array(512);
const GF_LOG = new Uint8Array(256);

(() => {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    GF_EXP[i] = x;
    GF_LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) GF_EXP[i] = GF_EXP[i - 255];
})();

/** Multiplikation in GF(256). */
function gfMul(a, b) {
  if (a === 0 || b === 0) return 0;
  return GF_EXP[GF_LOG[a] + GF_LOG[b]];
}

/**
 * Reed-Solomon-Divisor (Generatorpolynom) für `degree` Prüfbytes.
 * @param {number} degree
 * @returns {Uint8Array}
 */
function rsDivisor(degree) {
  const result = new Uint8Array(degree);
  result[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < degree; j++) {
      result[j] = gfMul(result[j], root);
      if (j + 1 < degree) result[j] ^= result[j + 1];
    }
    root = gfMul(root, 0x02);
  }
  return result;
}

/**
 * Reed-Solomon-Rest (die Prüfbytes) zu einem Datenblock.
 * @param {Uint8Array} data
 * @param {Uint8Array} divisor
 * @returns {Uint8Array}
 */
function rsRemainder(data, divisor) {
  const result = new Uint8Array(divisor.length);
  for (const b of data) {
    const factor = b ^ result[0];
    result.copyWithin(0, 1);
    result[result.length - 1] = 0;
    for (let i = 0; i < divisor.length; i++) result[i] ^= gfMul(divisor[i], factor);
  }
  return result;
}

// --------------------------------------------------------
// QR-Tabellen (Fehlerkorrektur-Level M, Versionen 1–10)
// --------------------------------------------------------

/** Prüfbytes pro Block, Index = Version (0 = ungenutzt). */
const ECC_PER_BLOCK = [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26];

/** Anzahl Fehlerkorrektur-Blöcke, Index = Version. */
const ECC_BLOCKS = [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5];

/** Maximal unterstützte Version (Byte-Modus, Level M). */
const MAX_VERSION = 10;

/** Zentren der Ausrichtungs-Muster, Index = Version. */
const ALIGN_POS = [
  null,
  [],            // v1: keine
  [6, 18],       // v2
  [6, 22],       // v3
  [6, 26],       // v4
  [6, 30],       // v5
  [6, 34],       // v6
  [6, 22, 38],   // v7
  [6, 24, 42],   // v8
  [6, 26, 46],   // v9
  [6, 28, 50],   // v10
];

/** Anzahl der Roh-Datenbits (vor Fehlerkorrektur) einer Version. */
function rawDataBits(version) {
  let result = (16 * version + 128) * version + 64;
  if (version >= 2) {
    const numAlign = Math.floor(version / 7) + 2;
    result -= (25 * numAlign - 10) * numAlign - 55;
    if (version >= 7) result -= 36;
  }
  return result;
}

/** Bit `i` eines Werts (0 = höchstwertig), als Boolean. */
function getBit(value, i) {
  return ((value >>> i) & 1) !== 0;
}

/** Hängt die oberen `len` Bits von `value` an den Bit-Stream an. */
function appendBits(bits, value, len) {
  for (let i = len - 1; i >= 0; i--) bits.push((value >>> i) & 1);
}

// --------------------------------------------------------
// Matrix-Aufbau
// --------------------------------------------------------

/**
 * Baut die vollständige QR-Matrix (Boolean[][] — true = dunkles Modul).
 * @param {number[]} dataCodewords Daten-Codewörter (bereits mit Padding)
 * @param {number} version
 * @returns {{ modules: boolean[][], size: number }}
 */
function buildMatrix(dataCodewords, version) {
  const size = version * 4 + 17;
  const modules = Array.from({ length: size }, () => new Array(size).fill(false));
  const isFunction = Array.from({ length: size }, () => new Array(size).fill(false));

  const setFunctionModule = (x, y, dark) => {
    if (x < 0 || y < 0 || x >= size || y >= size) return;
    modules[y][x] = dark;
    isFunction[y][x] = true;
  };

  // Timing-Muster (Zeile/Spalte 6).
  for (let i = 0; i < size; i++) {
    setFunctionModule(6, i, i % 2 === 0);
    setFunctionModule(i, 6, i % 2 === 0);
  }

  // Finder-Muster (7×7) samt Separatoren an drei Ecken.
  const drawFinder = (cx, cy) => {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const dist = Math.max(Math.abs(dx), Math.abs(dy));
        const xx = cx + dx;
        const yy = cy + dy;
        if (xx < 0 || yy < 0 || xx >= size || yy >= size) continue;
        setFunctionModule(xx, yy, dist !== 2 && dist !== 4);
      }
    }
  };
  drawFinder(3, 3);
  drawFinder(size - 4, 3);
  drawFinder(3, size - 4);

  // Ausrichtungs-Muster (5×5) — nicht auf den Finder-Positionen.
  const align = ALIGN_POS[version];
  for (let i = 0; i < align.length; i++) {
    for (let j = 0; j < align.length; j++) {
      const skip =
        (i === 0 && j === 0) ||
        (i === 0 && j === align.length - 1) ||
        (i === align.length - 1 && j === 0);
      if (skip) continue;
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          setFunctionModule(align[j] + dx, align[i] + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
        }
      }
    }
  }

  // Format-Information (zwei Kopien), zuerst mit Dummy-Werten.
  const drawFormatBits = (mask) => {
    const data = (0 << 3) | mask; // Level M = 0b00
    let rem = data;
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    const bits = ((data << 10) | rem) ^ 0x5412;

    for (let i = 0; i <= 5; i++) setFunctionModule(8, i, getBit(bits, i));
    setFunctionModule(8, 7, getBit(bits, 6));
    setFunctionModule(8, 8, getBit(bits, 7));
    setFunctionModule(7, 8, getBit(bits, 8));
    for (let i = 9; i < 15; i++) setFunctionModule(14 - i, 8, getBit(bits, i));

    for (let i = 0; i < 8; i++) setFunctionModule(size - 1 - i, 8, getBit(bits, i));
    for (let i = 8; i < 15; i++) setFunctionModule(8, size - 15 + i, getBit(bits, i));
    setFunctionModule(8, size - 8, true); // immer dunkel
  };
  drawFormatBits(0);

  // Versions-Information (ab Version 7, zwei Kopien).
  if (version >= 7) {
    let rem = version;
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    const bits = (version << 12) | rem;
    for (let i = 0; i < 18; i++) {
      const bit = getBit(bits, i);
      const a = size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      setFunctionModule(a, b, bit);
      setFunctionModule(b, a, bit);
    }
  }

  // Datenbits in Zickzack-Spalten (von rechts nach links, paarweise).
  let bitIndex = 0;
  const totalBits = dataCodewords.length * 8;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5; // Timing-Spalte überspringen
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? size - 1 - vert : vert;
        if (!isFunction[y][x] && bitIndex < totalBits) {
          modules[y][x] = getBit(dataCodewords[bitIndex >>> 3], 7 - (bitIndex & 7));
          bitIndex++;
        }
      }
    }
  }

  // Maske wählen: alle acht anwenden, Strafe bewerten, beste behalten.
  let bestMask = 0;
  let bestPenalty = Infinity;
  let bestModules = null;
  for (let mask = 0; mask < 8; mask++) {
    const candidate = modules.map((row) => row.slice());
    applyMask(candidate, isFunction, mask);
    drawFormatBitsOn(candidate, size, mask);
    const penalty = penaltyScore(candidate);
    if (penalty < bestPenalty) {
      bestPenalty = penalty;
      bestMask = mask;
      bestModules = candidate;
    }
  }
  void bestMask;
  return { modules: bestModules, size };
}

/**
 * Schreibt die Format-Bits (inkl. Maske) direkt in eine gegebene Matrix.
 * @param {boolean[][]} modules
 * @param {number} size
 * @param {number} mask
 */
function drawFormatBitsOn(modules, size, mask) {
  const data = (0 << 3) | mask; // Level M
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  const bits = ((data << 10) | rem) ^ 0x5412;

  for (let i = 0; i <= 5; i++) modules[i][8] = getBit(bits, i);
  modules[7][8] = getBit(bits, 6);
  modules[8][8] = getBit(bits, 7);
  modules[8][7] = getBit(bits, 8);
  for (let i = 9; i < 15; i++) modules[8][14 - i] = getBit(bits, i);

  for (let i = 0; i < 8; i++) modules[8][size - 1 - i] = getBit(bits, i);
  for (let i = 8; i < 15; i++) modules[size - 15 + i][8] = getBit(bits, i);
  modules[size - 8][8] = true;
}

/**
 * Wendet Maskenmuster `mask` auf alle Nicht-Funktions-Module an.
 * @param {boolean[][]} modules
 * @param {boolean[][]} isFunction
 * @param {number} mask
 */
function applyMask(modules, isFunction, mask) {
  const size = modules.length;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (isFunction[y][x]) continue;
      let invert;
      switch (mask) {
        case 0: invert = (x + y) % 2 === 0; break;
        case 1: invert = y % 2 === 0; break;
        case 2: invert = x % 3 === 0; break;
        case 3: invert = (x + y) % 3 === 0; break;
        case 4: invert = (Math.floor(y / 2) + Math.floor(x / 3)) % 2 === 0; break;
        case 5: invert = ((x * y) % 2) + ((x * y) % 3) === 0; break;
        case 6: invert = (((x * y) % 2) + ((x * y) % 3)) % 2 === 0; break;
        default: invert = (((x + y) % 2) + ((x * y) % 3)) % 2 === 0; break;
      }
      if (invert) modules[y][x] = !modules[y][x];
    }
  }
}

/**
 * Strafwertung nach ISO/IEC 18004 (Regeln 1–4). Kleiner = besser.
 * @param {boolean[][]} modules
 * @returns {number}
 */
function penaltyScore(modules) {
  const size = modules.length;
  let result = 0;

  // Regel 1: fünf oder mehr gleiche Module in einer Reihe.
  const runScore = (run) => (run >= 5 ? run - 2 : 0);
  for (let y = 0; y < size; y++) {
    let runColor = modules[y][0];
    let runLen = 1;
    for (let x = 1; x < size; x++) {
      if (modules[y][x] === runColor) {
        runLen++;
      } else {
        result += runScore(runLen);
        runColor = modules[y][x];
        runLen = 1;
      }
    }
    result += runScore(runLen);
  }
  for (let x = 0; x < size; x++) {
    let runColor = modules[0][x];
    let runLen = 1;
    for (let y = 1; y < size; y++) {
      if (modules[y][x] === runColor) {
        runLen++;
      } else {
        result += runScore(runLen);
        runColor = modules[y][x];
        runLen = 1;
      }
    }
    result += runScore(runLen);
  }

  // Regel 2: 2×2-Blöcke gleicher Farbe.
  for (let y = 0; y < size - 1; y++) {
    for (let x = 0; x < size - 1; x++) {
      const c = modules[y][x];
      if (c === modules[y][x + 1] && c === modules[y + 1][x] && c === modules[y + 1][x + 1]) {
        result += 3;
      }
    }
  }

  // Regel 3: Finder-ähnliche Muster 1:1:3:1:1, davor bzw. danach vier helle
  // Module. Als 11-Bit-Fenster je Zeile/Spalte geschoben: 0x05D entspricht
  // „4 hell + 1011101", 0x5D0 entspricht „1011101 + 4 hell" (1 = dunkel).
  const P3_BEFORE = 0x05d;
  const P3_AFTER = 0x5d0;
  for (let y = 0; y < size; y++) {
    let histRow = 0;
    let histCol = 0;
    for (let x = 0; x < size; x++) {
      histRow = ((histRow << 1) | (modules[y][x] ? 1 : 0)) & 0x7ff;
      histCol = ((histCol << 1) | (modules[x][y] ? 1 : 0)) & 0x7ff;
      if (x >= 10) {
        if (histRow === P3_BEFORE || histRow === P3_AFTER) result += 40;
        if (histCol === P3_BEFORE || histCol === P3_AFTER) result += 40;
      }
    }
  }

  // Regel 4: Abweichung des Dunkelanteils von 50 %.
  let dark = 0;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) if (modules[y][x]) dark++;
  }
  const total = size * size;
  const k = Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1;
  result += k * 10;

  return result;
}

// --------------------------------------------------------
// Öffentliche API
// --------------------------------------------------------

/**
 * Erzeugt die QR-Matrix für einen UTF-8-Text (Byte-Modus).
 * @param {string} text
 * @returns {{ modules: boolean[][], size: number, version: number }}
 */
export function qrMatrix(text) {
  const data = Array.from(Buffer.from(String(text), 'utf8'));

  // Kleinste passende Version suchen. Kapazität = Roh-Codewörter abzüglich der
  // Prüfbytes — die Fehlerkorrektur belegt Platz, den die Nutzdaten nicht nutzen
  // dürfen (sonst stimmt der Codewort-Count unten nicht).
  let version = -1;
  let dataCapacityBits = 0;
  for (let v = 1; v <= MAX_VERSION; v++) {
    const rawCodewordsV = Math.floor(rawDataBits(v) / 8);
    const capacity = (rawCodewordsV - ECC_PER_BLOCK[v] * ECC_BLOCKS[v]) * 8;
    // 4 Bit Modus-Kennung + Längenfeld (8 Bit bis v9, 16 Bit ab v10).
    const headerBits = 4 + (v <= 9 ? 8 : 16);
    if (data.length * 8 + headerBits <= capacity) {
      version = v;
      dataCapacityBits = capacity;
      break;
    }
  }
  if (version < 0) {
    throw new Error(`[QR] Input too long for QR version ${MAX_VERSION} (${data.length} bytes).`);
  }

  // Bit-Stream: Modus, Länge, Daten, Terminator, Padding.
  const bits = [];
  appendBits(bits, 0b0100, 4); // Byte-Modus
  appendBits(bits, data.length, version <= 9 ? 8 : 16);
  for (const b of data) appendBits(bits, b, 8);
  appendBits(bits, 0, Math.min(4, dataCapacityBits - bits.length));
  appendBits(bits, 0, (8 - (bits.length % 8)) % 8);
  for (let pad = 0xec; bits.length < dataCapacityBits; pad ^= 0xec ^ 0x11) {
    appendBits(bits, pad, 8);
  }

  const dataCodewords = [];
  for (let i = 0; i < bits.length; i += 8) {
    let byte = 0;
    for (let j = 0; j < 8; j++) byte = (byte << 1) | bits[i + j];
    dataCodewords.push(byte);
  }

  // Fehlerkorrektur: Blöcke aufteilen, Prüfbytes berechnen, verschachteln.
  const numBlocks = ECC_BLOCKS[version];
  const blockEccLen = ECC_PER_BLOCK[version];
  const rawCodewords = Math.floor(rawDataBits(version) / 8);
  const numShortBlocks = numBlocks - (rawCodewords % numBlocks);
  const shortBlockLen = Math.floor(rawCodewords / numBlocks);

  if (dataCodewords.length !== rawCodewords - blockEccLen * numBlocks) {
    // defensive: darf bei korrekten Tabellen nie eintreten
    throw new Error('[QR] Internal error: data codeword count mismatch.');
  }

  const blocks = [];
  const divisor = rsDivisor(blockEccLen);
  for (let i = 0, k = 0; i < numBlocks; i++) {
    const len = shortBlockLen - blockEccLen + (i < numShortBlocks ? 0 : 1);
    const dat = dataCodewords.slice(k, k + len);
    k += len;
    const ecc = rsRemainder(Uint8Array.from(dat), divisor);
    const block = Array.from(dat);
    if (i < numShortBlocks) block.push(0); // Platzhalter für das Verschachteln
    blocks.push(block.concat(Array.from(ecc)));
  }

  const result = [];
  for (let i = 0; i < blocks[0].length; i++) {
    blocks.forEach((block, j) => {
      if (i !== shortBlockLen - blockEccLen || j >= numShortBlocks) result.push(block[i]);
    });
  }

  const { modules, size } = buildMatrix(result, version);
  return { modules, size, version };
}

/**
 * Rendert einen Text als eigenständiges SVG ({{ … }} aus dem HTML-Template
 * heraus sicher einsetzbar — keine externen Referenzen, keine Skripte).
 *
 * @param {string} text Zu kodierender Inhalt
 * @param {{ moduleSize?: number, margin?: number, dark?: string, light?: string }} [opts]
 * @returns {string} SVG-Markup
 */
export function qrSvg(text, opts = {}) {
  const {
    moduleSize = 4,
    margin = 4,
    dark = '#111827',
    light = '#ffffff',
  } = opts;

  const { modules, size } = qrMatrix(text);
  const dimension = (size + margin * 2) * moduleSize;

  // Zusammenhängende dunkle Läufe pro Zeile zu einem <rect> zusammenfassen —
  // deutlich kompakter als ein Rechteck pro Modul.
  const rects = [];
  for (let y = 0; y < size; y++) {
    let x = 0;
    while (x < size) {
      if (!modules[y][x]) { x++; continue; }
      let run = 1;
      while (x + run < size && modules[y][x + run]) run++;
      rects.push(
        `<rect x="${(x + margin) * moduleSize}" y="${(y + margin) * moduleSize}" ` +
        `width="${run * moduleSize}" height="${moduleSize}"/>`
      );
      x += run;
    }
  }

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${dimension} ${dimension}" ` +
    `width="${dimension}" height="${dimension}" shape-rendering="crispEdges" role="img">` +
    `<rect width="${dimension}" height="${dimension}" fill="${light}"/>` +
    `<g fill="${dark}">${rects.join('')}</g>` +
    `</svg>`
  );
}

export { qrMatrix as matrix, qrSvg as svg };
