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

export class Sidecar {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private pending = new Map<number, Pending>();
  private nextId = 1;

  start(): void {
    if (this.proc) return;

    const { command, args, cwd } = sidecarCommand();
    const proc = spawn(command, args, { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    this.proc = proc;

    createInterface({ input: proc.stdout }).on('line', (line) => {
      if (!line.trim()) return;
      let msg: { id?: number; result?: unknown; error?: { message: string } };
      try {
        msg = JSON.parse(line);
      } catch {
        console.error('[sidecar] JSONとして解釈できない出力:', line);
        return;
      }
      if (typeof msg.id !== 'number') return;
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message));
      else p.resolve(msg.result);
    });

    // サイドカーの stderr はログとして扱う（進捗やワーニングが流れてくる）
    proc.stderr.on('data', (d: Buffer) => {
      console.error('[sidecar]', d.toString().trimEnd());
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
      for (const [, p] of this.pending) p.reject(new Error('サイドカーが終了しました'));
      this.pending.clear();
      this.proc = null;
    });
  }

  call(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    if (!this.proc) this.start();
    const proc = this.proc;
    if (!proc) return Promise.reject(new Error('サイドカーを起動できませんでした'));

    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      proc.stdin.write(JSON.stringify({ id, method, params }) + '\n');
    });
  }

  /** 親プロセス終了時に確実に落とす（孤児プロセスを残さない） */
  stop(): void {
    this.proc?.kill();
    this.proc = null;
  }
}

export const sidecar = new Sidecar();
