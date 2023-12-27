import Lightbox from 'yet-another-react-lightbox'
import 'yet-another-react-lightbox/styles.css'
import NextJsImage from '@/components/NextJsImage'

const images = require.context('@/images/', true, /\.(jpg|jpeg|png)$/i)
const imageList = images.keys().map(image => images(image).default)

export default function PhotoLightbox({ isOpen, setIsOpen, imageOverride }) {
	let index

	if (imageOverride) {
		index = imageList.findIndex(image => image.src.includes(imageOverride.replace(/\.jpg|\.jpeg|\.png/, '')))
	}

	return <Lightbox open={isOpen} index={index} close={() => setIsOpen(false)} slides={imageList} render={{ slide: NextJsImage }} />
}
