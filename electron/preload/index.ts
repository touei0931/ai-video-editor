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

contextBridge.exposeInMainWorld('telopE2E', {
  workDir: () => ipcRenderer.invoke('telopE2E:workDir'),
  mediaProbePath: () => ipcRenderer.invoke('telopE2E:mediaProbePath'),
  submit: (payload: unknown) => ipcRenderer.invoke('telopE2E:submit', payload),
});

/** アプリ本体の操作 */
contextBridge.exposeInMainWorld('app', {
  pickVideo: () => ipcRenderer.invoke('app:pickVideo'),
  pickOutput: (defaultPath: string) => ipcRenderer.invoke('app:pickOutput', defaultPath),
  analyze: (params: Record<string, unknown>) => ipcRenderer.invoke('app:analyze', params),
  cancel: () => ipcRenderer.invoke('app:cancel'),
  buildTelops: (params: Record<string, unknown>) => ipcRenderer.invoke('app:buildTelops', params),
  planFraming: (params: Record<string, unknown>) => ipcRenderer.invoke('app:planFraming', params),
  saveTelopFrames: (payload: { dir: string; frames: { name: string; base64: string }[] }) =>
    ipcRenderer.invoke('app:saveTelopFrames', payload),
  exportVideo: (params: Record<string, unknown>) => ipcRenderer.invoke('app:export', params),
  saveProject: (payload: { workDir: string; data: unknown }) =>
    ipcRenderer.invoke('app:saveProject', payload),
  loadProject: (workDir: string) => ipcRenderer.invoke('app:loadProject', workDir),
  confirmQuit: (info: { hasWork: boolean }) => ipcRenderer.invoke('app:confirmQuit', info),
  confirmResume: (info: { savedAt: string; decided: number }) =>
    ipcRenderer.invoke('app:confirmResume', info),
  revealFile: (filePath: string) => ipcRenderer.invoke('app:revealFile', filePath),
  /** 画面の段階を知らせる。メニューの有効/無効はこれで決まる */
  setContext: (ctx: { phase: string; workDir?: string | null; outPath?: string | null }) =>
    ipcRenderer.send('app:context', ctx),
  onMenu: (cb: (action: string) => void) => {
    const listener = (_e: unknown, action: string) => cb(action);
    ipcRenderer.on('app:menu', listener);
    return () => ipcRenderer.off('app:menu', listener);
  },
  onProgress: (cb: (p: { value: number; message: string }) => void) => {
    const listener = (_e: unknown, p: { value: number; message: string }) => cb(p);
    ipcRenderer.on('app:progress', listener);
    return () => ipcRenderer.off('app:progress', listener);
  },
});

export type SidecarApi = typeof api;
