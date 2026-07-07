// Shiranami MIDI mapping — drives the renderer's parameters from live piano
// input, per the mapping table in the Black Waves brief (§4c).
//
// Input sources, tried in order when the Midi toggle is switched on:
//   1. Web MIDI API (Chrome/Edge) — direct connection to the instrument.
//   2. midi-bridge SSE stream on http://localhost:3000 — for browsers
//      without Web MIDI, or when the piano is attached to another machine.
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
  var gateEMA = 0.5;      // note duration / inter-onset interval (legato-ness)
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
      if (ioi > 0.02 && ioi < 2) lastIOIs.push(ioi);
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

    var nps3 = 0, minN = 128, maxN = -1;
    for (var i = 0; i < onsets.length; i++) {
      var o = onsets[i];
      if (o.t > t - 3) nps3++;
      if (o.t > t - 4) {
        if (o.note < minN) minN = o.note;
        if (o.note > maxN) maxN = o.note;
      }
    }
    nps3 /= 3;

    // silence: velocity memory fades once nothing has sounded for a while
    if (t - lastOnsetT > 2.5) velEMA *= 0.985;

    var ioi = medianIOI();
    return {
      density: Math.min(1, nps3 / 8),                        // notes/sec
      rate: ioi ? Math.min(1, 0.5 / ioi) : 0,                // tempo proxy
      vel: Math.min(1, velEMA * 1.15),
      spread: maxN < 0 ? 0 : Math.min(1, (maxN - minN) / 40),
      tension: tension(),
      legato: Math.max(0, Math.min(1, (gateEMA - 0.15) / 0.9)),
      playing: t - lastOnsetT < 3 && onsets.length > 0
    };
  }

  // ---- mapping + smoothing ------------------------------------------------
  // brief §4c: tempo->pace/swell, density->strokes, velocity->height+foam,
  // spikes->spray, tension->chaos, articulation->brush, spread->body
  var TAU_UP = 0.5, TAU_DOWN = 3.0;
  var state = { strokes: 0, chaos: 0, brush: 0, body: 0, height: 0, swell: 0, spray: 0, foam: 0, pace: 0 };

  function targets(f) {
    return {
      strokes: f.density,
      pace: f.rate * 0.9,
      swell: f.playing ? Math.max(0.15, 1 - f.rate * 0.8) : 0,
      height: f.vel,
      foam: f.vel * 0.9,
      chaos: f.tension,
      brush: f.legato,
      body: f.spread,
      spray: Math.min(1, sprayBump)
    };
  }

  var lastT = now();
  function loop() {
    if (!active) return;
    var t = now();
    var dt = Math.min(0.1, t - lastT);
    lastT = t;

    sprayBump *= Math.exp(-dt / 1.5);

    var tg = targets(features());
    for (var k in tg) {
      var cur = state[k];
      var tau = tg[k] > cur ? TAU_UP : TAU_DOWN;
      if (k === 'spray') tau = tg[k] > cur ? 0.08 : 1.2;    // hits must land
      cur += (tg[k] - cur) * (1 - Math.exp(-dt / tau));
      if (cur < 0.004) cur = 0;
      state[k] = cur;
      api.set(k, cur);
    }
    setTimeout(loop, 33);
  }

  // ---- sources -------------------------------------------------------------
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

  function connectBridge() {
    sse = new EventSource('http://localhost:3000');
    sse.onmessage = function (m) {
      try { handleEvent(JSON.parse(m.data)); } catch (e) { /* handshake lines */ }
    };
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
  btn.addEventListener('click', function () {
    active = !active;
    btn.setAttribute('aria-pressed', String(active));
    if (active) {
      connectWebMidi().catch(function () { connectBridge(); });
      lastT = now();
      loop();
    } else {
      stop();
    }
  });
})();
