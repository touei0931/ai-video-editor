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

import { useCallback, useEffect, useRef, useState } from 'react';
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
  const { duration: srcDuration, cuts, applyCuts, music, musicUrl } = opts;

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  const [segments, setSegments] = useState<Segment[]>([]);
  const [time, setTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const pref = useRef(loadPref());
  const [volume, setVolumeState] = useState(pref.current.volume);
  const [muted, setMutedState] = useState(pref.current.muted);
  const [rate, setRateState] = useState(1);

  useEffect(() => {
    setSegments(applyCuts ? buildSegments(srcDuration, cuts) : []);
  }, [srcDuration, cuts, applyCuts]);

  const outDuration = applyCuts && segments.length ? outputDuration(segments) : srcDuration;

  /* ---- 音量・速度 ---- */

  useEffect(() => {
    const v = videoRef.current;
    if (v) {
      v.volume = volume;
      v.muted = muted;
      v.playbackRate = Math.abs(rate) || 1;
    }
    const a = audioRef.current;
    if (a) {
      // BGM は元の音量に対する掛け算。全体の音量を下げたら BGM も下がる
      a.volume = volume * (music?.volume ?? 0.18);
      a.muted = muted;
      a.playbackRate = Math.abs(rate) || 1;
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

  /*
    毎コマ見る。
    - 切る区間に入っていたら次へ飛ばす
    - 表示用の時刻（出来上がりの時刻）を更新する
    - BGM のずれを直す
  */
  useEffect(() => {
    if (!playing) return;
    let id = 0;
    const tick = () => {
      const v = videoRef.current;
      if (v) {
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
          const want = (applyCuts && segments.length ? toOutput(segments, v.currentTime) : v.currentTime) - music.start;
          if (want >= 0) {
            const cur = music.loop && a.duration ? want % Math.max(0.05, a.duration) : want;
            if (Math.abs(a.currentTime - cur) > 0.3) a.currentTime = cur;
          }
        }
      }
      id = requestAnimationFrame(tick);
    };
    id = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(id);
  }, [playing, applyCuts, segments, music]);

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
  const shuttle = useCallback(
    (v: number) => {
      if (reverse.current !== null) {
        cancelAnimationFrame(reverse.current);
        reverse.current = null;
      }
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
    [play, pause, applyCuts, segments],
  );

  useEffect(
    () => () => {
      if (reverse.current !== null) cancelAnimationFrame(reverse.current);
    },
    [],
  );

  const setVolume = useCallback((v: number) => setVolumeState(Math.min(1, Math.max(0, v))), []);
  const setMuted = useCallback((v: boolean) => setMutedState(v), []);
  const setRate = useCallback((v: number) => {
    setRateState(v);
    const vid = videoRef.current;
    if (vid) vid.playbackRate = Math.abs(v) || 1;
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
