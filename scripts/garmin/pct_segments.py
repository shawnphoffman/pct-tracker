#!/usr/bin/env python3
"""Turn a bucket GPX into per-track map features with a stable route id.

Two modes:
  snap (default) - snap each track to the PCT mile markers and draw the covered
                   mile range(s) as slices of the PCT centerline. Drops the raw
                   GPS back-and-forth/spurs; "follows the PCT marks".
  raw            - draw each track's actual (simplified) GPS. Used for the junk
                   'unknown' bucket so its shape is visible for debugging.

Each output feature carries {role, id, fromMile, toMile} - NO dates/timestamps,
so snap/raw geojson served on the site stays privacy-clean. A LOCAL, gitignored
sidecar garmin-export/buckets/route-index.json maps every id -> {date, miles}
for reference when moving tracks between buckets (see OVERRIDES in bucket.py).

    python3 scripts/garmin/pct_segments.py <bucket.gpx> <out.geojson> <role> [snap|raw]
"""
import sys, json, math, os
import xml.etree.ElementTree as ET

NS = '{http://www.topografix.com/GPX/1/1}'
SNAP_KM = 0.5
FILL_GAP = 2.0
TOL = 0.0001  # raw-mode RDP tolerance (~11 m)

REPO = __file__.rsplit('/scripts/', 1)[0]
# Hand-added segments with no Garmin track (see scripts/garmin/manual-segments.json).
MANUAL_PATH = f'{REPO}/scripts/garmin/manual-segments.json'
MANUAL = json.load(open(MANUAL_PATH)) if os.path.exists(MANUAL_PATH) else {}
ENRICHED = json.load(open(f'{REPO}/garmin-export/.enriched.json'))
# lookup a track's date/miles by its geometry fingerprint (npts, rounded bbox)
by_fp = {(t['npts'], tuple(t['bbox'])): t for t in ENRICHED}

markers = json.load(open(f'{REPO}/garmin-export/.markers.json'))
by_mile = {}
for m in markers:
    by_mile.setdefault(round(m['mile'] * 2) / 2, (m['lon'], m['lat']))
spine = sorted(by_mile.items())
idx = {}
for mile, (lon, lat) in by_mile.items():
    idx.setdefault(round(lat * 10), []).append((lon, lat, mile))

R = 6371; rad = math.radians
def hav(lo1, la1, lo2, la2):
    d1 = rad(la2 - la1); d2 = rad(lo2 - lo1)
    a = math.sin(d1/2)**2 + math.cos(rad(la1))*math.cos(rad(la2))*math.sin(d2/2)**2
    return 2 * R * math.asin(math.sqrt(a))

def snap(lon, lat):
    base = round(lat * 10); best = None; bd = 1e9
    for k in (base-1, base, base+1):
        for mlon, mlat, mile in idx.get(k, []):
            d = hav(lon, lat, mlon, mlat)
            if d < bd: bd = d; best = mile
    return best if best is not None and bd <= SNAP_KM else None

def intervals(miles):
    s = sorted(miles); out = []
    for m in s:
        if out and m - out[-1][1] <= FILL_GAP: out[-1][1] = m
        else: out.append([m, m])
    return [iv for iv in out if iv[1] > iv[0]]

# PCT centerline pieces (from centerline.mjs): real trail geometry so segments
# hug the trail instead of chording between 0.5-mi markers. Each piece is a
# per-tile LineString in vertex order; tag each vertex with its nearest mile.
def nearest_mile(lon, lat):
    base = round(lat * 10); best = None; bd = 1e9
    for k in (base-1, base, base+1):
        for mlon, mlat, mile in idx.get(k, []):
            d = hav(lon, lat, mlon, mlat)
            if d < bd: bd = d; best = mile
    return best   # centerline is on-trail, so no distance cap
CL_PATH = f'{REPO}/garmin-export/.centerline.json'
_pieces_mile = []
if os.path.exists(CL_PATH):
    for piece in json.load(open(CL_PATH)):
        _pieces_mile.append([(lon, lat, nearest_mile(lon, lat)) for lon, lat in piece])

def centerline_runs(a, b):
    """Maximal runs of consecutive centerline vertices with mile in [a, b]."""
    runs = []
    for piece in _pieces_mile:
        cur = []
        for lon, lat, mile in piece:
            if mile is not None and a <= mile <= b:
                cur.append([lon, lat])
            else:
                if len(cur) >= 2: runs.append(cur)
                cur = []
        if len(cur) >= 2: runs.append(cur)
    return runs

def perp(p, a, b):
    dx, dy = b[0]-a[0], b[1]-a[1]
    if dx == 0 and dy == 0: return ((p[0]-a[0])**2 + (p[1]-a[1])**2) ** 0.5
    t = ((p[0]-a[0])*dx + (p[1]-a[1])*dy) / (dx*dx + dy*dy)
    return ((p[0]-(a[0]+t*dx))**2 + (p[1]-(a[1]+t*dy))**2) ** 0.5

def rdp(pts, tol):
    if len(pts) <= 2: return pts
    keep = [False]*len(pts); keep[0] = keep[-1] = True; stack = [(0, len(pts)-1)]
    while stack:
        s, e = stack.pop(); md, mi = 0, -1
        for i in range(s+1, e):
            dd = perp(pts[i], pts[s], pts[e])
            if dd > md: md, mi = dd, i
        if md > tol and mi != -1:
            keep[mi] = True; stack += [(s, mi), (mi, e)]
    return [p for p, k in zip(pts, keep) if k]

def track_points(trk):
    pts = [[round(float(p.get('lon')), 5), round(float(p.get('lat')), 5)]
           for p in trk.iter(NS+'trkpt')]
    return pts

def fingerprint(pts):
    lats = [p[1] for p in pts]; lons = [p[0] for p in pts]
    bbox = (round(min(lats), 4), round(min(lons), 4), round(max(lats), 4), round(max(lons), 4))
    return (len(pts), bbox)

def convert(src, dst, role, mode):
    trks = ET.parse(src).getroot().findall(NS+'trk')
    rows = []
    for trk in trks:
        pts = track_points(trk)
        if len(pts) < 2: continue
        meta = by_fp.get(fingerprint(pts), {})
        rows.append((meta.get('date') or '9999', trk, pts, meta))
    rows.sort(key=lambda r: r[0])   # stable ids by date order
    feats = []; index = {}
    for n, (date, trk, pts, meta) in enumerate(rows, 1):
        rid = f'{role}-{n:02d}'
        if mode == 'raw':
            geom = rdp(pts, TOL)
            if len(geom) >= 2:
                feats.append({'type': 'Feature', 'properties': {'role': role, 'id': rid},
                              'geometry': {'type': 'LineString', 'coordinates': geom}})
            index[rid] = {'date': date, 'raw': True}
        else:
            miles = {snap(lon, lat) for lon, lat in pts}; miles.discard(None)
            ivs = intervals(miles)
            for a, b in ivs:
                runs = centerline_runs(a, b) if _pieces_mile else []
                if not runs:   # fallback: connect the 0.5-mi markers
                    coords = [[round(lo, 5), round(la, 5)] for mile, (lo, la) in spine if a <= mile <= b]
                    if len(coords) >= 2: runs = [coords]
                for run in runs:
                    feats.append({'type': 'Feature',
                                  'properties': {'role': role, 'id': rid, 'fromMile': a, 'toMile': b},
                                  'geometry': {'type': 'LineString', 'coordinates': rdp(run, TOL)}})
            index[rid] = {'date': date, 'miles': [[a, b] for a, b in ivs]}

    # Hand-added segments (no Garmin track): draw each mile range as a centerline
    # slice, same as the snapped bucket features. Only meaningful in snap mode.
    if mode != 'raw':
        for k, seg in enumerate(MANUAL.get(role, []), 1):
            a, b = seg['fromMile'], seg['toMile']
            rid = f'{role}-m{k:02d}'
            runs = centerline_runs(a, b) if _pieces_mile else []
            if not runs:   # fallback: connect the 0.5-mi markers
                coords = [[round(lo, 5), round(la, 5)] for mile, (lo, la) in spine if a <= mile <= b]
                if len(coords) >= 2: runs = [coords]
            for run in runs:
                feats.append({'type': 'Feature',
                              'properties': {'role': role, 'id': rid, 'fromMile': a, 'toMile': b},
                              'geometry': {'type': 'LineString', 'coordinates': rdp(run, TOL)}})
            index[rid] = {'manual': True, 'miles': [[a, b]], 'note': seg.get('note', '')}

    json.dump({'type': 'FeatureCollection', 'features': feats}, open(dst, 'w'), separators=(',', ':'))

    # merge into the local (gitignored) route index for cross-bucket reference
    sidecar = f'{REPO}/garmin-export/buckets/route-index.json'
    allidx = json.load(open(sidecar)) if os.path.exists(sidecar) else {}
    allidx[role] = index
    json.dump(allidx, open(sidecar, 'w'), indent=1)
    print(f'{src} -> {dst}: {len(feats)} features, {len(rows)} routes ({role}-01..{role}-{len(rows):02d})')

if __name__ == '__main__':
    src, dst, role = sys.argv[1], sys.argv[2], sys.argv[3]
    mode = sys.argv[4] if len(sys.argv) > 4 else 'snap'
    convert(src, dst, role, mode)
