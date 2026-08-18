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
  }
}
