// The renderer contract. Only the WebGPU renderer implements it now; the
// interface survives so a future renderer (or a test double) can slot in.

export interface Renderer {
  /** shown in tooling/debug contexts */
  name: string;
  /** canvas backing store was resized (cv.width/height already set) */
  resize(): void;
  /** render one frame. full = clear instead of fade (first frame and
   *  paused re-renders) */
  draw(full?: boolean): void;
}
