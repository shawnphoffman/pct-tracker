import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseGarminFixes, garminKmlToGeoJSON } from './garmin.js'

const kmlPlacemarks = fixes => `<?xml version="1.0"?>
<kml xmlns="http://www.opengis.net/kml/2.2" xmlns:gx="http://www.google.com/kml/ext/2.2"><Document><Folder>
${fixes
	.map(
		([lon, lat, when]) =>
			`<Placemark>${when ? `<TimeStamp><when>${when}</when></TimeStamp>` : ''}<Point><coordinates>${lon},${lat},0</coordinates></Point></Placemark>`
	)
	.join('\n')}
</Folder></Document></kml>`

test('orders fixes by time, drops 0,0 and consecutive duplicates', () => {
	const kml = kmlPlacemarks([
		[-121.5, 41.4, '2026-06-02T15:00:00Z'],
		[-121.577, 41.369, '2026-06-01T12:00:00Z'],
		[-121.54, 41.38, '2026-06-01T18:00:00Z'],
		[0, 0, '2026-06-01T13:00:00Z'],
		[-121.5, 41.4, '2026-06-02T15:05:00Z'], // duplicate coord
	])
	const { fixes } = parseGarminFixes(kml, { maxSpeedKmh: 0 })
	assert.deepEqual(
		fixes.map(f => f.coord),
		[
			[-121.577, 41.369],
			[-121.54, 41.38],
			[-121.5, 41.4],
		]
	)
})

test('parses gx:Track blocks', () => {
	const kml = `<?xml version="1.0"?><kml xmlns:gx="http://www.google.com/kml/ext/2.2"><Document><Placemark><gx:Track>
		<when>2026-06-01T12:00:00Z</when><when>2026-06-01T13:00:00Z</when>
		<gx:coord>-121.577 41.369 0</gx:coord><gx:coord>-121.56 41.372 0</gx:coord>
	</gx:Track></Placemark></Document></kml>`
	const { fixes } = parseGarminFixes(kml)
	assert.equal(fixes.length, 2)
	assert.deepEqual(fixes[0].coord, [-121.577, 41.369])
})

test('drops GPS spikes implying impossible speed', () => {
	const kml = kmlPlacemarks([
		[-121.5, 41.4, '2026-06-01T12:00:00Z'],
		[-95.0, 41.4, '2026-06-01T12:05:00Z'], // ~2000km in 5 min -> spike
		[-121.49, 41.41, '2026-06-01T12:10:00Z'],
	])
	const { fixes } = parseGarminFixes(kml, { maxSpeedKmh: 160 })
	assert.equal(fixes.length, 2)
	assert.ok(fixes.every(f => f.coord[0] < -120))
})

test('notAfter cutoff hides recent fixes (safety delay)', () => {
	const kml = kmlPlacemarks([
		[-121.5, 41.4, '2026-06-01T12:00:00Z'],
		[-121.4, 41.5, '2026-06-10T12:00:00Z'],
	])
	const cutoff = Date.parse('2026-06-05T00:00:00Z')
	const { fixes } = parseGarminFixes(kml, { notAfter: cutoff })
	assert.equal(fixes.length, 1)
	assert.deepEqual(fixes[0].coord, [-121.5, 41.4])
})

test('simplify removes collinear midpoints and rounds coords', () => {
	// Straight line: midpoints should collapse.
	const kml = kmlPlacemarks([
		[-121.0, 41.0, '2026-06-01T12:00:00Z'],
		[-121.1, 41.0, '2026-06-01T13:00:00Z'],
		[-121.2, 41.0, '2026-06-01T14:00:00Z'],
		[-121.3, 41.0, '2026-06-01T15:00:00Z'],
	])
	const gj = garminKmlToGeoJSON(kml, { maxSpeedKmh: 0 })
	const line = gj.features.find(f => f.geometry.type === 'LineString')
	assert.equal(line.geometry.coordinates.length, 2) // endpoints only
})

test('builds track + latest features; empty input is safe', () => {
	const gj = garminKmlToGeoJSON(
		kmlPlacemarks([
			[-121.5, 41.4, '2026-06-01T12:00:00Z'],
			[-121.4, 41.5, '2026-06-01T18:00:00Z'],
		]),
		{ maxSpeedKmh: 0 }
	)
	assert.equal(gj.features.length, 2)
	assert.equal(gj.features.find(f => f.geometry.type === 'Point').properties.role, 'latest')
	assert.deepEqual(garminKmlToGeoJSON('').features, [])
	assert.deepEqual(garminKmlToGeoJSON('not xml').features, [])
})
