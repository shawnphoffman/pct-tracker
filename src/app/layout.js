import './globals.css'
import 'mapbox-gl/dist/mapbox-gl.css'
import { Analytics } from '@vercel/analytics/react'

export const metadata = {
	title: 'PCT Tracker',
	description: '',
}

export default function RootLayout({ children }) {
	return (
		<html lang="en">
			<body>{children}</body>
			<Analytics />
		</html>
	)
}
