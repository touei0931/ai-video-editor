/**
 * sidecar.ts — Python サイドカーとの stdio JSON-RPC クライアント
 *
 * プロセス間は行区切りJSON。大きなデータ（analysis.json / PNG）は
 * 中身ではなく **ファイルパスを渡す**（設計レポート §4.4）。
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { sidecarCommand } from './paths.js';

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void };

export interface Progress {
  request_id: number | null;
  value: number;
  message: string;
}

type ProgressListener = (p: Progress) => void;

export class Sidecar {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private pending = new Map<number, Pending>();
  private nextId = 1;
  private progressListeners = new Set<ProgressListener>();
  private recentStderr: string[] = [];

  /** 直近のサイドカー出力。診断情報の書き出しに使う（§10.5） */
  get stderrTail(): string[] {
    return [...this.recentStderr];
  }

  /** 進捗通知を購読する。戻り値を呼ぶと解除。 */
  onProgress(listener: ProgressListener): () => void {
    this.progressListeners.add(listener);
    return () => this.progressListeners.delete(listener);
  }

  start(): void {
    if (this.proc) return;

    const { command, args, cwd } = sidecarCommand();
    const proc = spawn(command, args, { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    this.proc = proc;

    createInterface({ input: proc.stdout }).on('line', (line) => {
      if (!line.trim()) return;
      let msg: {
        id?: number;
        result?: unknown;
        error?: { message: string };
        method?: string;
        params?: Progress;
      };
      try {
        msg = JSON.parse(line);
      } catch {
        console.error('[sidecar] JSONとして解釈できない出力:', line);
        return;
      }

      // id を持たない = 応答ではなく通知（進捗）
      if (msg.method === 'progress' && msg.params) {
        for (const listener of this.progressListeners) listener(msg.params);
        return;
      }

      if (typeof msg.id !== 'number') return;
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message));
      else p.resolve(msg.result);
    });

    // サイドカーの stderr はログとして扱う（進捗やワーニングが流れてくる）。
    // 🔴 直近を保持しておく。Windows や配布時は Electron の console 出力が
    //    親コンソールに届かず、落ちた理由が分からなくなるため。
    proc.stderr.on('data', (d: Buffer) => {
      const text = d.toString().trimEnd();
      console.error('[sidecar]', text);
      this.recentStderr.push(...text.split(/\r?\n/));
      if (this.recentStderr.length > 200) {
        this.recentStderr.splice(0, this.recentStderr.length - 200);
      }
    });

    // spawn 自体の失敗（Python が見つからない等）。
    // 拾わないと 'error' が未処理例外になり、メインプロセスごと落ちる。
    proc.on('error', (err) => {
      console.error('[sidecar] 起動に失敗しました:', err.message);
      for (const [, p] of this.pending) p.reject(new Error(`サイドカーを起動できません: ${err.message}`));
      this.pending.clear();
      this.proc = null;
    });

    proc.on('exit', (code) => {
      console.error(`[sidecar] 終了しました (code=${code})`);
      const tail = this.recentStderr.slice(-30).join('\n');
      const message =
        `サイドカーが終了しました (code=${code})` +
        (tail ? `\n--- サイドカーの出力 ---\n${tail}` : '');
      for (const [, p] of this.pending) p.reject(new Error(message));
      this.pending.clear();
      this.proc = null;
    });
  }

  call(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    return this.callWithId(method, params).promise;
  }

  /**
   * リクエストIDも返す版。長い処理をキャンセルするのに要る。
   * （レビュー中に「やっぱりやめる」を押せることは、下ごしらえ自動化では重要）
   */
  callWithId(
    method: string,
    params: Record<string, unknown> = {},
  ): { id: number; promise: Promise<unknown> } {
    if (!this.proc) this.start();
    const proc = this.proc;
    if (!proc) {
      return { id: -1, promise: Promise.reject(new Error('サイドカーを起動できませんでした')) };
    }

    const id = this.nextId++;
    const promise = new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      proc.stdin.write(JSON.stringify({ id, method, params }) + '\n');
    });
    return { id, promise };
  }

  /** 実行中のリクエストを取り消す。サイドカーは次のチェックポイントで止まる。 */
  cancel(requestId: number): Promise<unknown> {
    return this.call('cancel', { request_id: requestId });
  }

  /** 親プロセス終了時に確実に落とす（孤児プロセスを残さない） */
  stop(): void {
    this.proc?.kill();
    this.proc = null;
  }
}

export const sidecar = new Sidecar();
