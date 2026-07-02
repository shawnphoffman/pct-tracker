// Harvest the PCT centerline (tileset shawnhoffman.8efdsxdm) around the
// non-year buckets, so their map segments can hug the real trail instead of
// chording between 0.5-mi markers. Writes garmin-export/.centerline.json
// (array of LineString pieces = per-tile clips, in vertex order).
//
//   node scripts/garmin/centerline.mjs
//
// Scoped to the bbox of buckets/{trail-crew,misc}.gpx (+ padding) so it's a
// few hundred tiles, not the whole PCT. Re-run if those buckets move regions.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { VectorTile } from '@mapbox/vector-tile'
import { PbfReader as Pbf } from 'pbf'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const EXPORT = path.join(REPO, 'garmin-export')
const TILESET = 'shawnhoffman.8efdsxdm'
const LAYER = 'Full_PCT_Simplified-05yji3'
const Z = 12
const PAD = 0.05

let TOKEN = process.env.NEXT_PUBLIC_MAPBOX_ACCESS_TOKEN || process.env.MAPBOX_TOKEN
if (!TOKEN) {
	for (const line of fs.readFileSync(path.join(REPO, '.env.local'), 'utf8').split('\n')) {
		const m = line.match(/^\s*(?:NEXT_PUBLIC_MAPBOX_ACCESS_TOKEN|MAPBOX_TOKEN)\s*=\s*(.*)\s*$/)
		if (m) { TOKEN = m[1].replace(/^["']|["']$/g, ''); break }
	}
}
if (!TOKEN) { console.error('no mapbox token'); process.exit(1) }

// bbox of the non-year bucket geometry
let minLon = 180, minLat = 90, maxLon = -180, maxLat = -90
for (const f of ['trail-crew', 'misc']) {
	const p = path.join(EXPORT, 'buckets', `${f}.gpx`)
	if (!fs.existsSync(p)) continue
	const gpx = fs.readFileSync(p, 'utf8')
	for (const m of gpx.matchAll(/lat="([-\d.]+)"\s+lon="([-\d.]+)"/g)) {
		const lat = +m[1], lon = +m[2]
		if (lat < minLat) minLat = lat; if (lat > maxLat) maxLat = lat
		if (lon < minLon) minLon = lon; if (lon > maxLon) maxLon = lon
	}
}
minLat -= PAD; minLon -= PAD; maxLat += PAD; maxLon += PAD
console.error(`bbox lat ${minLat.toFixed(3)}..${maxLat.toFixed(3)} lon ${minLon.toFixed(3)}..${maxLon.toFixed(3)}`)

const N = 2 ** Z
const lon2x = lon => Math.floor(((lon + 180) / 360) * N)
const lat2y = lat => { const r = (lat * Math.PI) / 180; return Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * N) }
const x0 = lon2x(minLon), x1 = lon2x(maxLon), y0 = lat2y(maxLat), y1 = lat2y(minLat)

const pieces = []
let tiles = 0
for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) {
	const res = await fetch(`https://api.mapbox.com/v4/${TILESET}/${Z}/${x}/${y}.vector.pbf?access_token=${TOKEN}`)
	if (!res.ok) continue
	const buf = Buffer.from(await res.arrayBuffer())
	if (!buf.length) continue
	const lyr = new VectorTile(new Pbf(buf)).layers[LAYER]
	if (!lyr) continue
	tiles++
	for (let i = 0; i < lyr.length; i++) {
		const g = lyr.feature(i).toGeoJSON(x, y, Z).geometry
		const lines = g.type === 'LineString' ? [g.coordinates] : g.type === 'MultiLineString' ? g.coordinates : []
		for (const line of lines) {
			const pts = line.map(([lon, lat]) => [Math.round(lon * 1e5) / 1e5, Math.round(lat * 1e5) / 1e5])
			if (pts.length >= 2) pieces.push(pts)
		}
	}
}
fs.writeFileSync(path.join(EXPORT, '.centerline.json'), JSON.stringify(pieces))
const verts = pieces.reduce((s, p) => s + p.length, 0)
console.error(`centerline: ${pieces.length} pieces, ${verts} vertices from ${tiles} tiles -> .centerline.json`)
