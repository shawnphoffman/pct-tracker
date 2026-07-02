'use client'
import { useRef, useEffect, useState, useCallback, Suspense } from 'react'
import mapboxgl from 'mapbox-gl'

import { useSearchParams } from 'next/navigation'
import dynamic from 'next/dynamic'

import EyeToggle from '@/components/EyeToggle'
import ColorCircle from '@/components/ColorCircle'
import CustomControl from '@/components/CustomControl'

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
	color: 'hsl(28, 100%, 52%)',
}

// Pin marker for Madison's most recent (delay-safe) position. Path is the
// FontAwesome location-dot (same shape as the old LocationDot component).
// viewBox is padded (path spans 0..384 / 0..512) so the thick outline stroke
// isn't clipped at the top curve and bottom tip.
const PIN_SVG = `<svg viewBox="-40 -40 464 592" overflow="visible" xmlns="http://www.w3.org/2000/svg"><path d="M215.7 499.2C267 435 384 279.4 384 192C384 86 298 0 192 0S0 86 0 192c0 87.4 117 243 168.3 307.2c12.3 15.3 35.1 15.3 47.4 0zM192 128a64 64 0 1 1 0 128 64 64 0 1 1 0-128z"/></svg>`

// Human-friendly "how long ago" for the latest-position popup. In production the
// underlying fix is already >=3 days old (safety delay).
const relativeTime = iso => {
	const ms = iso ? Date.now() - Date.parse(iso) : NaN
	if (!Number.isFinite(ms) || ms < 0) return 'recently'
	const days = Math.floor(ms / 86400000)
	if (days >= 1) return `${days} day${days > 1 ? 's' : ''} ago`
	const hours = Math.max(1, Math.floor(ms / 3600000))
	return `${hours} hour${hours > 1 ? 's' : ''} ago`
}

// Photos are only enabled once an external image CDN (Cloudflare R2) is
// configured. Until then the feature stays fully off so it can't touch the
// Vercel image budget. See docs/photos.md.
const photosEnabled = !!process.env.NEXT_PUBLIC_PHOTO_CDN

const Home = () => {
	const mapContainer = useRef(null)
	const map = useRef(null)
	const latestMarker = useRef(null)
	const [showNewslettersDialog, setShowNewslettersDialog] = useState(false)
	const [showNewslettersLayer, setShowNewslettersLayer] = useState(true)
	const [showCoolStuffDialog, setShowCoolStuffDialog] = useState(false)
	const [showPhotosLayer, setShowPhotosLayer] = useState(true)
	const [show26, setShow26] = useState(true)
	const [show23, setShow23] = useState(true)
	const [show19, setShow19] = useState(false)
	const [show18, setShow18] = useState(true)
	const [showLightbox, setShowLightbox] = useState(false)
	const [imageOverride, setImageOverride] = useState(null)
	const searchParams = useSearchParams()

	const isDebug = !!searchParams.get('debug')

	useEffect(() => {
		if (showLightbox === false) {
			setImageOverride(null)
		}
	}, [showLightbox])

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
			.addControl(controlNewsletter, 'top-left')
			.addControl(buttonReset, 'top-right')

		if (photosEnabled) {
			map.current.addControl(controlPhotos, 'top-left')
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
					if (!layer.id.includes('2019')) {
						map.current.setLayoutProperty(layer.id, 'visibility', 'visible')
					}
					const color = layer.paint['line-color']
					const yearKey = layer.id.slice(-2)
					document.documentElement.style.setProperty(`--color-${yearKey}`, color)
				}
			})

			// Add newsletter source and layer
			const newsletterSource = 'newsletter-points'
			map.current.addSource(newsletterSource, {
				type: 'vector',
				url: 'mapbox://shawnhoffman.cln29xsgu00fw2noxeyy2w94s-9r9pg',
			})
			map.current.addLayer(
				{
					id: 'newsletter-points',
					source: newsletterSource,
					'source-layer': 'PCT_-_Madison_-_2023_-_Newslette',
					type: 'circle',
					layout: {
						// visibility: 'visible',
						visibility: showNewslettersLayer ? 'visible' : 'none',
					},
					minzoom: 4.5,
					paint: {
						'circle-radius': ['step', ['zoom'], 2, 5, 4, 8, 5],
						'circle-color': 'hsl(60, 99%, 43%)',
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
					'source-layer': 'PCT_-_Madison_-_2023_-_Newslette',
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

			fetch(track2026.url)
				.then(r => r.json())
				.then(geo => {
					if (!map.current) return
					map.current.getSource(track2026.source)?.setData(geo)

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
						.setPopup(
							new mapboxgl.Popup({ offset: 28, className: 'popup' }).setHTML(
								`<div class="latest-popup"><strong>Madison was here</strong><span>${relativeTime(latest.properties.time)}</span></div>`
							)
						)
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
								'circle-color': 'hsl(190, 100%, 50%)',
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
	}, [isDebug, showNewslettersLayer, showPhotosLayer, show26])

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
					<button className={`mapboxgl-ctrl-year year-visible-${show23} year-23`} onClick={() => toggleLayer(Layers.Madi2023, setShow23)}>
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
