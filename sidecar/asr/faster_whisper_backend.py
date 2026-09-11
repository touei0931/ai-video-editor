"""faster-whisper による文字起こし（Windows 側の実装）。

Mac 側は pywhispercpp + CoreML を使う（§7.2 / §8.2）。
バックエンドの選択は asr/__init__.py の make_asr() だけが知る。

精度設計は2パス（§9.2）:
  turbo で全体を処理し、低信頼度セグメントだけ large-v3 で再認識する。
  Phase 0 では1パスのみ実装し、2パスは Phase 2 で足す。
"""

from __future__ import annotations

import os
import sys
import time
from typing import Callable

# 単語レベルのタイムスタンプは①カットに必須（無音・フィラーの境界を出すため）
WORD_TIMESTAMPS = True

# ── 日本語特化モデル ──
#
# kotoba-whisper は日本語の話し言葉で large-v3 より良い（ReazonSpeech test で
# CER 11.6 vs 14.9）。朗読のようなきれいな音声では少し劣る（CommonVoice 9.2 vs 8.5）。
# デコーダが2層しかないので、速さは turbo 並み。Apache-2.0 / MIT。
#
# 🔴 配布されている faster-whisper 版は、**そのままだと語の時刻を出せない**。
#    config.json の alignment_heads が教師（large-v3、デコーダ32層）のもの
#    （層 7, 10, 12, …, 25）をそのまま持っていて、2層しかないデコーダから
#    存在しない層の注意を読みに行き、Segmentation fault で落ちる
#    （2026-09-11 に実測。同じ作りの distil-large-v3 は層1の20ヘッドを使う）。
#    PAC はカット検出もテロップの時刻も語の時刻に依存しているので、
#    alignment_heads を差し替えた自前の置き場所から読む。
#
# 🔴 日本語専用。言語の設定に関わらず日本語として文字起こしする。
KOTOBA_NAME = "kotoba-whisper-v2.0"
KOTOBA_REPO = "kotoba-tech/kotoba-whisper-v2.0-faster"
# デコーダの最後の層（index 1）の全20ヘッド。distil-large-v3 と同じ
KOTOBA_ALIGNMENT_HEADS = [[1, h] for h in range(20)]

SPECIAL_MODELS = {KOTOBA_NAME: KOTOBA_REPO}


def pac_model_root() -> "Path":
    """PAC が手を入れたモデルの置き場所。

    HF のキャッシュ（~/.cache/huggingface）と同じ場所に置くこと。
    - 手順書の「消したいときは ~/.cache/huggingface を消す」がそのまま効く
    - 同じボリュームなので、1.5GB の本体をハードリンクで共有できる
    """
    from pathlib import Path

    env = os.environ.get("PAC_MODEL_ROOT")
    if env:
        return Path(env)
    hf = os.environ.get("HF_HOME")
    base = Path(hf) if hf else Path.home() / ".cache" / "huggingface"
    return base / "pac-models"


def prepare_patched_model(snapshot: "Path", dest: "Path", alignment_heads: list[list[int]]) -> "Path":
    """snapshot の中身を dest に揃え、config.json の alignment_heads だけ差し替える。

    本体（model.bin）は 1.5GB あるのでコピーせず、ハードリンクで共有する。
    リンクできなければコピーする。config.json だけは書き直すので必ず実体を作る。
    """
    import json
    import shutil
    from pathlib import Path

    snapshot = Path(snapshot)
    dest = Path(dest)
    dest.mkdir(parents=True, exist_ok=True)

    cfg_path = snapshot / "config.json"
    cfg = json.loads(cfg_path.read_text(encoding="utf-8")) if cfg_path.exists() else {}
    cfg["alignment_heads"] = alignment_heads
    (dest / "config.json").write_text(json.dumps(cfg, ensure_ascii=False, indent=2), encoding="utf-8")

    for src in snapshot.iterdir():
        if src.name == "config.json" or src.is_dir():
            continue
        real = src.resolve()  # HF のキャッシュはシンボリックリンク
        out = dest / src.name
        if out.exists() and out.stat().st_size == real.stat().st_size:
            continue
        if out.exists():
            out.unlink()
        try:
            os.link(real, out)
        except OSError:
            shutil.copyfile(real, out)
    return dest


def resolve_model(model_name: str) -> str:
    """faster-whisper に渡す名前（または置き場所）を決める。

    ふつうのモデルはそのまま。手を入れる必要のあるものだけ、
    取り寄せて差し替えた置き場所を返す。
    """
    if model_name != KOTOBA_NAME:
        return model_name
    from huggingface_hub import snapshot_download

    snap = snapshot_download(KOTOBA_REPO)
    dest = pac_model_root() / "kotoba-whisper-v2.0-faster"
    return str(prepare_patched_model(snap, dest, KOTOBA_ALIGNMENT_HEADS))

ProgressFn = Callable[[float, str], None]
CancelFn = Callable[[], bool]


class FasterWhisperAsr:
    """
    CUDA が使えれば使い、駄目なら CPU に落ちる。

    CTranslate2 は CUDA を使うのに cuBLAS / cuDNN の DLL を要求するが、
    NVIDIA GPU があってもこれらが入っているとは限らない
    （実際に `cublas64_12.dll is not found` で落ちた）。
    しかも失敗するのはモデル読み込み時ではなく**最初の推論時**なので、
    読み込みだけで判定してはいけない。
    """

    def __init__(self, device: str | None = None, compute_type: str | None = None) -> None:
        # ASR_DEVICE=cpu で CUDA を試さずに CPU 固定できる。
        # CUDA 環境の不備は切り分けが難しいので、逃げ道を用意しておく。
        self.requested_device = device or os.environ.get("ASR_DEVICE", "auto")
        self.compute_type = compute_type
        self._model = None
        self._model_name: str | None = None
        self.device: str | None = None

    def _build(self, model_name: str, device: str):
        from faster_whisper import WhisperModel

        compute = self.compute_type or ("float16" if device == "cuda" else "int8")
        model = WhisperModel(resolve_model(model_name), device=device, compute_type=compute)
        self._model = model
        self._model_name = model_name
        self.device = device
        return model

    def _load(self, model_name: str):
        # モデルは重いので使い回す。切り替わったときだけ読み直す。
        if self._model is not None and self._model_name == model_name:
            return self._model

        if self.requested_device in ("cpu", "cuda"):
            return self._build(model_name, self.requested_device)

        try:
            return self._build(model_name, "cuda")
        except Exception as e:  # noqa: BLE001
            print(f"asr: CUDA を使えないため CPU で動かします（{e}）", file=sys.stderr, flush=True)
            return self._build(model_name, "cpu")

    def _fallback_to_cpu(self, model_name: str, reason: str):
        print(f"asr: CUDA での推論に失敗したため CPU に切り替えます（{reason}）",
              file=sys.stderr, flush=True)
        self._model = None
        self._model_name = None
        return self._build(model_name, "cpu")

    def transcribe(
        self,
        audio_path: str,
        model: str = "large-v3-turbo",
        language: str = "ja",
        on_progress: ProgressFn | None = None,
        is_cancelled: CancelFn | None = None,
    ) -> dict:
        started = time.perf_counter()

        if on_progress:
            # 初回はモデルのダウンロード（large-v3-turbo で約1.6GB）が走る。
            # 何分も無反応に見えるので、必ず理由を出す。
            on_progress(0.0, f"モデルを準備中: {model}（初回のみダウンロードします）")
        whisper = self._load(model)
        load_seconds = time.perf_counter() - started

        if on_progress:
            on_progress(0.05, "文字起こし中")

        # 日本語専用のモデルは、言語の設定に関わらず日本語で起こす
        if model == KOTOBA_NAME:
            language = "ja"

        def start(model_obj):
            return model_obj.transcribe(
                audio_path,
                language=language,
                word_timestamps=WORD_TIMESTAMPS,
                # Silero VAD（§11.1）。faster-whisper に内蔵のものがそれ。
                # 無音・雑音を先に落とすので、精度が上がるうえに**2倍速くなる**。
                # タイムスタンプは元の時間軸に戻されるので、カット判定への影響はない。
                vad_filter=True,
                # 🔴 既定の閾値 0.5 は**実際の発話を落とす**。
                #    静かな家庭内の会話（子どもの声）で実測したところ、
                #    「お姉ちゃんが、この中にあるから」3.5秒がまるごと消えた。
                #    0.2 まで下げ、前後の余白を増やすと VAD 無しと同じ結果になる。
                #    ゲーム音声でも劣化せず、むしろ誤認識が減った。
                vad_parameters={"threshold": 0.2, "speech_pad_ms": 600},
                # 直前の文を文脈として渡さない。
                # 渡すと、雑音の多い素材で一度おかしな出力が出たときに
                # それを引きずって同じ語を延々繰り返す（Whisper の既知の失敗）。
                # きれいな素材では結果が変わらないことを実測で確認済み。
                condition_on_previous_text=False,
            )

        segments_iter, info = start(whisper)

        duration = info.duration or 0.0
        segments: list[dict] = []

        # faster-whisper は遅延評価なので、ここで初めて実際の推論が走る。
        # 1セグメントずつ取り出せるため、進捗を出せるしキャンセルも効く。
        # CUDA の DLL 不足はこのタイミングで初めて露見するので、ここでも CPU に落とせるようにする。
        try:
            first = next(iter(segments_iter), None)
        except Exception as e:  # noqa: BLE001
            if self.device != "cpu":
                whisper = self._fallback_to_cpu(model, str(e))
                segments_iter, info = start(whisper)
                duration = info.duration or 0.0
                first = next(iter(segments_iter), None)
            else:
                raise

        def all_segments():
            if first is not None:
                yield first
            yield from segments_iter

        for seg in all_segments():
            if is_cancelled and is_cancelled():
                return {"cancelled": True, "segments": segments}

            segments.append({
                "id": f"s{len(segments):04d}",
                "src_start": round(seg.start, 3),
                "src_end": round(seg.end, 3),
                "text": seg.text.strip(),
                "avg_logprob": round(seg.avg_logprob, 4),
                "no_speech_prob": round(seg.no_speech_prob, 4),
                "words": [
                    {
                        "src_start": round(w.start, 3),
                        "src_end": round(w.end, 3),
                        "text": w.word,
                        "probability": round(w.probability, 4),
                    }
                    for w in (seg.words or [])
                ],
            })

            if on_progress and duration > 0:
                on_progress(min(0.99, 0.05 + 0.94 * (seg.end / duration)), "文字起こし中")

        elapsed = time.perf_counter() - started
        if on_progress:
            on_progress(1.0, "完了")

        return {
            "cancelled": False,
            "backend": "faster-whisper",
            "device": self.device,
            "model": model,
            "language": info.language,
            "duration": round(duration, 3),
            "load_seconds": round(load_seconds, 2),
            "elapsed_seconds": round(elapsed, 2),
            "realtime_factor": round(duration / elapsed, 2) if elapsed > 0 else None,
            "segments": segments,
        }
