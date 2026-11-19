"""dds2png.py <in.dds> <out.png> <meta.json> [ao.dds] [mask.dds] [r,g,b]: decode DDS (BC1/BC3/BC4/BC7/RGBA) with optional AO & tint."""
import json
import os
import sys
from PIL import Image, ImageChops

src, dst, meta = sys.argv[1:4]
ao_src = sys.argv[4] if len(sys.argv) > 4 else ''
mask_src = sys.argv[5] if len(sys.argv) > 5 else ''
tint_arg = sys.argv[6] if len(sys.argv) > 6 else ''

im = Image.open(src).convert('RGBA')
r, g, b, a = im.split()

if ao_src and os.path.exists(ao_src):
    ao = Image.open(ao_src).convert('L')
    if ao.size != im.size:
        ao = ao.resize(im.size, Image.BILINEAR)
    ao = ao.point(lambda v: int(52 + (v * 203) // 255))
    r = ImageChops.multiply(r, ao)
    g = ImageChops.multiply(g, ao)
    b = ImageChops.multiply(b, ao)

if tint_arg:
    tr, tg, tb = [float(x) for x in tint_arg.split(',')]
    if mask_src and os.path.exists(mask_src):
        m = Image.open(mask_src).convert('L')
        if m.size != im.size:
            m = m.resize(im.size, Image.BILINEAR)
        r = ImageChops.multiply(r, m.point(lambda v: max(0, min(255, int(255 - v * (1.0 - tr))))))
        g = ImageChops.multiply(g, m.point(lambda v: max(0, min(255, int(255 - v * (1.0 - tg))))))
        b = ImageChops.multiply(b, m.point(lambda v: max(0, min(255, int(255 - v * (1.0 - tb))))))
    else:
        r = r.point(lambda v: max(0, min(255, int(v * tr))))
        g = g.point(lambda v: max(0, min(255, int(v * tg))))
        b = b.point(lambda v: max(0, min(255, int(v * tb))))

lo = a.getextrema()[0]
frac = sum(1 for v in a.getdata() if v < 250) / (im.width * im.height) if lo < 250 else 0
out = Image.merge('RGBA', (r, g, b, a)) if lo < 250 else Image.merge('RGB', (r, g, b))
out.save(dst)
json.dump({'w': im.width, 'h': im.height, 'alpha': frac}, open(meta, 'w'))
