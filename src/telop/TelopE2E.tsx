/**
 * テロップ書き出し経路の検証（`--t5-telop`）。
 *
 * 🔴 検証したいのは「本番と同じ経路で PNG が出来てディスクに落ちるか」。
 *
 * ここが無いまま出した版で、実際に事故が起きた:
 *   コンテキストを取っていない OffscreenCanvas から PNG を作ろうとして例外になり、
 *   書き出しボタンが「一瞬エラーが出て戻る」だけの動作になった。
 *   ffmpeg 側は Python 単体で検証していたので、
 *   **レンダラ→ディスクの区間だけが誰にも検証されていなかった**。
 *
 * 実際のアプリと同じ関数（buildCards / renderTelopPngs / renderBlank /
 * app.saveTelopFrames）を呼ぶこと。ここで別経路を書いたら意味が無い。
 */
import { useEffect, useState } from 'react';
import { loadTelopFonts } from './fonts';
import { renderBlank, renderTelopPngs } from './rasterize';
import { buildCards, makeMeasure, type TelopUnit } from './split';

const FRAME = { width: 1920, height: 1080 };

/** 実素材の文字起こしに寄せたケース。1行で収まるもの・2枚に割れるもの・記号混じり。 */
const UNITS: TelopUnit[] = [
  {
    id: 't0000',
    srcStart: 1.0,
    srcEnd: 3.2,
    text: 'このバイクのカスタムを紹介していきます',
    style: 'normal',
    reason: '',
    needsCheck: false,
    confidence: 0.9,
    lowWords: 0,
    words: 'このバイクのカスタムを紹介していきます'.split('').map((c, i) => ({
      text: c,
      srcStart: 1.0 + i * 0.1,
      srcEnd: 1.1 + i * 0.1,
    })),
  },
  {
    id: 't0001',
    srcStart: 4.0,
    srcEnd: 7.5,
    text: 'これがめちゃくちゃかたくて全然まわらないんですよ',
    style: 'emphasis',
    reason: '強調語「めちゃくちゃ」',
    needsCheck: true,
    confidence: 0.4,
    lowWords: 5,
    words: 'これがめちゃくちゃかたくて全然まわらないんですよ'.split('').map((c, i) => ({
      text: c,
      srcStart: 4.0 + i * 0.14,
      srcEnd: 4.14 + i * 0.14,
    })),
  },
  {
    id: 't0002',
    srcStart: 8.5,
    srcEnd: 10.0,
    text: '※ 撮影は許可を得ています',
    style: 'note',
    reason: '補足の言い回し',
    needsCheck: false,
    confidence: 0.95,
    lowWords: 0,
    words: '※ 撮影は許可を得ています'.split('').map((c, i) => ({
      text: c,
      srcStart: 8.5 + i * 0.12,
      srcEnd: 8.62 + i * 0.12,
    })),
  },
];

export interface SeekProbe {
  skipped?: string;
  error?: string;
  duration?: number;
  target?: number;
  landedAt?: number;
}

/**
 * media:// 経由の動画を途中までシークできるか確かめる。
 *
 * fetch で Range を叩く方法は使えない。
 * ページの生成元は file:// なので、media:// への fetch は CORS で弾かれる。
 * （動画要素の読み込みは CORS の対象外なので、アプリの再生自体は成立する）
 * ここで見たいのは動画要素の挙動そのものなので、動画要素で確かめる。
 */
function probeSeek(path: string): Promise<SeekProbe> {
  if (!path) return Promise.resolve({ skipped: '検証用の素材がありません' });

  return new Promise<SeekProbe>((resolve) => {
    const video = document.createElement('video');
    video.preload = 'auto';
    video.muted = true;
    const done = (r: SeekProbe) => {
      video.removeAttribute('src');
      resolve(r);
    };

    const timer = setTimeout(() => done({ error: 'シークが返ってきませんでした' }), 20_000);

    video.addEventListener('error', () => {
      clearTimeout(timer);
      done({ error: `読み込みに失敗しました（code ${video.error?.code}）` });
    });

    video.addEventListener('loadedmetadata', () => {
      const target = video.duration * 0.6;
      video.addEventListener(
        'seeked',
        () => {
          clearTimeout(timer);
          done({ duration: video.duration, target, landedAt: video.currentTime });
        },
        { once: true },
      );
      video.currentTime = target;
    });

    video.src = `media://local/${encodeURIComponent(path.replace(/\\/g, '/'))}`;
  });
}

export function TelopE2E() {
  const [status, setStatus] = useState('準備中');

  useEffect(() => {
    void (async () => {
      try {
        setStatus('フォントを読み込み中');
        const fonts = await loadTelopFonts();
        // 読み込めなかったファイルがあれば、そこで止める。
        // フォールバックの書体で描いた PNG は、見た目が違うのに検証は通ってしまう。
        if (fonts.missing.length > 0) {
          throw new Error(`フォントを読み込めません: ${fonts.missing.join(', ')}`);
        }

        setStatus('分割中');
        const cards = buildCards(UNITS, makeMeasure(), FRAME);

        setStatus('PNG を描画中');
        const rendered = await renderTelopPngs(cards, FRAME);
        const blank = renderBlank(FRAME);

        // 🔴 元素材の任意の時刻へシークできるかを確かめる。
        //    テロップ確認画面は「テロップの2.5秒前から再生」するので、
        //    シークできなければ画面ごと成立しない。
        //    シークは media:// が Range に応えて初めて動く。
        setStatus('元素材のシークを確認中');
        const seek = await probeSeek(await window.telopE2E.mediaProbePath());

        setStatus('保存中');
        const dir = await window.telopE2E.workDir();
        const saved = await window.app.saveTelopFrames({
          dir,
          frames: [
            ...rendered.map((r) => ({ name: r.name, base64: r.base64 })),
            { name: '_blank.png', base64: blank },
          ],
        });

        await window.telopE2E.submit({
          families: fonts.families,
          frame: FRAME,
          seek,
          cards: cards.map((c) => ({
            id: c.id,
            srcStart: c.srcStart,
            srcEnd: c.srcEnd,
            lines: c.lines,
            style: c.style,
            fontScale: c.fontScale,
            png: saved[`${c.id}.png`],
          })),
          blankPng: saved['_blank.png'],
        });
        setStatus('完了');
      } catch (e) {
        await window.telopE2E.submit({ error: (e as Error).message, stack: (e as Error).stack });
        setStatus('失敗');
      }
    })();
  }, []);

  return <p>テロップ書き出し検証: {status}</p>;
}
