// DSP puro (nessuna dipendenza dal browser): ponderazioni, FFT, bande d'ottava.
// Port fedele di soundscope/dsp.py.
//
// Convenzione dei livelli: "RMS rispetto al fondo scala digitale" (dBFS):
//   L = 10*log10(media dei quadrati dei campioni normalizzati a +-1)
// Una sinusoide a fondo scala vale quindi -3.01 dBFS. Sommando l'offset di calibrazione si ottengono dB SPL.

export const F1 = 20.598997, F2 = 107.65265, F3 = 737.86223, F4 = 12194.217;
export const G10 = Math.pow(10, 0.3);
export const DB_FLOOR = -200;
export const TONE_MIN_PROMINENCE_DB = 20;

export const WINDOWS = {
  "Hann": "hann",
  "Blackman-Harris": "blackmanharris",
  "Flat-top": "flattop",
  "Rettangolare": "boxcar",
};
const MAINLOBE = { hann: 2, blackmanharris: 4, flattop: 5, boxcar: 1 };

// ------------------------------------------------------------------ ponderazioni
export function aWeightingDb(f) {
  const f2 = f * f;
  const ra = (F4 * F4 * f2 * f2) /
    ((f2 + F1 * F1) * Math.sqrt((f2 + F2 * F2) * (f2 + F3 * F3)) * (f2 + F4 * F4));
  return 20 * Math.log10(Math.max(ra, 1e-30)) + 2.0;
}

export function cWeightingDb(f) {
  const f2 = f * f;
  const rc = (F4 * F4 * f2) / ((f2 + F1 * F1) * (f2 + F4 * F4));
  return 20 * Math.log10(Math.max(rc, 1e-30)) + 0.06;
}

export function weightingDb(w, f) {
  return w === "A" ? aWeightingDb(f) : w === "C" ? cWeightingDb(f) : 0;
}

function prewarp(f, fs) {
  return f >= 0.45 * fs ? f : (fs / Math.PI) * Math.tan((Math.PI * f) / fs);
}

// polo analogico reale a f Hz -> polo digitale (trasformata bilineare con pre-distorsione)
function digitalPole(f, fs) {
  const s = -2 * Math.PI * prewarp(f, fs);
  return (2 * fs + s) / (2 * fs - s);
}

function sectionMag(sec, f, fs) {
  const w = (2 * Math.PI * f) / fs;
  const c1 = Math.cos(w), s1 = -Math.sin(w), c2 = Math.cos(2 * w), s2 = -Math.sin(2 * w);
  const nr = sec.b[0] + sec.b[1] * c1 + sec.b[2] * c2, ni = sec.b[1] * s1 + sec.b[2] * s2;
  const dr = sec.a[0] + sec.a[1] * c1 + sec.a[2] * c2, di = sec.a[1] * s1 + sec.a[2] * s2;
  return Math.hypot(nr, ni) / Math.hypot(dr, di);
}

/** Sezioni biquad {b:[3], a:[3]} della ponderazione, normalizzate a 0 dB a 1 kHz. null per 'Z'. */
export function weightingSections(fs, w) {
  if (w === "Z") return null;
  // [zeri, frequenze dei poli] per sezione. Gli zeri a z=1 vengono dagli zeri in s=0, quelli a z=-1
  // dalla differenza di grado (poli - zeri) mandata all'infinito dalla bilineare.
  let spec;
  if (w === "A") spec = [[[1, 1], [F1, F1]], [[1, 1], [F2, F3]], [[-1, -1], [F4, F4]]];
  else if (w === "C") spec = [[[1, 1], [F1, F1]], [[-1, -1], [F4, F4]]];
  else throw new Error("Ponderazione sconosciuta: " + w);
  const secs = spec.map(([z, pf]) => {
    const p = pf.map((f) => digitalPole(f, fs));
    return { b: [1, -(z[0] + z[1]), z[0] * z[1]], a: [1, -(p[0] + p[1]), p[0] * p[1]] };
  });
  let g = 1;
  for (const s of secs) g *= sectionMag(s, 1000, fs);
  secs[0].b = secs[0].b.map((v) => v / g);
  return secs;
}

/** Cascata di biquad in forma trasposta II, con stato. */
export class Cascade {
  constructor(secs) {
    this.secs = secs;
    this.z = secs ? secs.map(() => [0, 0]) : null;
  }
  /** Filtra x (Float32Array/Float64Array) scrivendo in out (Float64Array della stessa lunghezza). */
  process(x, out) {
    const n = x.length;
    for (let i = 0; i < n; i++) out[i] = x[i];
    if (!this.secs) return out;
    for (let k = 0; k < this.secs.length; k++) {
      const { b, a } = this.secs[k];
      const b0 = b[0], b1 = b[1], b2 = b[2], a1 = a[1], a2 = a[2];
      let s1 = this.z[k][0], s2 = this.z[k][1];
      for (let i = 0; i < n; i++) {
        const v = out[i];
        const y = b0 * v + s1;
        s1 = b1 * v - a1 * y + s2;
        s2 = b2 * v - a2 * y;
        out[i] = y;
      }
      this.z[k][0] = s1;
      this.z[k][1] = s2;
    }
    return out;
  }
}

/** Modulo (dB) della cascata alla frequenza f. */
export function cascadeResponseDb(secs, f, fs) {
  if (!secs) return 0;
  let g = 1;
  for (const s of secs) g *= sectionMag(s, f, fs);
  return 20 * Math.log10(g);
}

// ------------------------------------------------------------------ FFT
const plans = new Map();
function plan(n) {
  let p = plans.get(n);
  if (p) return p;
  if (n < 2 || (n & (n - 1)) !== 0) throw new Error("FFT: la lunghezza deve essere una potenza di 2");
  const bits = Math.log2(n);
  const rev = new Uint32Array(n);
  for (let i = 0; i < n; i++) {
    let r = 0, v = i;
    for (let b = 0; b < bits; b++) { r = (r << 1) | (v & 1); v >>= 1; }
    rev[i] = r;
  }
  const cos = new Float64Array(n / 2), sin = new Float64Array(n / 2);
  for (let k = 0; k < n / 2; k++) { cos[k] = Math.cos((2 * Math.PI * k) / n); sin[k] = Math.sin((2 * Math.PI * k) / n); }
  p = { rev, cos, sin, re: new Float64Array(n), im: new Float64Array(n) };
  plans.set(n, p);
  return p;
}

/** FFT diretta sul posto (re, im: Float64Array di lunghezza potenza di 2). */
export function fft(re, im) {
  const n = re.length;
  const { rev, cos, sin } = plan(n);
  for (let i = 0; i < n; i++) {
    const j = rev[i];
    if (j > i) {
      let t = re[i]; re[i] = re[j]; re[j] = t;
      t = im[i]; im[i] = im[j]; im[j] = t;
    }
  }
  for (let size = 2; size <= n; size <<= 1) {
    const half = size >> 1, step = n / size;
    for (let i = 0; i < n; i += size) {
      for (let j = 0, k = 0; j < half; j++, k += step) {
        const wr = cos[k], wi = -sin[k];
        const a = i + j, b = a + half;
        const tr = re[b] * wr - im[b] * wi, ti = re[b] * wi + im[b] * wr;
        re[b] = re[a] - tr; im[b] = im[a] - ti;
        re[a] += tr; im[a] += ti;
      }
    }
  }
}

const winCache = new Map();
export function getWindow(name, n) {
  const key = name + ":" + n;
  let w = winCache.get(key);
  if (w) return w;
  const arr = new Float64Array(n);
  const c = {
    hann: [0.5, 0.5],
    blackmanharris: [0.35875, 0.48829, 0.14128, 0.01168],
    flattop: [0.21557895, 0.41663158, 0.277263158, 0.083578947, 0.006947368],
    boxcar: [1],
  }[name];
  if (!c) throw new Error("Finestra sconosciuta: " + name);
  let sumsq = 0;
  for (let i = 0; i < n; i++) {
    let v = 0;
    for (let k = 0; k < c.length; k++) v += (k % 2 ? -1 : 1) * c[k] * Math.cos((2 * Math.PI * k * i) / n);
    arr[i] = v;
    sumsq += v * v;
  }
  w = { w: arr, sumsq };
  winCache.set(key, w);
  return w;
}

/** Spettro di potenza monolatero: media dei quadrati attribuita a ciascun bin (n/2+1 valori).
 *  La somma dei bin e' la media dei quadrati del segnale; un tono di ampiezza A vale A^2/2 sul suo lobo. */
export function powerSpectrum(x, windowName = "hann", out = null) {
  const n = x.length;
  const { re, im } = plan(n);
  let mean = 0;
  for (let i = 0; i < n; i++) mean += x[i];
  mean /= n;
  const { w, sumsq } = getWindow(windowName, n);
  for (let i = 0; i < n; i++) { re[i] = (x[i] - mean) * w[i]; im[i] = 0; }
  fft(re, im);
  const m = n / 2 + 1;
  const p = out && out.length === m ? out : new Float64Array(m);
  const k = 2 / (n * sumsq);
  for (let i = 0; i < m; i++) p[i] = (re[i] * re[i] + im[i] * im[i]) * k;
  p[0] *= 0.5;
  p[m - 1] *= 0.5;
  return p;
}

export function toDb(ms, floor = 1e-20) {
  return 10 * Math.log10(Math.max(ms, floor));
}

// ------------------------------------------------------------------ analisi del tono
/** {freq, power}: frequenza (interpolata) e potenza del picco dominante (integrata sul lobo principale). */
export function dominantPeak(ms, fs, n, fmin = 20, windowName = "hann") {
  const df = fs / n;
  const k0 = Math.max(1, Math.ceil(fmin / df));
  if (k0 >= ms.length - 1) return { freq: NaN, power: 0 };
  let k = k0, best = -1;
  for (let i = k0; i < ms.length - 1; i++) if (ms[i] > best) { best = ms[i]; k = i; }
  let delta = 0;
  if (k >= 1 && k < ms.length - 1) {
    const a = Math.log(ms[k - 1] + 1e-30), b = Math.log(ms[k] + 1e-30), c = Math.log(ms[k + 1] + 1e-30);
    const denom = a - 2 * b + c;
    if (denom < 0) delta = Math.max(-0.5, Math.min(0.5, (0.5 * (a - c)) / denom));
  }
  const hw = MAINLOBE[windowName] ?? 2;
  let sum = 0;
  for (let i = Math.max(k - hw, 0); i < Math.min(k + hw + 1, ms.length); i++) sum += ms[i];
  return { freq: (k + delta) * df, power: sum };
}

/** Di quanti dB il picco in f0 emerge dai bin appena fuori dal suo lobo principale. */
export function toneProminenceDb(ms, f0, fs, n, windowName = "hann") {
  if (!isFinite(f0) || f0 <= 0) return -Infinity;
  const df = fs / n, hw = MAINLOBE[windowName] ?? 2, k = Math.round(f0 / df);
  let peak = 0;
  for (let i = Math.max(k - 1, 0); i < Math.min(k + 2, ms.length); i++) peak = Math.max(peak, ms[i]);
  let s = 0, c = 0;
  for (const sg of [-1, 1]) for (let d = hw + 3; d < hw + 9; d++) {
    const i = k + sg * d;
    if (i >= 1 && i < ms.length - 1) { s += ms[i]; c++; }
  }
  if (!c || peak <= 0) return -Infinity;
  return 10 * Math.log10(peak / Math.max(s / c, 1e-30));
}

/** Distorsione armonica totale (rapporto, non percentuale). */
export function thd(ms, fs, n, f0, windowName = "hann", maxHarmonic = 10) {
  if (!isFinite(f0) || f0 <= 0) return NaN;
  const df = fs / n, hw = MAINLOBE[windowName] ?? 2;
  const bandPower = (f) => {
    const k = Math.round(f / df);
    let s = 0;
    for (let i = Math.max(k - hw, 0); i < Math.min(k + hw + 1, ms.length); i++) s += ms[i];
    return s;
  };
  const p1 = bandPower(f0);
  if (p1 <= 0) return NaN;
  let ph = 0;
  for (let h = 2; h <= maxHarmonic; h++) {
    const fh = h * f0;
    if (fh >= fs / 2 - hw * df) break;
    ph += bandPower(fh);
  }
  return Math.sqrt(ph / p1);
}

// ------------------------------------------------------------------ bande d'ottava / terzi
const NOMINAL_THIRD = ["25", "31.5", "40", "50", "63", "80", "100", "125", "160", "200", "250", "315",
  "400", "500", "630", "800", "1k", "1.25k", "1.6k", "2k", "2.5k", "3.15k", "4k",
  "5k", "6.3k", "8k", "10k", "12.5k", "16k", "20k"];
const NOMINAL_OCTAVE = ["31.5", "63", "125", "250", "500", "1k", "2k", "4k", "8k", "16k"];

/** {centers: Float64Array, labels: string[]}; fraction = 1 (ottave) o 3 (terzi). */
export function bandCenters(fraction) {
  let k0, k1, labels;
  if (fraction === 1) { k0 = -5; k1 = 5; labels = NOMINAL_OCTAVE; }
  else if (fraction === 3) { k0 = -16; k1 = 14; labels = NOMINAL_THIRD; }
  else throw new Error("fraction deve essere 1 o 3");
  const centers = new Float64Array(k1 - k0);
  for (let i = 0; i < centers.length; i++) centers[i] = 1000 * Math.pow(G10, (k0 + i) / fraction);
  return { centers, labels: labels.slice() };
}

/** Potenza (media dei quadrati) per banda da uno spettro di potenza; NaN oltre Nyquist o senza bin. */
export function bandLevels(ms, fs, n, centers, fraction) {
  const df = fs / n;
  const csum = new Float64Array(ms.length + 1);
  for (let i = 0; i < ms.length; i++) csum[i + 1] = csum[i] + ms[i];
  const out = new Float64Array(centers.length);
  for (let b = 0; b < centers.length; b++) {
    const lo = centers[b] * Math.pow(G10, -1 / (2 * fraction));
    const hi = centers[b] * Math.pow(G10, 1 / (2 * fraction));
    const i0 = Math.min(Math.max(Math.ceil(lo / df - 1e-9), 0), ms.length);
    const i1 = Math.min(Math.max(Math.ceil(hi / df - 1e-9), 0), ms.length);
    out[b] = i1 > i0 && hi <= fs / 2 ? csum[i1] - csum[i0] : NaN;
  }
  return out;
}

// ------------------------------------------------------------------ utilita'
/** Percentili con interpolazione lineare (come numpy.percentile). values: array non ordinato. */
export function percentiles(values, ps) {
  const s = Float64Array.from(values).sort();
  const n = s.length;
  return ps.map((p) => {
    if (!n) return NaN;
    const r = (p / 100) * (n - 1), lo = Math.floor(r), hi = Math.ceil(r);
    return s[lo] + (s[hi] - s[lo]) * (r - lo);
  });
}
