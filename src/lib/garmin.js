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
 * @param {{ notAfter?: number }} [opts] notAfter: drop fixes newer than this epoch-ms
 *   (used for the deployed safety delay). Untimed fixes are dropped when set.
 * @returns {{ fixes: Array<{coord: [number, number], time: number}> }}
 */
export function parseGarminFixes(kml, { notAfter = null } = {}) {
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
		cleaned.push(fix)
	}

	return { fixes: cleaned }
}

/**
 * Build a GeoJSON FeatureCollection (track LineString + latest Point) from a
 * Garmin MapShare KML string. Returns empty features when there is no data.
 */
export function garminKmlToGeoJSON(kml, { properties = {}, notAfter = null } = {}) {
	const { fixes } = parseGarminFixes(kml, { notAfter })
	const features = []

	if (fixes.length >= 2) {
		features.push({
			type: 'Feature',
			properties: { role: 'track', ...properties },
			geometry: { type: 'LineString', coordinates: fixes.map(f => f.coord) },
		})
	}

	const last = fixes[fixes.length - 1]
	if (last) {
		features.push({
			type: 'Feature',
			properties: {
				role: 'latest',
				time: Number.isFinite(last.time) ? new Date(last.time).toISOString() : null,
				...properties,
			},
			geometry: { type: 'Point', coordinates: last.coord },
		})
	}

	return { type: 'FeatureCollection', features }
}
