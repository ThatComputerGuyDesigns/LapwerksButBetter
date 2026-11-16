#!/usr/bin/env python3
"""Build web-ready assets from CC0 sources (ambientCG materials, Poly Haven HDRIs).

usage: python3 tools/build_assets.py <ambientcg_dir> <hdri_dir>

ambientcg_dir contains one folder per material (e.g. Grass004/) with the
*_Color.jpg, *_NormalGL.jpg, *_Roughness.jpg and *_AmbientOcclusion.jpg maps.
hdri_dir contains <name>_1k.hdr and <name>_4k.hdr files.

Outputs to public/assets/: tex/<id>_c.jpg (colour), _n.jpg (normal),
_r.jpg (R = ambient occlusion, G = roughness), sky/<name>.jpg (tone-mapped
backdrop), sky/<name>.hdr (lighting) and sky/skies.json (sun directions).
"""
import json, os, sys, glob, shutil
import numpy as np
from PIL import Image

OUT = os.path.join(os.path.dirname(__file__), '..', 'public', 'assets')

MATERIALS = {
    # id: (source folder, size)
    'grass': ('Grass004', 1024),
    'grass2': ('Grass001', 1024),
    'meadow': ('Ground037', 1024),
    'rock': ('Rock026', 1024),
    'sand': ('Ground054', 1024),
    'dirt': ('Ground049B', 1024),
    'forest': ('Ground048', 1024),
    'asphalt': ('Asphalt031', 1024),
    'road': ('Road007', 2048),
    'gravel': ('Gravel023', 1024),
}

SKIES = {
    'midday': 'kloofendal_48d_partly_cloudy_puresky',
    'golden': 'kloppenheim_06_puresky',
    'dusk': 'belfast_sunset_puresky',
}
EXPOSURE = {'midday': 0.55, 'golden': 0.42, 'dusk': 0.36}


def find(folder, suffix):
    fs = glob.glob(os.path.join(folder, f'*_{suffix}.jpg'))
    return fs[0] if fs else None


def build_materials(src):
    os.makedirs(os.path.join(OUT, 'tex'), exist_ok=True)
    for mid, (name, size) in MATERIALS.items():
        folder = os.path.join(src, name)
        col = Image.open(find(folder, 'Color')).convert('RGB').resize((size, size), Image.LANCZOS)
        col.save(os.path.join(OUT, 'tex', f'{mid}_c.jpg'), quality=86, optimize=True)
        nrm = Image.open(find(folder, 'NormalGL')).convert('RGB').resize((size, size), Image.LANCZOS)
        nrm.save(os.path.join(OUT, 'tex', f'{mid}_n.jpg'), quality=90, optimize=True)
        rough = Image.open(find(folder, 'Roughness')).convert('L').resize((size, size), Image.LANCZOS)
        aof = find(folder, 'AmbientOcclusion')
        ao = Image.open(aof).convert('L').resize((size, size), Image.LANCZOS) if aof else Image.new('L', (size, size), 255)
        Image.merge('RGB', (ao, rough, Image.new('L', (size, size), 0))).save(os.path.join(OUT, 'tex', f'{mid}_r.jpg'), quality=88, optimize=True)
        print('material', mid, name, size)


def read_hdr(path):
    """Minimal Radiance RGBE reader (new-style RLE)."""
    with open(path, 'rb') as f:
        data = f.read()
    pos = 0
    while True:
        end = data.index(b'\n', pos)
        line = data[pos:end]
        pos = end + 1
        if line.strip() == b'':
            break
    end = data.index(b'\n', pos)
    dims = data[pos:end].split()
    pos = end + 1
    H, W = int(dims[1]), int(dims[3])
    img = np.zeros((H, W, 4), dtype=np.uint8)
    buf = np.frombuffer(data, dtype=np.uint8)
    for y in range(H):
        if buf[pos] != 2 or buf[pos + 1] != 2:
            raise ValueError('flat HDR not supported')
        pos += 4
        for c in range(4):
            x = 0
            row = img[y, :, c]
            while x < W:
                n = int(buf[pos]); pos += 1
                if n > 128:
                    n -= 128
                    row[x:x + n] = buf[pos]; pos += 1
                else:
                    row[x:x + n] = buf[pos:pos + n]; pos += n
                x += n
    e = img[..., 3].astype(np.float32)
    scale = np.where(e > 0, np.ldexp(1.0, (e - 136).astype(np.int32)), 0).astype(np.float32)
    return img[..., :3].astype(np.float32) * scale[..., None]


def aces(x):
    a, b, c, d, e = 2.51, 0.03, 2.43, 0.59, 0.14
    return np.clip((x * (a * x + b)) / (x * (c * x + d) + e), 0, 1)


def build_skies(src):
    os.makedirs(os.path.join(OUT, 'sky'), exist_ok=True)
    meta = {}
    for key, name in SKIES.items():
        lo = read_hdr(os.path.join(src, f'{name}_1k.hdr'))
        H, W, _ = lo.shape
        lum = lo @ np.array([0.2126, 0.7152, 0.0722], dtype=np.float32)
        y, x = np.unravel_index(np.argmax(lum), lum.shape)
        # equirect: u → azimuth, v → elevation (three.js convention: u=0.5 faces -Z)
        elev = (0.5 - (y + 0.5) / H) * 180
        azim = ((x + 0.5) / W) * 360
        # mean sky colour near the horizon (for fog) and overall level
        band = lo[int(H * 0.45):int(H * 0.5)].reshape(-1, 3).mean(0)
        meta[key] = {'file': name, 'sunElevation': round(float(elev), 2), 'sunAzimuthU': round(float((x + 0.5) / W), 4), 'horizon': [round(float(v), 4) for v in band], 'peak': round(float(lum.max()), 1)}
        # the 2k HDR is both the visible sky and the image-based lighting
        shutil.copy(os.path.join(src, f'{name}_2k.hdr'), os.path.join(OUT, 'sky', f'{key}.hdr'))
        # small tone-mapped preview (menus / loading)
        k = 0.6 / max(float(np.median(lum)), 1e-4)
        ldr = aces(lo * k * EXPOSURE[key]) ** (1 / 2.2)
        Image.fromarray((ldr * 255).astype(np.uint8)).resize((512, 256), Image.LANCZOS).save(os.path.join(OUT, 'sky', f'{key}.jpg'), quality=82)
        meta[key]['median'] = round(float(np.median(lum)), 4)
        print('sky', key, meta[key])
    with open(os.path.join(OUT, 'sky', 'skies.json'), 'w') as f:
        json.dump(meta, f, indent=1)


if __name__ == '__main__':
    build_materials(sys.argv[1])
    build_skies(sys.argv[2])
    with open(os.path.join(OUT, 'CREDITS.md'), 'w') as f:
        f.write('# Asset credits\n\nAll assets are CC0 (public domain).\n\n')
        f.write('Materials from ambientCG (https://ambientcg.com): ' + ', '.join(f'{v[0]}' for v in MATERIALS.values()) + '\n\n')
        f.write('HDRIs from Poly Haven (https://polyhaven.com): ' + ', '.join(SKIES.values()) + '\n')
