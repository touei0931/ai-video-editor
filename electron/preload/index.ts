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

export type SidecarApi = typeof api;
