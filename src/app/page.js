'use client'
import { useRef, useEffect, useState } from 'react'
import mapboxgl from 'mapbox-gl'
import 'mapbox-gl/dist/mapbox-gl.css'

mapboxgl.accessToken = process.env.NEXT_PUBLIC_MAPBOX_ACCESS_TOKEN

const Home = () => {
	const mapContainer = useRef(null)
	const map = useRef(null)
	const [lng, setLng] = useState(-121.577)
	const [lat, setLat] = useState(41.369)
	const [zoom, setZoom] = useState(4.75)

	useEffect(() => {
		if (map.current) return // initialize map only once
		map.current = new mapboxgl.Map({
			container: mapContainer.current,
			style: process.env.NEXT_PUBLIC_MAPBOX_STYLE,
			center: [lng, lat],
			zoom: zoom,
		})
	})

	return (
		<div>
			<div ref={mapContainer} className="map-container" />
		</div>
	)
}

export default Home
