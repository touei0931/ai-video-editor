/**
 * T1: テロップ WYSIWYG の成立確認（Phase 0）。
 *
 * 検証したいこと:
 *   「Canvas で描いたテロップを PNG にして ffmpeg で overlay した結果」が
 *   「ブラウザ上で見えている合成結果」と一致するか。
 *
 * ここが一致しないと「プレビューではカッコよかったのに書き出したらダサい」が起きる。
 * アプリの根幹が崩れるので、他の何より先に確かめる（§16 T1）。
 *
 * このコンポーネントは検証専用。`--t1-wysiwyg` で起動したときだけ描画される。
 */
import { useEffect, useRef, useState } from 'react';
import { drawTelop } from '../telop/render';
import { DEFAULT_STYLES, type TelopSpec } from '../telop/style';

const WIDTH = 1080;
const HEIGHT = 1920;

/** 友達の実際のテロップに寄せたケース + スタイル出し分けの確認用 */
const CASES: { name: string; spec: TelopSpec }[] = [
  {
    name: 'normal',
    spec: {
      lines: ['お前顔映っても', 'いいな'],
      style: DEFAULT_STYLES.normal,
      position: 'top',
    },
  },
  {
    name: 'note',
    spec: {
      lines: ['※ 撮影は許可を得ています'],
      style: DEFAULT_STYLES.note,
      position: 'bottom',
    },
  },
  {
    name: 'emphasis',
    spec: {
      lines: ['マジで！？'],
      style: DEFAULT_STYLES.emphasis,
      position: 'middle',
    },
  },
  {
    // 日本語テロップの主要技法。行の中で色と大きさが変わるので、
    // 中央揃えを自前で計算している部分がずれていないかもここで見る。
    name: 'highlight',
    spec: {
      lines: [
        [
          { text: 'これが' },
          { text: 'めちゃくちゃ', color: '#ffe14d', scale: 1.15 },
          { text: '硬くて' },
        ],
      ],
      style: DEFAULT_STYLES.normal,
      position: 'bottom',
    },
  },
];

async function loadFonts(): Promise<string[]> {
  // 🔴 相対パスにすること。
  // 絶対パス（/fonts/...）だと、配布時の file:// 読み込みで
  // ドライブ直下（C:/fonts/...）に解決されてフォントが載らない。
  // フォントが載らないとフォールバックフォントで描かれ、見た目が静かに変わる。
  const families: [string, string][] = [
    ['ZenKakuGothicNew', './fonts/ZenKakuGothicNew-Black.ttf'],
    ['DelaGothicOne', './fonts/DelaGothicOne-Regular.ttf'],
    ['ZenOldMincho', './fonts/ZenOldMincho-Bold.ttf'],
  ];

  const loaded: string[] = [];
  for (const [family, url] of families) {
    const face = new FontFace(family, `url(${url})`);
    await face.load();
    document.fonts.add(face);
    loaded.push(family);
  }
  await document.fonts.ready;
  return loaded;
}

function makeCanvas(): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = WIDTH;
  c.height = HEIGHT;
  return c;
}

function toBase64(canvas: HTMLCanvasElement): string {
  return canvas.toDataURL('image/png').replace(/^data:image\/png;base64,/, '');
}

export function T1Wysiwyg() {
  const [log, setLog] = useState<string[]>([]);
  const previewRef = useRef<HTMLCanvasElement>(null);
  const ran = useRef(false);

  const say = (m: string) => setLog((prev) => [...prev, m]);

  useEffect(() => {
    if (ran.current) return;
    ran.current = true;

    (async () => {
      try {
        const families = await loadFonts();
        say(`フォント読み込み: ${families.join(', ')}`);

        const frameBase64 = (await window.t1.getFrame()) as string;
        const bg = new Image();
        await new Promise<void>((resolve, reject) => {
          bg.onload = () => resolve();
          bg.onerror = () => reject(new Error('背景フレームを読み込めませんでした'));
          bg.src = `data:image/png;base64,${frameBase64}`;
        });
        say(`背景フレーム: ${bg.width}x${bg.height}`);

        const results: { name: string; telop: string; composite: string }[] = [];

        for (const { name, spec } of CASES) {
          // ① テロップのみ（透過）— これを ffmpeg で overlay する
          const telopCanvas = makeCanvas();
          const tctx = telopCanvas.getContext('2d')!;
          drawTelop(tctx, spec, { width: WIDTH, height: HEIGHT });

          // ② ブラウザ上での合成結果 — これが「プレビューで見えているもの」
          const compositeCanvas = makeCanvas();
          const cctx = compositeCanvas.getContext('2d')!;
          cctx.drawImage(bg, 0, 0, WIDTH, HEIGHT);
          drawTelop(cctx, spec, { width: WIDTH, height: HEIGHT });

          results.push({
            name,
            telop: toBase64(telopCanvas),
            composite: toBase64(compositeCanvas),
          });
          say(`描画: ${name}`);
        }

        // 画面にも1枚出しておく（目視確認用）
        const preview = previewRef.current;
        if (preview) {
          const pctx = preview.getContext('2d')!;
          pctx.drawImage(bg, 0, 0, WIDTH, HEIGHT);
          drawTelop(pctx, CASES[0].spec, { width: WIDTH, height: HEIGHT });
        }

        say('メインプロセスへ送信…');
        await window.t1.submit({ results });
      } catch (e) {
        say(`エラー: ${(e as Error).message}`);
        await window.t1.submit({ error: (e as Error).message });
      }
    })();
  }, []);

  return (
    <main>
      <h1>T1: テロップ WYSIWYG 検証</h1>
      <pre>{log.join('\n')}</pre>
      <canvas ref={previewRef} width={WIDTH} height={HEIGHT} style={{ width: 270 }} />
    </main>
  );
}
