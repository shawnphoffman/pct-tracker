import Image from 'next/image'

// Photos are served from an external CDN (Cloudflare R2) to keep image
// bandwidth off Vercel. See docs/photos.md. Objects are pre-sized by the
// migration script, so the loader just resolves the object URL.
const photoBase = process.env.NEXT_PUBLIC_PHOTO_CDN
const r2Loader = ({ src }) => `${photoBase}/${encodeURIComponent(src)}`

export default function NextJsImage({ slide, rect }) {
	return (
		<div style={{ position: 'relative', width: rect.width, height: rect.height }}>
			<Image
				loader={r2Loader}
				fill
				alt=""
				src={slide.src}
				loading="eager"
				draggable={false}
				sizes="100vw"
				style={{ objectFit: 'contain' }}
			/>
		</div>
	)
}
