import { timingSafeEqual } from 'node:crypto'

import gapsData from '@/data/pct-gaps.json'
import spine from '@/data/pct-mile-spine.json'

// Server-generated "incomplete" layer: the PCT sections that do NOT count toward
// coverage yet - the pending gaps in pct-gaps.json (any status other than
// "complete"), plus the "remaining" stretch to the Canadian terminus. Drawn along
// the public PCT mile-marker spine (src/data/pct-mile-spine.json), so it's a pure,
// cheap transform of two committed inputs - the server equivalent of
// scripts/garmin/incomplete_layer.py, minus the gitignored public/incomplete.geojson.
//
// The mile spine is PUBLIC PCT trail geometry (no Madison-GPS PII). The pending-gap
// mile ranges are the same to-do info the public PCT Progress panel already exposes.
// Even so, this is framed as a live/local-only view: it renders only in dev or with
// a valid ?live= key, matching the map's Incomplete toggle, and the live response is
// never shared-cached.

const isProd = process.env.NODE_ENV === 'production'

// Same constant-time secret check as /api/track/[year]; unset secret disables it.
const isLiveKey = key => {
	const secret = process.env.GARMIN_LIVE_SECRET
	if (!secret || !key) return false
	const a = Buffer.from(String(key))
	const b = Buffer.from(secret)
	return a.length === b.length && timingSafeEqual(a, b)
}

// spine is [[lon, lat, mile], ...] sorted by mile.
const between = (a, b) => spine.filter(([, , mile]) => a <= mile && mile <= b).map(([lon, lat]) => [lon, lat])

const feature = (rid, from, to, label) => {
	const coords = between(from, to)
	if (coords.length < 2) return null
	return {
		type: 'Feature',
		properties: { role: 'incomplete', id: rid, fromMile: from, toMile: to, label },
		geometry: { type: 'LineString', coordinates: coords },
	}
}

export async function GET(request) {
	const live = new URL(request.url).searchParams.get('live')
	const allowed = !isProd || isLiveKey(live)
	if (!allowed) {
		// Match the track feed's "never signal" posture: don't 403 (which would
		// confirm the endpoint exists and is gated) - just serve an empty
		// collection, indistinguishable from a fully-complete trail. A wrong key
		// reveals nothing about how close it was (isLiveKey is constant-time).
		return Response.json({ type: 'FeatureCollection', features: [] }, { headers: { 'Cache-Control': 'private, no-store' } })
	}

	const pending = (gapsData.gaps || []).filter(g => g.status !== 'complete').sort((a, b) => a.from - b.from)
	const features = []
	pending.forEach((g, i) => {
		const f = feature(`incomplete-${String(i + 1).padStart(2, '0')}`, g.from, g.to, `${g.miles} mi · ${g.region}`)
		if (f) features.push(f)
	})
	const remaining = gapsData.remaining
	if (remaining) {
		const f = feature('incomplete-remaining', remaining.from, remaining.to, `${remaining.miles} mi · to Canada`)
		if (f) features.push(f)
	}

	// Live responses stay private/never shared-cached; dev likewise fresh.
	return Response.json({ type: 'FeatureCollection', features }, { headers: { 'Cache-Control': 'private, no-store' } })
}
