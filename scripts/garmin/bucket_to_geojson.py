#!/usr/bin/env python3
"""Convert a sanitized bucket GPX into a web-ready GeoJSON for the map:
one simplified LineString per track segment, geometry only (NO timestamps,
matching the site's "never reveal when" rule), coords rounded to ~1 m.

    python3 scripts/garmin/bucket_to_geojson.py garmin-export/buckets/trail-crew.gpx public/trail-crew.geojson [role]
"""
import sys, json
import xml.etree.ElementTree as ET

NS = '{http://www.topografix.com/GPX/1/1}'
TOL = 0.0001   # RDP tolerance in degrees (~11 m), same order as the 2026 track

def perp(p, a, b):
    dx, dy = b[0]-a[0], b[1]-a[1]
    if dx == 0 and dy == 0:
        return ((p[0]-a[0])**2 + (p[1]-a[1])**2) ** 0.5
    t = ((p[0]-a[0])*dx + (p[1]-a[1])*dy) / (dx*dx + dy*dy)
    cx, cy = a[0]+t*dx, a[1]+t*dy
    return ((p[0]-cx)**2 + (p[1]-cy)**2) ** 0.5

def rdp(pts, tol):
    if len(pts) <= 2:
        return pts
    keep = [False]*len(pts); keep[0] = keep[-1] = True
    stack = [(0, len(pts)-1)]
    while stack:
        s, e = stack.pop()
        md, idx = 0, -1
        for i in range(s+1, e):
            d = perp(pts[i], pts[s], pts[e])
            if d > md:
                md, idx = d, i
        if md > tol and idx != -1:
            keep[idx] = True
            stack += [(s, idx), (idx, e)]
    return [p for p, k in zip(pts, keep) if k]

def convert(src, dst, role):
    root = ET.parse(src).getroot()
    feats = []
    for trk in root.iter(NS+'trk'):
        for seg in trk.iter(NS+'trkseg'):
            pts = [[round(float(p.get('lon')), 5), round(float(p.get('lat')), 5)]
                   for p in seg.iter(NS+'trkpt')]
            pts = rdp(pts, TOL)
            if len(pts) >= 2:
                feats.append({'type': 'Feature', 'properties': {'role': role},
                              'geometry': {'type': 'LineString', 'coordinates': pts}})
    json.dump({'type': 'FeatureCollection', 'features': feats}, open(dst, 'w'), separators=(',', ':'))
    pts_total = sum(len(f['geometry']['coordinates']) for f in feats)
    print(f'{src} -> {dst}: {len(feats)} lines, {pts_total} points')

if __name__ == '__main__':
    src, dst = sys.argv[1], sys.argv[2]
    role = sys.argv[3] if len(sys.argv) > 3 else 'trailcrew'
    convert(src, dst, role)
