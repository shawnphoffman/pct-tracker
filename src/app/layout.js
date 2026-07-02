import './globals.css'
import 'mapbox-gl/dist/mapbox-gl.css'
import { Analytics } from '@vercel/analytics/react'

export const metadata = {
	metadataBase: new URL(process.env.NEXT_PUBLIC_SITE_URL || 'https://pct-tracker.vercel.app'),
	title: "Madison's PCT Tracker",
	description: "Follow Madison's Pacific Crest Trail hikes on an interactive map — live 2026 progress plus her 2018, 2019, and 2023 tracks.",
	openGraph: {
		title: "Madison's PCT Tracker",
		description: "Follow Madison's Pacific Crest Trail hikes on an interactive map.",
		type: 'website',
	},
	twitter: {
		card: 'summary_large_image',
		title: "Madison's PCT Tracker",
		description: "Follow Madison's Pacific Crest Trail hikes on an interactive map.",
	},
}

export default function RootLayout({ children }) {
	return (
		<html lang="en">
			<body>{children}</body>
			<Analytics />
		</html>
	)
}
