/**
 * 並べたクリップを、1本の動画のように再生する。
 *
 * 素材が複数あり、クリップの境で別のファイルへ移ることがあるので、
 * <video> を1つだけ使う作りにはできない。境目で src を差し替えると
 * 読み込みのあいだ**黒い画面が入る**。
 *
 * そこで <video> を2つ持ち、片方を映しているあいだに、もう片方へ
 * 次のクリップを用意しておいて、境目で入れ替える。
 *
 * 🔴 時計は自前で持つこと。
 *    video.currentTime を時計にすると、入れ替えた瞬間に時刻が
 *    「次のクリップの素材内の時刻」へ飛ぶ。タイムラインの時刻とは別物なので、
 *    再生位置が作品の途中から急に頭へ戻ったように見える。
 *
 * 🔴 ずれたら**映像側を**直すこと。時計を映像に合わせない。
 *    合わせにいくと、読み込みで一瞬止まるたびに時計が巻き戻り、
 *    同じ所を何度も再生する。
 *
 * 🔴 入れ替えは「どちらを表にするか」の旗で行うこと。
 *    ref の中身を入れ替える書き方にしてはいけない。JSX の ref は
 *    描画のたびに React が入れ直すので、**入れ替えが元に戻る**。
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { assetUrl } from './assetUrl';
import {
  clipAt,
  layout,
  timelineDuration,
  videoAt,
  type PlacedClip,
  type Project,
} from './project';

/** 映像がずれていると判断する幅（秒）。これ以内なら触らない */
const DRIFT = 0.25;

/** 次のクリップを用意し始める、境目までの余裕（秒） */
const PRELOAD_LEAD = 1.5;

export interface TimelinePlayer {
  /** 2枚の <video>。表裏は frontIsA で決まる */
  aRef: React.RefObject<HTMLVideoElement | null>;
  bRef: React.RefObject<HTMLVideoElement | null>;
  /** A が表か。画面はこれを見て重ね順を決める */
  frontIsA: boolean;
  /** 音だけのレーン用 */
  audioRef: React.RefObject<HTMLAudioElement | null>;
  time: number;
  playing: boolean;
  duration: number;
  play(): void;
  pause(): void;
  toggle(): void;
  seek(t: number): void;
}

export function useTimelinePlayer(project: Project): TimelinePlayer {
  const aRef = useRef<HTMLVideoElement | null>(null);
  const bRef = useRef<HTMLVideoElement | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  const [time, setTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [frontIsA, setFrontIsA] = useState(true);

  const duration = timelineDuration(project);

  /*
    描画のたびに作り直されると、下の繰り返し処理が毎回止まって走り直す。
    最新のものを箱に入れて、繰り返し処理からはこれを覗く。
  */
  const projectRef = useRef(project);
  projectRef.current = project;
  const timeRef = useRef(0);
  const playingRef = useRef(false);
  playingRef.current = playing;
  const frontIsARef = useRef(true);

  /** いま表に載せているクリップ */
  const frontClip = useRef<string | null>(null);
  /** 裏に用意してあるクリップ */
  const backClip = useRef<string | null>(null);
  /** 音のレーンで鳴らしているクリップ */
  const audioClip = useRef<string | null>(null);

  /*
    🔴 映像を合わせる処理を、描画の繰り返しだけに任せないこと。

       requestAnimationFrame は「動きがあるとき」しか回らない。
       別のアプリに切り替えている間や、画面が隠れている間は止まる。
       止まっている最中にクリップを取り込むと、映像を載せる処理が
       一度も走らず、**再生を押すまで真っ黒のまま**になる。
       中身が変わった時にも一度合わせる。
  */
  const syncRef = useRef<((t: number) => void) | null>(null);

  useEffect(() => {
    let raf = 0;
    let last = performance.now();

    const front = () => (frontIsARef.current ? aRef.current : bRef.current);
    const back = () => (frontIsARef.current ? bRef.current : aRef.current);

    /** その素材の中の、いま出すべき時刻 */
    const srcTime = (clip: PlacedClip, t: number) => clip.srcStart + (t - clip.start);

    /** 指定のクリップを、その要素に載せる */
    const mount = (el: HTMLMediaElement | null, clip: PlacedClip, t: number) => {
      if (!el) return;
      const path = projectRef.current.assets.find((a) => a.id === clip.assetId)?.path;
      if (!path) return;
      const url = assetUrl(path);
      if (el.src !== url) el.src = url;
      const want = srcTime(clip, t);
      if (Math.abs(el.currentTime - want) > 0.02) el.currentTime = want;
    };

    const stopAll = () => {
      aRef.current?.pause();
      bRef.current?.pause();
      audioRef.current?.pause();
    };

    /** 音だけのレーン（BGM・効果音） */
    const syncAudioLane = (p: Project, t: number) => {
      const el = audioRef.current;
      if (!el) return;
      let hit: PlacedClip | null = null;
      for (const lane of p.lanes.filter((l) => l.kind === 'audio')) {
        const c = clipAt(p, lane.id, t);
        if (c) {
          hit = c;
          break;
        }
      }
      if (!hit) {
        if (!el.paused) el.pause();
        audioClip.current = null;
        return;
      }
      if (audioClip.current !== hit.id) {
        mount(el, hit, t);
        audioClip.current = hit.id;
      }
      const want = srcTime(hit, t);
      if (Math.abs(el.currentTime - want) > DRIFT) el.currentTime = want;
      if (playingRef.current) {
        if (el.paused) void el.play().catch(() => {});
      } else if (!el.paused) {
        el.pause();
      }
    };

    /** その時刻に合うように、映像と音を合わせる */
    const sync = (t: number) => {
      const p = projectRef.current;
      const want = videoAt(p, t);
      if (!front()) return;

      if (!want) {
        // 何も映らない所（穴）。止めておく
        aRef.current?.pause();
        bRef.current?.pause();
        frontClip.current = null;
        syncAudioLane(p, t);
        return;
      }

      if (frontClip.current !== want.id) {
        /*
          🔴 裏に用意できているなら**入れ替える**こと。
             ここで表に src を入れ直すと、読み込みのあいだ黒くなる。
             用意できていないときだけ、やむを得ず直に載せる。
        */
        if (backClip.current === want.id && back()) {
          frontIsARef.current = !frontIsARef.current;
          setFrontIsA(frontIsARef.current);
          backClip.current = null;
        } else {
          mount(front(), want, t);
        }
        frontClip.current = want.id;
      }

      const el = front();
      if (!el) return;

      // ずれていたら映像側を直す（時計は動かさない）
      const wantSrc = srcTime(want, t);
      if (Math.abs(el.currentTime - wantSrc) > DRIFT) el.currentTime = wantSrc;

      if (playingRef.current) {
        if (el.paused) void el.play().catch(() => {});
      } else if (!el.paused) {
        el.pause();
      }
      // 裏は鳴らさない。2つ同時に音が出る
      const other = back();
      if (other && !other.paused) other.pause();

      // 次のクリップを裏で用意する
      if (want.end - t < PRELOAD_LEAD) {
        const upcoming = videoAt(p, want.end + 0.01);
        if (upcoming && other && backClip.current !== upcoming.id && upcoming.id !== want.id) {
          mount(other, upcoming, upcoming.start);
          other.pause();
          backClip.current = upcoming.id;
        }
      }

      syncAudioLane(p, t);
    };

    const tick = (now: number) => {
      raf = requestAnimationFrame(tick);
      /*
        🔴 前の描画からの差を、そのまま足さないこと。
           別のアプリに切り替えている間、この繰り返しは**止まる**
           （ブラウザが止める）。戻ってきた1フレーム目の差は
           離れていた時間まるごとになるので、そのまま足すと
           再生位置が数十秒先へ飛ぶ。人が触っていない間に進むのは誤り。
           1フレームで進める上限を決めておく。
      */
      const dt = Math.min((now - last) / 1000, 0.25);
      last = now;

      const total = timelineDuration(projectRef.current);

      if (playingRef.current) {
        const next = timeRef.current + dt;
        if (next >= total) {
          // 末尾で止める。巻き戻さない（もう一度押したら頭から流す）
          timeRef.current = total;
          setTime(total);
          setPlaying(false);
          stopAll();
          return;
        }
        timeRef.current = next;
        setTime(next);
      }

      sync(timeRef.current);
    };

    syncRef.current = sync;
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      syncRef.current = null;
    };
  }, []);

  /** 中身・再生位置・再生状態が変わったら、その場で一度合わせる */
  useEffect(() => {
    syncRef.current?.(timeRef.current);
  }, [project, time, playing]);

  /* -------------------------------------------------------- 外からの操作 */

  const seek = useCallback((t: number) => {
    const total = timelineDuration(projectRef.current);
    const next = Math.max(0, Math.min(total, t));
    timeRef.current = next;
    setTime(next);
    /*
      🔴 用意してあった次のクリップは捨てること。
         飛んだ先は別の場所なので、用意してあるものは的外れになる。
         残すと、境目で**関係ないクリップに入れ替わる**。
    */
    backClip.current = null;
  }, []);

  const play = useCallback(() => {
    const total = timelineDuration(projectRef.current);
    // 末尾で押したら頭から。止まったまま何も起きないのを避ける
    if (timeRef.current >= total - 0.01) {
      timeRef.current = 0;
      setTime(0);
      backClip.current = null;
    }
    setPlaying(true);
  }, []);

  const pause = useCallback(() => setPlaying(false), []);
  const toggle = useCallback(() => {
    if (playingRef.current) pause();
    else play();
  }, [play, pause]);

  /*
    クリップの並びが変わったら、載せているものが的外れになっていることがある。
    🔴 作り直しではなく「載せ直させる」だけにすること。
       時刻まで戻すと、編集するたびに再生位置が頭へ飛ぶ。
  */
  useEffect(() => {
    const ids = new Set(layout(project).map((c) => c.id));
    if (frontClip.current && !ids.has(frontClip.current)) frontClip.current = null;
    if (backClip.current && !ids.has(backClip.current)) backClip.current = null;
    if (audioClip.current && !ids.has(audioClip.current)) audioClip.current = null;
  }, [project]);

  return { aRef, bRef, frontIsA, audioRef, time, playing, duration, play, pause, toggle, seek };
}
