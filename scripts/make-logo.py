"""
Draws the PulseGrid Studio logo and writes build/icon.png, build/icon.ico,
build/icon.icns (the Mac's format) and public/icon.png. Run it with:  python scripts/make-logo.py

The mark is a dark tile with a faint step-grid behind a "pulse": seven bars whose
heights rise to a peak in the middle, shaded from violet to cyan.
"""

from pathlib import Path

from PIL import Image, ImageChops, ImageDraw, ImageFilter

ROOT = Path(__file__).resolve().parent.parent
SIZE = 2048  # drawn large, then scaled down for crisp edges
S = SIZE / 1024

VIOLET = (155, 107, 255)
CYAN = (79, 214, 224)
TILE_TOP = (36, 28, 82)
TILE_BOTTOM = (10, 9, 28)


def mix(a, b, t):
    return tuple(round(a[i] + (b[i] - a[i]) * t) for i in range(3))


def gradient(size, start, end, vertical=False, diagonal=False):
    """A linear gradient image, built from a one-line ramp (fast, no numpy)."""
    ramp = Image.new("RGB", (size, 1))
    for x in range(size):
        ramp.putpixel((x, 0), mix(start, end, x / (size - 1)))
    image = ramp.resize((size, size))
    if vertical:
        image = image.rotate(-90, expand=True)
    if diagonal:
        image = ramp.resize((size * 2, size * 2)).rotate(-45, expand=True)
        left = (image.width - size) // 2
        top = (image.height - size) // 2
        image = image.crop((left, top, left + size, top + size))
    return image


def rounded_mask(box, radius):
    mask = Image.new("L", (SIZE, SIZE), 0)
    ImageDraw.Draw(mask).rounded_rectangle(box, radius=radius, fill=255)
    return mask


def build() -> Image.Image:
    canvas = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))

    # The tile: a dark, slightly violet squircle.
    margin = round(40 * S)
    box = (margin, margin, SIZE - margin, SIZE - margin)
    tile_mask = rounded_mask(box, round(230 * S))
    tile = gradient(SIZE, TILE_TOP, TILE_BOTTOM, diagonal=True).convert("RGBA")
    canvas.paste(tile, (0, 0), tile_mask)

    # A thin lighter edge so the tile reads on dark backgrounds.
    edge = ImageChops.subtract(tile_mask, tile_mask.filter(ImageFilter.MinFilter(round(7 * S) | 1)))
    rim = Image.new("RGBA", (SIZE, SIZE), (180, 150, 255, 70))
    canvas.paste(rim, (0, 0), edge)

    # The grid: faint lines, like the steps of a sequencer.
    grid = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    gd = ImageDraw.Draw(grid)
    inner = round(150 * S)
    step = (SIZE - 2 * inner) / 4
    line = max(2, round(5 * S))
    for i in range(5):
        p = round(inner + i * step)
        gd.line([(inner, p), (SIZE - inner, p)], fill=(190, 170, 255, 34), width=line)
        gd.line([(p, inner), (p, SIZE - inner)], fill=(190, 170, 255, 34), width=line)
    canvas.alpha_composite(Image.composite(grid, Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0)), tile_mask))

    # The pulse: seven bars rising to a peak in the middle.
    heights = [250, 380, 560, 760, 560, 380, 250]
    bar_w = round(84 * S)
    gap = round(38 * S)
    total = len(heights) * bar_w + (len(heights) - 1) * gap
    x0 = (SIZE - total) // 2
    middle = SIZE // 2

    colour_map = gradient(SIZE, VIOLET, CYAN)  # left to right
    bars = Image.new("L", (SIZE, SIZE), 0)
    bd = ImageDraw.Draw(bars)
    for i, h in enumerate(heights):
        height = round(h * S)
        x = x0 + i * (bar_w + gap)
        bd.rounded_rectangle((x, middle - height // 2, x + bar_w, middle + height // 2), radius=bar_w // 2, fill=255)

    # A soft glow under the bars.
    glow = bars.filter(ImageFilter.GaussianBlur(round(46 * S)))
    glow_layer = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    glow_layer.paste(colour_map.convert("RGBA"), (0, 0), glow.point(lambda v: round(v * 0.55)))
    canvas.alpha_composite(Image.composite(glow_layer, Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0)), tile_mask))

    bar_layer = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    bar_layer.paste(colour_map.convert("RGBA"), (0, 0), bars)
    canvas.alpha_composite(bar_layer)

    return canvas


def main() -> None:
    image = build()

    big = image.resize((512, 512), Image.LANCZOS)
    (ROOT / "build").mkdir(exist_ok=True)
    big.save(ROOT / "build" / "icon.png")
    big.save(ROOT / "public" / "icon.png")

    # Each size is scaled down from the big drawing, not from each other.
    sizes = [16, 24, 32, 48, 64, 128, 256]
    frames = [image.resize((s, s), Image.LANCZOS) for s in sizes]
    frames[-1].save(ROOT / "build" / "icon.ico", format="ICO", sizes=[(s, s) for s in sizes], append_images=frames[:-1])

    # The Mac's icon format, and the icons of the .pulsegrid project files (named after their extension).
    mac = image.resize((1024, 1024), Image.LANCZOS)
    mac.save(
        ROOT / "build" / "icon.icns",
        format="ICNS",
        sizes=[(16, 16), (32, 32), (64, 64), (128, 128), (256, 256), (512, 512), (1024, 1024)],
    )
    for name in ("pulsegrid.icns", "pulsegrid.ico"):
        source = ROOT / "build" / ("icon.icns" if name.endswith("icns") else "icon.ico")
        (ROOT / "build" / name).write_bytes(source.read_bytes())

    print("wrote build/icon.png, icon.ico, icon.icns, pulsegrid.ico, pulsegrid.icns and public/icon.png")


if __name__ == "__main__":
    main()
