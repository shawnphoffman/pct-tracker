// Compute how much of the PCT Madison has covered across ALL her hikes,
// deduped, by expressing every year's track as covered mile-intervals and
// taking their union.
//
// Why intervals: projecting each track point onto the nearest official mile
// marker (via the mile-marker tileset shawnhoffman.32639qah) turns a hike into
// ranges of trail miles. Off-trail wander (parking lots, town stops, GPS
// jitter) snaps back to the trail and adds nothing. A mile hiked in several
// years lands in the same interval, so the union counts it once.
//
// The live 2026 track is snapped at request time via Mapbox Tilequery; the
// static prior years (2018/2019/2023) are pre-snapped and baked into
// src/data/pct-history-coverage.json (see scripts note in that data's origin).
//
// 2026 is flip-flop aware: fixes are time-ordered, so we bridge the miles
// between two consecutive fixes only when they're within bridgeMaxMiles (a
// walkable gap); a larger gap reads as a shuttle/flip and isn't counted.

// PCT region spans (cumulative miles), derived from the mile-marker tileset and
// split at the half-mile gaps between regions so the lengths total 2662.
export const PCT_REGIONS = [
	{ name: 'Southern California', from: 0, to: 651.75 },
	{ name: 'Central California', from: 651.75, to: 1157.25 },
	{ name: 'Northern California', from: 1157.25, to: 1718.75 },
	{ name: 'Oregon', from: 1718.75, to: 2148.25 },
	{ name: 'Washington', from: 2148.25, to: 2662 },
]

const round1 = n => Math.round(n * 10) / 10

// Run `fn` over items with bounded concurrency, preserving index order.
const mapPool = async (items, limit, fn) => {
	const out = new Array(items.length)
	let next = 0
	const worker = async () => {
		while (next < items.length) {
			const i = next++
			out[i] = await fn(items[i], i)
		}
	}
	await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
	return out
}

// Nearest mile marker to a coord via Tilequery, or null if none within radius.
const snapMile = async ([lon, lat], { token, tileset, radius }) => {
	const url = `https://api.mapbox.com/v4/${tileset}/tilequery/${lon},${lat}.json?radius=${radius}&limit=1&dedupe=true&access_token=${token}`
	try {
		const res = await fetch(url, { cache: 'no-store' })
		if (!res.ok) return null
		const data = await res.json()
		const mile = data.features?.[0]?.properties?.Mile
		return Number.isFinite(mile) ? mile : null
	} catch {
		return null
	}
}

// Merge any list of [from, to] intervals into sorted, non-overlapping spans.
// tolerance joins spans separated by a gap that small (a snapping seam).
export const mergeIntervals = (intervals, tolerance = 0) => {
	const sorted = intervals.filter(iv => iv && iv[1] >= iv[0]).sort((p, q) => p[0] - q[0])
	const merged = []
	for (const iv of sorted) {
		const last = merged[merged.length - 1]
		if (last && iv[0] <= last[1] + tolerance) last[1] = Math.max(last[1], iv[1])
		else merged.push([iv[0], iv[1]])
	}
	return merged
}

// Ordered snapped miles -> walked intervals, bridging only walkable gaps.
const bridgeIntervals = (miles, bridgeMax) => {
	const seq = miles.filter(m => m != null)
	const intervals = []
	for (let i = 1; i < seq.length; i++) {
		const a = seq[i - 1]
		const b = seq[i]
		if (Math.abs(b - a) <= bridgeMax) intervals.push([Math.min(a, b), Math.max(a, b)])
	}
	return mergeIntervals(intervals)
}

const totalLength = intervals => intervals.reduce((sum, [a, b]) => sum + (b - a), 0)

const overlapLen = ([s, e], from, to) => {
	const a = Math.max(s, from)
	const b = Math.min(e, to)
	return b > a ? b - a : 0
}

const regionBreakdown = intervals =>
	PCT_REGIONS.map(r => {
		const length = r.to - r.from
		const covered = intervals.reduce((sum, iv) => sum + overlapLen(iv, r.from, r.to), 0)
		return {
			name: r.name,
			from: r.from,
			to: r.to,
			length: round1(length),
			covered: round1(covered),
			percent: round1((covered / length) * 100),
		}
	})

/**
 * @param {Array<[number, number]>} liveCoords ordered [lon, lat] 2026 vertices (oldest -> latest), or [] if none.
 * @param {{
 *   token: string, tileset: string, radius: number, bridgeMaxMiles: number, total: number,
 *   history?: Record<string, Array<[number, number]>>,
 *   gaps?: Array<{ from: number, to: number, status: string }>, seamMiles?: number,
 * }} opts history maps prior year -> pre-snapped covered intervals; gaps are the
 *   manually-adjudicated hitched/jumped sections (only status "complete" counts).
 * @returns {Promise<object|null>} combined progress, or null if there's nothing to report.
 */
export async function computePctProgress(liveCoords, { token, tileset, radius, bridgeMaxMiles, total, history = {}, gaps = [], seamMiles = 1 }) {
	// Snap the live 2026 track (if any) to its walked intervals.
	let liveIntervals = []
	let currentMile = null
	let furthestMile = null
	if (token && Array.isArray(liveCoords) && liveCoords.length) {
		const miles = await mapPool(liveCoords, 8, c => snapMile(c, { token, tileset, radius }))
		const snapped = miles.filter(m => m != null)
		if (snapped.length) {
			liveIntervals = bridgeIntervals(miles, bridgeMaxMiles)
			currentMile = round1([...miles].reverse().find(m => m != null))
			furthestMile = round1(Math.max(...snapped))
		}
	}

	// Per-year covered miles (each year on its own; overlaps allowed here).
	const byYear = {}
	for (const [year, intervals] of Object.entries(history)) {
		byYear[year] = round1(totalLength(mergeIntervals(intervals)))
	}
	if (liveIntervals.length) byYear['2026'] = round1(totalLength(liveIntervals))

	// Gaps she hitched/jumped only count once manually marked "complete".
	const completeIntervals = gaps.filter(g => g.status === 'complete').map(g => [g.from, g.to])

	// Union everything -> deduped lifetime coverage.
	const all = mergeIntervals([...Object.values(history).flat(), ...liveIntervals, ...completeIntervals], seamMiles)
	if (!all.length) return null

	// Pending = not-yet-complete gap miles that nothing else covers (the to-do list).
	const pending = gaps.filter(g => g.status !== 'complete')
	const pendingMiles = pending.reduce((sum, g) => {
		const covered = all.reduce((o, iv) => o + overlapLen(iv, g.from, g.to), 0)
		return sum + Math.max(0, g.to - g.from - covered)
	}, 0)

	const coveredMiles = totalLength(all)
	return {
		total,
		coveredMiles: round1(coveredMiles),
		coveredPercent: round1((coveredMiles / total) * 100),
		currentMile,
		furthestMile,
		byYear,
		regions: regionBreakdown(all),
		pendingMiles: round1(pendingMiles),
		pendingGaps: pending.length,
		bridgeMaxMiles,
	}
}
