"""PAC のアプリアイコンを作る。

依存は Pillow と numpy だけ。macOS が無くても .icns まで作れるようにしてある
（.icns は PNG を並べただけの容器なので、構造さえ合っていれば手で組める）。

    python scripts/make_icon.py

出力:
    packaging/icon.png   1024x1024。electron-builder が Windows 側で使う
    packaging/icon.icns  macOS 用。electron-builder の変換に頼らず自前で組む

図案:
    上に長い帯を1本（撮ったままの素材）、下に切り分けられた3本（下ごしらえ後）。
    3本のうち1本だけ色を変えてある = テロップが乗った箇所。
    32px まで縮めても「長いものが短く分かれた」と読めることだけを狙っている。
"""

from __future__ import annotations

import struct
import zlib
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
OUT_DIR = ROOT / "packaging"

# --- 配色 -------------------------------------------------------------
# 冷たい地に暖かい帯を置く。Electron の既定アイコン（薄紫）とは別方向にする。
IN_TOP = (28, 48, 82)      # 地の上側 濃い藍
IN_BOTTOM = (18, 30, 52)   # 地の下側 さらに沈める
BAR_RAW = (238, 236, 228)  # 素材の帯 温かみのある白
BAR_DONE = (206, 214, 226) # 下ごしらえ後の帯 少し青を引く
BAR_TELOP = (255, 122, 89) # テロップが乗った帯 珊瑚色

CANVAS = 1024
# Big Sur 以降の作法。1024 の枠に対して本体は 824、角丸は 185。
BODY = 824
RADIUS = 185
SS = 4  # 4倍で描いてから縮める（Pillow に角丸のアンチエイリアスが無いため）


def _squircle_mask(size: int, radius: int) -> Image.Image:
    """角丸の切り抜き。4倍で描いて縮めることで縁を滑らかにする。"""
    big = Image.new("L", (size * SS, size * SS), 0)
    ImageDraw.Draw(big).rounded_rectangle(
        (0, 0, size * SS - 1, size * SS - 1), radius=radius * SS, fill=255
    )
    return big.resize((size, size), Image.LANCZOS)


def _vertical_gradient(size: int, top: tuple, bottom: tuple) -> Image.Image:
    t = np.linspace(0.0, 1.0, size, dtype=np.float32)[:, None]
    rows = np.array(top, dtype=np.float32) * (1 - t) + np.array(bottom, dtype=np.float32) * t
    return Image.fromarray(np.repeat(rows[:, None, :], size, axis=1).astype(np.uint8), "RGB")


def _bar(draw: ImageDraw.ImageDraw, x: float, y: float, w: float, h: float, color: tuple) -> None:
    draw.rounded_rectangle((x, y, x + w, y + h), radius=h / 2, fill=color)


def build(size: int = CANVAS) -> Image.Image:
    scale = size / CANVAS
    body = int(BODY * scale)
    radius = int(RADIUS * scale)

    art = _vertical_gradient(body, IN_TOP, IN_BOTTOM).convert("RGBA")
    art.putalpha(_squircle_mask(body, radius))

    # 帯は 4倍で描いてから縮める。細い角丸が潰れるのを防ぐ。
    layer = Image.new("RGBA", (body * SS, body * SS), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    u = body * SS / 100.0  # 本体の 1% を単位にする

    bar_h = 11 * u
    top_y = 27 * u
    bottom_y = 60 * u
    left = 14 * u
    full_w = 72 * u

    # 上: 撮ったままの1本
    _bar(d, left, top_y, full_w, bar_h, BAR_RAW)

    # 下: 切り分けられた3本。
    # 🔴 右端を上の帯より手前で終わらせること。ここが揃っていると「短くなった」と読めず、
    #    ただの箇条書きの絵になる（最初そうなった）。
    gap = 4.5 * u
    widths = [20 * u, 15 * u, 12 * u]  # 不揃いにする（機械的に等分したのではない、の意）
    colors = [BAR_DONE, BAR_TELOP, BAR_DONE]
    x = left
    for w, c in zip(widths, colors):
        _bar(d, x, bottom_y, w, bar_h, c)
        x += w + gap

    art.alpha_composite(layer.resize((body, body), Image.LANCZOS))

    canvas = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    canvas.alpha_composite(art, ((size - body) // 2, (size - body) // 2))
    return canvas


# --- .icns を自前で組む ------------------------------------------------
# 容器の形: 'icns' + 全体の長さ + [4文字の種別 + その塊の長さ + PNG] の並び。
# 長さはどれもヘッダ8バイトを含む。すべてビッグエンディアン。
ICNS_ENTRIES = [
    (b"ic07", 128),
    (b"ic08", 256),
    (b"ic09", 512),
    (b"ic10", 1024),  # 512@2x
    (b"ic11", 32),    # 16@2x
    (b"ic12", 64),    # 32@2x
    (b"ic13", 256),   # 128@2x
    (b"ic14", 512),   # 256@2x
]


def write_icns(master: Image.Image, path: Path) -> None:
    chunks = []
    for kind, px in ICNS_ENTRIES:
        buf = master.resize((px, px), Image.LANCZOS)
        raw = _png_bytes(buf)
        chunks.append(kind + struct.pack(">I", len(raw) + 8) + raw)
    body = b"".join(chunks)
    path.write_bytes(b"icns" + struct.pack(">I", len(body) + 8) + body)


def _png_bytes(img: Image.Image) -> bytes:
    from io import BytesIO

    out = BytesIO()
    img.save(out, format="PNG", optimize=True)
    return out.getvalue()


def main() -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    master = build(CANVAS)

    png = OUT_DIR / "icon.png"
    master.save(png, format="PNG", optimize=True)
    print(f"OK {png.relative_to(ROOT)} ({png.stat().st_size // 1024} KB)")

    icns = OUT_DIR / "icon.icns"
    write_icns(master, icns)
    print(f"OK {icns.relative_to(ROOT)} ({icns.stat().st_size // 1024} KB)")

    # 縮めたときに読めるかを目で見るための並べ画像。配布物には入れない。
    strip = Image.new("RGBA", (16 + 32 + 64 + 128 + 256 + 60, 256), (245, 245, 247, 255))
    x = 0
    for px in (256, 128, 64, 32, 16):
        strip.alpha_composite(master.resize((px, px), Image.LANCZOS), (x, 256 - px))
        x += px + 12
    preview = ROOT / "packaging" / "icon-preview.png"
    strip.convert("RGB").save(preview)
    print(f"OK {preview.relative_to(ROOT)}（縮めたときの見え方の確認用）")


if __name__ == "__main__":
    main()
