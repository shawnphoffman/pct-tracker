#!/usr/bin/env python3
"""Build the LOCAL-ONLY 'unknown' debug layer, split into logical tracks.

The pct-unknown bucket holds Garmin's junk aggregate track(s) (e.g. "Madison
Sites (0)": 432 points strung across 2018-2022 with 250-767 km teleports between
consecutive fixes). Drawn as one line it's a mess of cross-state jumps. This
reads the ORIGINAL export (which still has timestamps), breaks each such track
wherever consecutive points jump too far or too long apart, and emits one dated
feature per cluster - so it renders as many small logical tracks.

Local-only: output is public/unknown.geojson (gitignored, never deployed), so
including a date label here is fine.

    python3 scripts/garmin/unknown_layer.py
"""
import json, math, glob, os
import xml.etree.ElementTree as ET

NS = '{http://www.topografix.com/GPX/1/1}'
GAP_KM = 20.0       # break the line when consecutive points jump more than this
GAP_HOURS = 24.0    # ...or when more than this much time passes
TOL = 0.0001        # RDP simplify (~11 m)

REPO = __file__.rsplit('/scripts/', 1)[0]
EXPORT = f'{REPO}/garmin-export'
SRC = sorted(glob.glob(f'{EXPORT}/explore_*.gpx'))[-1]
enr = json.load(open(f'{EXPORT}/.enriched.json'))
unknown_idxs = [t['idx'] for t in enr if t['mileSpan'] > 300]   # same rule bucket.py uses

R = 6371; rad = math.radians
def hav(a, b):
    d1 = rad(b[1]-a[1]); d2 = rad(b[0]-a[0])
    x = math.sin(d1/2)**2 + math.cos(rad(a[1]))*math.cos(rad(b[1]))*math.sin(d2/2)**2
    return 2*R*math.asin(x**0.5)

def parse_t(s):
    from datetime import datetime
    try: return datetime.strptime(s[:19], '%Y-%m-%dT%H:%M:%S')
    except Exception: return None

def perp(p, a, b):
    dx, dy = b[0]-a[0], b[1]-a[1]
    if dx == 0 and dy == 0: return ((p[0]-a[0])**2 + (p[1]-a[1])**2) ** 0.5
    t = ((p[0]-a[0])*dx + (p[1]-a[1])*dy) / (dx*dx + dy*dy)
    return ((p[0]-(a[0]+t*dx))**2 + (p[1]-(a[1]+t*dy))**2) ** 0.5
def rdp(pts, tol):
    if len(pts) <= 2: return pts
    keep = [False]*len(pts); keep[0] = keep[-1] = True; st = [(0, len(pts)-1)]
    while st:
        s, e = st.pop(); md, mi = 0, -1
        for i in range(s+1, e):
            d = perp(pts[i], pts[s], pts[e])
            if d > md: md, mi = d, i
        if md > tol and mi != -1:
            keep[mi] = True; st += [(s, mi), (mi, e)]
    return [p for p, k in zip(pts, keep) if k]

trks = ET.parse(SRC).getroot().findall(NS+'trk')

# Exact-dupe filter: drop any point already present (same lon/lat/time) in a
# NON-unknown track, so this extra layer never duplicates the year/misc/crew
# buckets. The kept copy always lives in the other (never year) bucket.
def raw_pts(trk):
    for p in trk.iter(NS+'trkpt'):
        t = p.find(NS+'time')
        yield (p.get('lon'), p.get('lat'), t.text if t is not None else None)
other = set()
for i, trk in enumerate(trks):
    if i not in unknown_idxs:
        other.update(raw_pts(trk))

runs = []   # each: list of (lon,lat,time)
skipped_dupes = 0
for idx in unknown_idxs:
    pts = []
    for lon, lat, tm in raw_pts(trks[idx]):
        if (lon, lat, tm) in other:
            skipped_dupes += 1
            continue
        pts.append((float(lon), float(lat), tm))
    cur = []
    for i, pt in enumerate(pts):
        if cur:
            dkm = hav(cur[-1], pt)
            ta, tb = parse_t(cur[-1][2]), parse_t(pt[2])
            dh = abs((tb - ta).total_seconds())/3600 if ta and tb else 0
            if dkm > GAP_KM or dh > GAP_HOURS:
                runs.append(cur); cur = []
        cur.append(pt)
    if cur: runs.append(cur)

feats = []; index = {}; dropped = 0
n = 0
for run in runs:
    coords = [[round(x, 5), round(y, 5)] for x, y, _ in run]
    if len(coords) < 2:
        dropped += 1
        continue
    n += 1
    rid = f'unknown-{n:02d}'
    dates = sorted(t[:10] for _, _, t in run if t)
    label = dates[0] if dates and dates[0] == dates[-1] else (f'{dates[0]}..{dates[-1]}' if dates else '?')
    simp = rdp(coords, TOL)
    feats.append({'type': 'Feature', 'properties': {'role': 'unknown', 'id': rid, 'label': label},
                  'geometry': {'type': 'LineString', 'coordinates': simp}})
    index[rid] = {'label': label, 'points': len(run)}

json.dump({'type': 'FeatureCollection', 'features': feats}, open(f'{REPO}/public/unknown.geojson', 'w'), separators=(',', ':'))
sidecar = f'{EXPORT}/buckets/route-index.json'
allidx = json.load(open(sidecar)) if os.path.exists(sidecar) else {}
allidx['unknown'] = index
json.dump(allidx, open(sidecar, 'w'), indent=1)
print(f'{SRC}: split {len(unknown_idxs)} junk track(s) into {n} logical tracks '
      f'({skipped_dupes} exact dupes of other buckets removed, {dropped} single-point '
      f'clusters dropped) -> public/unknown.geojson')
