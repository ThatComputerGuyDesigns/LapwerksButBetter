#!/usr/bin/env python3
"""Download CC0 Poly Haven models (glTF + textures) into a folder.

usage: python3 tools/fetch_polyhaven.py <out_dir> <res> <asset_id> [asset_id ...]
"""
import json, os, sys, urllib.request


def get(url, tries=4):
    import time
    for k in range(tries):
        try:
            req = urllib.request.Request(url, headers={'User-Agent': 'asset-fetch/1.0'})
            with urllib.request.urlopen(req, timeout=120) as r:
                return r.read()
        except Exception:
            if k == tries - 1:
                raise
            time.sleep(2 * (k + 1))


def fetch(out, res, aid):
    files = json.loads(get(f'https://api.polyhaven.com/files/{aid}'))
    g = files['gltf'][res]['gltf']
    base = os.path.join(out, aid)
    os.makedirs(base, exist_ok=True)
    with open(os.path.join(base, f'{aid}.gltf'), 'wb') as f:
        f.write(get(g['url']))
    for rel, info in g['include'].items():
        p = os.path.join(base, rel)
        os.makedirs(os.path.dirname(p), exist_ok=True)
        with open(p, 'wb') as f:
            f.write(get(info['url']))
    print('ok', aid, sum(i['size'] for i in g['include'].values()) // 1024, 'KB')


if __name__ == '__main__':
    out, res, *ids = sys.argv[1:]
    for aid in ids:
        fetch(out, res, aid)
