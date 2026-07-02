// Regenerates src/data/pct-gaps.json: the interior gaps in Madison's PCT
// coverage (sections she hitched, jumped, or otherwise skipped), derived from
// the baked history coverage. Each gap carries a manually-editable `status`:
//   "complete" -> counts as covered (she actually walked it; a track just
//                 doesn't exist, or a hitched gap she later filled)
//   anything else (default "unknown") -> NOT counted; it's still to-do.
//
// Regenerating PRESERVES existing status/note by matching from-to, so hand
// edits survive. Gaps shorter than SEAM_MILES are treated as snapping seams
// (not real gaps) and folded into coverage.
//
//   node scripts/build-gaps.mjs

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { PCT_REGIONS } from '../src/lib/pct-progress.js'

const SEAM_MILES = 1 // gaps this short are seams between adjacent tracks, not hitches

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const dataDir = path.join(__dirname, '..', 'src', 'data')
const historyPath = path.join(dataDir, 'pct-history-coverage.json')
const gapsPath = path.join(dataDir, 'pct-gaps.json')

const history = JSON.parse(fs.readFileSync(historyPath, 'utf8'))
// Also fold in the export-only buckets (2026/trail-crew/misc) so their walked
// miles don't show up as gaps. See scripts/garmin/bucket_coverage.py.
const exportPath = path.join(dataDir, 'pct-export-coverage.json')
const exportCov = fs.existsSync(exportPath) ? JSON.parse(fs.readFileSync(exportPath, 'utf8')) : {}
const intervals = [...Object.entries(history), ...Object.entries(exportCov)]
	.filter(([k]) => !k.startsWith('_'))
	.flatMap(([, v]) => v)

// Union all covered intervals, folding sub-seam gaps into coverage.
const merged = []
for (const [a, b] of [...intervals].sort((p, q) => p[0] - q[0])) {
	const last = merged[merged.length - 1]
	if (last && a <= last[1] + SEAM_MILES) last[1] = Math.max(last[1], b)
	else merged.push([a, b])
}

const regionAt = m => (PCT_REGIONS.find(r => m >= r.from && m < r.to) || PCT_REGIONS[PCT_REGIONS.length - 1]).name
const round1 = n => Math.round(n * 10) / 10

// Interior gaps = holes between covered blocks (not the trail beyond her furthest point).
const gaps = []
for (let i = 1; i < merged.length; i++) {
	const from = round1(merged[i - 1][1])
	const to = round1(merged[i][0])
	if (to > from) gaps.push({ from, to, region: regionAt((from + to) / 2) })
}

// Preserve manual status/note from any existing file, matched by from-to.
let prior = {}
if (fs.existsSync(gapsPath)) {
	try {
		const existing = JSON.parse(fs.readFileSync(gapsPath, 'utf8'))
		for (const g of existing.gaps || []) prior[`${g.from}-${g.to}`] = g
	} catch {}
}

const body = {
	_comment:
		'Interior gaps in Madison\'s PCT coverage (hitched/jumped/skipped). Edit "status" to "complete" to count a gap as walked; default "unknown" does not count and marks it as still to-do. Regenerate with scripts/build-gaps.mjs (preserves status/note).',
	statuses: ['complete', 'unknown'],
	gaps: gaps.map(g => {
		const p = prior[`${g.from}-${g.to}`]
		return {
			from: g.from,
			to: g.to,
			miles: round1(g.to - g.from),
			region: g.region,
			status: p?.status || 'unknown',
			note: p?.note || '',
		}
	}),
}

fs.writeFileSync(gapsPath, JSON.stringify(body, null, '\t') + '\n')
const pending = body.gaps.filter(g => g.status !== 'complete').reduce((s, g) => s + g.miles, 0)
console.log(`Wrote ${body.gaps.length} gaps (${round1(pending)} mi not yet complete) to ${gapsPath}`)
