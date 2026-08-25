"""PyInstaller で固めるときの入り口。

固めた実行ファイルは、コンテナアプリ（PAC.app）から呼ばれる:

    pac-engine --video 素材.mp4 --out state.json --ffmpeg <同梱の ffmpeg>
"""

import multiprocessing
import sys

from pac_fcp_engine.__main__ import main

if __name__ == "__main__":
    # 固めた実行ファイルが自分自身を再起動して無限に増えるのを防ぐ
    multiprocessing.freeze_support()
    sys.exit(main())
