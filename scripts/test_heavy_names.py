"""heavy.py の出演者名補正まわり（_fix_names / _analyze の name_fixes）の検査。

names.py の規則そのものは scripts/test_names.py。ここで見るのは heavy.py の配線:

🔴 守っていること:
   - _fix_names は読んだ直後に _clean_if_needed を通し、transcript.json と transcript.raw.json の
     両方に cleaned フラグを付ける。フラグ無しの旧ファイルに当てた後、build_telops / redetect が
     再 clean しても、名前が揃った連続セグメント（ぺこらちゃん ×2 / ぺこら）が落ちない。
   - raw があれば raw から当て直す。cast を変えると前回の補正は残らない。
   - count 0 でも書き戻す。
   - analysis.json が隣にあれば transcript.text と name_fixes（fixes 抜きの要約）を更新する。
   - transcript_path が無ければ FileNotFoundError（raw だけ隣にあっても新規ファイルを作らない）。
   - _analyze の返り値に name_fixes（count / cast / path / raw_transcript_path / skipped_mismatch / warnings）。
     clip-factory はこれが無いと「PAC が fix_names を知らない」と警告する。cast 無しなら None。
   - _analyze は不正な cast を ASR の前に ValueError で落とす。

一時ディレクトリに transcript.json を書いて heavy の関数を直接呼ぶ。ffmpeg も ASR も使わない
（_analyze は media / ASR をモックに差し替える）。

実行: python scripts/test_heavy_names.py
"""

from __future__ import annotations

import copy
import json
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from _console import enable_utf8  # noqa: E402

import sidecar.heavy as heavy  # noqa: E402
import sidecar.media as media  # noqa: E402

failed = 0


def check(name: str, ok: bool, detail: str = "") -> None:
    global failed
    if not ok:
        failed += 1
    print(f"[heavy-names] {'OK  ' if ok else 'NG  '} {name}")
    if detail:
        print(f"        {detail}")


def seg(i: int, text: str, prob: float) -> dict:
    """1 文字 1 語。prob は全 word の確度（0.5 未満だと clean の「似た繰り返し」判定に掛かる）。"""
    start = i * 2.0
    step = 0.15
    return {
        "id": i,
        "src_start": start,
        "src_end": start + step * len(text),
        "text": text,
        "avg_logprob": -0.5,
        "words": [
            {"src_start": round(start + k * step, 3), "src_end": round(start + (k + 1) * step, 3),
             "text": c, "probability": prob}
            for k, c in enumerate(text)
        ],
    }


def old_transcript() -> dict:
    """analyze 相当の transcript.json（掃除済み・cleaned フラグ無し）。
    補正後に ぺこらちゃん / ぺこらちゃん / ぺこら と揃い、再 clean で全部落ちる型。"""
    return {
        "duration": 10.0,
        "backend": "mock",
        "segments": [
            seg(0, "こんにちは", 0.9),
            seg(1, "ぺこれちゃん", 0.4),
            seg(2, "ペコラちゃん", 0.4),
            seg(3, "ぺこら", 0.45),
            seg(4, "それでね", 0.9),
        ],
    }


PEKORA = ["兎田ぺこら ぺこら ぺこ"]
NO_PROGRESS = lambda *_a: None  # noqa: E731
SUMMARY_KEYS = {"count", "cast", "path", "raw_transcript_path", "skipped_mismatch", "warnings"}


def read(p: Path) -> dict:
    return json.loads(p.read_text(encoding="utf-8"))


def texts(tr: dict) -> list[str]:
    return [s["text"] for s in tr["segments"]]


def test_fix_names() -> None:
    d = Path(tempfile.mkdtemp(prefix="pac-heavy-names-"))
    tp = d / "transcript.json"
    raw = d / heavy.RAW_TRANSCRIPT_FILE
    tp.write_text(json.dumps(old_transcript(), ensure_ascii=False), encoding="utf-8")

    # ① 旧ファイル（フラグ無し）→ transcript.json と raw の両方に cleaned が付き、名前が揃う
    res = heavy._fix_names({"transcript_path": str(tp), "cast": PEKORA}, NO_PROGRESS)
    after = read(tp)
    check("旧ファイルに当てると transcript.json に cleaned が付く", after.get("cleaned") is True, str(after.get("cleaned")))
    check("raw（transcript.raw.json）にも cleaned が付く", raw.exists() and read(raw).get("cleaned") is True)
    check("raw の中身は補正前（ぺこれちゃん のまま）", texts(read(raw)) == texts(old_transcript()), str(texts(read(raw))))
    check("補正で 3 セグメントが ぺこら 系に揃う（ぺこれ→ぺこら は同じ人の短い alias ぺこ を跨いで直る）",
          texts(after) == ["こんにちは", "ぺこらちゃん", "ぺこらちゃん", "ぺこら", "それでね"] and res["count"] == 2,
          f"{texts(after)} / count={res['count']}")
    check("返り値に count / fixes / paths", res["count"] == 2 and len(res["fixes"]) == 2
          and res["transcript_path"] == str(tp) and res["raw_transcript_path"] == str(raw)
          and Path(res["name_fixes_path"]).exists(), str({k: v for k, v in res.items() if k != "fixes"}))

    # ② その後 _clean_if_needed（build_telops / redetect と同じ）を通しても落ちない
    again = read(tp)
    heavy._clean_if_needed(again)
    check("再 clean で 5 セグメント全部残る（名前が揃った 3 つが落ちない）", len(again["segments"]) == 5, str(texts(again)))
    # 対照: フラグを剥がすと clean が 3 つ落とす（この検査が何を守っているかの確認）
    stripped = read(tp)
    stripped.pop("cleaned", None)
    heavy._clean_if_needed(stripped)
    check("対照: cleaned フラグ無しで再 clean すると 3 セグメント落ちる", len(stripped["segments"]) == 2, str(texts(stripped)))

    # ③ raw があれば raw から当て直す。cast を変えると前回の補正が残らない
    res2 = heavy._fix_names({"transcript_path": str(tp), "cast": ["天音かなた かなた"]}, NO_PROGRESS)
    after2 = read(tp)
    check("cast を変えて呼び直すと raw から当て直され、前回の ぺこらちゃん は残らない",
          texts(after2) == texts(old_transcript()) and res2["count"] == 0, f"{texts(after2)} / count={res2['count']}")
    check("当て直し後も cleaned が付いている", after2.get("cleaned") is True)

    # ④ count 0 でも書き戻す（書き戻し前に置いた印が消える）
    marked = read(tp)
    marked["__marker__"] = 1
    tp.write_text(json.dumps(marked, ensure_ascii=False), encoding="utf-8")
    res3 = heavy._fix_names({"transcript_path": str(tp), "cast": ["天音かなた かなた"]}, NO_PROGRESS)
    check("count 0 でも transcript.json を書き戻す", res3["count"] == 0 and "__marker__" not in read(tp), str(read(tp).keys()))
    fixes_file = read(d / heavy.NAME_FIXES_FILE)
    check("name_fixes.json も count 0 で書き直る", fixes_file["count"] == 0 and fixes_file["cast"] == ["天音かなた"], str(fixes_file))

    # ⑤ analysis.json が隣にあれば transcript.text と name_fixes が更新される
    analysis = {"duration": 10.0, "candidates": [], "transcript": {"backend": "mock", "text": "古い本文"}, "name_fixes": None}
    (d / "analysis.json").write_text(json.dumps(analysis, ensure_ascii=False), encoding="utf-8")
    res4 = heavy._fix_names({"transcript_path": str(tp), "cast": PEKORA}, NO_PROGRESS)
    an = read(d / "analysis.json")
    check("analysis.json の transcript.text が補正後の本文になる",
          an["transcript"]["text"] == "こんにちはぺこらちゃんぺこらちゃんぺこらそれでね", an["transcript"]["text"])
    check("analysis.json の name_fixes は fixes 抜きの要約",
          isinstance(an["name_fixes"], dict) and set(an["name_fixes"]) == SUMMARY_KEYS and an["name_fixes"]["count"] == res4["count"] == 2,
          str(an["name_fixes"]))
    check("analysis.json の他の項目は触らない", an["duration"] == 10.0 and an["candidates"] == [] and an["transcript"]["backend"] == "mock")

    # ⑥ transcript_path が無ければ FileNotFoundError（raw が隣にあっても新規ファイルを作らない）
    missing = d / "nope.json"
    try:
        heavy._fix_names({"transcript_path": str(missing), "cast": PEKORA}, NO_PROGRESS)
        check("transcript_path が無ければ FileNotFoundError", False, "例外が出なかった")
    except FileNotFoundError:
        check("transcript_path が無ければ FileNotFoundError（raw が隣にあっても）", not missing.exists(), "ファイルが作られた" if missing.exists() else "")
    try:
        heavy._fix_names({"cast": PEKORA}, NO_PROGRESS)
        check("transcript_path 無しは ValueError", False, "例外が出なかった")
    except ValueError:
        check("transcript_path 無しは ValueError", True)

    # 不正な cast は読む前に落ちる（transcript.json は変わらない）
    before = tp.read_text(encoding="utf-8")
    try:
        heavy._fix_names({"transcript_path": str(tp), "cast": "兎田ぺこら ぺこら"}, NO_PROGRESS)
        check("str のままの cast は ValueError", False, "例外が出なかった")
    except ValueError:
        check("str のままの cast は ValueError で、transcript.json は変わらない", tp.read_text(encoding="utf-8") == before)


class _MockAsr:
    def __init__(self) -> None:
        self.calls = 0

    def transcribe(self, wav, *, model, language, on_progress, is_cancelled):  # noqa: ANN001
        self.calls += 1
        tr = old_transcript()
        tr["model"] = model
        return tr


def test_analyze_name_fixes() -> None:
    """_analyze を media / ASR のモックで通し、返り値と analysis.json の name_fixes の形を見る。"""
    d = Path(tempfile.mkdtemp(prefix="pac-heavy-analyze-"))
    video = d / "src.mp4"
    video.write_bytes(b"")
    work = d / "work"
    mock = _MockAsr()

    saved = {
        "ensure_readable_video": media.ensure_readable_video,
        "ensure_writable_dir": media.ensure_writable_dir,
        "extract_audio": media.extract_audio,
        "probe_video_info": media.probe_video_info,
    }
    saved_asr = heavy._asr
    media.ensure_readable_video = lambda p: None
    media.ensure_writable_dir = lambda p, what: Path(p).mkdir(parents=True, exist_ok=True)
    media.extract_audio = lambda v, out, on_progress=None: out
    media.probe_video_info = lambda p: {"duration": 10.0, "width": 1920, "height": 1080, "fps": 30.0}
    heavy._asr = mock
    try:
        base = {"video_path": str(video), "work_dir": str(work), "skip_review_clips": True}
        res = heavy._analyze({**base, "cast": PEKORA}, NO_PROGRESS)
        nf = res.get("name_fixes")
        check("_analyze の返り値に name_fixes（fixes 抜きの要約）",
              isinstance(nf, dict) and set(nf) == SUMMARY_KEYS, str(nf))
        check("name_fixes の中身: count 2 / cast / path / raw_transcript_path",
              isinstance(nf, dict) and nf["count"] == 2 and nf["cast"] == ["兎田ぺこら"]
              and Path(nf["path"]).name == heavy.NAME_FIXES_FILE and Path(nf["raw_transcript_path"]).name == heavy.RAW_TRANSCRIPT_FILE
              and nf["skipped_mismatch"] == 0 and nf["warnings"] == [], str(nf))
        an = read(work / "analysis.json")
        check("analysis.json の name_fixes も同じ要約", an.get("name_fixes") == nf, str(an.get("name_fixes")))
        tr = read(work / "transcript.json")
        check("analyze の transcript.json は補正済みで cleaned 付き",
              tr.get("cleaned") is True and texts(tr) == ["こんにちは", "ぺこらちゃん", "ぺこらちゃん", "ぺこら", "それでね"], str(texts(tr)))
        rw = read(work / heavy.RAW_TRANSCRIPT_FILE)
        check("analyze の raw は補正前で cleaned 付き", rw.get("cleaned") is True and texts(rw) == texts(old_transcript()), str(texts(rw)))
        check("返り値の transcript.text は補正後", res["transcript"]["text"] == "こんにちはぺこらちゃんぺこらちゃんぺこらそれでね", res["transcript"]["text"])

        # cast 無し → name_fixes は None（キーはある）
        res0 = heavy._analyze(base, NO_PROGRESS)
        check("cast 無しなら name_fixes は None（キーは残す）", "name_fixes" in res0 and res0["name_fixes"] is None, str(res0.get("name_fixes")))

        # 不正な cast は ASR の前に ValueError
        calls = mock.calls
        try:
            heavy._analyze({**base, "cast": "兎田ぺこら ぺこら"}, NO_PROGRESS)
            check("不正な cast（str のまま）は ValueError", False, "例外が出なかった")
        except ValueError:
            check("不正な cast（str のまま）は ASR の前に ValueError", mock.calls == calls, f"ASR が {mock.calls - calls} 回呼ばれた")
    finally:
        for k, v in saved.items():
            setattr(media, k, v)
        heavy._asr = saved_asr


def main() -> int:
    enable_utf8()
    test_fix_names()
    test_analyze_name_fixes()
    print()
    print("test-heavy-names: 全て通りました" if failed == 0 else f"test-heavy-names: {failed} 件失敗")
    return 0 if failed == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
