// Webcam picture-in-picture — composited ONTO the canvas by whichever
// renderer is active, so it appears in recordings automatically and stays
// in sync; greyscaled to keep the monochrome world intact.
// This module owns the stream and the <video>; renderers read `cam`.

export const cam = {
  on: false,
  video: null as HTMLVideoElement | null,
};

export function initCam(camBtn: HTMLButtonElement): void {
  let camStream: MediaStream | null = null;
  let camList: MediaDeviceInfo[] = [];
  let camIdx = -1;

  function camStop(): void {
    if (camStream) { camStream.getTracks().forEach(function (t) { t.stop(); }); camStream = null; }
    cam.video = null;
    cam.on = false;
    camBtn.setAttribute('aria-pressed', 'false');
    camBtn.title = 'webcam picture-in-picture, drawn onto the canvas (so it records)';
  }

  // deviceId picks a specific camera; remembered across sessions.
  // Shift-click cycles when more than one exists
  function camStart(deviceId?: string): void {
    const cons: MediaStreamConstraints = { video: { width: 960, height: 540 } };
    if (deviceId) (cons.video as MediaTrackConstraints).deviceId = { exact: deviceId };
    const req = (navigator.mediaDevices && navigator.mediaDevices.getUserMedia)
      ? navigator.mediaDevices.getUserMedia(cons)
      : Promise.reject(new Error('no camera'));
    req.then(function (stream) {
      camStream = stream;
      const v = document.createElement('video');
      v.srcObject = stream;
      v.muted = true;
      v.playsInline = true;
      v.play();
      cam.video = v;
      cam.on = true;
      camBtn.setAttribute('aria-pressed', 'true');
      const track = stream.getVideoTracks()[0];
      const st = track.getSettings ? track.getSettings() : {} as MediaTrackSettings;
      try { localStorage.setItem('shiranami-cam', st.deviceId || ''); } catch (e) {}
      navigator.mediaDevices.enumerateDevices().then(function (devs) {
        camList = devs.filter(function (d) { return d.kind === 'videoinput'; });
        camIdx = -1;
        for (let i = 0; i < camList.length; i++) {
          if (camList[i].deviceId === st.deviceId) camIdx = i;
        }
        camBtn.title = 'camera: ' + (track.label || 'default') +
          (camList.length > 1 ? ' — shift-click to switch' : '');
      });
    }, function () {
      // a remembered camera may have been unplugged: retry with the default
      if (deviceId) camStart(); else camStop();
    });
  }

  function camNext(): void {
    if (camList.length < 2) return;
    const next = camList[(camIdx + 1) % camList.length].deviceId;
    if (camStream) { camStream.getTracks().forEach(function (t) { t.stop(); }); camStream = null; }
    camStart(next);
  }

  camBtn.addEventListener('click', function (ev) {
    if (!cam.on) {
      let saved = '';
      try { saved = localStorage.getItem('shiranami-cam') || ''; } catch (e) {}
      camStart(saved || undefined);
    } else if (ev.shiftKey) {
      camNext();
    } else {
      camStop();
    }
  });
}
