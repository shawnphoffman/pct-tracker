import { XMLParser } from 'fast-xml-parser'

// Garmin inReach MapShare exposes a KML feed at
//   https://share.garmin.com/Feed/Share/<user>?d1=<ISO>&d2=<ISO>
// The feed is one Placemark per tracked fix (Point + TimeStamp), and some
// feeds additionally carry a <gx:Track> with parallel <when>/<gx:coord> lists.
// We parse both shapes, order the fixes by time, drop junk, and build a
// single LineString for the route plus the most-recent fix for a "you are
// here" marker.

const parser = new XMLParser({
	ignoreAttributes: false,
	attributeNamePrefix: '@_',
	// Keep single-element lists as-is; we normalize to arrays ourselves.
	isArray: () => false,
})

const asArray = value => (value == null ? [] : Array.isArray(value) ? value : [value])

// Depth-first collect every node under `node` whose key === `name`.
const collect = (node, name, out = []) => {
	if (node == null || typeof node !== 'object') return out
	for (const [key, value] of Object.entries(node)) {
		if (key === name) {
			for (const v of asArray(value)) out.push(v)
		}
		for (const v of asArray(value)) {
			if (v && typeof v === 'object') collect(v, name, out)
		}
	}
	return out
}

const num = v => {
	const n = typeof v === 'number' ? v : parseFloat(v)
	return Number.isFinite(n) ? n : null
}

// "lon,lat[,elev]" (KML) or "lon lat[ elev]" (gx:coord) -> [lon, lat]
const parseCoord = (raw, sep) => {
	if (!raw) return null
	const parts = String(raw).trim().split(sep).map(num)
	const [lon, lat] = parts
	if (lon == null || lat == null) return null
	if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null
	if (lon === 0 && lat === 0) return null // Garmin emits 0,0 for a lost fix
	return [lon, lat]
}

const text = v => (v && typeof v === 'object' ? v['#text'] : v)

const R_KM = 6371
const toRad = d => (d * Math.PI) / 180
const haversineKm = ([lon1, lat1], [lon2, lat2]) => {
	const dLat = toRad(lat2 - lat1)
	const dLon = toRad(lon2 - lon1)
	const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2
	return 2 * R_KM * Math.asin(Math.sqrt(a))
}

const round5 = n => Math.round(n * 1e5) / 1e5 // ~1m precision, trims payload

// Perpendicular distance (degree space) from p to segment a-b.
const perpDist = (p, a, b) => {
	const dx = b[0] - a[0]
	const dy = b[1] - a[1]
	if (dx === 0 && dy === 0) return Math.hypot(p[0] - a[0], p[1] - a[1])
	const t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy)
	const cx = a[0] + t * dx
	const cy = a[1] + t * dy
	return Math.hypot(p[0] - cx, p[1] - cy)
}

// Ramer-Douglas-Peucker line simplification (iterative, tolerance in degrees).
const simplify = (points, tol) => {
	if (points.length <= 2 || !tol) return points
	const keep = new Array(points.length).fill(false)
	keep[0] = keep[points.length - 1] = true
	const stack = [[0, points.length - 1]]
	while (stack.length) {
		const [start, end] = stack.pop()
		let maxD = 0
		let idx = -1
		for (let i = start + 1; i < end; i++) {
			const d = perpDist(points[i], points[start], points[end])
			if (d > maxD) {
				maxD = d
				idx = i
			}
		}
		if (maxD > tol && idx !== -1) {
			keep[idx] = true
			stack.push([start, idx], [idx, end])
		}
	}
	return points.filter((_, i) => keep[i])
}

// Pull the numeric epoch (ms) from a Placemark's <TimeStamp><when> or ExtendedData.
const placemarkTime = pm => {
	const when = text(pm?.TimeStamp?.when)
	const t = when ? Date.parse(when) : NaN
	if (Number.isFinite(t)) return t
	// Fallback: ExtendedData "Time UTC" / "Time"
	for (const data of asArray(pm?.ExtendedData?.Data)) {
		const label = data?.['@_name']
		if (label === 'Time UTC' || label === 'Time') {
			const parsed = Date.parse(text(data?.value))
			if (Number.isFinite(parsed)) return parsed
		}
	}
	return NaN
}

/**
 * Convert a Garmin MapShare KML string into ordered track fixes.
 * @param {string} kml
 * @param {{ notAfter?: number, maxSpeedKmh?: number }} [opts]
 *   notAfter: drop fixes newer than this epoch-ms (deployed safety delay; untimed
 *   fixes are dropped when set). maxSpeedKmh: drop a fix implying a faster-than-this
 *   move from the last good fix (removes GPS spikes/teleports).
 * @returns {{ fixes: Array<{coord: [number, number], time: number}> }}
 */
export function parseGarminFixes(kml, { notAfter = null, maxSpeedKmh = 160 } = {}) {
	if (!kml || typeof kml !== 'string' || !kml.includes('<')) return { fixes: [] }

	let root
	try {
		root = parser.parse(kml)
	} catch {
		return { fixes: [] }
	}

	const fixes = []

	// 1) Per-point Placemarks with a <Point>.
	for (const pm of collect(root, 'Placemark')) {
		const coord = parseCoord(text(pm?.Point?.coordinates), ',')
		if (!coord) continue
		fixes.push({ coord, time: placemarkTime(pm) })
	}

	// 2) <gx:Track> blocks: parallel <when> and <gx:coord> arrays.
	for (const track of [...collect(root, 'gx:Track'), ...collect(root, 'Track')]) {
		const whens = asArray(track?.when).map(w => Date.parse(text(w)))
		const coords = [...asArray(track?.['gx:coord']), ...asArray(track?.coord)]
		coords.forEach((raw, i) => {
			const coord = parseCoord(text(raw), ' ')
			if (coord) fixes.push({ coord, time: whens[i] ?? NaN })
		})
	}

	// Order by time (untimed fixes keep insertion order at the end), then drop
	// consecutive duplicate coordinates.
	fixes.sort((a, b) => {
		if (Number.isFinite(a.time) && Number.isFinite(b.time)) return a.time - b.time
		if (Number.isFinite(a.time)) return -1
		if (Number.isFinite(b.time)) return 1
		return 0
	})

	const cleaned = []
	for (const fix of fixes) {
		// Safety delay: never surface a fix newer than the cutoff.
		if (notAfter != null && (!Number.isFinite(fix.time) || fix.time > notAfter)) continue
		const prev = cleaned[cleaned.length - 1]
		if (prev && prev.coord[0] === fix.coord[0] && prev.coord[1] === fix.coord[1]) continue
		// Drop GPS spikes: a fix implying an impossible speed from the last good fix.
		if (maxSpeedKmh && prev && Number.isFinite(fix.time) && Number.isFinite(prev.time) && fix.time > prev.time) {
			const hours = (fix.time - prev.time) / 3600000
			if (hours > 0 && haversineKm(prev.coord, fix.coord) / hours > maxSpeedKmh) continue
		}
		cleaned.push(fix)
	}

	return { fixes: cleaned }
}

/**
 * Build a GeoJSON FeatureCollection (track LineString + latest Point) from a
 * Garmin MapShare KML string. Returns empty features when there is no data.
 */
export function garminKmlToGeoJSON(kml, { properties = {}, notAfter = null, maxSpeedKmh = 160, simplifyTolerance = 0.0001 } = {}) {
	const { fixes } = parseGarminFixes(kml, { notAfter, maxSpeedKmh })
	const features = []

	if (fixes.length >= 2) {
		const coordinates = simplify(
			fixes.map(f => f.coord),
			simplifyTolerance
		).map(([lon, lat]) => [round5(lon), round5(lat)])
		features.push({
			type: 'Feature',
			properties: { role: 'track', ...properties },
			geometry: { type: 'LineString', coordinates },
		})
	}

	const last = fixes[fixes.length - 1]
	if (last) {
		// No timestamp is exposed on purpose: the public map shouldn't reveal when
		// Madison was at a location.
		features.push({
			type: 'Feature',
			properties: { role: 'latest', ...properties },
			geometry: { type: 'Point', coordinates: [round5(last.coord[0]), round5(last.coord[1])] },
		})
	}

	return { type: 'FeatureCollection', features }
}
