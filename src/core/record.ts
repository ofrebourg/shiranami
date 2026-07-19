// Recording — captureStream records the CANVAS only: placard/panel/stats
// never appear in the file. Esc (or clicking again) stops and downloads
// a .webm with audio and video muxed on one clock.
// Works identically for the 2d and webgl canvases: captureStream sits on
// the element, not the context.

import { DPR } from './sim';
import { recOverlay, buildRecOverlay } from './overlay';
import { takeNow, type TakeControl } from './take';
import type { MidiControl } from '../midi';

export function initRecording(cv: HTMLCanvasElement, recBtn: HTMLButtonElement,
                              midi: MidiControl, take: TakeControl): void {
  const placard = document.getElementById('placard');
  let recorder: MediaRecorder | null = null;
  let recChunks: Blob[] = [];
  let recT0 = 0;
  let recTimer = 0;
  let recAudio: MediaStream | null = null;
  let recPending = false;
  let autoTake = false;

  function recStop(): void {
    if (recorder && recorder.state !== 'inactive') recorder.stop();
  }

  function recStart(): void {
    if (!window.MediaRecorder || recorder || recPending) {
      if (!window.MediaRecorder) recBtn.textContent = 'no rec';
      return;
    }
    recPending = true;
    recBtn.textContent = '● …';
    // replaying a take: record the take's own audio, not the mic — the
    // re-export then carries the original performance sound in sync
    if (takeNow.media) {
      const el = takeNow.media as HTMLVideoElement & { captureStream(): MediaStream };
      let stream: MediaStream | null = null;
      try { stream = new MediaStream(el.captureStream().getAudioTracks()); } catch (e) {}
      recGo(stream && stream.getAudioTracks().length ? stream : null);
      return;
    }
    // a live performance with Midi on is worth keeping as a take too:
    // capture the inputs alongside the video, one download each
    autoTake = midi.isActive() && take.autoStart();
    // pull the line-in / mic into the SAME file: audio and video are muxed
    // with shared timestamps, so they never need aligning afterwards.
    // Voice processing must be OFF: AGC pumping and noise suppression are
    // built for speech and they mangle a piano
    const audioReq = (navigator.mediaDevices && navigator.mediaDevices.getUserMedia)
      ? navigator.mediaDevices.getUserMedia({ audio: {
          echoCancellation: false, noiseSuppression: false, autoGainControl: false,
        } })
      : Promise.reject(new Error('no getUserMedia'));
    audioReq.then(function (a) { recGo(a); }, function () { recGo(null); });
  }

  function recGo(audioStream: MediaStream | null): void {
    recPending = false;
    const stream = cv.captureStream(60);
    let withAudio = false;
    if (audioStream) {
      const atr = audioStream.getAudioTracks();
      if (atr.length) { stream.addTrack(atr[0]); withAudio = true; recAudio = audioStream; }
    }
    let mime = '';
    const tries = withAudio
      ? ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm']
      : ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'];
    for (let i = 0; i < tries.length; i++) {
      if (MediaRecorder.isTypeSupported(tries[i])) { mime = tries[i]; break; }
    }
    recBtn.title = withAudio ? 'recording with audio — Esc stops'
                             : 'recording video only — Esc stops';
    // high bitrate: thin bright lines on black smear badly at defaults
    recorder = new MediaRecorder(stream,
      { mimeType: mime || undefined, videoBitsPerSecond: 14000000, audioBitsPerSecond: 192000 });
    recChunks = [];
    recorder.ondataavailable = function (e) { if (e.data && e.data.size) recChunks.push(e.data); };
    recorder.onstop = function () {
      const blob = new Blob(recChunks, { type: 'video/webm' });
      const d = new Date();
      const p2 = function (v: number) { return (v < 10 ? '0' : '') + v; };
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'shiranami-' + d.getFullYear() + p2(d.getMonth() + 1) + p2(d.getDate()) +
                   '-' + p2(d.getHours()) + p2(d.getMinutes()) + p2(d.getSeconds()) + '.webm';
      a.click();
      setTimeout(function () { URL.revokeObjectURL(a.href); }, 5000);
      recorder = null;
      if (autoTake) { take.autoStop(); autoTake = false; }
      recOverlay.on = false;
      if (placard) placard.style.visibility = '';
      if (recAudio) { recAudio.getTracks().forEach(function (t) { t.stop(); }); recAudio = null; }
      clearInterval(recTimer);
      recBtn.textContent = 'Record';
      recBtn.setAttribute('aria-pressed', 'false');
    };
    recorder.start(1000);
    // the take carries its own placard, drawn onto the canvas by the
    // active renderer; hide the DOM one so the screen shows no doubling
    buildRecOverlay(DPR);
    recOverlay.on = true;
    if (placard) placard.style.visibility = 'hidden';
    recT0 = performance.now();
    recBtn.setAttribute('aria-pressed', 'true');
    recBtn.textContent = '● 0:00';
    recTimer = window.setInterval(function () {
      const sec = Math.floor((performance.now() - recT0) / 1000);
      recBtn.textContent = '● ' + Math.floor(sec / 60) + ':' + (sec % 60 < 10 ? '0' : '') + (sec % 60);
    }, 500);
  }

  recBtn.addEventListener('click', function () {
    if (recorder) recStop(); else recStart();
  });
  window.addEventListener('keydown', function (ev) {
    if (ev.key === 'Escape') recStop();
  });
}
