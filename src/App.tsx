import { useEffect, useState } from 'react';

type Env = {
  platform: string;
  python: string;
  machine: string;
  asr_backend: string;
  face_backend: string;
  encoder_args: string[];
};

export function App() {
  const [env, setEnv] = useState<Env | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [echo, setEcho] = useState<string>('');

  useEffect(() => {
    window.sidecar
      .call('env')
      .then((r) => setEnv(r as Env))
      .catch((e: Error) => setError(e.message));
  }, []);

  async function ping() {
    try {
      const r = (await window.sidecar.call('ping', { message: 'hello from renderer' })) as {
        echo: string;
      };
      setEcho(r.echo);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <main>
      <h1>AI動画編集アプリ</h1>
      <p className="phase">Phase 0 — 技術検証スパイク</p>

      <section>
        <h2>サイドカー疎通</h2>
        {error && <p className="error">エラー: {error}</p>}
        {!env && !error && <p className="muted">接続中…</p>}
        {env && (
          <dl>
            <dt>プラットフォーム</dt>
            <dd>{env.platform}</dd>
            <dt>Python</dt>
            <dd>
              {env.python} ({env.machine})
            </dd>
            <dt>ASR バックエンド</dt>
            <dd>{env.asr_backend}</dd>
            <dt>顔検出バックエンド</dt>
            <dd>{env.face_backend}</dd>
            <dt>エンコーダ引数</dt>
            <dd>
              <code>{env.encoder_args.join(' ')}</code>
            </dd>
          </dl>
        )}
        <button onClick={ping}>ping を送る</button>
        {echo && <p className="ok">応答: {echo}</p>}
      </section>

      <section>
        <h2>次のタスク</h2>
        <ol>
          <li>
            <strong>T1</strong> テロップ WYSIWYG の成立確認（Canvas → PNG → ffmpeg overlay）
          </li>
          <li>
            <strong>T2</strong> BudouX 文節改行の検証
          </li>
          <li>
            <strong>T3</strong> ffmpeg LGPL ビルドの確保
          </li>
        </ol>
        <p className="muted">詳細は docs/design-report.md §16</p>
      </section>
    </main>
  );
}
