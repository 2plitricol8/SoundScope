// Fonometro in streaming: ponderazioni A/C/Z, Fast/Slow, Leq, Lmax/Lmin, Ln. Port di soundscope/meter.py.
import { Cascade, weightingSections, percentiles, DB_FLOOR } from "./dsp.js";

export const TAU_FAST = 0.125;
export const TAU_SLOW = 1.0;
export const WEIGHTINGS = ["A", "C", "Z"];
const HISTORY_RATE = 8;          // campioni/s della storia usata per i percentili Ln
const HISTORY_SECONDS = 3600;    // 1 ora
const SETTLE_SECONDS = 1.0;      // transitorio iniziale escluso da Lmin e dai percentili
const MAX_BLOCKS = 20000;

function db(ms) {
  if (!isFinite(ms) || ms <= 0) return DB_FLOOR;
  return Math.max(10 * Math.log10(ms), DB_FLOOR);
}

class Channel {
  constructor(fs, weighting) {
    this.fs = fs;
    this.weighting = weighting;
    this.cascade = new Cascade(weightingSections(fs, weighting));
    this.af = Math.exp(-1 / (fs * TAU_FAST));
    this.as = Math.exp(-1 / (fs * TAU_SLOW));
    this.fast = 0; this.slow = 0;
    this.skip = Math.floor(SETTLE_SECONDS * fs);
    this.buf = new Float64Array(0);
    this.resetStats();
  }

  resetStats() {
    this.sumsq = 0; this.count = 0;
    this.maxFast = 0; this.maxSlow = 0;
    this.minFast = Infinity; this.minSlow = Infinity;
    this.maxAbs = 0;
    this.blocks = []; this.blockHead = 0;           // coda (somma dei quadrati, n campioni)
    this.history = [];
    this.histStep = Math.max(1, Math.floor(this.fs / HISTORY_RATE));
    this.histPhase = 0;
    this.pct = null; this.pctTime = 0;
  }

  process(x) {
    const n = x.length;
    if (this.buf.length < n) this.buf = new Float64Array(n);
    const y = this.cascade.process(x, this.buf);
    const { af, as } = this;
    let fast = this.fast, slow = this.slow;
    let s = 0, cnt = 0, mf = this.maxFast, ms = this.maxSlow, nf = this.minFast, ns = this.minSlow, ma = this.maxAbs;
    for (let i = 0; i < n; i++) {
      const p = y[i] * y[i];
      fast = (1 - af) * p + af * fast;
      slow = (1 - as) * p + as * slow;
      if (this.skip > 0) { this.skip--; continue; }
      s += p; cnt++;
      if (fast > mf) mf = fast;
      if (slow > ms) ms = slow;
      if (fast < nf) nf = fast;
      if (slow < ns) ns = slow;
      const a = Math.abs(x[i]);
      if (a > ma) ma = a;
      if (this.histPhase <= 0) { this.history.push(fast); this.histPhase = this.histStep; }
      this.histPhase--;
    }
    this.fast = fast; this.slow = slow;
    if (cnt) {
      this.sumsq += s; this.count += cnt;
      this.blocks.push(s, cnt);
      if (this.blocks.length - this.blockHead > 2 * MAX_BLOCKS) this.blockHead += 2;
      if (this.blockHead > 4000) { this.blocks.splice(0, this.blockHead); this.blockHead = 0; }
      this.maxFast = mf; this.maxSlow = ms; this.minFast = nf; this.minSlow = ns; this.maxAbs = ma;
      const maxHist = HISTORY_RATE * HISTORY_SECONDS;
      if (this.history.length > maxHist + 1000) this.history.splice(0, this.history.length - maxHist);
    }
  }

  leqWindowMs(seconds) {
    const need = Math.floor(seconds * this.fs);
    let total = 0, n = 0;
    for (let i = this.blocks.length - 2; i >= this.blockHead; i -= 2) {
      total += this.blocks[i]; n += this.blocks[i + 1];
      if (n >= need) break;
    }
    return n ? total / n : NaN;
  }

  availableSeconds() {
    let n = 0;
    for (let i = this.blockHead + 1; i < this.blocks.length; i += 2) n += this.blocks[i];
    return n / this.fs;
  }

  percentilesMs() {
    const now = performance.now();
    if (this.pct && now - this.pctTime < 500) return this.pct;
    this.pct = this.history.length < 2 ? [NaN, NaN, NaN] : percentiles(this.history, [90, 50, 10]);
    this.pctTime = now;
    return this.pct;
  }
}

export class SoundLevelMeter {
  constructor(fs) {
    this.fs = fs;
    this.offsetDb = 0;
    this.calibrated = false;
    this.channels = Object.fromEntries(WEIGHTINGS.map((w) => [w, new Channel(fs, w)]));
  }

  process(x) { for (const w of WEIGHTINGS) this.channels[w].process(x); }
  resetStats() { for (const w of WEIGHTINGS) this.channels[w].resetStats(); }
  clearHistory() { for (const w of WEIGHTINGS) { this.channels[w].history = []; this.channels[w].pct = null; } }

  reading(weighting = "A", timeWeighting = "F", windowS = 10) {
    const ch = this.channels[weighting], off = this.offsetDb;
    const fast = timeWeighting.toUpperCase().startsWith("F");
    const last = fast ? ch.fast : ch.slow, mx = fast ? ch.maxFast : ch.maxSlow, mn = fast ? ch.minFast : ch.minSlow;
    const leq = ch.count ? ch.sumsq / ch.count : NaN;
    const [l10, l50, l90] = ch.percentilesMs();
    const zpeak = this.channels.Z.maxAbs;
    const peak = zpeak > 0 ? 20 * Math.log10(zpeak) : DB_FLOOR;
    const d = (ms) => (isFinite(ms) ? db(ms) + off : NaN);
    return {
      level: d(last), leq: d(leq), leqWindow: d(ch.leqWindowMs(windowS)),
      lmax: mx > 0 ? d(mx) : NaN, lmin: isFinite(mn) ? d(mn) : NaN,
      l10: d(l10), l50: d(l50), l90: d(l90),
      peak: peak + off, calibrated: this.calibrated, seconds: ch.count / this.fs,
    };
  }

  rawLeqDbfs(seconds = 3, weighting = "Z") {
    const ch = this.channels[weighting];
    return { level: db(ch.leqWindowMs(seconds)), available: Math.min(seconds, ch.availableSeconds()) };
  }

  /** Imposta l'offset in modo che gli ultimi `seconds` di segnale valgano referenceDb. */
  calibrate(referenceDb, seconds = 3, weighting = "Z") {
    const { level, available } = this.rawLeqDbfs(seconds, weighting);
    if (available < 0.8 * seconds) throw new Error("Dati insufficienti: attendi qualche secondo di acquisizione.");
    if (level < -90) throw new Error("Segnale troppo debole (< -90 dBFS): la sorgente di riferimento e' accesa e vicina al microfono?");
    this.setOffset(referenceDb - level);
    return this.offsetDb;
  }

  setOffset(offsetDb, calibrated = true) { this.offsetDb = offsetDb; this.calibrated = calibrated; }
  clearCalibration() { this.offsetDb = 0; this.calibrated = false; }
}
