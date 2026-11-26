// Keep the printed format, including every leading zero. An item number alone
// is not evidence of a GTIN, even when its digits pass the check.
export function normalizeGtin(raw) {
  if (typeof raw !== 'string') return '';
  const digits = raw.trim().replace(/[ -]/g, '');
  if (!/^(?:\d{8}|\d{12,14})$/.test(digits) || /^0+$/.test(digits)) return '';
  let sum = 0;
  let weight = 3;
  for (let i = digits.length - 2; i >= 0; i--) {
    sum += Number(digits[i]) * weight;
    weight = 4 - weight;
  }
  return (10 - sum % 10) % 10 === Number(digits[digits.length - 1]) ? digits : '';
}

const L_WIDTHS = ['3211','2221','2122','1411','1132','1231','1114','1312','1213','3112'];
const LEFT_PARITY = ['LLLLLL','LLGLGG','LLGGLG','LLGGGL','LGLLGG','LGGLLG','LGGGLL','LGLGLG','LGLGGL','LGGLGL'];
const leftPatterns = L_WIDTHS.map((widths, digit) => ({widths: Array.from(widths, Number), digit, parity: 'L'}));
const allPatterns = [...leftPatterns, ...leftPatterns.map(({widths, digit}) => ({widths: [...widths].reverse(), digit, parity: 'G'}))];

function guardWidth(runs, start, length) {
  let sum = 0;
  for (let i = 0; i < length; i++) sum += runs[start + i];
  const module = sum / length;
  for (let i = 0; i < length; i++) {
    if (Math.abs(runs[start + i] / module - 1) > 0.55) return 0;
  }
  return module;
}

function readDigit(runs, offset, base, patterns) {
  const module = (runs[offset] + runs[offset+1] + runs[offset+2] + runs[offset+3]) / 7;
  if (module < base * .58 || module > base * 1.65) return null;
  const widths = runs.slice(offset, offset + 4).map(width => width / module);
  let best = null;
  let error = Infinity;
  let second = Infinity;
  for (const pattern of patterns) {
    let diff = 0;
    for (let i = 0; i < 4; i++) diff += Math.abs(widths[i] - pattern.widths[i]);
    if (diff < error) {
      second = error;
      error = diff;
      best = pattern;
    } else if (diff < second) {
      second = diff;
    }
  }
  return error <= 1.65 && second - error >= .18 ? best : null;
}

function readSymbol(runs, start, base, digitsPerSide) {
  const middle = start + 3 + digitsPerSide * 4;
  const end = middle + 5 + digitsPerSide * 4;
  if (end + 3 >= runs.length) return '';
  const middleWidth = guardWidth(runs, middle, 5);
  const endWidth = guardWidth(runs, end, 3);
  if (middleWidth < base * .58 || middleWidth > base * 1.65 ||
      endWidth < base * .58 || endWidth > base * 1.65 || runs[end+3] < endWidth * 4.5) return '';

  let parity = '', left = '', right = '';
  const leftPatternsForSize = digitsPerSide === 6 ? allPatterns : leftPatterns;
  for (let i = 0; i < digitsPerSide; i++) {
    const a = readDigit(runs, start + 3 + i*4, (base + middleWidth)/2, leftPatternsForSize);
    const b = readDigit(runs, middle + 5 + i*4, (middleWidth + endWidth)/2, leftPatterns);
    if (!a || !b) return '';
    parity += a.parity;
    left += a.digit;
    right += b.digit;
  }
  if (digitsPerSide === 4) return normalizeGtin(left + right);
  const lead = LEFT_PARITY.indexOf(parity);
  return lead < 0 ? '' : normalizeGtin(String(lead) + left + right);
}

// Each entry is an alternating light/dark run, starting and ending in light.
// Local midpoints compensate for shadows across a shelf label.
function lightDarkRuns(pixels) {
  const blockSize = 48;
  const blocks = Math.ceil(pixels.length / blockSize);
  const lows = new Uint8Array(blocks).fill(255), highs = new Uint8Array(blocks);
  let globalLow = 255, globalHigh = 0;
  for (let i = 0; i < pixels.length; i++) {
    const block = Math.floor(i / blockSize);
    const v = pixels[i];
    lows[block] = Math.min(lows[block], v);
    highs[block] = Math.max(highs[block], v);
    globalLow = Math.min(globalLow, v);
    globalHigh = Math.max(globalHigh, v);
  }
  if (globalHigh - globalLow < 25) return [];
  const runs = [0];
  let dark = false;
  for (let block = 0; block < blocks; block++) {
    const prev = Math.max(0, block - 1), next = Math.min(blocks - 1, block + 1);
    const low = Math.min(lows[prev], lows[block], lows[next]);
    const high = Math.max(highs[prev], highs[block], highs[next]);
    const threshold = high - low >= 25 ? (low + high)/2 : (globalLow + globalHigh)/2;
    const stop = Math.min(pixels.length, (block + 1)*blockSize);
    for (let i = block*blockSize; i < stop; i++) {
      const current = pixels[i] < threshold;
      if (current !== dark) { runs.push(0); dark = current; }
      runs[runs.length - 1]++;
    }
  }
  if (dark) runs.push(0);
  return runs;
}

function decodeRuns(runs, hits) {
  for (let start = 1; start + 43 < runs.length; start += 2) {
    const base = guardWidth(runs, start, 3);
    if (!base || runs[start-1] < base * 4.5) continue;
    for (const count of [4, 6]) {
      const gtin = readSymbol(runs, start, base, count);
      if (gtin) hits.add(gtin);
    }
  }
}

function scanDirection(image, vertical, slope, found) {
  const {width, height, data} = image;
  const length = vertical ? height : width;
  const cross = vertical ? width : height;
  const step = Math.max(2, Math.min(12, Math.floor(cross / 85)));
  const pixels = new Uint8Array(length);
  // Require agreement on two distinct parallel scan lines. An isolated sequence
  // in lettering can accidentally look like a valid short barcode.
  const prior = new Set();
  const extra = Math.ceil(Math.abs(slope) * length/2);
  for (let offset = -extra; offset < cross + extra; offset += step) {
    for (let i = 0; i < length; i++) {
      const j = Math.round(offset + (i - length/2)*slope);
      if (j < 0 || j >= cross) { pixels[i] = 255; continue; }
      const p = 4*(vertical ? i*width + j : j*width + i);
      pixels[i] = (data[p]*77 + data[p+1]*150 + data[p+2]*29) >> 8;
    }
    const runs = lightDarkRuns(pixels);
    if (runs.length < 45) continue;
    const hits = new Set();
    decodeRuns(runs, hits);
    decodeRuns(runs.reverse(), hits);
    for (const code of hits) {
      if (prior.has(code)) found.set(code.padStart(14, '0'), code);
      prior.add(code);
    }
  }
}

async function detectNative(canvas) {
  const Detector = globalThis.BarcodeDetector;
  if (!Detector) return [];
  const allowed = ['ean_13', 'ean_8', 'upc_a', 'itf'];
  const supported = Detector.getSupportedFormats ? await Detector.getSupportedFormats() : allowed;
  const formats = allowed.filter(format => supported.includes(format));
  if (!formats.length) return [];
  return (await new Detector({formats}).detect(canvas))
    .filter(result => formats.includes(result.format) && (result.format !== 'itf' || result.rawValue.length === 14))
    .map(result => normalizeGtin(result.rawValue)).filter(Boolean);
}

export async function readRetailBarcodes(canvas) {
  if (!canvas?.width || !canvas.height) return [];
  const found = new Map();
  let timer;
  try {
    const codes = await Promise.race([detectNative(canvas), new Promise(resolve => {
      timer = setTimeout(() => resolve([]), 1800);
    })]);
    for (const code of codes) found.set(code.padStart(14, '0'), code);
  } catch { /* Unsupported image or detector: try the bundled EAN reader. */ }
  finally { clearTimeout(timer); }
  if (found.size) return [...found.values()];

  let image;
  try {
    image = canvas.getContext('2d', {willReadFrequently:true}).getImageData(0, 0, canvas.width, canvas.height);
  } catch { return []; }
  for (const slope of [0, .45, -.45, 1, -1]) {
    scanDirection(image, false, slope, found);
    scanDirection(image, true, slope, found);
    if (found.size) break;
    // Allow the photo dialog to paint between orientations on slower phones.
    await new Promise(resolve => setTimeout(resolve, 0));
  }
  return [...found.values()];
}
