/**
 * 並べたタイムラインの書き出しを、**アプリの形のまま**通す（`npm run t6`）。
 *
 * 🔴 これが無いと、書き出しの経路は一度も走らないまま出荷される。
 *    書き出しエンジン（sidecar/timeline_render.py）は Python から直接叩いて
 *    確かめられるが、そこへ辿り着くまでの
 *      素材を読む → テロップを描く → PNG を保存する → サイドカーへ渡す
 *    という道は、ブラウザでは走らせられない（media:// も保存も Electron のもの）。
 *    途中のどこかが切れていても、型検査もテストも通ってしまう。
 *
 * 🔴 見た目の確認はしない。ここで見るのは「通るか」だけ。
 *    絵が合っているかは T5（テロップの焼き込み）と、
 *    プレビューと書き出しの突き合わせが受け持つ。
 */

import { useEffect, useState } from 'react';
import {
  addAsset,
  addLane,
  appendToMain,
  emptyProject,
  importCutResult,
  layout,
  placeOnLane,
  placedTelops,
  removeClip,
  isGap,
  type Project,
} from './project';
import { probeAsset } from './probe';
import { buildTimelineCards } from './telopCanvas';
import { renderBlank, renderTelopPngs } from '../telop/rasterize';

export function TimelineE2E() {
  const [note, setNote] = useState('用意しています…');

  useEffect(() => {
    void (async () => {
      try {
        const api = window.timelineE2E;
        const workDir = await api.workDir();
        const outPath = await api.outPath();
        const [pathA, pathB] = await api.samples();

        setNote('素材を読んでいます');
        /*
          🔴 素材は probeAsset で読むこと。
             長さや画の大きさを決め打ちにすると、
             「素材が読めていない」を見逃す（この経路がまさに壊れやすい）。
        */
        const a = await probeAsset(pathA);
        const b = pathB ? await probeAsset(pathB) : null;

        setNote('並べています');
        let p: Project = emptyProject();
        // 自動カットの結果を流し込む（子画面から来る形と同じ）
        p = importCutResult(p, {
          asset: a,
          keeps: [
            { srcStart: 0, srcEnd: 3 },
            { srcStart: 6, srcEnd: 8 },
          ],
          telops: [
            { srcStart: 0.5, srcEnd: 2.5, text: 'はじめのテロップ', style: 'normal' },
            { srcStart: 6.2, srcEnd: 7.8, text: '強調のテロップ', style: 'emphasis' },
          ],
        });

        // 上に重ねるレーンへ、別の素材を置く（縦横が混ざる形を作る）
        if (b) {
          p = addAsset(p, b);
          p = addLane(p, { id: 'v1', kind: 'video', name: '重ね' });
          p = placeOnLane(p, 'v1', b.id, 1.0, 0, 1.5);
        }
        // 末尾にもう1本足す
        p = appendToMain(p, a.id, 12, 14);

        /*
          真ん中を空きにする。
          🔴 「黒くないこと」だけを見ると、逆方向（空きなのに絵が出ている）を見逃す。
             空きが本当に黒いことも確かめる。
        */
        const mainClips = p.clips.filter((c) => c.laneId === p.lanes[0].id);
        p = removeClip(p, mainClips[1].id, 'lift');

        const placed = layout(p);
        const duration = Math.max(...placed.map((c) => c.end), 0);
        const frame = { width: p.settings.width, height: p.settings.height };

        setNote('テロップを描いています');
        const cards = buildTimelineCards(placedTelops(p), frame);
        const rendered = await renderTelopPngs(cards, frame);
        const saved = await window.app.saveTelopFrames({
          dir: `${workDir}/telops`,
          frames: [
            ...rendered.map((r) => ({ name: r.name, base64: r.base64 })),
            { name: '_blank.png', base64: renderBlank(frame) },
          ],
        });

        setNote('書き出しています');
        const clips = placed
          .filter((c) => !isGap(c))
          .map((c) => {
            const asset = p.assets.find((x) => x.id === c.assetId)!;
            const lane = p.lanes.find((l) => l.id === c.laneId)!;
            return {
              path: asset.path,
              at: c.start,
              src_start: c.srcStart,
              src_end: c.srcEnd,
              z: lane.kind === 'main' ? 0 : 1,
              video: lane.kind !== 'audio' && asset.hasVideo,
              audio: asset.hasAudio,
              gain_db: c.gainDb ?? 0,
            };
          });

        const result = await window.app.exportTimeline({
          out_path: outPath,
          work_dir: workDir,
          settings: p.settings,
          duration,
          clips,
          telops: cards.map((c, i) => ({
            out_start: c.srcStart,
            out_end: c.srcEnd,
            text: c.text,
            png: saved[rendered[i].name],
            lane: rendered[i].lane,
          })),
          blank_png: saved['_blank.png'],
          burn_telops: true,
          write_srt: true,
        });

        /*
          どの時点に絵があり、どこが黒いはずかを、**並べた結果から**出す。
          🔴 検査する側に数字を書き写さないこと。
             並べ方を変えたときに、検査だけ古い数字のまま緑になる。
        */
        const middleOf = (c: { start: number; end: number }) => (c.start + c.end) / 2;
        const expectBright = placed.filter((c) => !isGap(c) && c.laneId === p.lanes[0].id).map(middleOf);
        const expectDark = placed.filter((c) => isGap(c)).map(middleOf);

        await api.submit({
          outPath,
          duration,
          expectBright,
          expectDark,
          settings: p.settings,
          assets: p.assets.map((x) => ({ name: x.name, duration: x.duration, w: x.width, h: x.height })),
          clips: clips.length,
          telops: cards.length,
          result,
        });
        setNote('終わりました');
      } catch (e) {
        await window.timelineE2E.submit({
          error: (e as Error).message,
          stack: (e as Error).stack,
        });
        setNote(`失敗: ${(e as Error).message}`);
      }
    })();
  }, []);

  return <p style={{ font: '14px sans-serif', padding: 16 }}>{note}</p>;
}
