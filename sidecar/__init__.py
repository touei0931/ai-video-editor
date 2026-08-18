"""Python サイドカー。

Electron 本体とは stdio の行区切り JSON-RPC で通信する。
大きなデータ（analysis.json / project.json / PNG）は stdio に流さず、
**ファイルパスを受け渡す**（設計レポート §4.4）。
"""

__version__ = "0.0.0"
