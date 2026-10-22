// SoundScope Web: interfaccia. Il DSP sta in dsp.js / meter.js (provati contro l'implementazione Python).
import * as D from "./dsp.js";
import { SoundLevelMeter } from "./meter.js";

const $ = (id) => document.getElementById(id);
const store = {
  get(k, d = null) { try { const v = localStorage.getItem(k); return v === null ? d : v; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* storage non disponibile */ } },
  del(k) { try { localStorage.removeItem(k); } catch { /* idem */ } },
};


// Campi numerici come menu a scelta (su iPad compare la ruota di selezione, non la tastiera)
const NUM_SPECS = {
  ymin: [-200, 200, 10, -120], ymax: [-200, 200, 10, 0], bMin: [-200, 200, 10, -110], bMax: [-200, 200, 10, -10],
  sgMin: [-200, 200, 5, -110], sgMax: [-200, 200, 5, -30],
  trigLevel: [-1, 1, 0.05, 0], avg: [0, 0.95, 0.05, 0.6],
};
const roundTo = (v, step) => +(Math.round(v / step) * step).toFixed(2);
function setNum(id, v) {
  const sel = $(id);
  const s = String(+(+v).toFixed(2));
  if (![...sel.options].some((o) => o.value === s)) {            // valore fuori elenco: lo aggiunge in ordine
    const opt = new Option(s, s);
    const next = [...sel.options].find((o) => parseFloat(o.value) > parseFloat(s));
    sel.add(opt, next || null);
  }
  sel.value = s;
}
for (const [id, [lo, hi, step, def]] of Object.entries(NUM_SPECS)) {
  const sel = $(id);
  for (let v = lo; v <= hi + 1e-9; v += step) { const s = String(+v.toFixed(2)); sel.append(new Option(s, s)); }
  setNum(id, def);
}

// ------------------------------------------------------------------ stato
const S = {
  running: false, kind: null,       // 'mic' | 'demo'
  fs: 48000, ctx: null, stream: null, node: null, demoTimer: null, wakeLock: null,
  ring: null, meter: null, devKey: "default",
  trackSettings: null, frames: 0, fps: 0, fpsT: performance.now(),
  prevOffset: 0,
  avg: null, avgN: 0,
};

class Ring {
  constructor(n) { this.buf = new Float32Array(n); this.pos = 0; this.filled = 0; }
  write(x) {
    const n = this.buf.length;
    if (x.length >= n) { this.buf.set(x.subarray(x.length - n)); this.pos = 0; this.filled = n; return; }
    const first = Math.min(x.length, n - this.pos);
    this.buf.set(x.subarray(0, first), this.pos);
    if (first < x.length) this.buf.set(x.subarray(first), 0);
    this.pos = (this.pos + x.length) % n;
    this.filled = Math.min(n, this.filled + x.length);
  }
  latest(count, out = null) {
    const n = this.buf.length;
    count = Math.min(count, n);
    const res = out && out.length === count ? out : new Float32Array(count);
    let start = this.pos - count;
    if (start < 0) {
      start += n;
      res.set(this.buf.subarray(start), 0);
      res.set(this.buf.subarray(0, this.pos), n - start);
    } else res.set(this.buf.subarray(start, this.pos));
    return res;
  }
}

function feed(chunk) {
  S.ring.write(chunk);
  S.meter.process(chunk);
}

// ------------------------------------------------------------------ sorgenti
async function listDevices() {
  try {
    const devs = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === "audioinput");
    const sel = $("device"), cur = sel.value;
    sel.innerHTML = "";
    sel.append(new Option("Microfono predefinito", ""));
    devs.forEach((d, i) => { if (d.deviceId && d.deviceId !== "default") sel.append(new Option(d.label || "Ingresso " + (i + 1), d.deviceId)); });
    if ([...sel.options].some((o) => o.value === cur)) sel.value = cur;
  } catch { /* elenco non disponibile */ }
}

function setupSession(fs, kind, devKey) {
  S.fs = fs; S.kind = kind; S.devKey = devKey;
  S.ring = new Ring(Math.round(fs * 30));
  S.meter = new SoundLevelMeter(fs);
  S.avg = null;
  const saved = parseFloat(store.get(`soundscope.cal.${devKey}.${Math.round(fs)}`));
  if (isFinite(saved)) S.meter.setOffset(saved);
  S.prevOffset = S.meter.offsetDb;
  rescaleForOffset(0, S.meter.offsetDb);
  S.running = true;
  sgReset();
  updateButtons();
}

async function startMic() {
  if (!navigator.mediaDevices?.getUserMedia) throw new Error("Questo browser non permette l'accesso al microfono (serve HTTPS).");
  const id = $("device").value;
  const audio = { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 };
  if (id) audio.deviceId = { exact: id };
  S.stream = await navigator.mediaDevices.getUserMedia({ audio });
  const track = S.stream.getAudioTracks()[0];
  S.trackSettings = track.getSettings();
  const Ctx = window.AudioContext || window.webkitAudioContext;
  S.ctx = new Ctx({ latencyHint: "interactive" });
  await S.ctx.resume();
  await S.ctx.audioWorklet.addModule("worklet.js");
  const src = S.ctx.createMediaStreamSource(S.stream);
  S.node = new AudioWorkletNode(S.ctx, "capture", { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 1 });
  S.node.port.onmessage = (e) => feed(e.data);
  const mute = S.ctx.createGain();
  mute.gain.value = 0;                          // il nodo deve essere collegato all'uscita per essere eseguito
  src.connect(S.node).connect(mute).connect(S.ctx.destination);
  const label = track.label || "default";
  setupSession(S.ctx.sampleRate, "mic", label);
  S.ctx.addEventListener?.("statechange", () => { if (S.running && S.ctx && S.ctx.state !== "running") setStatus("Audio sospeso dal sistema (" + S.ctx.state + ")"); });
  track.addEventListener("ended", () => { if (S.running) { stop(); setStatus("Microfono scollegato"); } });
  await listDevices();                          // dopo il permesso le etichette sono disponibili
  try { S.wakeLock = await navigator.wakeLock?.request("screen"); } catch { /* facoltativo */ }
}

function startDemo() {
  const fs = 48000;
  setupSession(fs, "demo", "demo");
  let n = 0, t0 = performance.now(), seed = 12345;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296 - 0.5; };
  let lp = 0, lp2 = 0;
  S.demoTimer = setInterval(() => {
    const want = Math.floor(((performance.now() - t0) / 1000) * fs);
    while (n + 1024 <= want) {
      const x = new Float32Array(1024);
      for (let i = 0; i < 1024; i++, n++) {
        const t = n / fs, ph = t % 8;
        let v = 0.15 * Math.sin(2 * Math.PI * 1000 * t) + 0.004 * Math.sin(2 * Math.PI * 2000 * t);
        v += 0.03 * Math.sin(2 * Math.PI * 50 * t) + 0.01 * Math.sin(2 * Math.PI * 100 * t);
        const w = rnd();
        lp += 0.02 * (w - lp); lp2 += 0.3 * (w - lp2);
        v += 0.5 * lp + 0.01 * lp2;                           // rumore di fondo "rosa" approssimato
        if (ph >= 3 && ph < 3.6) v += 0.5 * w * Math.exp(-(ph - 3) * 8);   // "battito di mani" a banda larga
        if (ph >= 5 && ph < 6) v += 0.2 * Math.sin(2 * Math.PI * 440 * t);
        x[i] = Math.max(-1, Math.min(1, v));
      }
      feed(x);
    }
  }, 20);
}

async function start(kind) {
  if (S.running) stop();
  setStatus(kind === "mic" ? "Richiesta del microfono…" : "Avvio demo…");
  try {
    if (kind === "mic") await startMic(); else startDemo();
    setStatus(describeSource());
  } catch (e) {
    stop();
    const msg = e && e.name === "NotAllowedError" ? "Permesso negato: abilita il microfono per questo sito nelle impostazioni di Safari."
      : e && e.name === "NotFoundError" ? "Nessun microfono trovato." : (e && e.message) || String(e);
    setStatus("Errore"); showWarn(msg);
  }
}

function stop() {
  S.running = false;
  clearInterval(S.demoTimer); S.demoTimer = null;
  try { S.node?.port && (S.node.port.onmessage = null); S.node?.disconnect(); } catch { /* gia' scollegato */ }
  try { S.stream?.getTracks().forEach((t) => t.stop()); } catch { /* idem */ }
  try { S.ctx?.close(); } catch { /* idem */ }
  try { S.wakeLock?.release(); } catch { /* idem */ }
  S.node = S.stream = S.ctx = S.wakeLock = null;
  setStatus("Fermo");
  updateButtons();
  renderMeterIdle();
}

function describeSource() {
  if (S.kind === "demo") return "Demo (segnale simulato) · 48000 Hz";
  return `Acquisizione · ${Math.round(S.fs)} Hz`;
}

function setStatus(t) { $("status").textContent = t; }
function showWarn(t) { const w = $("warn"); w.textContent = t || ""; w.hidden = !t; }
function updateButtons() {
  $("startBtn").textContent = S.running && S.kind === "mic" ? "■ Ferma" : "▶ Avvia";
  $("startBtn").classList.toggle("on", S.running && S.kind === "mic");
  $("demoBtn").textContent = S.running && S.kind === "demo" ? "■ Ferma demo" : "Demo";
  $("demoBtn").classList.toggle("on", S.running && S.kind === "demo");
  $("device").disabled = S.running && S.kind === "mic";
}

// ------------------------------------------------------------------ canvas
const views = {};
function setupCanvas(id) {
  const c = $(id), v = { c, ctx: c.getContext("2d"), w: 0, h: 0, dpr: 1 };
  const fit = () => {
    const r = c.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    const w = Math.max(1, Math.round(r.width)), h = Math.max(1, Math.round(r.height));
    if (w !== v.w || h !== v.h || dpr !== v.dpr) {
      v.w = w; v.h = h; v.dpr = dpr;
      c.width = Math.round(w * dpr); c.height = Math.round(h * dpr);
      v.resized = true;
    }
  };
  v.fit = fit;
  views[id] = v;
  return v;
}
const vScope = setupCanvas("scope"), vSpec = setupCanvas("spectrum"), vSg = setupCanvas("sgram"),
  vSgAxis = setupCanvas("sgramAxis"), vBands = setupCanvas("bands"), vHist = setupCanvas("hist");

function begin(v) {
  v.fit();
  v.ctx.setTransform(v.dpr, 0, 0, v.dpr, 0, 0);
  return v.ctx;
}

const COL = { grid: "#1f2a36", grid2: "#2b3a4a", text: "#7f8fa1", trace: "#4ade80", spec: "#38bdf8", ref: "#e879f9", zero: "#475569" };
const FONT = '11px ui-monospace, "SF Mono", Menlo, monospace';

function niceFreqTicks(fmin, fmax) {
  const t = [];
  for (let d = 1; d <= 100000; d *= 10) for (const m of [1, 2, 5]) { const f = d * m; if (f >= fmin && f <= fmax) t.push(f); }
  return t;
}
function fmtHz(f) { return f >= 1000 ? (f / 1000) + "k" : String(f); }
function fmtDb(v, d = 1) { return isFinite(v) ? v.toFixed(d) : "—"; }

// ------------------------------------------------------------------ oscilloscopio
const TDIVS = [0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 50, 100];     // ms/div
const VDIVS = [0.005, 0.01, 0.02, 0.05, 0.1, 0.2, 0.25, 0.5];  // FS/div
$("tdiv").innerHTML = TDIVS.map((t) => `<option value="${t}"${t === 1 ? " selected" : ""}>${t} ms/div</option>`).join("");
$("vdiv").innerHTML = VDIVS.map((v) => `<option value="${v}"${v === 0.1 ? " selected" : ""}>${v} FS/div</option>`).join("");
let frozenScope = null;
let scopeBuf = null;

function findTrigger(x, level, rising, from, to, hyst) {
  // ultimo attraversamento del livello nell'intervallo [from, to), con isteresi
  let armed = false, found = -1;
  for (let i = Math.max(from - 64, 1); i < to; i++) {
    if (rising) {
      if (x[i - 1] < level - hyst) armed = true;
      if (armed && x[i - 1] < level && x[i] >= level) { found = i; armed = false; }
    } else {
      if (x[i - 1] > level + hyst) armed = true;
      if (armed && x[i - 1] > level && x[i] <= level) { found = i; armed = false; }
    }
  }
  return found;
}

function drawScope() {
  const ctx = begin(vScope), W = vScope.w, H = vScope.h;
  ctx.fillStyle = "#0b0f14"; ctx.fillRect(0, 0, W, H);
  const L = 44, R = 8, T = 6, B = 18, pw = W - L - R, ph = H - T - B;
  const vdiv = parseFloat($("vdiv").value), tdiv = parseFloat($("tdiv").value);
  ctx.font = FONT; ctx.lineWidth = 1;
  for (let i = 0; i <= 10; i++) {                       // griglia: 10 divisioni orizzontali, 8 verticali
    const x = Math.round(L + (pw * i) / 10) + 0.5;
    ctx.strokeStyle = i === 0 || i === 10 ? COL.grid2 : COL.grid; ctx.beginPath(); ctx.moveTo(x, T); ctx.lineTo(x, T + ph); ctx.stroke();
    if (i % 2 === 0) { ctx.fillStyle = COL.text; ctx.textAlign = "center"; ctx.fillText(String(+(i * tdiv).toFixed(2)), x, H - 4); }
  }
  for (let j = -4; j <= 4; j++) {
    const y = Math.round(T + ph / 2 - (ph / 8) * j) + 0.5;
    ctx.strokeStyle = j === 0 ? COL.zero : COL.grid; ctx.beginPath(); ctx.moveTo(L, y); ctx.lineTo(L + pw, y); ctx.stroke();
    ctx.fillStyle = COL.text; ctx.textAlign = "right"; ctx.fillText((j * vdiv).toFixed(vdiv < 0.05 ? 3 : 2), L - 4, y + 4);
  }
  ctx.fillStyle = COL.text; ctx.textAlign = "left"; ctx.fillText("ms", L + pw - 14, H - 4 - 10);
  if (!S.running) return null;
  const fs = S.fs, N = Math.max(16, Math.round((fs * tdiv * 10) / 1000));
  let seg;
  if ($("freeze").checked && frozenScope) seg = frozenScope;
  else {
    const total = Math.min(S.ring.buf.length, Math.max(N * 3, N + 2048));
    scopeBuf = S.ring.latest(total, scopeBuf && scopeBuf.length === total ? scopeBuf : null);
    seg = scopeBuf;
  }
  if ($("freeze").checked && !frozenScope) frozenScope = Float32Array.from(seg); else if (!$("freeze").checked) frozenScope = null;
  const pre = Math.round(N * 0.1);
  let start = seg.length - N;
  if ($("trigMode").value === "auto") {
    const lvl = parseFloat($("trigLevel").value) || 0;
    const i = findTrigger(seg, lvl, $("trigEdge").value === "rise", pre, seg.length - (N - pre), 0.01);
    if (i >= 0) start = i - pre;
  }
  start = Math.max(0, Math.min(start, seg.length - N));
  // traccia: min/max per colonna quando ci sono piu' campioni che pixel
  const sx = pw / N, sy = ph / 8 / vdiv;
  const yOf = (v) => T + ph / 2 - Math.max(-4.2 * vdiv, Math.min(4.2 * vdiv, v)) * sy;
  ctx.save(); ctx.beginPath(); ctx.rect(L, T, pw, ph); ctx.clip();
  ctx.strokeStyle = COL.trace; ctx.lineWidth = 1.5; ctx.beginPath();
  if (N > pw * 2) {
    for (let px = 0; px < pw; px++) {
      const a = start + Math.floor((px * N) / pw), b = start + Math.floor(((px + 1) * N) / pw);
      let mn = Infinity, mx = -Infinity;
      for (let i = a; i < b; i++) { const v = seg[i]; if (v < mn) mn = v; if (v > mx) mx = v; }
      ctx.moveTo(L + px + 0.5, yOf(mn)); ctx.lineTo(L + px + 0.5, yOf(mx));
    }
  } else {
    for (let i = 0; i < N; i++) { const x = L + i * sx, y = yOf(seg[start + i]); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); }
  }
  ctx.stroke();
  if ($("trigMode").value === "auto") {                  // marcatore di trigger
    const ty = yOf(parseFloat($("trigLevel").value) || 0);
    ctx.setLineDash([2, 4]); ctx.strokeStyle = "#f59e0b"; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(L, ty); ctx.lineTo(L + pw, ty); ctx.moveTo(L + pre * sx, T); ctx.lineTo(L + pre * sx, T + ph); ctx.stroke(); ctx.setLineDash([]);
  }
  ctx.restore();
  let mn = Infinity, mx = -Infinity, ss = 0;
  for (let i = start; i < start + N; i++) { const v = seg[i]; if (v < mn) mn = v; if (v > mx) mx = v; ss += v * v; }
  return { vpp: mx - mn, rms: 10 * Math.log10(Math.max(ss / N, 1e-20)) };
}

// ------------------------------------------------------------------ spettro
for (const n of [1024, 2048, 4096, 8192, 16384, 32768]) $("fftSize").append(new Option(String(n), n));
$("fftSize").value = "8192";
for (const k of Object.keys(D.WINDOWS)) $("window").append(new Option(k, D.WINDOWS[k]));
let specMs = null, specDb = null, specKey = "";
let lastTone = null;

function computeSpectrum() {
  const n = parseInt($("fftSize").value), win = $("window").value;
  if (!S.running || S.ring.filled < n) return null;
  const x = S.ring.latest(n);
  const ms = D.powerSpectrum(x, win);
  const key = n + win + S.fs;
  const a = Math.min(0.95, Math.max(0, parseFloat($("avg").value) || 0));
  if (!S.avg || S.avg.length !== ms.length || specKey !== key) { S.avg = Float64Array.from(ms); specKey = key; }
  else for (let i = 0; i < ms.length; i++) S.avg[i] = a * S.avg[i] + (1 - a) * ms[i];
  return { ms: S.avg, n, win };
}

function drawSpectrum(sp) {
  const ctx = begin(vSpec), W = vSpec.w, H = vSpec.h;
  ctx.fillStyle = "#0b0f14"; ctx.fillRect(0, 0, W, H);
  const L = 44, R = 8, T = 6, B = 18, pw = W - L - R, ph = H - T - B;
  const ymin = parseFloat($("ymin").value), ymax = parseFloat($("ymax").value);
  const logf = $("logf").checked, nyq = S.fs / 2, fmin = 20, fmax = nyq;
  const xOf = (f) => (logf ? (Math.log10(Math.max(f, fmin)) - Math.log10(fmin)) / (Math.log10(fmax) - Math.log10(fmin)) : f / fmax) * pw + L;
  const fOf = (x) => (logf ? Math.pow(10, Math.log10(fmin) + ((x - L) / pw) * (Math.log10(fmax) - Math.log10(fmin))) : ((x - L) / pw) * fmax);
  const yOf = (v) => T + ((ymax - v) / (ymax - ymin)) * ph;
  ctx.font = FONT; ctx.lineWidth = 1;
  const step = ymax - ymin > 80 ? 20 : 10;
  for (let v = Math.ceil(ymin / step) * step; v <= ymax; v += step) {
    const y = Math.round(yOf(v)) + 0.5;
    ctx.strokeStyle = COL.grid; ctx.beginPath(); ctx.moveTo(L, y); ctx.lineTo(L + pw, y); ctx.stroke();
    ctx.fillStyle = COL.text; ctx.textAlign = "right"; ctx.fillText(String(v), L - 4, y + 4);
  }
  const ticks = logf ? niceFreqTicks(fmin, fmax) : Array.from({ length: Math.floor(fmax / 2000) + 1 }, (_, i) => i * 2000);
  for (const f of ticks) {
    const x = Math.round(xOf(f)) + 0.5;
    ctx.strokeStyle = String(f).startsWith("1") || !logf ? COL.grid2 : COL.grid; ctx.beginPath(); ctx.moveTo(x, T); ctx.lineTo(x, T + ph); ctx.stroke();
    if (!logf || String(f)[0] !== "5" || f >= 500) { ctx.fillStyle = COL.text; ctx.textAlign = "center"; ctx.fillText(fmtHz(f), x, H - 4); }
  }
  ctx.save(); ctx.translate(11, T + ph / 2); ctx.rotate(-Math.PI / 2); ctx.textAlign = "center"; ctx.fillStyle = COL.text;
  ctx.fillText(S.meter && S.meter.calibrated ? "dB SPL" : "dBFS", 0, 0); ctx.restore();
  if (!sp) return;
  const off = S.meter.offsetDb, df = S.fs / sp.n, ms = sp.ms, nb = ms.length;
  if (!specDb || specDb.length !== nb) specDb = new Float32Array(nb);
  for (let i = 0; i < nb; i++) specDb[i] = 10 * Math.log10(Math.max(ms[i], 1e-20)) + off;
  ctx.save(); ctx.beginPath(); ctx.rect(L, T, pw, ph); ctx.clip();
  ctx.beginPath();
  let first = true;
  for (let px = 0; px < pw; px++) {
    const ka = fOf(L + px) / df, kb = fOf(L + px + 1) / df;
    let v;
    if (kb - ka < 1) {                                   // piu' pixel per bin: interpolazione in dB
      const k = (ka + kb) / 2, i0 = Math.max(0, Math.min(nb - 2, Math.floor(k))), fr = k - i0;
      v = specDb[i0] * (1 - fr) + specDb[i0 + 1] * fr;
    } else {                                             // piu' bin per pixel: massimo
      v = -Infinity;
      for (let i = Math.max(0, Math.ceil(ka)); i <= Math.min(nb - 1, Math.floor(kb)); i++) if (specDb[i] > v) v = specDb[i];
    }
    const y = yOf(v);
    first ? ctx.moveTo(L + px, y) : ctx.lineTo(L + px, y); first = false;
  }
  ctx.strokeStyle = COL.spec; ctx.lineWidth = 1.2; ctx.stroke();
  ctx.lineTo(L + pw, T + ph); ctx.lineTo(L, T + ph); ctx.closePath(); ctx.fillStyle = "rgba(56,189,248,0.16)"; ctx.fill();
  if (lastTone) {
    const x = xOf(lastTone.freq), y = yOf(lastTone.db);
    ctx.fillStyle = "#f59e0b"; ctx.beginPath(); ctx.arc(x, y, 4, 0, 7); ctx.fill();
    ctx.textAlign = x > L + pw - 70 ? "right" : "left"; ctx.fillText(lastTone.freq.toFixed(1) + " Hz", x + (x > L + pw - 70 ? -8 : 8), y - 6);
  }
  ctx.restore();
}

function updateSpecInfo(sp) {
  const el = $("specInfo");
  if (!sp) { lastTone = null; el.textContent = S.running ? "Raccolta dati…" : " "; return; }
  const pk = D.dominantPeak(sp.ms, S.fs, sp.n, 20, sp.win);
  const prom = D.toneProminenceDb(sp.ms, pk.freq, S.fs, sp.n, sp.win);
  const unit = S.meter.calibrated ? "dB SPL" : "dBFS";
  const res = `risoluzione ${(S.fs / sp.n).toFixed(2)} Hz`;
  if (isFinite(pk.freq) && prom >= D.TONE_MIN_PROMINENCE_DB) {
    const lvl = D.toDb(pk.power) + S.meter.offsetDb;
    const t = D.thd(sp.ms, S.fs, sp.n, pk.freq, sp.win);
    lastTone = { freq: pk.freq, db: lvl };
    el.textContent = `Picco ${pk.freq.toFixed(1)} Hz · tono (integrato) ${fmtDb(lvl)} ${unit} · THD ${isFinite(t) ? (t * 100).toFixed(2) + " %" : "—"} · ${res}`;
  } else {
    lastTone = null;
    el.textContent = `Nessun tono dominante (rumore a banda larga) · ${res}`;
  }
}

// ------------------------------------------------------------------ spettrogramma
const SG_N = 4096;
let sgLast = 0, sgLut = null, sgImg = null;
function makeLut() {
  const stops = [[0, 0, 4], [30, 10, 90], [100, 20, 130], [190, 50, 100], [240, 110, 40], [250, 200, 60], [252, 255, 190]];
  const lut = new Uint8ClampedArray(256 * 3);
  for (let i = 0; i < 256; i++) {
    const p = (i / 255) * (stops.length - 1), k = Math.min(stops.length - 2, Math.floor(p)), f = p - k;
    for (let c = 0; c < 3; c++) lut[i * 3 + c] = stops[k][c] * (1 - f) + stops[k + 1][c] * f;
  }
  return lut;
}
function sgReset() { const c = vSg.c, x = c.getContext("2d"); x.setTransform(1, 0, 0, 1, 0, 0); x.fillStyle = "#000"; x.fillRect(0, 0, c.width, c.height); }

function drawSpectrogram(now) {
  vSg.fit(); vSgAxis.fit();
  if (vSg.resized) { vSg.resized = false; sgReset(); sgImg = null; }
  const c = vSg.c, ctx = c.getContext("2d"), W = c.width, H = c.height;
  if (S.running && S.ring.filled >= SG_N && now - sgLast >= 33) {
    sgLast = now;
    if (!sgLut) sgLut = makeLut();
    const ms = D.powerSpectrum(S.ring.latest(SG_N), "hann"), df = S.fs / SG_N, nb = ms.length;
    const lo = parseFloat($("sgMin").value), hi = parseFloat($("sgMax").value), off = S.meter.offsetDb;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(c, -1, 0);
    if (!sgImg || sgImg.height !== H) sgImg = ctx.createImageData(1, H);
    const fmin = 20, fmax = S.fs / 2, l0 = Math.log10(fmin), l1 = Math.log10(fmax);
    for (let y = 0; y < H; y++) {
      const fa = Math.pow(10, l0 + ((H - y - 0.5 + 0.5) / H) * (l1 - l0)), fb = Math.pow(10, l0 + ((H - y - 0.5 - 0.5) / H) * (l1 - l0));
      const ka = fb / df, kb = fa / df;
      let v;
      if (kb - ka < 1) { const k = (ka + kb) / 2, i0 = Math.max(0, Math.min(nb - 2, Math.floor(k))), fr = k - i0; v = (ms[i0] * (1 - fr) + ms[i0 + 1] * fr); }
      else { v = 0; for (let i = Math.max(0, Math.ceil(ka)); i <= Math.min(nb - 1, Math.floor(kb)); i++) if (ms[i] > v) v = ms[i]; }
      const dbv = 10 * Math.log10(Math.max(v, 1e-20)) + off;
      const idx = Math.max(0, Math.min(255, Math.round(((dbv - lo) / (hi - lo)) * 255))) * 3;
      const o = y * 4;
      sgImg.data[o] = sgLut[idx]; sgImg.data[o + 1] = sgLut[idx + 1]; sgImg.data[o + 2] = sgLut[idx + 2]; sgImg.data[o + 3] = 255;
    }
    ctx.putImageData(sgImg, W - 1, 0);
  }
  // assi (livello sovrapposto)
  const a = begin(vSgAxis), w = vSgAxis.w, h = vSgAxis.h;
  a.clearRect(0, 0, w, h); a.font = FONT; a.textAlign = "left";
  const fmin = 20, fmax = S.fs / 2, l0 = Math.log10(fmin), l1 = Math.log10(fmax);
  for (const f of niceFreqTicks(fmin, fmax)) {
    const y = Math.round(h - ((Math.log10(f) - l0) / (l1 - l0)) * h) + 0.5;
    a.strokeStyle = "rgba(255,255,255,0.12)"; a.beginPath(); a.moveTo(0, y); a.lineTo(w, y); a.stroke();
    if (String(f)[0] !== "5" || f >= 500) { a.fillStyle = "rgba(255,255,255,0.75)"; a.fillText(fmtHz(f), 4, y - 2); }
  }
}

// ------------------------------------------------------------------ bande
let bandAvg = null, bandKey = "";
const BAND_N = 16384;
function drawBands(now) {
  const ctx = begin(vBands), W = vBands.w, H = vBands.h;
  ctx.fillStyle = "#0b0f14"; ctx.fillRect(0, 0, W, H);
  const L = 44, R = 8, T = 8, B = 22, pw = W - L - R, ph = H - T - B;
  const frac = parseInt($("bandFrac").value), ymin = parseFloat($("bMin").value), ymax = parseFloat($("bMax").value);
  const { centers, labels } = D.bandCenters(frac);
  ctx.font = FONT; ctx.lineWidth = 1;
  const yOf = (v) => T + ((ymax - v) / (ymax - ymin)) * ph;
  const step = ymax - ymin > 80 ? 20 : 10;
  for (let v = Math.ceil(ymin / step) * step; v <= ymax; v += step) {
    const y = Math.round(yOf(v)) + 0.5;
    ctx.strokeStyle = COL.grid; ctx.beginPath(); ctx.moveTo(L, y); ctx.lineTo(L + pw, y); ctx.stroke();
    ctx.fillStyle = COL.text; ctx.textAlign = "right"; ctx.fillText(String(v), L - 4, y + 4);
  }
  const nb = centers.length, bw = pw / nb;
  let lv = null;
  if (S.running && S.ring.filled >= BAND_N) {
    const ms = D.powerSpectrum(S.ring.latest(BAND_N), "hann");
    const p = D.bandLevels(ms, S.fs, BAND_N, centers, frac), key = frac + ":" + S.fs;
    if (!bandAvg || bandAvg.length !== p.length || bandKey !== key) { bandAvg = Float64Array.from(p); bandKey = key; }
    else for (let i = 0; i < p.length; i++) bandAvg[i] = Number.isNaN(p[i]) ? NaN : 0.6 * bandAvg[i] + 0.4 * p[i];
    lv = bandAvg;
  }
  for (let i = 0; i < nb; i++) {
    const x = L + i * bw;
    if (lv && isFinite(lv[i])) {
      const v = 10 * Math.log10(Math.max(lv[i], 1e-20)) + S.meter.offsetDb;
      const y = Math.max(T, Math.min(T + ph, yOf(v)));
      const g = ctx.createLinearGradient(0, y, 0, T + ph); g.addColorStop(0, "#38bdf8"); g.addColorStop(1, "#0e4f70");
      ctx.fillStyle = g; ctx.fillRect(x + 1, y, Math.max(1, bw - 2), T + ph - y);
    }
    ctx.fillStyle = COL.text; ctx.textAlign = "center";
    if (nb <= 12 || i % 2 === 0 || bw > 34) ctx.fillText(labels[i], x + bw / 2, H - 6);
  }
  const unit = S.meter && S.meter.calibrated ? "dB SPL" : "dBFS";
  $("bandInfo").textContent = lv ? `Livello per banda in ${unit} (FFT ${BAND_N}, Hann, media 0.6). Le bande oltre Nyquist non sono mostrate.` : " ";
}

// ------------------------------------------------------------------ fonometro
const histSeries = [];
let histT = 0, meterT = 0;
function readingFor() {
  return S.meter.reading($("wt").value, $("tw").value, parseFloat($("leqWin").value));
}
function renderMeter(now) {
  if (now - meterT < 66) return;                          // ~15 Hz
  meterT = now;
  const w = $("wt").value, tw = $("tw").value, cal = S.meter.calibrated, win = parseFloat($("leqWin").value);
  const r = readingFor();
  $("bigVal").textContent = r.seconds > 0 ? fmtDb(r.level) : "—";
  $("bigUnit").textContent = `${cal ? "dB" : "dBFS"}(${w}) ${tw}`;
  const cn = $("calNote");
  cn.textContent = cal ? `Calibrato (offset ${S.meter.offsetDb >= 0 ? "+" : ""}${S.meter.offsetDb.toFixed(1)} dB): livelli in dB SPL` : "NON CALIBRATO: livelli relativi al fondo scala (dBFS)";
  cn.classList.toggle("ok", cal);
  const wl = w === "Z" ? "Z" : w, wlbl = win >= 60 ? (win / 60) + " min" : win + " s";
  $("lbLeq").textContent = `L${wl}eq (totale)`; $("lbLeqW").textContent = `L${wl}eq (${wlbl})`;
  $("lbMax").textContent = `L${wl}${tw}max`; $("lbMin").textContent = `L${wl}${tw}min`;
  $("lbL10").textContent = `L${wl}10`; $("lbL50").textContent = `L${wl}50`; $("lbL90").textContent = `L${wl}90`;
  $("vLeq").textContent = fmtDb(r.leq); $("vLeqW").textContent = fmtDb(r.leqWindow);
  $("vMax").textContent = fmtDb(r.lmax); $("vMin").textContent = fmtDb(r.lmin);
  $("vL10").textContent = fmtDb(r.l10); $("vL50").textContent = fmtDb(r.l50); $("vL90").textContent = fmtDb(r.l90);
  $("vPeak").textContent = fmtDb(r.peak);
  if (now - histT > 250 && r.seconds > 0 && isFinite(r.level)) { histT = now; histSeries.push(r.level); if (histSeries.length > 240) histSeries.shift(); }
  drawHist();
  if (!$("calPanel").hidden && S.running) {
    const raw = S.meter.rawLeqDbfs(3, "Z");
    $("calMeasured").textContent = `Livello misurato (Z, ultimi 3 s): ${fmtDb(raw.level, 2)} dBFS`;
  }
}
function renderMeterIdle() {
  $("bigVal").textContent = "—";
  histSeries.length = 0;
}
function drawHist() {
  const ctx = begin(vHist), W = vHist.w, H = vHist.h;
  ctx.fillStyle = "#0b0f14"; ctx.fillRect(0, 0, W, H);
  if (histSeries.length < 2) return;
  let lo = Math.min(...histSeries), hi = Math.max(...histSeries);
  if (hi - lo < 6) { const m = (hi + lo) / 2; lo = m - 3; hi = m + 3; }
  const pad = 22, pw = W - pad - 4, ph = H - 8;
  ctx.font = FONT; ctx.fillStyle = COL.text; ctx.textAlign = "right";
  ctx.fillText(hi.toFixed(0), pad - 3, 12); ctx.fillText(lo.toFixed(0), pad - 3, H - 4);
  ctx.strokeStyle = COL.trace; ctx.lineWidth = 1.5; ctx.beginPath();
  histSeries.forEach((v, i) => {
    const x = pad + (i / 239) * pw + (240 - histSeries.length) / 239 * pw, y = 4 + ((hi - v) / (hi - lo)) * ph;
    i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
  });
  ctx.stroke();
}

// calibrazione
$("calBtn").onclick = () => { $("calPanel").hidden = !$("calPanel").hidden; };
$("calDo").onclick = () => {
  const msg = $("calMsg");
  if (!S.running) { msg.textContent = "Avvia prima l'acquisizione."; return; }
  const ref = parseFloat($("calRef").value);
  if (!isFinite(ref)) { msg.textContent = "Livello di riferimento non valido."; return; }
  if (S.meter.channels.Z.maxAbs > 0.99) { msg.textContent = "Attenzione: il segnale ha saturato (picco a fondo scala). Riduci il livello e riprova."; }
  try {
    const old = S.meter.offsetDb;
    const off = S.meter.calibrate(ref, 3, "Z");
    store.set(`soundscope.cal.${S.devKey}.${Math.round(S.fs)}`, String(off));
    onOffsetChanged(old, off);
    msg.textContent = `Calibrato: offset ${off.toFixed(2)} dB (${ref.toFixed(1)} dB SPL = ${(ref - off).toFixed(2)} dBFS).`;
  } catch (e) { msg.textContent = e.message; }
};
$("calClear").onclick = () => {
  if (!S.running) return;
  const old = S.meter.offsetDb;
  S.meter.clearCalibration();
  store.del(`soundscope.cal.${S.devKey}.${Math.round(S.fs)}`);
  onOffsetChanged(old, 0);
  $("calMsg").textContent = "Calibrazione rimossa.";
};
function onOffsetChanged(old, neu) {
  rescaleForOffset(old, neu);
  S.meter.clearHistory();
  histSeries.length = 0;
}
function rescaleForOffset(old, neu) {
  const d = Math.round(neu - old);
  if (!d) return;
  for (const id of ["ymin", "ymax", "sgMin", "sgMax", "bMin", "bMax"]) {
    const step = NUM_SPECS[id][2];
    setNum(id, roundTo(parseFloat($(id).value) + d, step));       // l'asse resta su valori "tondi"
  }
}
$("resetBtn").onclick = () => { if (S.running) { S.meter.resetStats(); histSeries.length = 0; } };

// ------------------------------------------------------------------ ciclo di disegno
function diagLine() {
  const parts = [`SoundScope Web 0.1.3`];
  if (S.running) {
    parts.push(`${Math.round(S.fs)} Hz`);
    if (S.kind === "mic" && S.trackSettings) {
      const t = S.trackSettings, f = (v) => (v === undefined ? "n/d" : v ? "ON" : "off");
      parts.push(`eco ${f(t.echoCancellation)} · NS ${f(t.noiseSuppression)} · AGC ${f(t.autoGainControl)}`);
    }
    parts.push(`${S.fps} fps`);
  }
  return parts.join("  |  ");
}

let tabNow = "scope", frameCount = 0, lastDiag = 0;
function frame(now) {
  requestAnimationFrame(frame);
  S.frames++;
  if (now - S.fpsT >= 1000) { S.fps = S.frames; S.frames = 0; S.fpsT = now; }
  if (now - lastDiag > 1000) {
    lastDiag = now; $("diag").textContent = diagLine();
    if (S.running && S.kind === "mic" && S.trackSettings && (S.trackSettings.autoGainControl || S.trackSettings.noiseSuppression || S.trackSettings.echoCancellation))
      showWarn("Il sistema sta ancora elaborando il microfono (AGC / soppressione rumore / eco): toni e livelli possono risultare alterati.");
  }
  const inScope = tabNow === "scope", meterVisible = $("meterPanel").offsetParent !== null;
  if (!S.running) {
    if (inScope) { const a = drawScope(); drawSpectrum(null); void a; }
    else if (tabNow === "bands") drawBands(now);
    else if (tabNow === "sgram") drawSpectrogram(now);
    if (meterVisible) drawHist();
    return;
  }
  if (inScope) {
    const info = drawScope();
    if (info) $("scopeInfo").textContent = `Vpp ${info.vpp.toFixed(3)} FS · RMS ${info.rms.toFixed(1)} dBFS`;
    const sp = computeSpectrum();
    if (now - (frame.specInfoT || 0) > 120) { frame.specInfoT = now; updateSpecInfo(sp); }
    drawSpectrum(sp);
  } else if (tabNow === "sgram") drawSpectrogram(now);
  else if (tabNow === "bands") drawBands(now);
  if (meterVisible) renderMeter(now);
}

// ------------------------------------------------------------------ interfaccia
document.querySelectorAll(".tabs button").forEach((b) => {
  b.onclick = () => {
    document.querySelectorAll(".tabs button").forEach((x) => x.classList.toggle("active", x === b));
    tabNow = b.dataset.tab;
    document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t.id === "tab-" + tabNow));
    if (tabNow === "sgram") { vSg.resized = true; }
  };
});

// su schermi stretti il fonometro diventa una scheda
const mq = window.matchMedia("(max-width: 900px)");
function placeMeter() {
  const aside = $("meterPanel");
  if (mq.matches) { $("tab-meter").appendChild(aside); aside.classList.add("in-tab"); }
  else { document.querySelector("main").appendChild(aside); aside.classList.remove("in-tab"); if (tabNow === "meter") document.querySelector('.tabs button[data-tab="scope"]').click(); }
}
mq.addEventListener("change", placeMeter);
placeMeter();

$("startBtn").onclick = () => { showWarn(""); S.running && S.kind === "mic" ? stop() : start("mic"); };
$("demoBtn").onclick = () => { showWarn(""); S.running && S.kind === "demo" ? stop() : start("demo"); };
$("freeze").onchange = () => { frozenScope = null; };
// pannello del fonometro: nascondilo per dare tutta la larghezza ai grafici (scelta ricordata)
function setMeterShown(on) {
  document.body.classList.toggle("no-meter", !on);
  $("meterToggle").classList.toggle("active", on);
  $("meterToggle").setAttribute("aria-pressed", String(on));
  store.set("soundscope.meterShown", on ? "1" : "0");
  meterT = 0;
}
$("meterToggle").onclick = () => setMeterShown(document.body.classList.contains("no-meter"));
setMeterShown(store.get("soundscope.meterShown", "1") !== "0");
$("wt").onchange = $("tw").onchange = () => { meterT = 0; histSeries.length = 0; };
$("logf").onchange = () => { };

if (new URLSearchParams(location.search).has("demo")) start("demo");
if ("serviceWorker" in navigator && location.protocol.startsWith("http")) navigator.serviceWorker.register("sw.js").catch(() => { });
requestAnimationFrame(frame);

window.__soundscope = { S, D };                    // per i collaudi automatici
