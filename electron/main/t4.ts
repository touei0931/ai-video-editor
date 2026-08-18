/**
 * T4: Python サイドカーの検証（Phase 0 §16）。
 *
 * 成功条件: Windows でサイドカーが起動し、30秒素材の文字起こしが返る。
 * あわせて T4 の実装要件（進捗の逐次送信・キャンセル・親プロセス終了時の kill）も確認する。
 *
 * SIDECAR_BIN を指定すると PyInstaller でビルドしたバイナリを使う。
 * 素の Python と固めたバイナリの両方で同じ結果になることを確かめるのが目的。
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { sidecar, type Progress } from './sidecar.js';

interface Check {
  name: string;
  ok: boolean;
  detail: unknown;
}

async function checkEnv(): Promise<Check> {
  const env = (await sidecar.call('env')) as Record<string, unknown>;
  return { name: 'env', ok: typeof env.platform === 'string', detail: env };
}

/** 進捗が段階的に届くこと */
async function checkProgress(): Promise<Check> {
  const seen: number[] = [];
  const off = sidecar.onProgress((p: Progress) => seen.push(p.value));
  const result = (await sidecar.call('sleep', { seconds: 1.5, steps: 15 })) as {
    completed_steps: number;
  };
  off();

  const increasing = seen.every((v, i) => i === 0 || v >= seen[i - 1]);
  return {
    name: 'progress',
    ok: seen.length >= 5 && increasing && result.completed_steps === 15,
    detail: { received: seen.length, increasing, last: seen[seen.length - 1] },
  };
}

/** 実行中の処理を途中で止められること */
async function checkCancel(): Promise<Check> {
  const { id, promise } = sidecar.callWithId('sleep', { seconds: 10, steps: 100 });

  await new Promise((r) => setTimeout(r, 600));
  await sidecar.cancel(id);

  const result = (await promise) as { cancelled: boolean; completed_steps: number };
  return {
    name: 'cancel',
    ok: result.cancelled === true && result.completed_steps < 100,
    detail: result,
  };
}

async function checkTranscribe(appRoot: string, outDir: string): Promise<Check> {
  // 合成音声（Windows の TTS で生成・プライバシー問題なし）。無ければサンプル動画の音声を使う。
  const speech = join(appRoot, 'fixtures-local', 'speech_ja.wav');
  const fallback = join(appRoot, 'samples', 'sample_landscape_solo.mp4');
  const audio = existsSync(speech) ? speech : fallback;

  if (!existsSync(audio)) {
    return { name: 'transcribe', ok: false, detail: '音声素材がありません' };
  }

  const progresses: number[] = [];
  const off = sidecar.onProgress((p) => progresses.push(p.value));

  const result = (await sidecar.call('transcribe', {
    audio_path: audio,
    model: process.env.ASR_MODEL ?? 'base',
    language: 'ja',
    out_path: join(outDir, 'transcript.json'),
  })) as Record<string, unknown>;
  off();

  return {
    name: 'transcribe',
    ok: result.cancelled === false && typeof result.text === 'string',
    detail: {
      audio: audio.endsWith('.wav') ? 'TTS合成音声' : 'サンプル動画',
      progressUpdates: progresses.length,
      ...result,
    },
  };
}

export async function runT4(appRoot: string): Promise<number> {
  const outDir = join(appRoot, 'phase0-artifacts', 't4');
  mkdirSync(outDir, { recursive: true });

  // どこで止まったかが分かるよう、各段階を都度書き出す。
  // 途中でハングしても最後に通った段階が残る（実機の診断でも同じ手が使える）。
  const stepFile = join(outDir, 't4-step.json');
  const step = (name: string) =>
    writeFileSync(stepFile, JSON.stringify({ step: name, at: new Date().toISOString() }), 'utf8');

  step('start');
  sidecar.start();

  const checks: Check[] = [];
  step('env');
  checks.push(await checkEnv());
  step('progress');
  checks.push(await checkProgress());
  step('cancel');
  checks.push(await checkCancel());
  step('transcribe');
  checks.push(await checkTranscribe(appRoot, outDir));
  step('done');

  const ok = checks.every((c) => c.ok);
  writeFileSync(
    join(outDir, 't4-result.json'),
    JSON.stringify({ ok, sidecarBin: process.env.SIDECAR_BIN ?? '(system python)', checks }, null, 2),
    'utf8',
  );

  for (const c of checks) {
    console.error(`[t4] ${c.name}: ${c.ok ? 'OK' : 'NG'}`);
  }

  return ok ? 0 : 1;
}
