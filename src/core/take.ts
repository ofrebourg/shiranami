// Takes — record a performance's INPUTS (MIDI events, piano audio, webcam
// video) into one importable JSON file, then replay it through the live
// mapping pipeline. The point: replaying a take re-renders the SAME
// performance through whatever the algorithm has become, so the mapping
// and the renderer can be tweaked against a fixed reference.
//
// File: { type: 'shiranami-take', version: 1, duration, events, media? }
//   events — [ms-from-start, 'NOTE_ON'|'NOTE_OFF', note, velocity][]
//   media  — data: URL of a webm holding the mic audio (and the webcam
//            video if Cam was on during capture)
//
// Replay sync: the media element's clock dispatches the MIDI events, so
// audio, PiP video and injected notes cannot drift apart. Without media,
// a wall clock drives dispatch. Visuals are NOT frame-deterministic
// (seeds and spray roll dice) — the control trajectories are.
//
// Button: click = import a take / play / stop · shift-click = capture
// start/stop (needs Midi on — events are tapped as they reach the
// mapping) · alt-click = unload the take.

import { cam } from './cam';
import type { MidiControl, BridgeEvent } from '../midi';

/** set while a take is replaying — Record pulls its audio from here
 *  instead of opening the mic */
export const takeNow = { media: null as HTMLVideoElement | null };

interface TakeFile {
  type: 'shiranami-take';
  version: 1;
  duration: number; // ms
  events: [number, string, number, number][];
  media?: string;
  /** basename of the .webm recorded in the same session, when Record
   *  captured this take automatically — the association handle */
  video?: string;
}

export interface TakeControl {
  load(file: unknown): void;
  /** start/stop a capture on Record's behalf (no-ops if one is running).
   *  nameBase ties the json to the webm recorded alongside it */
  autoStart(): boolean;
  autoStop(nameBase?: string): void;
  /** scripted replay: start at fromMs (state needs ~8s of preroll before
   *  any moment under study), stop, and read the playhead (-1 if idle) */
  play(fromMs?: number): void;
  stopReplay(): void;
  clock(): number;
}

export function initTake(btn: HTMLButtonElement, midi: MidiControl): TakeControl {
  let state: 'idle' | 'capturing' | 'loaded' | 'playing' = 'idle';
  let events: [number, string, number, number][] = [];
  let t0 = 0;
  let rec: MediaRecorder | null = null;
  let recChunks: Blob[] = [];
  let recStream: MediaStream | null = null;
  let take: TakeFile | null = null;
  let mediaEl: HTMLVideoElement | null = null;
  let evIdx = 0;
  let raf = 0;
  let labelTimer = 0;
  let playT0 = 0;
  let camWasOn = false;
  let camWasVideo: HTMLVideoElement | null = null;

  const IDLE_TITLE = 'takes: click = import/replay · shift-click = capture (Midi must be on) · alt-click = unload';
  btn.title = IDLE_TITLE;

  midi.onEvent(function (ev: BridgeEvent, t: number) {
    if (state === 'capturing' && (ev.type === 'NOTE_ON' || ev.type === 'NOTE_OFF')) {
      events.push([Math.round(t - t0), ev.type, ev.note || 0, ev.velocity || 0]);
    }
  });

  function label(text: string): void { btn.textContent = text; }

  function fmt(ms: number): string {
    const s = Math.floor(ms / 1000);
    return Math.floor(s / 60) + ':' + (s % 60 < 10 ? '0' : '') + (s % 60);
  }

  // ---- capture ---------------------------------------------------------------
  async function capStart(): Promise<void> {
    events = [];
    recChunks = [];
    t0 = performance.now();
    // mic (voice processing off — it mangles a piano) + webcam if Cam is on
    let stream: MediaStream | null = null;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: {
        echoCancellation: false, noiseSuppression: false, autoGainControl: false,
      } });
    } catch (e) { /* audio-less take is still a take */ }
    const camSrc = cam.on && cam.video && cam.video.srcObject instanceof MediaStream
      ? cam.video.srcObject : null;
    if (camSrc) {
      const vt = camSrc.getVideoTracks()[0];
      if (vt) {
        stream = stream
          ? new MediaStream([...stream.getAudioTracks(), vt])
          : new MediaStream([vt]);
      }
    }
    if (stream) {
      const hasVideo = stream.getVideoTracks().length > 0;
      const tries = hasVideo
        ? ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm']
        : ['audio/webm;codecs=opus', 'audio/webm'];
      let mime = '';
      for (const tr of tries) if (MediaRecorder.isTypeSupported(tr)) { mime = tr; break; }
      recStream = stream;
      rec = new MediaRecorder(stream, {
        mimeType: mime || undefined,
        videoBitsPerSecond: 1200000, // reference footage, not the main capture
        audioBitsPerSecond: 128000,
      });
      rec.ondataavailable = function (e) { if (e.data && e.data.size) recChunks.push(e.data); };
      rec.onstart = function () { t0 = performance.now(); };
      rec.start(1000);
    }
    state = 'capturing';
    btn.setAttribute('aria-pressed', 'true');
    labelTimer = window.setInterval(function () {
      label('● ' + fmt(performance.now() - t0));
    }, 500);
    label('● 0:00');
  }

  async function capStop(nameBase?: string): Promise<void> {
    clearInterval(labelTimer);
    const duration = Math.round(performance.now() - t0);
    if (rec && rec.state !== 'inactive') {
      await new Promise<void>(function (res) { rec!.onstop = function () { res(); }; rec!.stop(); });
    }
    // stop only the tracks we created (the mic); the cam's video track
    // belongs to the Cam feature — leave it running
    if (recStream) { recStream.getAudioTracks().forEach(function (t) { t.stop(); }); recStream = null; }
    rec = null;
    let media: string | undefined;
    if (recChunks.length) {
      const blob = new Blob(recChunks, { type: recChunks[0].type || 'video/webm' });
      media = await new Promise<string>(function (res) {
        const r = new FileReader();
        r.onload = function () { res(String(r.result)); };
        r.readAsDataURL(blob);
      });
    }
    const d = new Date();
    const p2 = function (v: number) { return (v < 10 ? '0' : '') + v; };
    const base = nameBase || ('take-' + d.getFullYear() + p2(d.getMonth() + 1) + p2(d.getDate()) +
                 '-' + p2(d.getHours()) + p2(d.getMinutes()));
    const file: TakeFile = { type: 'shiranami-take', version: 1, duration, events, media,
                             video: nameBase ? nameBase + '.webm' : undefined };
    const out = new Blob([JSON.stringify(file)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(out);
    a.download = base + '.shiranami.json';
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 5000);
    // captured takes load straight away — tweak without re-importing
    load(file);
  }

  // ---- import ------------------------------------------------------------------
  function loadUnknown(file: unknown): void {
    const f = file as TakeFile;
    if (!f || f.type !== 'shiranami-take' || !Array.isArray(f.events)) {
      console.warn('[shiranami] not a shiranami take');
      return;
    }
    if (state === 'playing') playStop();
    load(f);
  }

  function load(file: TakeFile): void {
    take = file;
    mediaEl = null;
    if (file.media) {
      mediaEl = document.createElement('video');
      mediaEl.src = file.media;
      mediaEl.playsInline = true;
    }
    state = 'loaded';
    btn.setAttribute('aria-pressed', 'false');
    label('play');
    btn.title = 'take loaded: ' + file.events.length + ' events, ' + fmt(file.duration) +
      ' — click to replay · alt-click to unload';
  }

  function importFile(): void {
    const inp = document.createElement('input');
    inp.type = 'file';
    inp.accept = '.json,application/json';
    inp.onchange = function () {
      const f = inp.files && inp.files[0];
      if (!f) return;
      f.text().then(function (txt) {
        try {
          const parsed = JSON.parse(txt) as TakeFile;
          if (parsed.type !== 'shiranami-take' || !Array.isArray(parsed.events)) {
            throw new Error('not a take');
          }
          load(parsed);
        } catch (e) {
          console.warn('[shiranami] not a shiranami take:', e);
          label('take?');
          setTimeout(function () { if (state === 'idle') label('take'); }, 1500);
        }
      });
    };
    inp.click();
  }

  // ---- replay -------------------------------------------------------------------
  function clockMs(): number {
    if (mediaEl && !mediaEl.paused) return mediaEl.currentTime * 1000;
    return performance.now() - playT0;
  }

  function pump(): void {
    if (state !== 'playing' || !take) return;
    const t = clockMs();
    while (evIdx < take.events.length && take.events[evIdx][0] <= t) {
      const e = take.events[evIdx++];
      midi.inject({ type: e[1], note: e[2], velocity: e[3] });
    }
    label('■ ' + fmt(t));
    if (t >= take.duration + 400 || (mediaEl && mediaEl.ended)) {
      playStop();
      return;
    }
    raf = requestAnimationFrame(pump);
  }

  function playStart(fromMs?: number): void {
    if (!take) return;
    const from = Math.max(0, fromMs || 0);
    evIdx = 0;
    while (evIdx < take.events.length && take.events[evIdx][0] < from) evIdx++;
    playT0 = performance.now() - from;
    state = 'playing';
    btn.setAttribute('aria-pressed', 'true');
    midi.replayStart();
    if (mediaEl) {
      // the take's own footage takes over the PiP for the duration
      camWasOn = cam.on;
      camWasVideo = cam.video;
      takeNow.media = mediaEl;
      mediaEl.currentTime = from / 1000;
      mediaEl.play().then(function () {
        if (mediaEl && mediaEl.videoWidth > 0) {
          cam.video = mediaEl;
          cam.on = true;
        }
        // MediaRecorder webms sometimes refuse to seek (no cue index);
        // if the seek didn't take, drop to the wall clock so the notes
        // still land where they should — audio will be off, video won't
        if (from > 0 && mediaEl && mediaEl.currentTime * 1000 < from - 800) {
          console.warn('[shiranami] take media would not seek — replaying this section without audio sync');
          mediaEl.pause();
        }
      });
    }
    pump();
  }

  function playStop(): void {
    cancelAnimationFrame(raf);
    takeNow.media = null;
    if (mediaEl) {
      mediaEl.pause();
      cam.on = camWasOn;
      cam.video = camWasVideo;
    }
    midi.replayStop();
    state = 'loaded';
    btn.setAttribute('aria-pressed', 'false');
    label('play');
  }

  // ---- button -------------------------------------------------------------------
  btn.addEventListener('click', function (ev) {
    if (ev.altKey) {
      if (state === 'playing') playStop();
      if (state === 'capturing') return; // finish the capture first
      take = null; mediaEl = null; state = 'idle';
      label('take');
      btn.title = IDLE_TITLE;
      return;
    }
    if (ev.shiftKey) {
      if (state === 'capturing') { void capStop(); }
      else if (state === 'idle' || state === 'loaded') { void capStart(); }
      return;
    }
    if (state === 'idle') importFile();
    else if (state === 'loaded') playStart();
    else if (state === 'playing') playStop();
    else if (state === 'capturing') { void capStop(); }
  });

  return {
    load: loadUnknown,
    autoStart: function () {
      if (state === 'idle' || state === 'loaded') { void capStart(); return true; }
      return false;
    },
    autoStop: function (nameBase?: string) {
      if (state === 'capturing') void capStop(nameBase);
    },
    play: function (fromMs?: number) {
      if (state === 'playing') playStop();
      if (state === 'loaded') playStart(fromMs);
    },
    stopReplay: function () {
      if (state === 'playing') playStop();
    },
    clock: function () { return state === 'playing' && take ? clockMs() : -1; },
  };
}
