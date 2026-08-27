export {};

/** 下書きの一覧に出す1件分。本体は作業フォルダの project.json。 */
export interface DraftEntry {
  videoPath: string;
  videoName: string;
  /** 元の動画が見つからない（移動・削除された） */
  videoMissing: boolean;
  workDir: string;
  savedAt: string;
  phase: string;
  decided: number;
  total: number;
  duration: number;
}

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
      /** BGM に使う音楽ファイルを選ぶ */
      pickMusic: () => Promise<string | null>;
      pickOutput: (defaultPath: string) => Promise<string | null>;
      analyze: (params: Record<string, unknown>) => Promise<unknown>;
      cancel: () => Promise<boolean>;
      buildTelops: (params: Record<string, unknown>) => Promise<unknown>;
      planFraming: (params: Record<string, unknown>) => Promise<unknown>;
      redetect: (params: Record<string, unknown>) => Promise<unknown>;
      saveTelopFrames: (payload: {
        dir: string;
        frames: { name: string; base64: string }[];
      }) => Promise<Record<string, string>>;
      exportVideo: (params: Record<string, unknown>) => Promise<unknown>;
      saveProject: (payload: {
        workDir: string;
        data: unknown;
        summary?: Record<string, unknown>;
      }) => Promise<string>;
      loadProject: (workDir: string) => Promise<unknown | null>;
      listDrafts: () => Promise<DraftEntry[]>;
      findDraft: (videoPath: string) => Promise<DraftEntry | null>;
      deleteDraft: (workDir: string) => Promise<boolean>;
      makeClip: (
        params: Record<string, unknown>,
      ) => Promise<{ path: string; join_at: number; duration: number } | null>;
      confirmQuit: (info: { hasWork: boolean }) => Promise<'save' | 'discard' | 'cancel'>;
      confirmResume: (info: {
        savedAt: string;
        decided: number;
      }) => Promise<'resume' | 'fresh' | 'cancel'>;
      revealFile: (filePath: string) => Promise<void>;
      /** 並べたタイムラインを Final Cut の XML として保存する。保存先を返す */
      saveFCPXML: (payload: { xml: string; defaultName: string }) => Promise<string | null>;
      /** 並べたタイムラインを保存する。保存先を返す */
      saveTimeline: (payload: { data: unknown; defaultName: string }) => Promise<string | null>;
      /** 保存したタイムラインを開く。data が null なら壊れている */
      openTimeline: () => Promise<{ path: string; data: unknown } | null>;
      uiInfo: () => Promise<{ isMac: boolean }>;
      /** Final Cut 用のタイムラインの隣に書体を置く。置いたフォルダを返す */
      exportFonts: (payload: { nextTo: string; files: string[] }) => Promise<string | null>;
      /** 保存してある既定。形は信用できないので sanitizeStyles を通すこと */
      loadTelopStyles: () => Promise<unknown | null>;
      saveTelopStyles: (styles: unknown) => Promise<boolean>;
      setContext: (ctx: { phase: string; workDir?: string | null; outPath?: string | null }) => void;
      onMenu: (cb: (action: string) => void) => () => void;
      onProgress: (cb: (p: { value: number; message: string }) => void) => () => void;
    };
  }
}
