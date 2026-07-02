#!/usr/bin/env python3
"""Strip PII from Garmin GPX before it is committed or exposed.

Garmin inReach exports embed PRIVATE MESSAGES and third-party names in per-point
<desc> fields (and waypoint name/desc), plus device/author metadata. This keeps
ONLY geometry: track points (lat/lon), elevation, time, and fix type. Everything
that could carry text a human wrote is removed.

Reusable as a module (`strip_pii(element)`) or a CLI:

    python3 scripts/garmin/sanitize.py in.gpx out.gpx
    python3 scripts/garmin/sanitize.py in.gpx            # verify only: report PII, exit 1 if found
"""
import sys
import xml.etree.ElementTree as ET

NS = 'http://www.topografix.com/GPX/1/1'
ET.register_namespace('', NS)

# Any element with one of these local names is removed wholesale (it holds, or
# may hold, human-authored text / identifying metadata).
STRIP_TAGS = {
    'desc', 'cmt', 'name', 'src', 'link', 'url', 'urlname', 'keywords',
    'extensions', 'metadata', 'author', 'email', 'wpt', 'rte',
}

def _local(tag):
    return tag.split('}')[-1] if isinstance(tag, str) else tag

def strip_pii(el):
    """Recursively remove PII-bearing children from an element, in place.

    Returns the number of elements removed."""
    removed = 0
    for child in list(el):
        if _local(child.tag) in STRIP_TAGS:
            el.remove(child)
            removed += 1
        else:
            removed += strip_pii(child)
    return removed

def count_pii(el):
    n = 0
    for child in el.iter():
        if _local(child.tag) in STRIP_TAGS:
            # a non-empty <desc> is the message payload; count those specifically
            n += 1
    return n

def sanitize_file(src, dst):
    tree = ET.parse(src)
    root = tree.getroot()
    root.set('creator', 'pct-tracker (sanitized)')
    removed = strip_pii(root)
    tree.write(dst, xml_declaration=True, encoding='UTF-8')
    return removed

if __name__ == '__main__':
    if len(sys.argv) == 3:
        n = sanitize_file(sys.argv[1], sys.argv[2])
        print(f'sanitized {sys.argv[1]} -> {sys.argv[2]} (removed {n} PII elements)')
    elif len(sys.argv) == 2:
        root = ET.parse(sys.argv[1]).getroot()
        n = count_pii(root)
        if n:
            print(f'PII FOUND in {sys.argv[1]}: {n} desc/name/cmt/extensions/wpt elements')
            sys.exit(1)
        print(f'clean: {sys.argv[1]} has no PII-bearing elements')
    else:
        print(__doc__)
        sys.exit(2)
