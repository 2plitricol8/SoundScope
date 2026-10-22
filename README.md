# SoundScope Web

Versione web (PWA) di SoundScope: **oscilloscopio, analizzatore di spettro, spettrogramma, ottave/terzi d'ottava e
fonometro** (A/C/Z, Fast/Slow, Leq, Lmax/Lmin, L10/50/90, Lpeak) con calibrazione in dB SPL. Gira in Safari su iPad e
iPhone (e in qualunque browser moderno), senza installare nulla. Il DSP e' un port di quello della versione Python.

![Schermata](docs/scope.png)

## Pubblicarla su GitHub Pages

Il microfono e' accessibile dal browser solo da una pagina in **HTTPS**; GitHub Pages lo fornisce gratis.

1. Crea un repository (pubblico, per usare Pages gratuito) e carica **tutto il contenuto di questa cartella**
   (`index.html`, `app.js`, `dsp.js`, `meter.js`, `worklet.js`, `sw.js`, `style.css`, `manifest.webmanifest`, `icons/`, `.nojekyll`).
2. *Settings → Pages → Build and deployment → Deploy from a branch → main / (root)*.
3. Dopo un minuto l'app e' su `https://<utente>.github.io/<repository>/`.
4. Sull'iPad apri l'indirizzo in Safari, consenti il microfono, poi *Condividi → Aggiungi alla schermata Home*
   per averla a tutto schermo come un'app.

Per pubblicare una modifica: aggiorna i file e **incrementa `VERSION` in `sw.js`** (la cache offline).

Prova in locale: `python3 -m http.server` nella cartella e apri `http://localhost:8000` (localhost e' ammesso senza HTTPS).
Con `?demo` nell'indirizzo parte subito il segnale simulato.

## Uso

* **Avvia** apre il microfono (la prima volta Safari chiede il permesso). **Demo** genera un segnale simulato
  (tono a 1 kHz, rumore di fondo, un "battito di mani" a banda larga, un tono a 440 Hz).
* **Oscilloscopio + Spettro**: base tempi, scala verticale, trigger (auto/libero, fronte, livello), blocco; FFT da 1024 a 32768,
  finestre Hann/Blackman-Harris/Flat-top/Rettangolare, media, asse log/lin. Il picco e il THD si mostrano solo se c'e'
  davvero un tono (prominenza ≥ 20 dB), altrimenti compare "nessun tono dominante".
* **Spettrogramma** e **Ottave / Terzi**. I limiti degli assi (Y min/max, livello di trigger, media) si scelgono con la ruota
  di selezione, senza tastiera; dopo la calibrazione gli assi si spostano da soli su valori tondi.
* **Fonometro**: livelli come nell'app desktop. Il pulsante **Fonometro** in alto (verde = visibile) nasconde il pannello per
  dare tutta la larghezza a spettro e oscilloscopio; la scelta viene ricordata. Nascosto, il pannello non si aggiorna, ma le
  statistiche continuano a essere calcolate (Leq, Lmax, ecc. al ritorno includono anche quel periodo). Su schermi stretti (iPad in verticale, iPhone) e' una scheda a parte.
* **Calibra…**: applica al microfono una sorgente di livello noto, inserisci il livello e premi *Calibra*
  (media degli ultimi 3 s, ponderazione Z). La calibrazione e' salvata nel browser per microfono e frequenza di campionamento.

Convenzione dei livelli: dBFS = RMS rispetto al fondo scala (una sinusoide a fondo scala = −3,01 dBFS);
dB SPL = dBFS + offset di calibrazione.

## Limiti (da leggere prima di fidarsi dei numeri)

* **Elaborazione del sistema.** Safari/iOS puo' applicare al microfono cancellazione d'eco, soppressione del rumore e
  controllo automatico del guadagno. L'app chiede di disattivarli e mostra nella riga in basso se il sistema ha obbedito
  (`eco off · NS off · AGC off`; "n/d" significa che Safari non riporta quel parametro (non che sia spento: verifica con un tono stazionario a 1 kHz)); se compare **ON** vedrai un avviso e le misure non sono affidabili (toni che scompaiono,
  livelli che "respirano"). E' lo stesso problema avuto con il driver Windows. Per misure serie la versione nativa
  (modalita' di misura di iOS) o un microfono esterno USB-C sono preferibili.
* **Microfono interno dell'iPad**: risposta in frequenza e sensibilita' non note; senza calibrazione i valori sono relativi.
* Lo schermo si tiene acceso mentre l'acquisizione e' attiva (se Safari lo consente); se l'app passa in secondo piano
  iOS sospende l'audio.
* Non ci sono (ancora) registrazione WAV, esportazione CSV, spettro di riferimento ed equalizzazione del microfono,
  presenti nella versione desktop.

## Struttura e test

* `dsp.js` – ponderazioni A/C (IIR, bilineare con pre-distorsione), FFT, finestre, picco/THD, bande.
* `meter.js` – fonometro in streaming (Fast/Slow, Leq, Lmax/Lmin, percentili).
* `worklet.js` – cattura dei campioni (AudioWorklet). `app.js` – interfaccia. `sw.js` – cache offline.
* `npm test` (oppure `node --test test/dsp.test.mjs`): confronta DSP e fonometro con i valori calcolati dall'implementazione
  Python (`test/reference.json`, stessi segnali, stessi numeri) e verifica -3,01 dBFS, calibrazione, tono vs rumore.
* `python3 test/e2e.py`: collaudo in Chromium headless con microfono finto (richiede `python3 -m http.server 8765` e Playwright).
