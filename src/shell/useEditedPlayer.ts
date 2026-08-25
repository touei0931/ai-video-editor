/**
 * 「書き出したあとの動画」をその場で再生する。
 *
 * 書き出さずに結果を確かめられることが、このアプリの速さの正体。
 * 実際の書き出しは10分素材で3〜8分かかるので、確認のたびに書き出していては
 * 「下ごしらえを速くする」道具にならない。
 *
 * やっていること:
 *   - 元素材を再生しながら、切る区間に入った瞬間に次の残る区間へ飛ばす
 *   - BGM を別の <audio> で並走させ、出来上がりの時刻に合わせる
 *   - 音量と再生速度をまとめて面倒みる
 *
 * 🔴 飛ばす判定は timeupdate ではなく毎コマ見ること。
 *    timeupdate は毎秒4回ほどしか鳴らない。切る区間が 0.3 秒だと
 *    通り過ぎてから気づくので、切ったはずの声が聞こえる。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { buildSegments, outputDuration, skipTarget, toOutput, toSource, type Cut, type Segment } from './editedTime';

export interface MusicForPlayback {
  path: string;
  /** 出来上がりの何秒から鳴らすか */
  start: number;
  volume: number;
  loop: boolean;
}

export interface EditedPlayerOptions {
  duration: number;
  cuts: readonly Cut[];
  /** カットを適用して再生するか。false なら元素材をそのまま流す */
  applyCuts: boolean;
  music?: MusicForPlayback | null;
  musicUrl?: string | null;
  /**
   * 逆再生のときに鳴らす音（解析で作った audio.wav）。
   *
   * 🔴 <video> は逆再生できない。負の playbackRate は主要なブラウザで動かない。
   *    映像は自分で時刻を戻せば逆送りになるが、音は出ない。
   *    そこで音だけ Web Audio で「逆向きにした波形」を鳴らす。
   *    編集ソフトの J は音が聞こえるからこそ使えるので、ここは省けない。
   */
  reverseAudioPath?: string | null;
}

export interface EditedPlayer {
  videoRef: React.RefObject<HTMLVideoElement | null>;
  audioRef: React.RefObject<HTMLAudioElement | null>;
  segments: Segment[];
  /** 出来上がりの長さ（カットを適用しないときは素材の長さ） */
  duration: number;
  /** いまの位置（表示している時間軸での秒） */
  time: number;
  playing: boolean;
  volume: number;
  muted: boolean;
  rate: number;
  seek(t: number): void;
  play(): void;
  pause(): void;
  toggle(): void;
  setVolume(v: number): void;
  setMuted(v: boolean): void;
  setRate(v: number): void;
  /** 逆再生も含めた早送り（J K L 用）。0 で停止、負で逆送り */
  shuttle(v: number): void;
}

const STORE_KEY = 'pac.player';

/**
 * 再生速度を安全に入れる。
 *
 * 🔴 Chromium の playbackRate は 0.0625〜16 の外を入れると**例外を投げる**。
 *    投げた例外はキー操作の中で拾われず、React の木ごと消えて
 *    **画面が真っ白になり、何を押しても反応しなくなる**（実際に起きた）。
 *    速さを上げていった先で必ず踏むので、ここで必ず丸める。
 */
export const MAX_RATE = 16;
export const MIN_RATE = 0.0625;

function setRateSafely(el: HTMLMediaElement, rate: number): void {
  const v = Math.min(MAX_RATE, Math.max(MIN_RATE, Math.abs(rate) || 1));
  try {
    el.playbackRate = v;
  } catch {
    // 端末が対応していない速さでも、再生そのものは続ける
    try {
      el.playbackRate = 1;
    } catch {
      /* ここで諦める */
    }
  }
}

/** 音量と速度は覚えておく。毎回下げ直させない */
function loadPref(): { volume: number; muted: boolean } {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) {
      const p = JSON.parse(raw) as { volume?: number; muted?: boolean };
      return {
        volume: typeof p.volume === 'number' ? Math.min(1, Math.max(0, p.volume)) : 0.7,
        muted: Boolean(p.muted),
      };
    }
  } catch {
    /* 壊れていても既定で続ける */
  }
  return { volume: 0.7, muted: false };
}

export function useEditedPlayer(opts: EditedPlayerOptions): EditedPlayer {
  const { duration: srcDuration, cuts, applyCuts, music, musicUrl, reverseAudioPath } = opts;

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);


  const [time, setTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const pref = useRef(loadPref());
  const [volume, setVolumeState] = useState(pref.current.volume);
  const [muted, setMutedState] = useState(pref.current.muted);
  const [rate, setRateState] = useState(1);

  /*
    🔴 配列そのものを依存に入れないこと。

    呼び出し側は `cuts={xs.map(...)}` のように**毎描画で新しい配列**を渡してくる。
    これを useEffect の依存に入れると、毎描画で setState が走り、
    その setState でまた描画され……と無限に回る。

    実測: 何もしていない2秒間に DOM の書き換えが 50,991 回。
    画面は生きているように見えるのに、ボタンを押しても届かず、
    再生位置も動かない（1コマ送りが効かない、に見える）。

    中身を文字列にして比べる。ここは state ではなく計算で持つ。
  */
  const cutsKey = cuts.map((c) => `${c.srcStart.toFixed(3)}-${c.srcEnd.toFixed(3)}`).join(',');
  const segments = useMemo(
    () => (applyCuts ? buildSegments(srcDuration, cuts) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [srcDuration, applyCuts, cutsKey],
  );

  const outDuration = applyCuts && segments.length ? outputDuration(segments) : srcDuration;

  /* ---- 音量・速度 ---- */

  useEffect(() => {
    const v = videoRef.current;
    if (v) {
      v.volume = volume;
      v.muted = muted;
      setRateSafely(v, rate);
    }
    const a = audioRef.current;
    if (a) {
      // BGM は元の音量に対する掛け算。全体の音量を下げたら BGM も下がる
      a.volume = volume * (music?.volume ?? 0.18);
      a.muted = muted;
      setRateSafely(a, rate);
    }
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify({ volume, muted }));
    } catch {
      /* 保存できなくても再生は続ける */
    }
  }, [volume, muted, rate, music?.volume]);

  /* ---- 再生位置 ---- */

  const seek = useCallback(
    (t: number) => {
      const clamped = Math.min(outDuration, Math.max(0, t));
      setTime(clamped);
      const v = videoRef.current;
      if (v) {
        const src = applyCuts && segments.length ? toSource(segments, clamped) : clamped;
        if (Number.isFinite(src)) v.currentTime = src;
      }
      const a = audioRef.current;
      if (a && music) {
        const at = clamped - music.start;
        if (at >= 0 && Number.isFinite(at)) {
          a.currentTime = music.loop && a.duration ? at % Math.max(0.05, a.duration) : at;
        }
      }
    },
    [applyCuts, segments, outDuration, music],
  );

  /**
   * 再生位置を進め、切る区間に入ったら飛ばす。
   *
   * 🔴 requestAnimationFrame だけに頼らないこと。
   *    rAF はウインドウが**前面に無いと1度も鳴らない**（実測: 2秒で0回）。
   *    そうなると再生位置の表示が止まり、切る区間も飛ばせなくなる。
   *    timeupdate（毎秒4回ほど）を土台にして、rAF は滑らかさのために重ねる。
   */
  const advance = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    const src = v.currentTime;
    if (applyCuts && segments.length) {
      const jump = skipTarget(segments, src);
      if (jump !== null) v.currentTime = jump;
      else if (src >= segments[segments.length - 1].srcEnd - 0.02) {
        v.pause();
        setPlaying(false);
      }
      setTime(toOutput(segments, v.currentTime));
    } else {
      setTime(src);
    }

    // BGM のずれを直す。0.3秒以上ずれたときだけ合わせる
    const a = audioRef.current;
    if (a && music && !a.paused) {
      const want =
        (applyCuts && segments.length ? toOutput(segments, v.currentTime) : v.currentTime) -
        music.start;
      if (want >= 0) {
        const cur = music.loop && a.duration ? want % Math.max(0.05, a.duration) : want;
        if (Math.abs(a.currentTime - cur) > 0.3) a.currentTime = cur;
      }
    }
  }, [applyCuts, segments, music]);

  // 土台。ウインドウが前面でなくても鳴る
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    v.addEventListener('timeupdate', advance);
    v.addEventListener('seeked', advance);
    return () => {
      v.removeEventListener('timeupdate', advance);
      v.removeEventListener('seeked', advance);
    };
  }, [advance]);

  // 滑らかさのために重ねる。前面のときだけ鳴る
  useEffect(() => {
    if (!playing) return;
    let id = 0;
    const tick = () => {
      advance();
      id = requestAnimationFrame(tick);
    };
    id = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(id);
  }, [playing, advance]);

  const play = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    void v.play().then(() => setPlaying(true));
    const a = audioRef.current;
    if (a && music) void a.play().catch(() => undefined);
  }, [music]);

  const pause = useCallback(() => {
    videoRef.current?.pause();
    audioRef.current?.pause();
    setPlaying(false);
  }, []);

  /** 逆再生の音は shuttle 以外でも必ず止める（下で定義） */

  const toggle = useCallback(() => {
    if (videoRef.current?.paused) play();
    else pause();
  }, [play, pause]);

  /**
   * J / K / L の早送り。
   * 🔴 逆再生は <video> だけではできない。
   *    負の playbackRate は主要なブラウザで動かないので、
   *    自分で時刻を戻す。編集ソフトの J と同じ手触りにする。
   */
  const reverse = useRef<number | null>(null);

  /*
    逆向きにした音を用意する。
    重いので**初めて J を押したときに一度だけ**作り、あとは使い回す。
  */
  const revCtx = useRef<AudioContext | null>(null);
  const revBuf = useRef<AudioBuffer | null>(null);
  const revNode = useRef<AudioBufferSourceNode | null>(null);
  const revGain = useRef<GainNode | null>(null);
  const revLoading = useRef(false);

  const ensureReverseAudio = useCallback(async () => {
    if (revBuf.current || revLoading.current || !reverseAudioPath) return;
    revLoading.current = true;
    try {
      const res = await fetch(reverseAudioPath);
      if (!res.ok) return;
      const raw = await res.arrayBuffer();
      const ctx = revCtx.current ?? new AudioContext();
      revCtx.current = ctx;
      const decoded = await ctx.decodeAudioData(raw);
      // 全チャンネルを前後ひっくり返す
      const out = ctx.createBuffer(decoded.numberOfChannels, decoded.length, decoded.sampleRate);
      for (let ch = 0; ch < decoded.numberOfChannels; ch++) {
        const src = decoded.getChannelData(ch);
        const dst = out.getChannelData(ch);
        for (let i = 0, n = src.length; i < n; i++) dst[i] = src[n - 1 - i];
      }
      revBuf.current = out;
    } catch {
      /* 逆再生の音が出せなくても、映像の逆送りは続ける */
    } finally {
      revLoading.current = false;
    }
  }, [reverseAudioPath]);

  const stopReverseAudio = useCallback(() => {
    try {
      revNode.current?.stop();
    } catch {
      /* すでに止まっている */
    }
    revNode.current?.disconnect();
    revNode.current = null;
  }, []);

  /** srcSec（元素材の秒）から、speed 倍で逆向きに鳴らす */
  const startReverseAudio = useCallback(
    (srcSec: number, speed: number) => {
      const ctx = revCtx.current;
      const buf = revBuf.current;
      if (!ctx || !buf || muted || volume <= 0) return;
      stopReverseAudio();
      void ctx.resume();
      const node = ctx.createBufferSource();
      node.buffer = buf;
      node.playbackRate.value = Math.min(MAX_RATE, Math.max(MIN_RATE, speed));
      const gain = revGain.current ?? ctx.createGain();
      gain.gain.value = volume;
      revGain.current = gain;
      node.connect(gain).connect(ctx.destination);
      // 逆向きの波形なので、開始位置は「終わりから測った位置」になる
      const offset = Math.max(0, Math.min(buf.duration, buf.duration - srcSec));
      node.start(0, offset);
      revNode.current = node;
    },
    [muted, volume, stopReverseAudio],
  );

  const shuttle = useCallback(
    (v: number) => {
      if (reverse.current !== null) {
        cancelAnimationFrame(reverse.current);
        reverse.current = null;
      }
      stopReverseAudio();
      if (v === 0) {
        pause();
        setRateState(1);
        return;
      }
      setRateState(v);
      if (v > 0) {
        play();
        return;
      }
      // 逆送り
      pause();
      void ensureReverseAudio().then(() => {
        const vid = videoRef.current;
        if (vid) startReverseAudio(vid.currentTime, Math.abs(v));
      });
      let last = performance.now();
      const step = () => {
        const now = performance.now();
        const dt = (now - last) / 1000;
        last = now;
        setTime((t) => {
          const next = Math.max(0, t + v * dt);
          const vid = videoRef.current;
          if (vid) {
            const src = applyCuts && segments.length ? toSource(segments, next) : next;
            if (Number.isFinite(src)) vid.currentTime = src;
          }
          return next;
        });
        reverse.current = requestAnimationFrame(step);
      };
      reverse.current = requestAnimationFrame(step);
    },
    [play, pause, applyCuts, segments, ensureReverseAudio, startReverseAudio, stopReverseAudio],
  );

  useEffect(
    () => () => {
      if (reverse.current !== null) cancelAnimationFrame(reverse.current);
      stopReverseAudio();
      void revCtx.current?.close();
    },
    [stopReverseAudio],
  );

  const setVolume = useCallback((v: number) => setVolumeState(Math.min(1, Math.max(0, v))), []);
  const setMuted = useCallback((v: boolean) => setMutedState(v), []);
  const setRate = useCallback((v: number) => {
    setRateState(v);
    const vid = videoRef.current;
    if (vid) setRateSafely(vid, v);
  }, []);

  // BGM のファイルが変わったら読み直す
  useEffect(() => {
    const a = audioRef.current;
    if (!a) return;
    if (!musicUrl) {
      a.pause();
      a.removeAttribute('src');
      return;
    }
    a.src = musicUrl;
    a.load();
  }, [musicUrl]);

  return {
    videoRef,
    audioRef,
    segments,
    duration: outDuration,
    time,
    playing,
    volume,
    muted,
    rate,
    seek,
    play,
    pause,
    toggle,
    setVolume,
    setMuted,
    setRate,
    shuttle,
  };
}
