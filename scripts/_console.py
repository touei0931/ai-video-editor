"""コンソール出力を UTF-8 に固定する。

Windows の既定コードページは環境によって cp932 だったり cp1252 だったりする。
手元の PowerShell では通っても **CI の Windows ランナーでは cp1252 で
UnicodeEncodeError で落ちる**（実際に踏んだ）。

このプロジェクトのログ・エラーメッセージは日本語なので、
出力ストリームの encoding を明示するのは必須。
"""

from __future__ import annotations

import sys


def enable_utf8() -> None:
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8")
        except (AttributeError, ValueError):
            # リダイレクト先が TextIOWrapper でない場合など。握りつぶしてよい。
            pass
