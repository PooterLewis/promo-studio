"""Kyrn text kit: renders titles, captions and the call to action as transparent
PNGs in the Kyrn look, ready to overlay on video with ffmpeg.

  python3 kyrn_text.py <look> <role> "TEXT" out.png [width]

look is shell or prism; role is title, caption or cta. Needs Pillow; fonts live next to this file.

Follows the game's UI style sheet: every fill is one flat color, depth comes only from hard
edges, nothing glows. Letters are cut like the game's icons: a lit face and a shaded face,
lit from the top left, like cut crystal or carved shell. Titles carry a Vael script line."""
import os, sys
from PIL import Image, ImageChops, ImageDraw, ImageFont

HERE = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'fonts')

LOOKS = {
    # The game's own UI colors (Kryn UI style sheet, flat pass).
    'shell': dict(lit='#efe7d6', shade='#c2b496', seam=None, gap='#0a1418', script='#5fb5a7',
                  plate='#d4a24c', plate_rim='#0a1418', plate_text='#0f1c22'),
    # Prism glass with aurora seams where each letter is cut (Prism bundle palette).
    'prism': dict(lit='#f2f6fb', shade='#b0c0d6', seam=['#5fe0cc', '#a78bff', '#7cf0a0'], gap='#15172e',
                  script='#5fe0cc', plate='#d6e2f0', plate_rim='#15172e', plate_text='#454a72'),
}

ROLES = {
    'title':   dict(font='KronaOne-Regular.ttf', size=200, track=30, stroke=5, depth=12, script=True, seams=True),
    'caption': dict(font='KronaOne-Regular.ttf', size=70, track=3, stroke=5, depth=6, script=False, seams=False),
    'cta':     dict(font='KronaOne-Regular.ttf', size=40, track=5),
}

# Vael script glyphs from the game's style sheet (10x14 boxes, stroked).
GLYPHS = [
    [[(3, 1), (3, 13)], [(3, 4), (8, 4)]],
    [[(2, 2), (5, 6), (8, 2)], [(5, 6), (5, 13)]],
    [[(5, 1), (5, 13)], 'dot', (8, 9)],
    [[(2, 1), (2, 8), (5, 11), (8, 8), (8, 1)]],
    [[(5, 1), (8, 4), (5, 7), (2, 4), (5, 1)], [(5, 7), (5, 13)]],
    [[(2, 3), (8, 3)], [(5, 3), (5, 13)], [(2, 10), (5, 10)]],
    [[(3, 1), (3, 13)], [(7, 4), (7, 10)]],
    [[(2, 12), (5, 2), (8, 12)], 'dot', (5, 9)],
]

def rgb(c):
    c = c.lstrip('#')
    return tuple(int(c[i:i + 2], 16) for i in (0, 2, 4))

def solid(color, mask):
    return Image.merge('RGBA', (*[Image.new('L', mask.size, v) for v in rgb(color)], mask))

def script_line(width, height, color, seed=7):
    """A row of Vael glyphs, spaced like the style sheet's script line."""
    s = height / 14
    img = Image.new('L', (width, height))
    d = ImageDraw.Draw(img)
    x, i = 0, 0
    while x + 10 * s <= width:
        seed = (seed * 16807) % 2147483647
        g = GLYPHS[seed % 8]
        for j, part in enumerate(g):
            if part == 'dot':
                cx, cy = g[j + 1]
                r = 1.3 * s
                d.ellipse((x + cx * s - r, cy * s - r, x + cx * s + r, cy * s + r), fill=255)
            elif isinstance(part, list):
                d.line([(x + px * s, py * s) for px, py in part], fill=255, width=max(1, round(1.5 * s)), joint='curve')
        x += 14 * s + (6 * s if i % 3 == 2 else 0)
        i += 1
    bbox = img.getbbox()
    out = img.crop((0, 0, bbox[2] if bbox else width, height))
    return solid(color, out)

def faceted(text, f, track, look, pad, seams=True):
    """Draws each letter split into a lit face (top left) and a shaded face, hard edge between."""
    L = LOOKS[look]
    asc, desc = f.getmetrics()
    lines = text.split('\n')
    lh = int((asc + desc) * 1.1)
    widths = [sum(f.getlength(ch) + track for ch in ln) - track for ln in lines]
    W, H = int(max(widths)) + 2 * pad, lh * len(lines) + 2 * pad
    glyph = Image.new('L', (W, H))
    face = Image.new('RGBA', (W, H))
    n = 0
    for li, ln in enumerate(lines):
        x, y = (W - widths[li]) / 2, pad + li * lh
        for ch in ln:
            m = Image.new('L', (W, H))
            ImageDraw.Draw(m).text((x, y), ch, font=f, fill=255)
            bb = m.getbbox()
            if bb:
                x0, y0, x1, y1 = bb
                # The cut runs corner to corner, tipped a little differently on each letter.
                t = [0.42, 0.56, 0.48, 0.62, 0.38][n % 5]
                cut = Image.new('L', (W, H))
                ImageDraw.Draw(cut).polygon([(x0 - 2, y0 - 2), (x1 + 2, y0 - 2), (x0 + (x1 - x0) * t, (y0 + y1) / 2 + (y1 - y0) * 0.08), (x0 - 2, y1 + 2)], fill=255)
                lit = ImageChops.multiply(m, cut)
                face.alpha_composite(solid(L['shade'], m))
                face.alpha_composite(solid(L['lit'], lit))
                if seams and L['seam']:  # a thin aurora seam along the cut
                    seam = ImageChops.subtract(ImageChops.multiply(m, cut.transform(cut.size, Image.AFFINE, (1, 0, -max(3, f.size // 11), 0, 1, -max(3, f.size // 11)))), lit)
                    face.alpha_composite(solid(L['seam'][n % len(L['seam'])], seam))
                glyph = ImageChops.lighter(glyph, m)
                n += 1
            x += f.getlength(ch) + track
    return glyph, face

def grow(mask, r):
    from PIL import ImageFilter
    return mask.filter(ImageFilter.MaxFilter(r * 2 + 1)) if r else mask

def render(look, role, text, max_w=980):
    L, R = LOOKS[look], ROLES[role]
    text = text.upper()
    if role == 'cta':
        return plate(look, text, max_w)
    size = R['size']
    while True:  # shrink to fit the frame width
        f = ImageFont.truetype(os.path.join(HERE, R['font']), size)
        pad = R['stroke'] + R['depth'] + 4
        glyph, face = faceted(text, f, R['track'], look, pad, R['seams'])
        if glyph.getbbox()[2] - glyph.getbbox()[0] <= max_w or size < 30: break
        size = int(size * 0.92)
    W, H = glyph.size
    out = Image.new('RGBA', (W, H))
    rim = grow(glyph, R['stroke'])
    # Hard extrusion down and right: flat dark steps, no blur.
    for i in range(R['depth'], 0, -1):
        out.alpha_composite(solid(L['gap'], rim.transform(rim.size, Image.AFFINE, (1, 0, -i * 0.5, 0, 1, -i))))
    out.alpha_composite(solid(L['gap'], rim))
    out.alpha_composite(face)
    out = out.crop(out.getbbox())
    if R['script']:
        line = script_line(int(out.width * 0.8), max(16, size // 6), L['script'])
        full = Image.new('RGBA', (out.width, out.height + line.height * 2))
        full.alpha_composite(out)
        full.alpha_composite(line, ((out.width - line.width) // 2, out.height + line.height // 2))
        out = full
    return out

def plate(look, text, max_w):
    """The call to action on a crystal-cut plate, like the game's main button."""
    L, R = LOOKS[look], ROLES['cta']
    f = ImageFont.truetype(os.path.join(HERE, R['font']), R['size'])
    tw = sum(f.getlength(ch) + R['track'] for ch in text) - R['track']
    while tw > max_w - 140:
        f = ImageFont.truetype(os.path.join(HERE, R['font']), f.size - 2)
        tw = sum(f.getlength(ch) + R['track'] for ch in text) - R['track']
    asc, desc = f.getmetrics()
    h = int(asc * 1.0 + 44)
    w = int(tw + 120)
    c = h // 2
    img = Image.new('RGBA', (w + 8, h + 8))
    d = ImageDraw.Draw(img)
    hexa = lambda o, x, y, w, h, c: [(x + c, y), (x + w - c, y), (x + w, y + h / 2), (x + w - c, y + h), (x + c, y + h), (x, y + h / 2)]
    d.polygon(hexa(0, 0, 0, w + 8, h + 8, c + 2), fill=rgb(L['plate_rim']))
    d.polygon(hexa(0, 4, 4, w, h, c), fill=rgb(L['plate']))
    x, y = (w + 8 - tw) / 2, (h + 8 - asc) / 2 + 2
    for ch in text:
        d.text((x, y), ch, font=f, fill=rgb(L['plate_text']))
        x += f.getlength(ch) + R['track']
    return img

if __name__ == '__main__':
    look, role, text, dest = sys.argv[1:5]
    render(look, role, text.replace('\\n', '\n'), int(sys.argv[5]) if len(sys.argv) > 5 else 980).save(dest)
