import Image from 'next/image'
import { isImageFitCover, isImageSlide, useLightboxProps } from 'yet-another-react-lightbox'

// TODO Add caption lookup

const gumletLoader = ({ src, width, quality }) => {
	return `https://pct-tracker.gumlet.io/${src}?q=${quality || 75}`
}

// function isNextJsImage(slide) {
// 	return isImageSlide(slide) && typeof slide.width === 'number' && typeof slide.height === 'number'
// }

export default function NextJsImage({ slide, rect }) {
	const { imageFit } = useLightboxProps().carousel
	const cover = isImageSlide(slide) && isImageFitCover(slide, imageFit)

	// console.log('slide', slide)

	// if (!isNextJsImage(slide)) return undefined

	const width = !cover ? Math.round(Math.min(rect.width, (rect.height / slide.height) * slide.width)) : rect.width

	const height = !cover ? Math.round(Math.min(rect.height, (rect.width / slide.width) * slide.height)) : rect.height

	return (
		<div style={{ position: 'relative', width, height }}>
			<Image
				loader={gumletLoader}
				// fill
				width={500}
				height={500}
				alt=""
				src={slide}
				loading="eager"
				draggable={false}
				placeholder={slide.blurDataURL ? 'blur' : undefined}
				style={{ objectFit: cover ? 'cover' : 'contain' }}
				sizes={`${Math.ceil((width / window.innerWidth) * 100)}vw`}
			/>
		</div>
	)
}

/*


  import Image from 'next/image'

  const gumletLoader = ({ src, width, quality }) => {
    return https://pct-tracker.gumlet.io/src?w=width&q=quality || 75}
  }

  const MyImage = (props) => {
    return (
      <Image
        loader={gumletLoader}
        src="/me.png"
        alt="Picture of the author"
        width={500}
        height={500}
      />
     )
    }
*/
