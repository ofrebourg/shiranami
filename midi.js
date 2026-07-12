// Shiranami MIDI mapping — drives the renderer's parameters from live piano
// input, per the mapping table in the Black Waves brief (§4c).
//
// Input sources, tried in order when the Midi toggle is switched on:
//   1. midi-bridge SSE stream (default http://localhost:3000, override with
//      ?bridge=http://host:port) — preferred when the bridge is running.
//   2. Web MIDI API (Chrome/Edge) — direct connection to the instrument.
// Exactly one source is active — listening to both would double-count
// every note. The live source and note rate show in the Stats readout.
//
// Design rules:
//   - Every visual parameter is SMOOTHED toward its target (fast attack,
//     slow release) — snapping per note makes the water strobe.
//   - Silence decays every feature to zero, so no music = every control at
//     its minimum: sparse, slow, near-black calm.
//   - The two deliberate exceptions to smoothing (per the brief): the Spray
//     bump on velocity spikes (fast attack, ~1.5 s decay) is implemented;
//     the Solid flip on section boundaries is left manual for now.

(function () {
  'use strict';

  var api = window.shiranami;
  if (!api) return;

  // ---- input state ---------------------------------------------------------
  var active = false;
  var midiAccess = null;
  var sse = null;

  var now = function () { return performance.now() / 1000; };

  // onset log: {t, note, vel} for the last few seconds
  var onsets = [];
  var held = {};          // note -> { t, vel }
  var gateEMA = 0.15;     // note duration / inter-onset interval (legato-ness); starts staccato so lines begin thin
  var lastOnsetT = 0;
  var velEMA = 0;         // average onset velocity, 0..1
  var sprayBump = 0;

  function noteOn(note, vel) {
    var t = now();
    var v01 = vel / 127;
    onsets.push({ t: t, note: note, vel: v01 });
    held[note] = { t: t, vel: v01 };

    velEMA += (v01 - velEMA) * 0.25;
    // a velocity spike above the running average throws spray — the one
    // mapping that must land on the transient, not the smoothed value
    if (v01 > 0.55 && v01 > velEMA * 1.3) {
      sprayBump = Math.max(sprayBump, v01);
    }
    if (lastOnsetT > 0) {
      var ioi = t - lastOnsetT;
      if (ioi > 0.09 && ioi < 2) lastIOIs.push(ioi); // <90ms = same chord, not tempo
      if (lastIOIs.length > 24) lastIOIs.shift();
    }
    lastOnsetT = t;
  }

  function noteOff(note) {
    var t = now();
    var h = held[note];
    if (h) {
      delete held[note];
      // gate ratio: how much of the gap to the next onset the note filled.
      // Long ratios = legato washes, short = staccato ink
      var ioi = medianIOI() || 0.5;
      var gate = Math.min(1.2, (t - h.t) / ioi);
      gateEMA += (gate - gateEMA) * 0.15;
    }
  }

  var lastIOIs = [];
  function medianIOI() {
    if (!lastIOIs.length) return 0;
    var a = lastIOIs.slice().sort(function (x, y) { return x - y; });
    return a[a.length >> 1];
  }

  function handleEvent(ev) {
    console.log('[shiranami midi]', ev.type, 'note', ev.note, 'vel', ev.velocity);
    if (ev.type === 'NOTE_ON') noteOn(ev.note, ev.velocity);
    else if (ev.type === 'NOTE_OFF') noteOff(ev.note);
  }

  // ---- feature extraction --------------------------------------------------
  // dissonance of the held pitch-class set: 0 = consonant, 1 = tense.
  // Interval-class tension, semitone/tritone high, fifths/thirds low
  var IC_TENSION = [0, 0.9, 0.55, 0.25, 0.2, 0.1, 1.0];

  function tension() {
    var pcs = [];
    for (var n in held) pcs.push(n % 12);
    var cutoff = now() - 1.0;
    for (var i = onsets.length - 1; i >= 0 && onsets[i].t > cutoff; i--) {
      pcs.push(onsets[i].note % 12);
    }
    if (pcs.length < 2) return 0;
    var sum = 0, cnt = 0;
    for (var a = 0; a < pcs.length; a++) {
      for (var b = a + 1; b < pcs.length; b++) {
        var ic = Math.abs(pcs[a] - pcs[b]) % 12;
        if (ic > 6) ic = 12 - ic;
        sum += IC_TENSION[ic];
        cnt++;
      }
    }
    return Math.min(1, sum / cnt * 1.4);
  }

  function features() {
    var t = now();
    while (onsets.length && onsets[0].t < t - 6) onsets.shift();

    var nps = 0, minN = 128, maxN = -1;
    for (var i = 0; i < onsets.length; i++) {
      var o = onsets[i];
      if (o.t > t - 2) nps++;
      if (o.t > t - 4) {
        if (o.note < minN) minN = o.note;
        if (o.note > maxN) maxN = o.note;
      }
    }
    nps /= 2;

    // release envelope: 1 while playing, falls to 0 between ~1.2s and ~2.5s
    // after the last note — the phrase ends, the sea calms
    var tSil = lastOnsetT > 0 ? t - lastOnsetT : 1e9;
    var rel = tSil < 1.2 ? 1 : Math.max(0, 1 - (tSil - 1.2) / 1.3);
    if (rel === 0) {
      lastIOIs.length = 0;          // next phrase sets its own tempo
      if (velEMA > 0) velEMA *= 0.9;
    }

    var ioi = medianIOI();
    return {
      density: Math.min(1, nps / 6),                         // notes/sec
      rate: ioi ? Math.min(1, 0.14 / ioi) : 0,               // tempo proxy
      vel: Math.min(1, velEMA),
      spread: maxN < 0 ? 0 : Math.min(1, (maxN - minN) / 40),
      tension: tension(),
      legato: Math.max(0, Math.min(1, (gateEMA - 0.15) / 0.9)),
      playing: rel > 0,
      rel: rel
    };
  }

  // ---- mapping + smoothing ------------------------------------------------
  // brief §4c: tempo->pace/swell, density->strokes, velocity->height+foam,
  // spikes->spray, tension->chaos, articulation->brush, spread->body
  var TAU_UP = 0.5, TAU_DOWN = 1.3;
  var state = { strokes: 0, chaos: 0, brush: 0, body: 0, height: 0, swell: 0, spray: 0, foam: 0, pace: 0 };

  var dynPrev = 0, surgeEnv = 0;

  function targets(f, dt) {
    // dynamics curve: MIDI velocity is not perceived loudness. Quiet piano
    // playing sits at v ~0.3-0.4, which mapped linearly kept the sea half-
    // tall all evening. Below ~mp stays near-flat; mf->ff opens up steeply
    var dyn = f.vel <= 0.22 ? 0 : Math.pow((f.vel - 0.22) / 0.55, 1.35);
    if (dyn > 1) dyn = 1;

    // crescendo surge: a sea that RISES fast is a sea that breaks. Sudden
    // quiet->loud drives foam/spray directly, not just sustained loudness
    if (dt > 0) {
      var rise = (dyn - dynPrev) / dt;
      if (rise > 0.5) surgeEnv = Math.max(surgeEnv, Math.min(1, rise * 0.7));
      surgeEnv *= Math.exp(-dt / 1.8);
    }
    dynPrev = dyn;

    return {
      strokes: f.density,
      pace: f.rate * 0.9,
      swell: f.playing ? Math.max(0.15, 1 - f.rate * 0.8) : 0,
      height: dyn,
      foam: Math.max(dyn * 0.9, surgeEnv * 0.9),
      // a velocity spike must also steepen the water: Spray alone is gated
      // by actual breaking, so without a Chaos kick a hard hit shows nothing
      chaos: Math.max(f.tension, Math.min(1, sprayBump) * 0.6, surgeEnv * 0.7),
      // capped at half range: playing modulates thin<->medium ink, never
      // the fat washes (the full range drowned the thin strokes)
      brush: f.legato * 0.5,
      body: f.spread,
      spray: Math.max(Math.min(1, sprayBump), surgeEnv)
    };
  }

  var lastT = now();
  function loop() {
    if (!active) return;
    var t = now();
    var dt = Math.min(0.1, t - lastT);
    lastT = t;

    sprayBump *= Math.exp(-dt / 1.5);

    var f = features();
    var tg = targets(f, dt);
    for (var k in tg) {
      // the release envelope pulls every target to zero shortly after the
      // last note, so silence always means calm — fast
      var target = tg[k] * f.rel;
      var cur = state[k];
      var tau = target > cur ? TAU_UP : TAU_DOWN;
      if (k === 'pace' || k === 'swell') tau = target > cur ? 1.4 : TAU_DOWN;
      if (k === 'spray') tau = target > cur ? 0.08 : 1.2;   // hits must land
      cur += (target - cur) * (1 - Math.exp(-dt / tau));
      if (cur < 0.004) cur = 0;
      state[k] = cur;
      api.set(k, cur);
    }
    setTimeout(loop, 33);
  }

  // ---- sources -------------------------------------------------------------
  var BRIDGE_URL = (function () {
    var m = /[?&]bridge=([^&]+)/.exec(location.search);
    return m ? decodeURIComponent(m[1]) : 'http://localhost:3000';
  })();
  var mode = '';

  function connectBridge() {
    return new Promise(function (resolve, reject) {
      var es = new EventSource(BRIDGE_URL);
      var settled = false;
      es.onopen = function () {
        if (!settled) { settled = true; sse = es; resolve(); }
      };
      es.onerror = function () {
        if (!settled) { settled = true; es.close(); reject(new Error('bridge unreachable')); }
        // post-open errors: EventSource retries by itself
      };
      es.onmessage = function (msg) {
        try { handleEvent(JSON.parse(msg.data)); } catch (e) { /* handshake lines */ }
      };
    });
  }

  function connectWebMidi() {
    if (!navigator.requestMIDIAccess) return Promise.reject(new Error('no Web MIDI'));
    return navigator.requestMIDIAccess().then(function (access) {
      midiAccess = access;
      var wire = function () {
        access.inputs.forEach(function (input) {
          input.onmidimessage = function (msg) {
            var d = msg.data;
            var status = d[0] & 0xf0;
            if (status === 0x90 && d[2] > 0) handleEvent({ type: 'NOTE_ON', note: d[1], velocity: d[2] });
            else if (status === 0x80 || (status === 0x90 && d[2] === 0)) handleEvent({ type: 'NOTE_OFF', note: d[1], velocity: 0 });
          };
        });
      };
      wire();
      access.onstatechange = wire;
      return access.inputs.size;
    });
  }

  function stop() {
    if (midiAccess) {
      midiAccess.inputs.forEach(function (input) { input.onmidimessage = null; });
      midiAccess.onstatechange = null;
      midiAccess = null;
    }
    if (sse) { sse.close(); sse = null; }
  }

  // ---- toggle ---------------------------------------------------------------
  var btn = document.getElementById('midi-btn');

  function status() {
    if (!active) { api.midiStatus = ''; btn.title = ''; return; }
    var t = now(), nps = 0;
    for (var i = onsets.length - 1; i >= 0 && onsets[i].t > t - 2; i--) nps++;
    api.midiStatus = 'midi ' + (mode || '…') + ' · ' + (nps / 2).toFixed(1) + ' n/s';
    btn.title = mode ? 'source: ' + mode : 'connecting…';
  }

  btn.addEventListener('click', function () {
    active = !active;
    btn.setAttribute('aria-pressed', String(active));
    if (active) {
      mode = '';
      connectBridge()
        .then(function () { mode = 'bridge'; })
        .catch(function () {
          return connectWebMidi().then(function (n) { mode = 'web (' + n + ' in)'; });
        })
        .catch(function () { mode = 'no source'; })
        .then(status);
      lastT = now();
      loop();
    } else {
      stop();
      mode = '';
      status();
    }
  });

  // keep the status fresh while active
  setInterval(function () { if (active) status(); }, 500);
})();
