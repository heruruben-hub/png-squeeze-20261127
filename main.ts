// png-squeeze: a lossless PNG recompressor for 1280x720 RGBA screenshots.
//
// Strategy (all deterministic, work-bounded, no clock / randomness / env input):
//   1. Decode the stored input PNG with Node's built-in zlib.
//   2. Reduce the colour type when it is exact: palette (<=256 colours, transparent
//      entries first so tRNS stays short), grey / grey+alpha, RGB (+tRNS key when the
//      image has a single fully-transparent colour), otherwise RGBA.
//   3. Screen each form with every fixed filter (0-4) and with per-row
//      minimum-sum filtering, at zlib level 9; a fixed filter keeps raw bytes
//      equal across repeated rows, which LZ77 matches far better than any
//      adaptive choice on screenshots. Then re-try the winning form with a
//      brute-force per-row choice (each row trial deflated at level 4 against
//      the preceding 32 KiB of filtered data) and with the filtered deflate
//      strategy, keeping the smallest stream.
//   5. Write a minimal PNG: IHDR, PLTE / tRNS only when needed, one IDAT, IEND.
//
// Only Node built-ins are used; nothing is installed and no network is touched.
// Runs as `node /bot/main.ts` (plain JavaScript in a .ts file, so Node 22's type
// stripping accepts it as-is). Input /input/<id>/image.png, output
// /output/<id>/image.png. MAKEFUN_INPUT_DIR / MAKEFUN_OUTPUT_DIR override the
// directories for local runs, as in the kit's starter.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { deflateSync, inflateSync, constants } from 'node:zlib';

const I = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const O = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';
const BRUTE_CONTEXT = 32768;
const BRUTE_LEVEL = 4;

// ---------------------------------------------------------------------------
// CRC-32 (ISO 3309, as PNG uses) and the minimal PNG chunk writer.
// ---------------------------------------------------------------------------
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(bytes, start, end) {
  let c = -1;
  for (let i = start; i < end; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

const ascii = (s) => Uint8Array.from(s, (ch) => ch.charCodeAt(0));

function pngOf(chunks) {
  let size = 8;
  for (const [, data] of chunks) size += 12 + data.length;
  const out = new Uint8Array(size);
  const view = new DataView(out.buffer);
  out.set([137, 80, 78, 71, 13, 10, 26, 10], 0);
  let at = 8;
  for (const [type, data] of chunks) {
    view.setUint32(at, data.length);
    out.set(ascii(type), at + 4);
    out.set(data, at + 8);
    view.setUint32(at + 8 + data.length, crc32(out, at + 4, at + 8 + data.length));
    at += 12 + data.length;
  }
  return out;
}

function ihdrOf(width, height, colourType) {
  const d = new Uint8Array(13);
  new DataView(d.buffer).setUint32(0, width);
  new DataView(d.buffer).setUint32(4, height);
  d[8] = 8;
  d[9] = colourType;
  return d;
}

// ---------------------------------------------------------------------------
// PNG decoder: any bit-depth-8, non-interlaced PNG of colour type 0/2/3/4/6,
// expanded to RGBA. (The inputs are stored type-6 PNGs; the general path costs
// nothing and keeps the program honest about its own output.)
// ---------------------------------------------------------------------------
const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = p > a ? p - a : a - p;
  const pb = p > b ? p - b : b - p;
  const pc = p > c ? p - c : c - p;
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

function decodePng(bytes) {
  if (bytes.length < 8 || bytes[0] !== 137 || bytes[1] !== 80 || bytes[2] !== 78 || bytes[3] !== 71) {
    throw new Error('not a PNG');
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = 8;
  let header = null;
  let palette = null;
  let trns = null;
  const idat = [];
  let ended = false;
  while (at < bytes.length) {
    if (ended) throw new Error('bytes after IEND');
    if (at + 12 > bytes.length) throw new Error('truncated chunk');
    const len = view.getUint32(at);
    if (at + 12 + len > bytes.length) throw new Error('chunk overruns file');
    const type = String.fromCharCode(bytes[at + 4], bytes[at + 5], bytes[at + 6], bytes[at + 7]);
    if (crc32(bytes, at + 4, at + 8 + len) !== view.getUint32(at + 8 + len)) throw new Error(`${type} CRC mismatch`);
    const data = bytes.subarray(at + 8, at + 8 + len);
    at += 12 + len;
    if (type === 'IHDR') {
      const dv = new DataView(data.buffer, data.byteOffset, 13);
      header = { width: dv.getUint32(0), height: dv.getUint32(4), depth: data[8], colourType: data[9] };
      if (header.depth !== 8 || !Object.hasOwn(CHANNELS, header.colourType)) throw new Error('unsupported IHDR');
    } else if (type === 'PLTE') palette = data;
    else if (type === 'tRNS') trns = data;
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') ended = true;
    else throw new Error(`unsupported chunk ${type}`);
  }
  if (!ended || !header || idat.length === 0) throw new Error('incomplete PNG');
  const { width, height, colourType } = header;
  const bpp = CHANNELS[colourType];
  const stride = width * bpp;
  const expected = height * (stride + 1);
  const raw = inflateSync(idat.length === 1 ? idat[0] : Buffer.concat(idat), { maxOutputLength: expected + 1 });
  if (raw.length !== expected) throw new Error('IDAT inflates to the wrong size');
  const samples = new Uint8Array(height * stride);
  for (let y = 0; y < height; y++) {
    const ft = raw[y * (stride + 1)];
    if (ft > 4) throw new Error(`bad filter type ${ft} on row ${y}`);
    const src = y * (stride + 1) + 1;
    const o = y * stride;
    const p = o - stride;
    if (ft === 0) samples.set(raw.subarray(src, src + stride), o);
    else if (ft === 1) {
      for (let i = 0; i < stride; i++) samples[o + i] = raw[src + i] + (i >= bpp ? samples[o + i - bpp] : 0);
    } else if (ft === 2) {
      for (let i = 0; i < stride; i++) samples[o + i] = raw[src + i] + (y > 0 ? samples[p + i] : 0);
    } else if (ft === 3) {
      for (let i = 0; i < stride; i++) {
        samples[o + i] = raw[src + i] + (((i >= bpp ? samples[o + i - bpp] : 0) + (y > 0 ? samples[p + i] : 0)) >> 1);
      }
    } else {
      for (let i = 0; i < stride; i++) {
        const a = i >= bpp ? samples[o + i - bpp] : 0;
        const b = y > 0 ? samples[p + i] : 0;
        const c = y > 0 && i >= bpp ? samples[p + i - bpp] : 0;
        samples[o + i] = raw[src + i] + paeth(a, b, c);
      }
    }
  }
  const n = width * height;
  const rgba = new Uint8Array(n * 4);
  if (colourType === 6) rgba.set(samples);
  else if (colourType === 2) {
    const key = trns === null ? -1 : (trns[1] << 16) | (trns[3] << 8) | trns[5];
    for (let i = 0, s = 0, d = 0; i < n; i++, s += 3, d += 4) {
      rgba[d] = samples[s];
      rgba[d + 1] = samples[s + 1];
      rgba[d + 2] = samples[s + 2];
      rgba[d + 3] = ((samples[s] << 16) | (samples[s + 1] << 8) | samples[s + 2]) === key ? 0 : 255;
    }
  } else if (colourType === 0) {
    const key = trns === null ? -1 : trns[1];
    for (let i = 0, d = 0; i < n; i++, d += 4) {
      const g = samples[i];
      rgba[d] = rgba[d + 1] = rgba[d + 2] = g;
      rgba[d + 3] = g === key ? 0 : 255;
    }
  } else if (colourType === 4) {
    for (let i = 0, s = 0, d = 0; i < n; i++, s += 2, d += 4) {
      rgba[d] = rgba[d + 1] = rgba[d + 2] = samples[s];
      rgba[d + 3] = samples[s + 1];
    }
  } else {
    const entries = palette.length / 3;
    const lut = new Uint8Array(entries * 4);
    for (let e = 0; e < entries; e++) {
      lut[e * 4] = palette[e * 3];
      lut[e * 4 + 1] = palette[e * 3 + 1];
      lut[e * 4 + 2] = palette[e * 3 + 2];
      lut[e * 4 + 3] = trns !== null && e < trns.length ? trns[e] : 255;
    }
    for (let i = 0, d = 0; i < n; i++, d += 4) {
      const e = samples[i];
      if (e >= entries) throw new Error('palette index out of range');
      rgba[d] = lut[e * 4];
      rgba[d + 1] = lut[e * 4 + 1];
      rgba[d + 2] = lut[e * 4 + 2];
      rgba[d + 3] = lut[e * 4 + 3];
    }
  }
  return { width, height, rgba };
}

// ---------------------------------------------------------------------------
// Image analysis: opacity, greyness, and the colour set (capped at 257, so a
// many-colour image is recognised without building a huge map).
// ---------------------------------------------------------------------------
function analyse(rgba) {
  const n = rgba.length >>> 2;
  const u32 = rgba.byteOffset % 4 === 0
    ? new Uint32Array(rgba.buffer, rgba.byteOffset, n)
    : new Uint32Array(rgba.slice().buffer);
  let opaque = true;
  let grey = true;
  const counts = new Map();
  let many = false;
  for (let i = 0, d = 0; i < n; i++, d += 4) {
    if (rgba[d + 3] !== 255) opaque = false;
    if (rgba[d] !== rgba[d + 1] || rgba[d] !== rgba[d + 2]) grey = false;
    if (!many) {
      const c = u32[i];
      const k = counts.get(c);
      if (k === undefined) {
        if (counts.size === 256) many = true;
        else counts.set(c, 1);
      } else counts.set(c, k + 1);
    }
  }
  let colours = null;
  if (!many) {
    colours = [...counts.keys()].map((c) => {
      const b = new Uint8Array(Uint32Array.of(c).buffer);
      return { rgba: [b[0], b[1], b[2], b[3]], word: c, count: counts.get(c) };
    });
  }
  return { opaque, grey, colours };
}

// The one fully-transparent value (grey or RGB) the image may key by tRNS
// instead of carrying an alpha channel: every non-opaque pixel is exactly that
// value at alpha 0, and no opaque pixel uses the same value. Null otherwise.
function transparentKey(rgba, grey) {
  let key = -1;
  for (let d = 0; d < rgba.length; d += 4) {
    const a = rgba[d + 3];
    if (a === 255) continue;
    if (a !== 0) return null;
    const v = grey ? rgba[d] : (rgba[d] << 16) | (rgba[d + 1] << 8) | rgba[d + 2];
    if (key === -1) key = v;
    else if (key !== v) return null;
  }
  if (key === -1) return null;
  for (let d = 0; d < rgba.length; d += 4) {
    if (rgba[d + 3] !== 255) continue;
    const v = grey ? rgba[d] : (rgba[d] << 16) | (rgba[d + 1] << 8) | rgba[d + 2];
    if (v === key) return null;
  }
  return key;
}

function samplesOf(rgba, ct) {
  const n = rgba.length >>> 2;
  if (ct === 6) return rgba;
  const ch = ct === 0 ? 1 : ct === 4 ? 2 : 3;
  const out = new Uint8Array(n * ch);
  for (let i = 0, d = 0, s = 0; i < n; i++, d += 4, s += ch) {
    if (ct === 0) out[s] = rgba[d];
    else if (ct === 4) {
      out[s] = rgba[d];
      out[s + 1] = rgba[d + 3];
    } else {
      out[s] = rgba[d];
      out[s + 1] = rgba[d + 1];
      out[s + 2] = rgba[d + 2];
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Palette form: transparent entries first (by alpha, so tRNS is exactly the
// leading non-opaque run), then by count or by luminance.
// ---------------------------------------------------------------------------
function paletteForm(rgba, colours, order) {
  const lum = (c) => 299 * c.rgba[0] + 587 * c.rgba[1] + 114 * c.rgba[2];
  const entries = [...colours].sort((x, y) => {
    const ta = x.rgba[3] === 255 ? 1 : 0;
    const tb = y.rgba[3] === 255 ? 1 : 0;
    if (ta !== tb) return ta - tb;
    if (ta === 0 && x.rgba[3] !== y.rgba[3]) return x.rgba[3] - y.rgba[3];
    if (order === 'luminance') return lum(x) - lum(y) || x.word - y.word;
    return y.count - x.count || x.word - y.word;
  });
  const index = new Map(entries.map((c, i) => [c.word, i]));
  const plte = new Uint8Array(entries.length * 3);
  let transparent = 0;
  entries.forEach((c, i) => {
    plte[i * 3] = c.rgba[0];
    plte[i * 3 + 1] = c.rgba[1];
    plte[i * 3 + 2] = c.rgba[2];
    if (c.rgba[3] !== 255) transparent = i + 1;
  });
  const trns = transparent === 0 ? null : Uint8Array.from(entries.slice(0, transparent), (c) => c.rgba[3]);
  const n = rgba.length >>> 2;
  const u32 = rgba.byteOffset % 4 === 0
    ? new Uint32Array(rgba.buffer, rgba.byteOffset, n)
    : new Uint32Array(rgba.slice().buffer);
  const indices = new Uint8Array(n);
  for (let i = 0; i < n; i++) indices[i] = index.get(u32[i]);
  return { colourType: 3, bpp: 1, samples: indices, plte, trns };
}

// ---------------------------------------------------------------------------
// Row filtering: all five filters of one row in a single pass, each into its
// own trial buffer, with the signed-sum cost of each.
// ---------------------------------------------------------------------------
function filterTrials(cur, prev, bpp, trials) {
  const n = cur.length;
  const sums = [0, 0, 0, 0, 0];
  for (let i = 0; i < n; i++) {
    const c = cur[i];
    const a = i >= bpp ? cur[i - bpp] : 0;
    const b = prev !== null ? prev[i] : 0;
    const cc = prev !== null && i >= bpp ? prev[i - bpp] : 0;
    const f0 = c;
    const f1 = (c - a) & 255;
    const f2 = (c - b) & 255;
    const f3 = (c - ((a + b) >> 1)) & 255;
    const f4 = (c - paeth(a, b, cc)) & 255;
    trials[0][i] = f0;
    trials[1][i] = f1;
    trials[2][i] = f2;
    trials[3][i] = f3;
    trials[4][i] = f4;
    sums[0] += f0 < 128 ? f0 : 256 - f0;
    sums[1] += f1 < 128 ? f1 : 256 - f1;
    sums[2] += f2 < 128 ? f2 : 256 - f2;
    sums[3] += f3 < 128 ? f3 : 256 - f3;
    sums[4] += f4 < 128 ? f4 : 256 - f4;
  }
  return sums;
}

// One filter of one row, computed directly (the fast path for a fixed filter
// choice, which needs only one of the five filters per row).
function filterOne(type, cur, prev, bpp, out) {
  const n = cur.length;
  if (type === 0) {
    out.set(cur);
    return;
  }
  for (let i = 0; i < n; i++) {
    const c = cur[i];
    const a = i >= bpp ? cur[i - bpp] : 0;
    const b = prev !== null ? prev[i] : 0;
    if (type === 1) out[i] = (c - a) & 255;
    else if (type === 2) out[i] = (c - b) & 255;
    else if (type === 3) out[i] = (c - ((a + b) >> 1)) & 255;
    else {
      const cc = prev !== null && i >= bpp ? prev[i - bpp] : 0;
      out[i] = (c - paeth(a, b, cc)) & 255;
    }
  }
}

// Filtered data of `samples` (height rows of width*bpp), one filter byte per
// row. `choice` is 'minsum' (per-row lowest signed sum), 'brute' (per-row
// smallest level-4 deflate against the preceding 32 KiB), or a fixed type 0-4.
function filtered(samples, width, height, bpp, choice) {
  const stride = width * bpp;
  const raw = new Uint8Array(height * (stride + 1));
  if (typeof choice === 'number') {
    for (let y = 0; y < height; y++) {
      const cur = samples.subarray(y * stride, (y + 1) * stride);
      const prev = y === 0 ? null : samples.subarray((y - 1) * stride, y * stride);
      const at = y * (stride + 1);
      raw[at] = choice;
      filterOne(choice, cur, prev, bpp, raw.subarray(at + 1, at + 1 + stride));
    }
    return raw;
  }
  const trials = Array.from({ length: 5 }, () => new Uint8Array(stride + 1));
  for (let t = 0; t < 5; t++) trials[t][0] = t;
  const bodies = trials.map((r) => r.subarray(1));
  for (let y = 0; y < height; y++) {
    const cur = samples.subarray(y * stride, (y + 1) * stride);
    const prev = y === 0 ? null : samples.subarray((y - 1) * stride, y * stride);
    const at = y * (stride + 1);
    let type;
    if (choice === 'minsum') {
      const sums = filterTrials(cur, prev, bpp, bodies);
      type = 0;
      for (let t = 1; t < 5; t++) if (sums[t] < sums[type]) type = t;
    } else {
      // Brute force: deflate each trial row at level 4 with the filtered data
      // written so far (up to 32 KiB) as the dictionary; keep the smallest.
      filterTrials(cur, prev, bpp, bodies);
      const before = raw.subarray(Math.max(0, at - BRUTE_CONTEXT), at);
      let best = Infinity;
      type = 0;
      for (let t = 0; t < 5; t++) {
        const len = deflateSync(trials[t], before.length === 0
          ? { level: BRUTE_LEVEL, memLevel: 8 }
          : { level: BRUTE_LEVEL, memLevel: 8, dictionary: before }).length;
        if (len < best) {
          best = len;
          type = t;
        }
      }
    }
    raw[at] = type;
    raw.set(bodies[type], at + 1);
  }
  return raw;
}

// The bytes a form's PLTE / tRNS chunks add to the file (12 bytes of framing each).
const chunkBytes = (form) =>
  (form.plte == null ? 0 : 12 + form.plte.length) + (form.trns == null ? 0 : 12 + form.trns.length);

// ---------------------------------------------------------------------------
// Compress one image: screen the exact forms with the fixed filters and
// minimum-sum filtering at zlib level 9, then spend the remaining effort on
// the winner (brute-force rows, filtered deflate strategy) and keep the
// smallest file.
// ---------------------------------------------------------------------------
function compress(rgba, width, height) {
  const { opaque, grey, colours } = analyse(rgba);
  const forms = [];
  if (colours !== null) {
    forms.push(paletteForm(rgba, colours, 'count'));
    forms.push(paletteForm(rgba, colours, 'luminance'));
    if (!grey) {
      // A non-grey palette image is held exactly by the palette alone.
      return finish(forms, width, height);
    }
  }
  const key = opaque ? null : transparentKey(rgba, grey);
  let ct;
  let trns = null;
  if (grey) {
    ct = opaque || key !== null ? 0 : 4;
    if (key !== null) trns = Uint8Array.of(0, key);
  } else {
    ct = opaque || key !== null ? 2 : 6;
    if (key !== null) trns = Uint8Array.of(0, key >>> 16, 0, (key >>> 8) & 0xff, 0, key & 0xff);
  }
  const bpp = { 0: 1, 2: 3, 4: 2, 6: 4 }[ct];
  forms.push({ colourType: ct, bpp, samples: samplesOf(rgba, ct), plte: null, trns });
  return finish(forms, width, height);
}

function finish(forms, width, height) {
  let best = null; // {form, raw, idat, bytes}
  // Screen every form with each fixed filter and with per-row minimum-sum:
  // a fixed filter keeps raw bytes equal across repeated rows, which zlib's
  // LZ77 then matches far better than any adaptive choice on screenshots.
  for (const form of forms) {
    for (const choice of [0, 1, 2, 3, 4, 'minsum']) {
      const raw = filtered(form.samples, width, height, form.bpp, choice);
      const idat = deflateSync(raw, { level: 9, chunkSize: 256 * 1024 });
      const bytes = idat.length + chunkBytes(form);
      if (best === null || bytes < best.bytes) best = { form, raw, idat, bytes };
    }
  }
  // Spend the remaining effort on the winner only: brute-force row filters,
  // and the filtered deflate strategy on both filtered variants.
  const { form } = best;
  const bruteRaw = filtered(form.samples, width, height, form.bpp, 'brute');
  for (const raw of [best.raw, bruteRaw]) {
    for (const strategy of [constants.Z_DEFAULT_STRATEGY, constants.Z_FILTERED]) {
      const idat = deflateSync(raw, { level: 9, strategy, chunkSize: 256 * 1024 });
      const bytes = idat.length + chunkBytes(form);
      if (bytes < best.bytes) best = { form, raw, idat, bytes };
    }
  }
  const chunks = [['IHDR', ihdrOf(width, height, form.colourType)]];
  if (form.plte !== null) chunks.push(['PLTE', form.plte]);
  if (form.trns !== null) chunks.push(['tRNS', form.trns]);
  chunks.push(['IDAT', new Uint8Array(best.idat)]);
  chunks.push(['IEND', new Uint8Array(0)]);
  return pngOf(chunks);
}

// ---------------------------------------------------------------------------
// Main: every instance in /input, in sorted order, to /output/<id>/image.png.
// ---------------------------------------------------------------------------
for (const id of readdirSync(I).sort()) {
  const image = decodePng(new Uint8Array(readFileSync(join(I, id, 'image.png'))));
  mkdirSync(join(O, id), { recursive: true });
  writeFileSync(join(O, id, 'image.png'), compress(image.rgba, image.width, image.height));
}
