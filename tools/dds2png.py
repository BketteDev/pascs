"""dds2png.py <in.dds> <out.png> <meta.json>: decode a DDS (BC1/BC3/BC7/RGBA) with Pillow; write PNG (RGB when fully opaque) and {w,h,alpha}."""
import json
import sys
from PIL import Image

src, dst, meta = sys.argv[1:4]
im = Image.open(src).convert('RGBA')
a = im.getchannel('A')
lo = a.getextrema()[0]
frac = sum(1 for v in a.getdata() if v < 250) / (im.width * im.height) if lo < 250 else 0
(im if lo < 250 else im.convert('RGB')).save(dst)
json.dump({'w': im.width, 'h': im.height, 'alpha': frac}, open(meta, 'w'))
