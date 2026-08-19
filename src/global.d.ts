export {};

declare global {
  interface Window {
    sidecar: {
      call: (method: string, params?: Record<string, unknown>) => Promise<unknown>;
    };
    /** Phase 0 の検証用。本番機能ではない。 */
    t1: {
      getFrame: () => Promise<string>;
      submit: (payload: unknown) => Promise<void>;
    };
    t2: {
      submit: (payload: unknown) => Promise<void>;
    };
    telopE2E: {
      workDir: () => Promise<string>;
      mediaProbePath: () => Promise<string>;
      submit: (payload: unknown) => Promise<void>;
    };
    app: {
      pickVideo: () => Promise<string | null>;
      pickOutput: (defaultPath: string) => Promise<string | null>;
      analyze: (params: Record<string, unknown>) => Promise<unknown>;
      buildTelops: (params: Record<string, unknown>) => Promise<unknown>;
      saveTelopFrames: (payload: {
        dir: string;
        frames: { name: string; base64: string }[];
      }) => Promise<Record<string, string>>;
      exportVideo: (params: Record<string, unknown>) => Promise<unknown>;
      revealFile: (filePath: string) => Promise<void>;
      onProgress: (cb: (p: { value: number; message: string }) => void) => () => void;
    };
  }
}
