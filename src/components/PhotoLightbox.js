import Lightbox from 'yet-another-react-lightbox'
import Counter from 'yet-another-react-lightbox/plugins/counter'
import NextJsImage from '@/components/NextJsImage'
import 'yet-another-react-lightbox/styles.css'
import 'yet-another-react-lightbox/plugins/counter.css'

// const images = require.context('../images/', true, /\.(jpg|jpeg|png)$/i)
const images = require.context('../images/', true, /\.\/.*\.(jpg|jpeg|png)$/i)
const imageList = images.keys().map(image => images(image).default)

// console.log('length', JSON.stringify(images.keys().sort(), null, 2))

export default function PhotoLightbox({ isOpen, setIsOpen, imageOverride }) {
	let index

	if (imageOverride) {
		index = imageList.findIndex(image => image.src.includes(imageOverride.replace(/\.jpg|\.jpeg|\.png/, '')))
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
