"""Kyrn text kit: renders titles, captions and the call to action as transparent
PNGs in the Kyrn look, ready to overlay on video with ffmpeg.

  python3 kyrn_text.py <style> <role> "TEXT" out.png [width]

role is title, caption or cta. Needs Pillow; fonts live next to this file."""
import os, sys
from PIL import Image, ImageDraw, ImageFilter, ImageFont

HERE = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'fonts')

# Pulled from the game: night sky, glowing cyan paths, magenta mushrooms, orange borders.
PALETTE = {
    'night': '#0a0d26',   # outlines and shadows
    'indigo': '#2a2370',
    'glow': '#3ff3ff',    # cyan path glow
    'spore': '#ff3fb8',   # magenta mushrooms
    'ember': '#ff8a1f',   # orange borders and UI numbers
    'gold': '#ffd45a',
    'white': '#f4fbff',
}

STYLES = {
    # Fantasy serif with a cyan glow, like the glowing paths at night.
    'glowcap': {
        'title':   dict(font='CinzelDecorative-Black.ttf', size=260, fill=('white', 'glow'), stroke=8, glow='glow', glow_r=26, track=4),
        'caption': dict(font='Cinzel[wght].ttf', var='Black', size=84, fill=('white', 'white'), stroke=7, glow='glow', glow_r=18, track=3),
        'cta':     dict(font='Cinzel[wght].ttf', var='Bold', size=46, fill=('gold', 'ember'), stroke=5, glow='spore', glow_r=14, track=6),
    },
    # Chunky game lettering in ember orange with a magenta glow.
    'ember': {
        'title':   dict(font='LilitaOne-Regular.ttf', size=280, fill=('gold', 'ember'), stroke=12, glow='spore', glow_r=24, track=2),
        'caption': dict(font='LilitaOne-Regular.ttf', size=96, fill=('white', 'white'), stroke=10, glow='ember', glow_r=16, track=1),
        'cta':     dict(font='LilitaOne-Regular.ttf', size=54, fill=('white', 'glow'), stroke=7, glow='glow', glow_r=14, track=3),
    },
    # Arcane runic lettering in magenta with a cyan aura.
    'arcane': {
        'title':   dict(font='Metamorphous-Regular.ttf', size=260, fill=('white', 'spore'), stroke=8, glow='glow', glow_r=24, track=6),
        'caption': dict(font='Metamorphous-Regular.ttf', size=80, fill=('white', 'white'), stroke=7, glow='spore', glow_r=16, track=3),
        'cta':     dict(font='Metamorphous-Regular.ttf', size=46, fill=('glow', 'glow'), stroke=5, glow='glow', glow_r=12, track=6),
    },
}

def rgb(c):
    c = PALETTE.get(c, c).lstrip('#')
    return tuple(int(c[i:i + 2], 16) for i in (0, 2, 4))

def font(spec, size=None):
    f = ImageFont.truetype(os.path.join(HERE, spec['font']), size or spec['size'])
    if spec.get('var'): f.set_variation_by_name(spec['var'])
    return f

def text_mask(lines, f, track, stroke, pad):
    """Draw centred lines (letter by letter for tracking); returns fill and stroke masks."""
    asc, desc = f.getmetrics()
    lh = int((asc + desc) * 1.05)
    widths = [sum(f.getlength(ch) + track for ch in ln) - track for ln in lines]
    W, H = int(max(widths)) + 2 * pad, lh * len(lines) + 2 * pad
    fill, edge = Image.new('L', (W, H)), Image.new('L', (W, H))
    df, de = ImageDraw.Draw(fill), ImageDraw.Draw(edge)
    for i, ln in enumerate(lines):
        x, y = (W - widths[i]) / 2, pad + i * lh
        for ch in ln:
            df.text((x, y), ch, font=f, fill=255)
            de.text((x, y), ch, font=f, fill=255, stroke_width=stroke, stroke_fill=255)
            x += f.getlength(ch) + track
    return fill, edge

def render(style, role, text, max_w=980):
    s = STYLES[style][role]
    lines, size = text.upper().split('\n'), s['size']
    while True:  # shrink to fit the frame width
        f = font(s, size)
        pad = s['glow_r'] * 3 + s['stroke']
        fill, edge = text_mask(lines, f, s['track'], s['stroke'], pad)
        if fill.width - 2 * pad <= max_w or size < 30: break
        size = int(size * 0.92)
    W, H = fill.size
    out = Image.new('RGBA', (W, H))
    # Glow: two blurred passes, wide and soft then tight and bright.
    for r, a in ((s['glow_r'], 0.9), (s['glow_r'] / 3, 0.8)):
        g = edge.filter(ImageFilter.GaussianBlur(r)).point(lambda v: int(min(255, v * a * 1.6)))
        out.alpha_composite(Image.merge('RGBA', (*[Image.new('L', (W, H), c) for c in rgb(s['glow'])], g)))
    out.alpha_composite(Image.merge('RGBA', (*[Image.new('L', (W, H), c) for c in rgb('night')], edge)))
    # Vertical gradient fill.
    top, bot = rgb(s['fill'][0]), rgb(s['fill'][1])
    grad = Image.new('RGB', (1, H))
    for y in range(H):
        t = min(1, max(0, (y - pad) / max(1, H - 2 * pad)))
        grad.putpixel((0, y), tuple(int(top[i] + (bot[i] - top[i]) * t) for i in range(3)))
    out.alpha_composite(Image.merge('RGBA', (*grad.resize((W, H)).split(), fill)))
    return out.crop(out.getbbox())

if __name__ == '__main__':
    style, role, text, dest = sys.argv[1:5]
    render(style, role, text.replace('\\n', '\n'), int(sys.argv[5]) if len(sys.argv) > 5 else 980).save(dest)
