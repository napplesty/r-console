#!/usr/bin/env python3
"""Generate the r-console app icon (flat retro-futurism, 1024x1024 PNG).

A chunky pixel-art `>_` prompt in phosphor green on near-black. Run:

    python3 scripts/generate_icon.py
    npm run tauri icon src-tauri/icons/icon.png
"""

from PIL import Image, ImageDraw

SIZE = 1024
BG = (5, 10, 5, 255)            # near-black with a green tint
GREEN = (51, 255, 102, 255)     # phosphor green

# Pixel glyphs on a 7-row grid. `>` is a 2-wide chevron; `_` is a 2-thick
# bar, bottoms aligned.
CHEVRON = [
    "X....",
    "XX...",
    ".XX..",
    "..XX.",
    ".XX..",
    "XX...",
    "X....",
]
UNDERSCORE = [
    ".....",
    ".....",
    ".....",
    ".....",
    ".....",
    "XXXXX",
    "XXXXX",
]

BLOCK = 64
GAP_COLS = 1


def paint(draw, glyph, col_offset, x0, y0):
    for row, line in enumerate(glyph):
        for col, cell in enumerate(line):
            if cell == "X":
                x = x0 + (col_offset + col) * BLOCK
                y = y0 + row * BLOCK
                draw.rectangle((x, y, x + BLOCK, y + BLOCK), fill=GREEN)


def main():
    total_cols = len(CHEVRON[0]) + GAP_COLS + len(UNDERSCORE[0])
    x0 = (SIZE - total_cols * BLOCK) // 2
    y0 = (SIZE - 7 * BLOCK) // 2

    img = Image.new("RGBA", (SIZE, SIZE), BG)
    draw = ImageDraw.Draw(img)
    paint(draw, CHEVRON, 0, x0, y0)
    paint(draw, UNDERSCORE, len(CHEVRON[0]) + GAP_COLS, x0, y0)

    img.save("src-tauri/icons/icon.png")
    print("wrote src-tauri/icons/icon.png")


if __name__ == "__main__":
    main()
