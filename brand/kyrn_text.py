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
    'core': '#eafff9',    # letter fill: pale, slightly green-white
    'aqua': '#2af5e0',    # alien glow, a touch greener than the game's cyan paths
    'glow': '#3ff3ff',    # cyan path glow
    'spore': '#ff3fb8',   # magenta mushrooms
    'ember': '#ff8a1f',   # orange borders and UI numbers
    'gold': '#ffd45a',
}

# House rule: flat fills only, no gradients. "ring" is a thin colored line around the outline.
STYLES = {
    # Wide, tracked lettering like an alien transmission.
    'signal': {
        'title':   dict(font='Michroma-Regular.ttf', size=200, fill='core', stroke=6, ring=(4, 'aqua'), glow='aqua', glow_r=22, track=40),
        'caption': dict(font='KronaOne-Regular.ttf', size=74, fill='core', stroke=7, glow='aqua', glow_r=14, track=4),
        'cta':     dict(font='Michroma-Regular.ttf', size=40, fill='spore', stroke=5, glow='spore', glow_r=10, track=12),
    },
    # Rounded, bulbous shapes that feel grown rather than built.
    'hive': {
        'title':   dict(font='ZenDots-Regular.ttf', size=230, fill='core', stroke=8, ring=(5, 'aqua'), glow='aqua', glow_r=24, track=10),
        'caption': dict(font='ZenDots-Regular.ttf', size=78, fill='core', stroke=7, glow='aqua', glow_r=14, track=2),
        'cta':     dict(font='ZenDots-Regular.ttf', size=42, fill='spore', stroke=5, glow='spore', glow_r=10, track=6),
    },
    # Strange glyph shapes for the logo, sharp alien lettering for captions.
    'glyph': {
        'title':   dict(font='MajorMonoDisplay-Regular.ttf', size=230, fill='core', stroke=8, ring=(5, 'aqua'), glow='aqua', glow_r=24, track=16),
        'caption': dict(font='TurretRoad-ExtraBold.ttf', size=96, fill='core', stroke=7, glow='aqua', glow_r=14, track=6),
        'cta':     dict(font='TurretRoad-ExtraBold.ttf', size=52, fill='spore', stroke=5, glow='spore', glow_r=10, track=10),
    },
    # Kept for a Halloween event.
    'halloween': {
        'title':   dict(font='LilitaOne-Regular.ttf', size=280, fill='ember', stroke=12, glow='spore', glow_r=24, track=2),
        'caption': dict(font='LilitaOne-Regular.ttf', size=96, fill='core', stroke=10, glow='ember', glow_r=16, track=1),
        'cta':     dict(font='LilitaOne-Regular.ttf', size=54, fill='gold', stroke=7, glow='spore', glow_r=14, track=3),
    },
    # First draft (Oct 20): fantasy serif. Jack liked its colors, not its feel.
    'glowcap': {
        'title':   dict(font='CinzelDecorative-Black.ttf', size=260, fill='core', stroke=8, glow='glow', glow_r=26, track=4),
        'caption': dict(font='Cinzel[wght].ttf', var='Black', size=84, fill='core', stroke=7, glow='glow', glow_r=18, track=3),
        'cta':     dict(font='Cinzel[wght].ttf', var='Bold', size=46, fill='gold', stroke=5, glow='spore', glow_r=14, track=6),
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
    solid = lambda c, m: Image.merge('RGBA', (*[Image.new('L', (W, H), v) for v in rgb(c)], m))
    ring_w, ring_c = s.get('ring', (0, None))
    outer = edge
    if ring_w:  # outline grown by a gap, then a thin ring of color around it
        _, outer = text_mask(lines, f, s['track'], s['stroke'] + ring_w * 2, pad)
    out = Image.new('RGBA', (W, H))
    # Glow: two blurred passes, wide and soft then tight and bright.
    for r, a in ((s['glow_r'], 0.9), (s['glow_r'] / 3, 0.8)):
        out.alpha_composite(solid(s['glow'], outer.filter(ImageFilter.GaussianBlur(r)).point(lambda v: int(min(255, v * a * 1.6)))))
    if ring_w:
        out.alpha_composite(solid(ring_c, outer))
        _, gap = text_mask(lines, f, s['track'], s['stroke'] + ring_w, pad)
        out.alpha_composite(solid('night', gap))
    out.alpha_composite(solid('night', edge))
    out.alpha_composite(solid(s['fill'], fill))
    return out.crop(out.getbbox())

if __name__ == '__main__':
    style, role, text, dest = sys.argv[1:5]
    render(style, role, text.replace('\\n', '\n'), int(sys.argv[5]) if len(sys.argv) > 5 else 980).save(dest)
