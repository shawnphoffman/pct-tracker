import { ImageResponse } from 'next/og'

// Branded preview image for shared links (auto-wired into OG + Twitter tags).
export const runtime = 'edge'
export const alt = "Madison's PCT Tracker"
export const size = { width: 1200, height: 630 }
export const contentType = 'image/png'

export default function OpengraphImage() {
	return new ImageResponse(
		(
			<div
				style={{
					width: '100%',
					height: '100%',
					display: 'flex',
					flexDirection: 'column',
					alignItems: 'center',
					justifyContent: 'center',
					background: 'linear-gradient(135deg, #1f6f43 0%, #2f9e60 60%, #f97316 100%)',
					color: '#fff',
					fontFamily: 'sans-serif',
				}}
			>
				<div style={{ fontSize: 72, fontWeight: 800, letterSpacing: -1 }}>Madison&apos;s PCT Tracker</div>
				<div style={{ fontSize: 34, marginTop: 16, opacity: 0.92 }}>Following the Pacific Crest Trail · 2018 – 2026</div>
			</div>
		),
		{ ...size }
	)
}
