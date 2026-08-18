import { contextBridge, ipcRenderer } from 'electron';

const api = {
  /** Python サイドカーを呼ぶ。大きなデータはパスで受け渡す（§4.4） */
  call: (method: string, params: Record<string, unknown> = {}) =>
    ipcRenderer.invoke('sidecar:call', method, params),
};

contextBridge.exposeInMainWorld('sidecar', api);

/** Phase 0 の検証モード専用。本番機能ではない。 */
contextBridge.exposeInMainWorld('t1', {
  getFrame: () => ipcRenderer.invoke('t1:frame'),
  submit: (payload: unknown) => ipcRenderer.invoke('t1:submit', payload),
});

contextBridge.exposeInMainWorld('t2', {
  submit: (payload: unknown) => ipcRenderer.invoke('t2:submit', payload),
});

/** アプリ本体の操作 */
contextBridge.exposeInMainWorld('app', {
  pickVideo: () => ipcRenderer.invoke('app:pickVideo'),
  pickOutput: (defaultPath: string) => ipcRenderer.invoke('app:pickOutput', defaultPath),
  analyze: (params: Record<string, unknown>) => ipcRenderer.invoke('app:analyze', params),
  exportVideo: (params: Record<string, unknown>) => ipcRenderer.invoke('app:export', params),
  revealFile: (filePath: string) => ipcRenderer.invoke('app:revealFile', filePath),
  onProgress: (cb: (p: { value: number; message: string }) => void) => {
    const listener = (_e: unknown, p: { value: number; message: string }) => cb(p);
    ipcRenderer.on('app:progress', listener);
    return () => ipcRenderer.off('app:progress', listener);
  },
});

export type SidecarApi = typeof api;
