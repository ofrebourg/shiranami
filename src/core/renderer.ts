// The contract both renderers implement. main.ts picks one at boot;
// a page reload swaps them (a canvas element cannot change context type).

export interface Renderer {
  /** shown in the Stats readout and on the switcher button */
  name: string;
  /** canvas backing store was resized (cv.width/height already set) */
  resize(): void;
  /** consume the sim's stroke/dot buckets. full = clear instead of fade
   *  (first frame and paused re-renders) */
  draw(full?: boolean): void;
}
