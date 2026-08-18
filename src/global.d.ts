export {};

declare global {
  interface Window {
    sidecar: {
      call: (method: string, params?: Record<string, unknown>) => Promise<unknown>;
    };
  }
}
