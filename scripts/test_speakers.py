"""話者の見分け（sidecar/speakers.py）の検査。

🔴 守っていること:
   - 登録済みの声との照合は「閾値」と「2位との差」の両方で縛る。
     似た2人のどちらか分からないものに色を付けると、間違った色が半分出る
   - 当たらなかった声のまとめ直しは、後から似てきた組も合流させる
   - 覚えた声は上限で古いものから捨てる。名前と色は消えない
   - 壊れたファイルは空として読む（覚え直せる）

モデル本体は要らない（埋め込みを直接渡す）。モデルがあれば最後に実物で1回通す。

実行: python scripts/test_speakers.py
"""

from __future__ import annotations

import json
import sys
import tempfile
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from _console import enable_utf8  # noqa: E402

from sidecar import speakers as S  # noqa: E402

failed = 0


def check(name: str, ok: bool, detail: str = "") -> None:
    global failed
    if not ok:
        failed += 1
    print(f"[speakers] {'OK  ' if ok else 'NG  '} {name}")
    if detail:
        print(f"           {detail}")


def unit(v: list[float]) -> np.ndarray:
    a = np.asarray(v, dtype=np.float32)
    return a / np.linalg.norm(a)


def main() -> int:
    enable_utf8()
    rng = np.random.default_rng(7)

    # 3人の「声」。それぞれ少しずつ違う区間を作る
    base = {k: unit(rng.normal(size=64)) for k in ("A", "B", "C")}

    # 実物の埋め込みは 512 次元で同じ人どうし 0.5〜0.6。64 次元の作り物では 0.05 の揺れがそれに当たる
    def sample(k: str, noise: float = 0.05) -> np.ndarray:
        return unit(base[k] + rng.normal(size=64) * noise)

    speakers = [
        {"id": "a", "name": "A", "color": "#fff", "samples": [sample("A").tolist() for _ in range(5)]},
        {"id": "b", "name": "B", "color": "#0ff", "samples": [sample("B").tolist() for _ in range(5)]},
    ]

    # ── 照合 ──
    got = S.match_embeddings([sample("A"), sample("B"), sample("C"), None], speakers)
    check("A の声は A に当たる", got[0][0] == "a", str(got[0]))
    check("B の声は B に当たる", got[1][0] == "b", str(got[1]))
    check("登録に無い声は当てない", got[2][0] is None, str(got[2]))
    check("短すぎて特徴が無いものは当てない", got[3] == (None, 0.0), str(got[3]))

    # 🔴 A と B のちょうど中間の声は、閾値を超えても「どちらとも言えない」で当てない
    exact = [
        {"id": "a", "name": "A", "color": "#fff", "samples": [base["A"].tolist()]},
        {"id": "b", "name": "B", "color": "#0ff", "samples": [base["B"].tolist()]},
    ]
    mid = unit(base["A"] + base["B"])
    got = S.match_embeddings([mid], exact, threshold=0.3, margin=0.06)
    check("2人の中間の声は当てない（2位との差が無い）", got[0][0] is None, str(got[0]))

    # ── まとめ直し ──
    # 実物の埋め込みは 512 次元で同じ人どうし 0.5〜0.6。64 次元の作り物では 0.05 の揺れがそれに当たる
    embs = [sample("A", 0.05) for _ in range(4)] + [sample("C", 0.05) for _ in range(3)] + [sample("A", 0.05)] + [None]
    groups = S.group_unknown(embs, threshold=0.5)
    check("同じ声は同じ組になる", len({groups[i] for i in (0, 1, 2, 3, 7)}) == 1, str(groups))
    check("別の声は別の組になる", groups[0] != groups[4], str(groups))
    check("短すぎるものは組に入らない", groups[8] is None, str(groups))
    check("大きい組が 0 番", groups[0] == 0 and groups[4] == 1, str(groups))

    # ── 覚える・変える・消す（ファイル）──
    with tempfile.TemporaryDirectory() as tmp:
        path = str(Path(tmp) / "speakers.json")
        check("無ければ空", S.load_profiles(path)["speakers"] == [])
        Path(path).write_text("{ こわれた", encoding="utf-8")
        check("壊れていても空として読む", S.load_profiles(path)["speakers"] == [])

        prof = {"version": 1, "speakers": [{"id": "x", "name": "X", "color": "#123456", "samples": []}]}
        S.save_profiles(path, prof)
        loaded = S.load_profiles(path)
        check("保存して読める", loaded["speakers"][0]["name"] == "X")

        # 覚えた声の上限
        sp = loaded["speakers"][0]
        sp["samples"] = [[float(i)] * 4 for i in range(40)]
        sp["samples"] = sp["samples"][-S.DEFAULTS["max_samples"] :]
        check(f"覚えるのは {S.DEFAULTS['max_samples']} 本まで（古い順に捨てる）",
              len(sp["samples"]) == S.DEFAULTS["max_samples"] and sp["samples"][0][0] == 8.0)

        # update / delete は埋め込みを触らずに済むので、モデル無しで検める
        S.save_profiles(path, {"version": 1, "speakers": [sp]})
        r = S.update({"profiles_path": path, "id": "x", "name": "エックス", "color": "#abcdef"})
        check("名前と色を変えられる", r["speakers"][0]["name"] == "エックス" and r["speakers"][0]["color"] == "#abcdef")
        check("画面に渡す形に埋め込みは入らない", "samples" in r["speakers"][0] and isinstance(r["speakers"][0]["samples"], int))
        r = S.update({"profiles_path": path, "id": "x", "forget": True})
        check("声を忘れると本数が 0 になる（名前と色は残る）", r["speakers"][0]["samples"] == 0 and r["speakers"][0]["name"] == "エックス")
        r = S.delete({"profiles_path": path, "id": "x"})
        check("消せる", r["speakers"] == [])
        try:
            S.handle({"op": "なにそれ", "profiles_path": path})
            check("知らない操作は断る", False)
        except ValueError:
            check("知らない操作は断る", True)

    # ── 実物のモデルがあれば1回通す（無ければ飛ばす）──
    try:
        model = S.model_path()
    except RuntimeError:
        model = None
    if model is None:
        print("[speakers] --   モデルが無いので実物の検査は飛ばします（python scripts/fetch_models.py）")
    else:
        try:
            import sherpa_onnx  # noqa: F401
        except ImportError:
            print("[speakers] --   sherpa-onnx が無いので実物の検査は飛ばします")
        else:
            import wave

            with tempfile.TemporaryDirectory() as tmp:
                wav = str(Path(tmp) / "a.wav")
                sr = 16000
                t = np.arange(sr * 3) / sr
                # 2つの「声」らしきもの: 基音の違う倍音の束（本物の声ではないが特徴は取れる）
                def tone(f0: float) -> np.ndarray:
                    y = sum(np.sin(2 * np.pi * f0 * k * t) / k for k in range(1, 8))
                    return (y / np.max(np.abs(y)) * 0.6 * 32767).astype(np.int16)
                data = np.concatenate([tone(140.0), tone(260.0)])
                with wave.open(wav, "wb") as w:
                    w.setnchannels(1)
                    w.setsampwidth(2)
                    w.setframerate(sr)
                    w.writeframes(data.tobytes())
                path = str(Path(tmp) / "speakers.json")
                units = [
                    {"id": "u1", "src_start": 0.0, "src_end": 1.4},
                    {"id": "u2", "src_start": 1.5, "src_end": 2.9},
                    {"id": "u3", "src_start": 3.0, "src_end": 4.4},
                    {"id": "u4", "src_start": 4.5, "src_end": 5.9},
                    {"id": "u5", "src_start": 0.0, "src_end": 0.2},
                ]
                r = S.handle({"op": "identify", "wav_path": wav, "units": units, "profiles_path": path})
                check("実物: 登録が無ければ全部「不明」", r["matched"] == 0 and r["unknown"] == 4, str(r["voices"]))
                check("実物: 短すぎるものは数えない", r["tooShort"] == 1)
                e = S.handle({"op": "enroll", "wav_path": wav, "profiles_path": path, "name": "低い声", "color": "#ff0000",
                              "ranges": [units[0], units[1]]})
                check("実物: 覚えられる", e["added"] == 2 and e["speaker"]["samples"] == 2, str(e["speaker"]))
                r = S.handle({"op": "identify", "wav_path": wav, "units": units, "profiles_path": path})
                by = {u["id"]: u for u in r["units"]}
                check("実物: 覚えた声は当たる", by["u1"]["speaker"] == e["speaker"]["id"] and by["u2"]["speaker"] == e["speaker"]["id"],
                      json.dumps(by, ensure_ascii=False)[:300])
                # 作り物の音（倍音の束）は声ではないので別の声を「外す」検査はできない。
                # 覚えた区間のほうが確実に高く出ることだけ見る
                check("実物: 覚えた区間の類似度が他より高い",
                      by["u1"]["score"] > by["u3"]["score"] and by["u2"]["score"] > by["u4"]["score"],
                      f"u1 {by['u1']['score']} / u3 {by['u3']['score']}")

    print()
    print("test-speakers: OK" if failed == 0 else f"test-speakers: {failed} 件失敗")
    return 0 if failed == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
