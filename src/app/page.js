'use client'
import { useRef, useEffect, useState, useCallback, Suspense } from 'react'
import mapboxgl from 'mapbox-gl'

import { useSearchParams } from 'next/navigation'
import dynamic from 'next/dynamic'

import EyeToggle from '@/components/EyeToggle'
import ColorCircle from '@/components/ColorCircle'
import CustomControl from '@/components/CustomControl'

// Newsletter dots are driven by these local per-year GeoJSON files (the single
// source of truth, also read by NewsletterDialog and edited via
// /admin/newsletters) rather than a baked Mapbox tileset, so edits show up on the
// map on next deploy. All years share one source/layer/toggle; merge them here.
import newsletterPoints2023 from '@/data/PCT - Madison - 2023 - Newsletter Points.json'
import newsletterPoints2026 from '@/data/PCT - Madison - 2026 - Newsletter Points.json'

const newsletterPoints = {
	type: 'FeatureCollection',
	features: [...newsletterPoints2026.features, ...newsletterPoints2023.features],
}

// Interaction-only UI: keep the lightbox library + JSON data out of the initial
// bundle and load each on first use.
const PhotoLightbox = dynamic(() => import('@/components/PhotoLightbox'), { ssr: false })
const NewsletterDialog = dynamic(() => import('@/components/NewsletterDialog'), { ssr: false })
const CoolStuffDialog = dynamic(() => import('@/components/CoolStuffDialog'), { ssr: false })

mapboxgl.accessToken = process.env.NEXT_PUBLIC_MAPBOX_ACCESS_TOKEN

const defaults = {
	lng: -121.577,
	lat: 41.369,
	zoom: 4.25,
	bounds: {
		north: 49.94686973387624,
		south: 30.997918064591815,
		east: -92.56810177337066,
		west: -146.44220630628152,
	},
}

const Layers = {
	Madi2026: 'PCT - 2026',
	Madi2023: 'PCT - 2023',
	Madi2019: 'PCT - 2019',
	Madi2018: 'PCT - 2018',
}

// 2026 is a live GeoJSON track sourced from Madison's Garmin inReach feed
// (proxied + cleaned by /api/track/2026), unlike the older years which are
// baked into the Mapbox style.
const track2026 = {
	source: 'track-2026',
	line: Layers.Madi2026,
	url: '/api/track/2026',
	color: '#84cc16',
}

// 2023 is served from our OWN sanitized track (public/pct-2023.geojson, generated
// by scripts/garmin/year_track.py) instead of the Mapbox tileset. The tileset
// hides a whole track feature to protect Madison's home, which left a gap at
// mi 1100-1103; our version is clipped to the trail corridor (home/town spurs
// dropped) so it's gapless AND home-safe. The tileset 'PCT - 2023' layer stays
// hidden. Colour matches YEAR_COLORS[23].
const track2023 = {
	source: 'track-2023',
	line: 'pct-2023-line',
	url: '/pct-2023.geojson',
	color: '#dc2626',
}

// Trail-crew project tracks (2020-2022 + 2026 pre-season), a static sanitized
// GeoJSON in public/ (geometry only, no timestamps). Generated from the Garmin
// export by scripts/garmin/bucket_to_geojson.py; lazy-loaded on first toggle.
const trackTrailCrew = {
	source: 'track-trailcrew',
	line: 'trail-crew-line',
	url: '/trail-crew.geojson',
	color: '#f97316',
}

// Misc: other PCT-adjacent tracks (2020-2022), also drawn as PCT segments.
// Same static-GeoJSON + lazy-load treatment as trail crew.
const trackMisc = {
	source: 'track-misc',
	line: 'misc-line',
	url: '/misc.geojson',
	color: '#f472b6',
}

// Unknown: LOCAL-ONLY debug layer (the junk aggregate track, raw geometry).
// public/unknown.geojson is gitignored so it never deploys; rendered only in dev.
const trackUnknown = {
	source: 'track-unknown',
	line: 'unknown-line',
	url: '/unknown.geojson',
	color: '#facc15',
}

// Incomplete: LOCAL-ONLY debug layer of the PCT sections that don't count toward
// coverage yet (pending gaps). public/incomplete.geojson is gitignored.
const trackIncomplete = {
	source: 'track-incomplete',
	line: 'incomplete-line',
	url: '/incomplete.geojson',
	color: '#000000',
}

// Layers that get a dev-only hover popover showing the route id (for reference
// when moving tracks between buckets / adjudicating gaps).
const HOVER_ID_LAYERS = [trackTrailCrew.line, trackMisc.line, trackUnknown.line, trackIncomplete.line]

// Distinct year colours; override the older Mapbox-style line colours in code.
// Keys are the 2-digit year suffix the toggles use.
const YEAR_COLORS = { 26: '#84cc16', 23: '#dc2626', 19: '#2563eb', 18: '#9333ea' }

// Start of each PCT section (mile-marker coords from the shawnhoffman.32639qah
// tileset; SoCal omitted since it's mile 0). Matches the progress region bounds.
const SECTION_STARTS = [
	{ label: 'Central', coord: [-118.03951, 35.65813] },
	{ label: 'NorCal', coord: [-120.32999, 39.33788] },
	{ label: 'Oregon', coord: [-122.61077, 42.07058] },
	{ label: 'Washington', coord: [-121.88739, 45.65929] },
]

// Pin marker for Madison's most recent (delay-safe) position. Path is the
// FontAwesome location-dot (same shape as the old LocationDot component).
// viewBox is padded (path spans 0..384 / 0..512) so the thick outline stroke
// isn't clipped at the top curve and bottom tip.
const PIN_SVG = `<svg viewBox="-40 -40 464 592" overflow="visible" xmlns="http://www.w3.org/2000/svg"><path d="M215.7 499.2C267 435 384 279.4 384 192C384 86 298 0 192 0S0 86 0 192c0 87.4 117 243 168.3 307.2c12.3 15.3 35.1 15.3 47.4 0zM192 128a64 64 0 1 1 0 128 64 64 0 1 1 0-128z"/></svg>`

// Photos are only enabled once an external image CDN (Cloudflare R2) is
// configured. Until then the feature stays fully off so it can't touch the
// Vercel image budget. See docs/photos.md.
const photosEnabled = !!process.env.NEXT_PUBLIC_PHOTO_CDN

const Home = () => {
	const mapContainer = useRef(null)
	const map = useRef(null)
	const latestMarker = useRef(null)
	const year2023Loaded = useRef(false)
	const trailCrewLoaded = useRef(false)
	const miscLoaded = useRef(false)
	const unknownLoaded = useRef(false)
	const incompleteLoaded = useRef(false)
	const throbTimer = useRef(null)
	const [showNewslettersDialog, setShowNewslettersDialog] = useState(false)
	const [showNewslettersLayer, setShowNewslettersLayer] = useState(false)
	const [showCoolStuffDialog, setShowCoolStuffDialog] = useState(false)
	const [showPhotosLayer, setShowPhotosLayer] = useState(false)
	const [show26, setShow26] = useState(true)
	const [show23, setShow23] = useState(true)
	const [show19, setShow19] = useState(false)
	const [show18, setShow18] = useState(true)
	// Trail Crew + Misc: PCT-adjacent tracks drawn as PCT segments (static GeoJSON).
	// Default on; eager-loaded on map load (see the load handler).
	const [showTrailCrew, setShowTrailCrew] = useState(true)
	const [showMisc, setShowMisc] = useState(true)
	const [showUnknown, setShowUnknown] = useState(false)
	const [showIncomplete, setShowIncomplete] = useState(false)
	const [showLightbox, setShowLightbox] = useState(false)
	const [imageOverride, setImageOverride] = useState(null)
	const [progress, setProgress] = useState(null)
	const [progressOpen, setProgressOpen] = useState(false)
	const searchParams = useSearchParams()

	const isDebug = !!searchParams.get('debug')
	// Local-only tooling: the Unknown debug layer + the route-id hover popovers.
	// Never on the deployed (production) site. process.env.NODE_ENV is inlined by Next.
	const isLocal = process.env.NODE_ENV !== 'production'

	useEffect(() => {
		if (showLightbox === false) {
			setImageOverride(null)
		}
	}, [showLightbox])

	// Stop the map-dot throb loop on unmount.
	useEffect(() => () => clearInterval(throbTimer.current), [])

	// Keep the current-position pin in sync with the 2026 toggle (it's a DOM
	// marker, not a style layer, so toggleLayer doesn't reach it).
	useEffect(() => {
		if (latestMarker.current) {
			latestMarker.current.getElement().style.display = show26 ? '' : 'none'
		}
	}, [show26])

	const toggleLayer = useCallback(
		(layerName, stateCallback) => {
			if (!map.current || !map.current.getLayer(layerName)) {
				return
			}
			const visibility = map.current.getLayoutProperty(layerName, 'visibility')
			// Toggle layer visibility by changing the layout object's visibility property.
			map.current.setLayoutProperty(layerName, 'visibility', visibility === 'none' ? 'visible' : 'none')
			stateCallback && stateCallback(visibility === 'none')
		},
		[map]
	)

	const toggleLayers = useCallback(
		(layerNames, stateCallback) => {
			layerNames.forEach(layerName => toggleLayer(layerName, stateCallback))
		},
		[toggleLayer]
	)

	// Toggle a lazy static-GeoJSON line, fetching its data the first time it's shown.
	const toggleLazyLine = useCallback(
		(track, loadedRef, stateCallback) => {
			if (!loadedRef.current) {
				loadedRef.current = true
				fetch(track.url)
					.then(r => r.json())
					.then(geo => map.current?.getSource(track.source)?.setData(geo))
					.catch(() => {})
			}
			toggleLayer(track.line, stateCallback)
		},
		[toggleLayer]
	)
	const toggleTrailCrew = useCallback(() => toggleLazyLine(trackTrailCrew, trailCrewLoaded, setShowTrailCrew), [toggleLazyLine])
	const toggleMisc = useCallback(() => toggleLazyLine(trackMisc, miscLoaded, setShowMisc), [toggleLazyLine])
	const toggleUnknown = useCallback(() => toggleLazyLine(trackUnknown, unknownLoaded, setShowUnknown), [toggleLazyLine])
	const toggleIncomplete = useCallback(() => toggleLazyLine(trackIncomplete, incompleteLoaded, setShowIncomplete), [toggleLazyLine])

	const copyValues = useCallback(() => {
		const values = {
			label: 'Label',
			zoom: map.current.getZoom(),
			pitch: map.current.getPitch(),
			bearing: map.current.getBearing(),
			center: map.current.getCenter(),
		}
		navigator.clipboard.writeText(JSON.stringify(values, null, 2))
	}, [])

	const reset = useCallback(() => {
		map.current.flyTo({
			center: [defaults.lng, defaults.lat],
			zoom: defaults.zoom,
			pitch: 0,
			bearing: 0,
			duration: 2000,
		})
	}, [])

	useEffect(() => {
		if (map.current) return // initialize map only once

		// Zoom and pitch controls
		const controlNav = new mapboxgl.NavigationControl({
			visualizePitch: true,
		})

		// Scale control
		const controlScale = new mapboxgl.ScaleControl({
			maxWidth: 80,
			unit: 'imperial',
		})

		// Fullscreen control
		const controlFullscreen = new mapboxgl.FullscreenControl()

		// Attribution control
		const controlAttribution = new mapboxgl.AttributionControl({
			customAttribution: 'Map by Shawn',
		})

		// Custom controls
		const control26 = new CustomControl({
			container: document.getElementById('toggle-26'),
		})
		const control23 = new CustomControl({
			container: document.getElementById('toggle-23'),
		})
		const control19 = new CustomControl({
			container: document.getElementById('toggle-19'),
		})
		const control18 = new CustomControl({
			container: document.getElementById('toggle-18'),
		})
		const controlTrailCrew = new CustomControl({
			container: document.getElementById('toggle-trailcrew'),
		})
		const controlMisc = new CustomControl({
			container: document.getElementById('toggle-misc'),
		})
		const controlUnknown = new CustomControl({
			container: document.getElementById('toggle-unknown'),
		})
		const controlIncomplete = new CustomControl({
			container: document.getElementById('toggle-incomplete'),
		})
		const controlNewsletter = new CustomControl({
			container: document.getElementById('toggle-newsletter'),
		})
		const controlPhotos = new CustomControl({
			container: document.getElementById('toggle-photos'),
		})
		const controlCoolStuff = new CustomControl({
			container: document.getElementById('toggle-cool'),
		})
		const buttonReset = new CustomControl({
			container: document.getElementById('button-reset'),
		})
		const controlCopy = new CustomControl({
			container: document.getElementById('button-copy'),
		})

		// Initialize map
		map.current = new mapboxgl.Map({
			container: mapContainer.current,
			style: process.env.NEXT_PUBLIC_MAPBOX_STYLE,
			center: [defaults.lng, defaults.lat],
			zoom: defaults.zoom,
			attributionControl: false,
			minZoom: defaults.zoom - 0.5,
			bearingSnap: 0,
			// mapbox-gl v3 defaults to the globe projection; keep the flat map we designed for.
			projection: 'mercator',
		})
			.addControl(controlNav)
			.addControl(controlScale)
			.addControl(controlFullscreen)
			.addControl(controlAttribution)
			.addControl(control26, 'top-left')
			.addControl(control23, 'top-left')
			.addControl(control19, 'top-left')
			.addControl(control18, 'top-left')
			.addControl(controlTrailCrew, 'top-left')
			.addControl(controlMisc, 'top-left')
			.addControl(controlNewsletter, 'top-left')
			.addControl(buttonReset, 'top-right')

		if (photosEnabled) {
			map.current.addControl(controlPhotos, 'top-left')
		}

		if (isLocal) {
			map.current.addControl(controlUnknown, 'top-left')
			map.current.addControl(controlIncomplete, 'top-left')
		}

		if (isDebug) {
			map.current.addControl(controlCoolStuff, 'top-left')
			map.current.addControl(controlCopy, 'top-right')
		}

		// Wait for the map to load
		map.current.on('load', () => {
			// Resize just in case
			map.current.resize()

			// Reveal the baked-in year layers (all but 2019, which starts hidden) and
			// capture each year's line colour for the toggle swatches.
			map.current.getStyle().layers.forEach(layer => {
				if (layer.id.includes('PCT -')) {
					// 2019 starts hidden; 2023's tileset layer stays hidden for good (we
					// render 2023 from our own home-safe GeoJSON instead - see track2023).
					if (!layer.id.includes('2019') && !layer.id.includes('2023')) {
						map.current.setLayoutProperty(layer.id, 'visibility', 'visible')
					}
					const yearKey = layer.id.slice(-2)
					const color = YEAR_COLORS[yearKey] || layer.paint['line-color']
					map.current.setPaintProperty(layer.id, 'line-color', color)
					document.documentElement.style.setProperty(`--color-${yearKey}`, color)
					// Do NOT clear the style's per-year filters: the 2023 filter hides the
					// track feature `Madison Sites (23344013)` on purpose because it runs off
					// the trail to Madison's HOME. The mi 1100-1103 gap is the cost of that;
					// the real fix is trimming that track at the trailhead (in Studio, or by
					// serving our own sanitized 2023 track). PRIVACY: never reveal it.
				}
			})

			// Add newsletter source and layer
			const newsletterSource = 'newsletter-points'
			map.current.addSource(newsletterSource, {
				type: 'geojson',
				data: newsletterPoints,
			})
			map.current.addLayer(
				{
					id: 'newsletter-points',
					source: newsletterSource,
					type: 'circle',
					layout: {
						// visibility: 'visible',
						visibility: showNewslettersLayer ? 'visible' : 'none',
					},
					minzoom: 4.5,
					paint: {
						'circle-radius': ['step', ['zoom'], 2, 5, 4, 8, 5],
						'circle-color': '#eab308',
						'circle-stroke-color': 'hsl(64, 100%, 0%)',
						'circle-stroke-width': ['step', ['zoom'], 1, 5, 2, 8, 3],
					},
				},
				'pct-miles' // Add layer below labels
			)
			map.current.addLayer(
				{
					id: 'newsletter-points-hidden',
					source: newsletterSource,
					type: 'circle',
					layout: {
						// visibility: 'visible',
						visibility: showNewslettersLayer ? 'visible' : 'none',
					},
					minzoom: 4.5,
					paint: {
						'circle-opacity': 0.01,
						'circle-radius': 18,
						'circle-color': 'hsl(120, 100%, 50%)',
					},
				},
				'newsletter-points'
			)
			// 2026 live track (Garmin inReach feed via /api/track/2026). Fetched once
			// so the same data drives the route line, the current-position pin, and
			// the fly-to below.
			map.current.addSource(track2026.source, {
				type: 'geojson',
				data: { type: 'FeatureCollection', features: [] },
			})
			map.current.addLayer(
				{
					id: track2026.line,
					source: track2026.source,
					type: 'line',
					filter: ['==', ['get', 'role'], 'track'],
					layout: {
						'line-join': 'round',
						'line-cap': 'round',
						visibility: show26 ? 'visible' : 'none',
					},
					paint: {
						'line-color': track2026.color,
						'line-width': ['interpolate', ['linear'], ['zoom'], 4, 1.5, 10, 3.5],
					},
				},
				'newsletter-points' // keep the route line beneath the newsletter dots
			)
			document.documentElement.style.setProperty('--color-26', track2026.color)

			// 2023 line from our own home-safe GeoJSON (replaces the hidden tileset
			// layer). Default on, so eager-load it below.
			map.current.addSource(track2023.source, {
				type: 'geojson',
				data: { type: 'FeatureCollection', features: [] },
			})
			map.current.addLayer(
				{
					id: track2023.line,
					source: track2023.source,
					type: 'line',
					layout: { 'line-join': 'round', 'line-cap': 'round', visibility: show23 ? 'visible' : 'none' },
					paint: {
						'line-color': track2023.color,
						'line-width': ['interpolate', ['linear'], ['zoom'], 4, 1.5, 10, 3.5],
					},
				},
				'newsletter-points'
			)
			if (show23) {
				year2023Loaded.current = true
				fetch(track2023.url).then(r => r.json()).then(geo => map.current?.getSource(track2023.source)?.setData(geo)).catch(() => {})
			}

			// Trail-crew line: empty source now, data fetched lazily by toggleTrailCrew.
			map.current.addSource(trackTrailCrew.source, {
				type: 'geojson',
				data: { type: 'FeatureCollection', features: [] },
			})
			map.current.addLayer(
				{
					id: trackTrailCrew.line,
					source: trackTrailCrew.source,
					type: 'line',
					layout: {
						'line-join': 'round',
						'line-cap': 'round',
						visibility: showTrailCrew ? 'visible' : 'none',
					},
					paint: {
						'line-color': trackTrailCrew.color,
						'line-width': ['interpolate', ['linear'], ['zoom'], 4, 1.5, 10, 3.5],
					},
				},
				'newsletter-points'
			)

			// Misc line: same lazy pattern as trail crew.
			map.current.addSource(trackMisc.source, {
				type: 'geojson',
				data: { type: 'FeatureCollection', features: [] },
			})
			map.current.addLayer(
				{
					id: trackMisc.line,
					source: trackMisc.source,
					type: 'line',
					layout: {
						'line-join': 'round',
						'line-cap': 'round',
						visibility: showMisc ? 'visible' : 'none',
					},
					paint: {
						'line-color': trackMisc.color,
						'line-width': ['interpolate', ['linear'], ['zoom'], 4, 1.5, 10, 3.5],
					},
				},
				'newsletter-points'
			)

			// Trail crew + misc default to visible, so eager-load their data here
			// (the lazy fetch in toggleLazyLine only fires on a toggle click).
			if (showTrailCrew) {
				trailCrewLoaded.current = true
				fetch(trackTrailCrew.url).then(r => r.json()).then(geo => map.current?.getSource(trackTrailCrew.source)?.setData(geo)).catch(() => {})
			}
			if (showMisc) {
				miscLoaded.current = true
				fetch(trackMisc.url).then(r => r.json()).then(geo => map.current?.getSource(trackMisc.source)?.setData(geo)).catch(() => {})
			}

			// LOCAL-ONLY: the Unknown debug layer + route-id hover popovers.
			if (isLocal) {
				map.current.addSource(trackUnknown.source, {
					type: 'geojson',
					data: { type: 'FeatureCollection', features: [] },
				})
				map.current.addLayer(
					{
						id: trackUnknown.line,
						source: trackUnknown.source,
						type: 'line',
						layout: { 'line-join': 'round', 'line-cap': 'round', visibility: showUnknown ? 'visible' : 'none' },
						paint: {
							'line-color': trackUnknown.color,
							'line-width': ['interpolate', ['linear'], ['zoom'], 4, 1.5, 10, 3.5],
							'line-dasharray': [2, 1],
						},
					},
					'newsletter-points'
				)
				map.current.addSource(trackIncomplete.source, {
					type: 'geojson',
					data: { type: 'FeatureCollection', features: [] },
				})
				map.current.addLayer(
					{
						id: trackIncomplete.line,
						source: trackIncomplete.source,
						type: 'line',
						layout: { 'line-join': 'round', 'line-cap': 'round', visibility: showIncomplete ? 'visible' : 'none' },
						paint: {
							'line-color': trackIncomplete.color,
							'line-width': ['interpolate', ['linear'], ['zoom'], 4, 2, 10, 4.5],
						},
					},
					'newsletter-points'
				)

				// Hover any debug line to see its route id (e.g. "misc-03 · mi 943–944").
				const hoverPopup = new mapboxgl.Popup({ closeButton: false, closeOnClick: false, className: 'popup route-id-popup' })
				HOVER_ID_LAYERS.forEach(layer => {
					map.current.on('mousemove', layer, e => {
						map.current.getCanvas().style.cursor = 'pointer'
						const { id, fromMile, toMile, label } = e.features[0].properties
						const detail = fromMile != null ? ` · mi ${fromMile}–${toMile}` : label ? ` · ${label}` : ''
						hoverPopup.setLngLat(e.lngLat).setHTML(`<div class="route-id">${id}${detail}</div>`).addTo(map.current)
					})
					map.current.on('mouseleave', layer, () => {
						map.current.getCanvas().style.cursor = ''
						hoverPopup.remove()
					})
				})
			}

			// Stack the track lines to match the on-page toggle hierarchy so the more
			// recent hike wins wherever routes overlap: 2026 on top, older years
			// beneath, then the trail-crew/misc buckets, with the local-only debug
			// layers at the bottom. All stay below the newsletter dots. The 2018/2019
			// lines are baked into the style at an arbitrary depth, so we can't rely
			// on add-order - move every layer explicitly. Mapbox draws layers in list
			// order (later = on top) and moveLayer(id, 'newsletter-points') drops id
			// just below the newsletters, so moving bottom-to-top leaves 2026 topmost.
			const trackStackBottomToTop = [
				trackIncomplete.line, // local-only debug
				trackUnknown.line, // local-only debug
				trackMisc.line,
				trackTrailCrew.line,
				Layers.Madi2018,
				Layers.Madi2019,
				track2023.line,
				track2026.line,
			]
			for (const id of trackStackBottomToTop) {
				if (map.current.getLayer(id)) map.current.moveLayer(id, 'newsletter-points')
			}

			// Section-start markers: labeled dots at the start of each PCT section.
			SECTION_STARTS.forEach(s => {
				const el = document.createElement('div')
				el.className = 'section-marker'
				el.innerHTML = `<span class="section-dot"></span><span class="section-label">${s.label}</span>`
				new mapboxgl.Marker({ element: el, anchor: 'left' }).setLngLat(s.coord).addTo(map.current)
			})

			fetch(track2026.url)
				.then(r => r.json())
				.then(geo => {
					if (!map.current) return
					map.current.getSource(track2026.source)?.setData(geo)
					setProgress(geo.progress || null)

					const latest = geo.features?.find(f => f.properties?.role === 'latest')
					if (!latest) return
					const coord = latest.geometry.coordinates

					// Current-position pin with a "how long ago" popup.
					const el = document.createElement('div')
					el.className = 'latest-pin'
					el.innerHTML = PIN_SVG
					el.style.color = track2026.color
					el.setAttribute('aria-label', 'Madison’s most recent position')
					if (!show26) el.style.display = 'none'
					latestMarker.current = new mapboxgl.Marker({ element: el, anchor: 'bottom' })
						.setLngLat(coord)
						.setPopup(new mapboxgl.Popup({ offset: 28, className: 'popup' }).setHTML(`<div class="latest-popup"><strong>Madison was here</strong></div>`))
						.addTo(map.current)

					// Bring the viewport to her current position on load.
					map.current.flyTo({ center: coord, zoom: Math.max(map.current.getZoom(), 8.5), duration: 3000 })
				})
				.catch(() => {})

			map.current.on('click', 'newsletter-points-hidden', function (e) {
				// Copy coordinates array.
				const coordinates = e.features[0].geometry.coordinates.slice()
				const { Mile, Link } = e.features[0].properties

				// Ensure that if the map is zoomed out such that multiple
				// copies of the feature are visible, the popup appears
				// over the copy being pointed to.
				while (Math.abs(e.lngLat.lng - coordinates[0]) > 180) {
					coordinates[0] += e.lngLat.lng > coordinates[0] ? 360 : -360
				}

				new mapboxgl.Popup()
					.setLngLat(coordinates)
					.setHTML(
						`<div class="newsletter-container">
							<div class="newsletter-title">Mile ${Mile}</div>
							<a href="${Link}" target="_blank">View Newsletter</a>
						</div>`
					)
					.addTo(map.current)
			})

			// Photo markers: cheap circles from photos.json. The images themselves
			// load lazily in the lightbox (from R2), so browsing the map costs no
			// image bandwidth. photos.json is dynamically imported to stay out of
			// the initial bundle, and the whole thing is gated on the CDN.
			if (photosEnabled) {
				import('@/data/photos.json').then(({ default: photos }) => {
					if (!map.current) return
					map.current.addSource('photo-points-data', { type: 'geojson', data: photos })
					map.current.addLayer(
						{
							id: 'photo-points',
							source: 'photo-points-data',
							type: 'circle',
							layout: {
								visibility: showPhotosLayer ? 'visible' : 'none',
							},
							minzoom: 4.5,
							paint: {
								'circle-radius': ['step', ['zoom'], 2, 5, 4, 8, 5],
								'circle-color': '#14b8a6',
								'circle-stroke-color': 'hsl(64, 100%, 0%)',
								'circle-stroke-width': ['step', ['zoom'], 1, 5, 2, 8, 3],
							},
						},
						'newsletter-points' // Add layer below newsletters
					)
					map.current.on('click', 'photo-points', function (e) {
						setImageOverride(e.features[0].properties.filename)
						setShowLightbox(true)
					})
				})
			}

			// Throb the newsletter + photo dots' colours (easing between the base
			// colour and a brighter tint) so they read differently from the static
			// year/track lines. Only repaints while a dot layer is actually visible,
			// and honours reduced-motion.
			if (!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
				const THROB = [
					{ layer: 'newsletter-points', from: [0xea, 0xb3, 0x08], to: [0xfd, 0xe0, 0x47] },
					{ layer: 'photo-points', from: [0x14, 0xb8, 0xa6], to: [0x99, 0xf6, 0xe4] },
				]
				throbTimer.current = setInterval(() => {
					if (!map.current) return
					const k = 0.5 + 0.5 * Math.sin(Date.now() / 300)
					for (const { layer, from, to } of THROB) {
						if (!map.current.getLayer(layer)) continue
						if (map.current.getLayoutProperty(layer, 'visibility') !== 'visible') continue
						const c = from.map((f, i) => Math.round(f + (to[i] - f) * k))
						map.current.setPaintProperty(layer, 'circle-color', `rgb(${c[0]},${c[1]},${c[2]})`)
					}
				}, 60)
			}

			// DEBUG STUFF
			if (isDebug) {
				map.current.on('click', function (e) {
					console.log('click', {
						zoom: map.current.getZoom(),
						pitch: map.current.getPitch(),
						bearing: map.current.getBearing(),
						center: map.current.getCenter(),
					})
				})
			}
		})
	}, [isDebug, isLocal, showNewslettersLayer, showPhotosLayer, show23, show26, showTrailCrew, showMisc, showUnknown, showIncomplete])

	return (
		<div>
			<div className="controls">
				{/* LEFT CONTROLS */}
				{/* YEAR TOGGLES */}
				<div id="toggle-26">
					<button
						className={`mapboxgl-ctrl-year year-visible-${show26} year-26`}
						onClick={() => toggleLayer(Layers.Madi2026, setShow26)}
					>
						<EyeToggle visible={show26} />
						<>2026</>
						<ColorCircle />
					</button>
				</div>
				<div id="toggle-23">
					<button className={`mapboxgl-ctrl-year year-visible-${show23} year-23`} onClick={() => toggleLazyLine(track2023, year2023Loaded, setShow23)}>
						<EyeToggle visible={show23} />
						<>2023</>
						<ColorCircle />
					</button>
				</div>
				<div id="toggle-19">
					<button className={`mapboxgl-ctrl-year year-visible-${show19} year-19`} onClick={() => toggleLayer(Layers.Madi2019, setShow19)}>
						<EyeToggle visible={show19} />
						<>2019</>
						<ColorCircle />
					</button>
				</div>
				<div id="toggle-18">
					<button className={`mapboxgl-ctrl-year year-visible-${show18} year-18`} onClick={() => toggleLayer(Layers.Madi2018, setShow18)}>
						<EyeToggle visible={show18} />
						<>2018</>
						<ColorCircle />
					</button>
				</div>
				{/* TRAIL CREW */}
				<div id="toggle-trailcrew">
					<button className={`mapboxgl-ctrl-year year-visible-${showTrailCrew} year-tc`} onClick={toggleTrailCrew}>
						<EyeToggle visible={showTrailCrew} />
						<>Trail Crew</>
						<ColorCircle />
					</button>
				</div>
				{/* MISC */}
				<div id="toggle-misc">
					<button className={`mapboxgl-ctrl-year year-visible-${showMisc} year-misc`} onClick={toggleMisc}>
						<EyeToggle visible={showMisc} />
						<>Misc</>
						<ColorCircle />
					</button>
				</div>
				{/* UNKNOWN + INCOMPLETE (local-only debug) */}
				{isLocal && (
					<div id="toggle-unknown">
						<button className={`mapboxgl-ctrl-year year-visible-${showUnknown} year-unknown`} onClick={toggleUnknown}>
							<EyeToggle visible={showUnknown} />
							<>Unknown</>
							<ColorCircle />
						</button>
					</div>
				)}
				{isLocal && (
					<div id="toggle-incomplete">
						<button className={`mapboxgl-ctrl-year year-visible-${showIncomplete} year-incomplete`} onClick={toggleIncomplete}>
							<EyeToggle visible={showIncomplete} />
							<>Incomplete</>
							<ColorCircle />
						</button>
					</div>
				)}
				{/* NEWSLETTERS */}
				<div id="toggle-newsletter">
					<button className="mapboxgl-ctrl-toggle news-list" onClick={() => setShowNewslettersDialog(!showNewslettersDialog)}>
						<>Newsletters</>
					</button>
					<span></span>
					<button
						className={`mapboxgl-ctrl-toggle toggle-eye visible-${showNewslettersLayer}`}
						onClick={() => toggleLayers(['newsletter-points', 'newsletter-points-hidden'], setShowNewslettersLayer)}
						aria-label="Toggle newsletter markers"
					>
						<EyeToggle visible={showNewslettersLayer} />
						<ColorCircle />
					</button>
				</div>
				{/* PHOTOS (only when an image CDN is configured) */}
				{photosEnabled && (
					<div id="toggle-photos">
						<button className="mapboxgl-ctrl-toggle photo-list" onClick={() => setShowLightbox(true)}>
							Photos
						</button>
						<span></span>
						<button
							className={`mapboxgl-ctrl-toggle toggle-eye visible-${showPhotosLayer}`}
							onClick={() => toggleLayers(['photo-points'], setShowPhotosLayer)}
							aria-label="Toggle photo markers"
						>
							<EyeToggle visible={showPhotosLayer} />

							<ColorCircle />
						</button>
					</div>
				)}
				{/* COOL STUFF */}
				<div id="toggle-cool">
					<button className="mapboxgl-ctrl-toggle cool-list" onClick={() => setShowCoolStuffDialog(!showCoolStuffDialog)}>
						Cool Stuff
					</button>
				</div>
				{/* RIGHT CONTROLS */}
				<div id="button-reset">
					<button className="" onClick={() => reset()} aria-label="Reset map view">
						<span className="mapboxgl-ctrl-icon madi-icon">
							<svg xmlns="http://www.w3.org/2000/svg" height="1em" viewBox="0 0 512 512">
								<path d="M48.5 224H40c-13.3 0-24-10.7-24-24V72c0-9.7 5.8-18.5 14.8-22.2s19.3-1.7 26.2 5.2L98.6 96.6c87.6-86.5 228.7-86.2 315.8 1c87.5 87.5 87.5 229.3 0 316.8s-229.3 87.5-316.8 0c-12.5-12.5-12.5-32.8 0-45.3s32.8-12.5 45.3 0c62.5 62.5 163.8 62.5 226.3 0s62.5-163.8 0-226.3c-62.2-62.2-162.7-62.5-225.3-1L185 183c6.9 6.9 8.9 17.2 5.2 26.2s-12.5 14.8-22.2 14.8H48.5z" />
							</svg>
						</span>
					</button>
				</div>
				{/* COPY */}
				<div id="button-copy">
					<button className="" onClick={copyValues} aria-label="Copy map position">
						<span className="mapboxgl-ctrl-icon madi-icon">
							<svg xmlns="http://www.w3.org/2000/svg" height="1em" viewBox="0 0 448 512">
								<path d="M384 336H192c-8.8 0-16-7.2-16-16V64c0-8.8 7.2-16 16-16l140.1 0L400 115.9V320c0 8.8-7.2 16-16 16zM192 384H384c35.3 0 64-28.7 64-64V115.9c0-12.7-5.1-24.9-14.1-33.9L366.1 14.1c-9-9-21.2-14.1-33.9-14.1H192c-35.3 0-64 28.7-64 64V320c0 35.3 28.7 64 64 64zM64 128c-35.3 0-64 28.7-64 64V448c0 35.3 28.7 64 64 64H256c35.3 0 64-28.7 64-64V416H272v32c0 8.8-7.2 16-16 16H64c-8.8 0-16-7.2-16-16V192c0-8.8 7.2-16 16-16H96V128H64z" />
							</svg>
						</span>
					</button>
				</div>
			</div>
			{/* MAP */}
			<div ref={mapContainer} className="map-container" role="application" aria-label="Map of Madison’s Pacific Crest Trail hikes" />

			{/* LIFETIME PCT PROGRESS: miles/percent covered across all years, snapped
			    to the trail and deduped so a mile hiked twice counts once.
			    Collapsible via the chart icon in the header. */}
			{progress && (
				<div className={`progress-panel${progressOpen ? ' open' : ''}`}>
					<button
						className="progress-head"
						onClick={() => setProgressOpen(o => !o)}
						aria-expanded={progressOpen}
						aria-label="Toggle PCT progress details"
					>
						<svg className="progress-icon" viewBox="0 0 512 512" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
							<path d="M32 32c17.7 0 32 14.3 32 32V400c0 8.8 7.2 16 16 16H480c17.7 0 32 14.3 32 32s-14.3 32-32 32H80c-44.2 0-80-35.8-80-80V64C0 46.3 14.3 32 32 32zm96 288c-17.7 0-32-14.3-32-32V192c0-17.7 14.3-32 32-32s32 14.3 32 32v96c0 17.7-14.3 32-32 32zm128-32c0 17.7-14.3 32-32 32s-32-14.3-32-32V96c0-17.7 14.3-32 32-32s32 14.3 32 32V288zm64 32c-17.7 0-32-14.3-32-32V256c0-17.7 14.3-32 32-32s32 14.3 32 32v32c0 17.7-14.3 32-32 32zm128-32c0 17.7-14.3 32-32 32s-32-14.3-32-32V160c0-17.7 14.3-32 32-32s32 14.3 32 32V288z" />
						</svg>
						<span className="progress-title">PCT Progress</span>
						<span className="progress-pct">{progress.coveredPercent}%</span>
					</button>
					<div className="progress-body">
						<div className="progress-body-inner">
							<div className="progress-sub">
								{progress.coveredMiles} of {progress.total} mi
							</div>
							<div className="progress-regions">
								{progress.regions.map(r => (
									<div className="progress-region" key={r.name}>
										<div className="progress-region-top">
											<span>{r.name}</span>
											<span>{r.percent}%</span>
										</div>
										<div className="progress-bar">
											<div className="progress-bar-fill" style={{ width: `${Math.min(100, r.percent)}%` }} />
										</div>
									</div>
								))}
							</div>
						</div>
					</div>
				</div>
			)}

			{/* NEWSLETTERS */}
			{showNewslettersDialog && <NewsletterDialog open onClose={() => setShowNewslettersDialog(false)} />}

			{/* COOL STUFF */}
			{showCoolStuffDialog && <CoolStuffDialog open map={map} onClick={() => setShowCoolStuffDialog(false)} />}

			{/* LIGHTBOX */}
			{showLightbox && <PhotoLightbox isOpen setIsOpen={setShowLightbox} imageOverride={imageOverride} />}
		</div>
	)
}

// useSearchParams() requires a Suspense boundary under the App Router.
const Page = () => (
	<Suspense>
		<Home />
	</Suspense>
)

export default Page
