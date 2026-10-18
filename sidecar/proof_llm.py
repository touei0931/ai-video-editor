"""前後の会話を読んで、文字起こしの直し候補を出す（ローカルの小さな LLM）。

決定論的な見直し（proof.py）で拾えない「文脈を読まないと分からない誤変換」を扱う。
実素材で見えた例:

    「ほんまか確かにまばたきしたら終わるはいはい母はいはいはいはいはい」
       → 「母」は幻聴。前後がすべて「はいはい」の連呼だと分かれば直せる
    「自信力だね本当にねえ待って嬉しいSVPおめでとう」
       → 「自信力」「SVP」。何の話をしているかが分かれば直せる

🔴 黙って書き換えないこと。**候補として出し、人が選ぶ**。
   テロップは発言の引用で、小さいモデルは「もっともらしい別の台詞」を作る。
   自動適用は、誤りが減る代わりに「言っていないこと」が混ざる。

🔴 返ってきた候補は必ず検算すること（validate）。
   - 直す前の語が、そのテロップに**そのまま入っている**こと（無ければ捨てる）
   - 語の置き換えに収めること（長い言い換え＝台詞の作り直しは捨てる）
   - 1枚につき 3件まで
   小さいモデルほど、頼んでいない書き直しを返す。

🔴 ネットに出ないこと。Mac は mlx（Apple の GPU）、Windows は Ollama。
   どちらも手元で動く。初回だけモデルの取得が要る（約 2.3GB）。

モデル（2026-10-19 に調べて決めた。[[2026-10-19-PAC-文字起こしを前後の文脈で見直す]]）:
   Mac     mlx-community/Qwen3-4B-Instruct-2507-4bit … 2.28GB / Apache-2.0 /
           思考ブロックを出さない（JSON が壊れにくい）
   Windows Ollama の qwen3:4b … 2.5GB。format にスキーマを渡せる（公式）
"""

from __future__ import annotations

import json
import re
from typing import Any, Callable

ProgressFn = Callable[[float, str], None]
CancelFn = Callable[[], bool]

#: 既定のモデル
MODELS = {
    "mlx": "mlx-community/Qwen3-4B-Instruct-2507-4bit",
    "ollama": "qwen3:4b",
}

#: 前後に何枚ぶんの会話を見せるか
WINDOW = 3
#: 1枚につき採る候補の数
MAX_PER_TELOP = 3
#: 「直す前の語」の長さの上限（これを超える＝台詞の作り直し）
MAX_SPAN = 14
#: 1回に見せるテロップの数（まとめて頼むと速いが、取り違えが増える）
BATCH = 1

_SCHEMA = {
    "type": "object",
    "properties": {
        "直し": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "前": {"type": "string"},
                    "後": {"type": "string"},
                    "理由": {"type": "string"},
                },
                "required": ["前", "後", "理由"],
            },
        }
    },
    "required": ["直し"],
}

_SYSTEM = """あなたは日本語の動画テロップの校正係です。
音声認識（文字起こし）の結果を、前後の会話と照らして見直します。

守ること:
- 直すのは**聞き間違いだと分かる語だけ**。言い回しや語尾は変えない
- 直す前の語は、対象の文に出てくる文字列をそのまま書く
- 自信が無ければ何も返さない（空の配列でよい）
- 話し言葉の崩れ（えー、あのー、〜っす）はそのまま残す
- 句読点の有無は直さない

返すのは JSON だけ:
{"直し":[{"前":"誤っている語","後":"正しい語","理由":"短い根拠"}]}
直す所が無ければ {"直し":[]} と返す。"""


def pick_engine() -> str:
    """どちらで動かすか。**入っているものを見て決める**（OS は見ない）。

    🔴 プラットフォーム分岐にしないこと。
       プラットフォーム差は4ファイルに閉じ込める決まりがある（platform-guard）。
       ここは「mlx-lm が入っていれば mlx、無ければ Ollama」という
       **部品の有無**で決める。Mac で Ollama を使っている人もそのまま動く。
    """
    try:
        import mlx_lm  # noqa: F401

        return "mlx"
    except ImportError:
        return "ollama"


def build_messages(
    target: str, before: list[str], after: list[str], names: list[str] | None = None
) -> list[dict[str, str]]:
    """前後の会話つきで1枚ぶんを頼む。"""
    lines = []
    if names:
        lines.append(f"この動画に出てくる名前・用語: {' / '.join(names)}")
    if before:
        lines.append("直前の会話:\n" + "\n".join(before))
    lines.append(f"見直す文:\n{target}")
    if after:
        lines.append("直後の会話:\n" + "\n".join(after))
    return [
        {"role": "system", "content": _SYSTEM},
        {"role": "user", "content": "\n\n".join(lines)},
    ]


def parse_reply(text: str) -> list[dict[str, str]]:
    """返事から JSON を取り出す。前後に説明が付いていても拾う。"""
    if not text:
        return []
    # ```json ... ``` を剥がす
    fenced = re.search(r"```(?:json)?\s*(.+?)```", text, re.S)
    if fenced:
        text = fenced.group(1)
    start = text.find("{")
    end = text.rfind("}")
    if start < 0 or end <= start:
        return []
    try:
        data = json.loads(text[start : end + 1])
    except ValueError:
        return []
    items = data.get("直し") or data.get("fixes") or []
    out = []
    for it in items if isinstance(items, list) else []:
        if not isinstance(it, dict):
            continue
        before = str(it.get("前") or it.get("before") or "").strip()
        after = str(it.get("後") or it.get("after") or "").strip()
        reason = str(it.get("理由") or it.get("reason") or "").strip()
        if before:
            out.append({"before": before, "after": after, "reason": reason})
    return out


def validate(candidates: list[dict[str, str]], text: str) -> list[dict[str, str]]:
    """検算。本文に無い語・長すぎる言い換え・同じものは捨てる。

    🔴 ここを緩めないこと。小さいモデルは、頼んでいない書き直しを平気で返す。
       「前」が本文に無い候補を通すと、画面に出しても押せない（置換できない）し、
       長い言い換えを通すと台詞そのものが別物になる。
    """
    seen: set[tuple[str, str]] = set()
    out: list[dict[str, str]] = []
    for c in candidates:
        before, after = c["before"], c["after"]
        if not before or before == after:
            continue
        if before not in text:
            continue
        if len(before) > MAX_SPAN or len(after) > MAX_SPAN * 2:
            continue
        # 本文そのものの置き換え（＝台詞の作り直し）は受けない
        if before == text.strip() and len(text.strip()) > MAX_SPAN:
            continue
        key = (before, after)
        if key in seen:
            continue
        seen.add(key)
        out.append(c)
        if len(out) >= MAX_PER_TELOP:
            break
    return out


# ── 動かす側 ───────────────────────────────────────────


class Proofreader:
    """ローカルの LLM に頼む。engine は "mlx"（Mac）か "ollama"（Windows）。"""

    def __init__(self, engine: str, model: str | None = None) -> None:
        if engine not in MODELS:
            raise ValueError(f"engine は mlx か ollama: {engine}")
        self.engine = engine
        self.model = model or MODELS[engine]
        self._loaded: Any = None

    # 診断用。何が足りないかを1行で
    def describe(self) -> str:
        if self.engine == "mlx":
            try:
                import mlx_lm  # noqa: F401

                return f"mlx-lm / {self.model}"
            except ImportError:
                return "mlx-lm が入っていない"
        return f"ollama / {self.model}（{self._ollama_url()}）"

    @staticmethod
    def _ollama_url() -> str:
        import os

        return os.environ.get("OLLAMA_HOST", "http://127.0.0.1:11434").rstrip("/")

    def _ask_mlx(self, messages: list[dict[str, str]]) -> str:
        from mlx_lm import generate, load

        if self._loaded is None:
            self._loaded = load(self.model)
        model, tokenizer = self._loaded
        prompt = tokenizer.apply_chat_template(messages, add_generation_prompt=True)
        kwargs: dict[str, Any] = {"max_tokens": 400}
        try:
            # 校正は迷わせない。温度は 0 に寄せる
            from mlx_lm.sample_utils import make_sampler

            kwargs["sampler"] = make_sampler(temp=0.0)
        except Exception:  # noqa: BLE001
            pass
        return generate(model, tokenizer, prompt=prompt, verbose=False, **kwargs)

    def _ask_ollama(self, messages: list[dict[str, str]]) -> str:
        import urllib.error
        import urllib.request

        body = json.dumps(
            {
                "model": self.model,
                "messages": messages,
                "stream": False,
                # 🔴 Ollama はスキーマを渡せる（公式）。渡すと JSON が壊れにくい
                "format": _SCHEMA,
                "options": {"temperature": 0},
            },
            ensure_ascii=False,
        ).encode("utf-8")
        req = urllib.request.Request(
            f"{self._ollama_url()}/api/chat",
            data=body,
            headers={"Content-Type": "application/json"},
        )
        try:
            with urllib.request.urlopen(req, timeout=180) as res:
                data = json.loads(res.read().decode("utf-8"))
        except urllib.error.URLError as e:
            raise RuntimeError(
                "Ollama に繋がりません（起動していますか）。"
                f"{self._ollama_url()} / {e}"
            ) from e
        return (data.get("message") or {}).get("content") or ""

    def ask(self, messages: list[dict[str, str]]) -> str:
        return self._ask_mlx(messages) if self.engine == "mlx" else self._ask_ollama(messages)

    # ── 本体 ──

    def review(
        self,
        telops: list[dict[str, Any]],
        *,
        names: list[str] | None = None,
        only_ids: list[str] | None = None,
        on_progress: ProgressFn | None = None,
        is_cancelled: CancelFn | None = None,
    ) -> dict[str, Any]:
        """直し候補を返す。本文は**書き換えない**。

        only_ids を渡すと、その id だけを見る（印が付いた所だけ見直す、など）。
        """
        texts = [(t.get("id"), (t.get("text") or "").strip()) for t in telops]
        texts = [(i, x) for i, x in texts if i and x]
        targets = [n for n, (i, _) in enumerate(texts) if not only_ids or i in only_ids]

        candidates: list[dict[str, Any]] = []
        checked = 0
        for pos, n in enumerate(targets):
            if is_cancelled and is_cancelled():
                return {"cancelled": True, "candidates": candidates, "checked": checked}
            tid, text = texts[n]
            before = [x for _, x in texts[max(0, n - WINDOW) : n]]
            after = [x for _, x in texts[n + 1 : n + 1 + WINDOW]]
            try:
                reply = self.ask(build_messages(text, before, after, names))
            except RuntimeError:
                raise
            except Exception as e:  # noqa: BLE001
                return {
                    "error": f"見直しに失敗しました: {e}",
                    "candidates": candidates,
                    "checked": checked,
                }
            for c in validate(parse_reply(reply), text):
                candidates.append({"id": tid, **c})
            checked += 1
            if on_progress and targets:
                on_progress((pos + 1) / len(targets), "文字起こしを見直しています")
        return {"cancelled": False, "candidates": candidates, "checked": checked}
