import Lightbox from 'yet-another-react-lightbox'
import Counter from 'yet-another-react-lightbox/plugins/counter'
import NextJsImage from '@/components/NextJsImage'
import 'yet-another-react-lightbox/styles.css'
import 'yet-another-react-lightbox/plugins/counter.css'
import photos from '@/data/photos.json'

// Slides carry the R2 object key (== photos.json filename); NextJsImage resolves
// the URL via the CDN loader.
const imageList = photos.features.map(photo => ({ src: photo.properties.filename }))

export default function PhotoLightbox({ isOpen, setIsOpen, imageOverride }) {
	let index

	if (imageOverride) {
		const key = imageOverride.replace(/\.jpg|\.jpeg|\.png/, '')
		index = imageList.findIndex(slide => slide.src.includes(key))
	}

	return (
		<Lightbox
			open={isOpen}
			index={index}
			close={() => setIsOpen(false)}
			slides={imageList}
			render={{ slide: NextJsImage }}
			plugins={[Counter]}
		/>
	)
}
