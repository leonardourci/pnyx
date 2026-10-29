import { useState } from 'react'
import { createPortal } from 'react-dom'
import { ATTACHMENT_NAME, imageLine, imageType, shownImageNames } from '#hydra/images.ts'
import { AttachmentCard } from './attachment-card.tsx'
import { Dialog } from '#web-shared/ui/dialog.tsx'
import { Button } from '#web-shared/ui/controls.tsx'
import { CopyButton } from '#web-shared/ui/copy-button.tsx'
import { Icon } from '#web-shared/ui/icon.tsx'
import { CHIP_SOURCE } from './message-selection.ts'

// A Hydra serves its stored attachments and the images inside its task copies; any other path has no source.
function attachmentSource({ path }: { path: string }) {
  const served = /\/(?:hydras|boards)\/([a-z0-9][a-z0-9._-]{0,63})\/(attachments\/[^/]+|copies\/.+)$/.exec(path)
  const token = document.querySelector<HTMLMetaElement>('meta[name=pnyx-token]')?.content
  const route = served?.[2]
  const stored = route?.startsWith('attachments/') && ATTACHMENT_NAME.test(route.slice('attachments/'.length))
  const copied = route?.startsWith('copies/') && imageType({ path: route })
    && !route.split('/').some(part => part === '.' || part === '..')

  // Cached chat can render while navigation still has the previous Hydra's base URL.
  return token && route && (stored || copied)
    ? `/hydra/${encodeURIComponent(served[1]!)}/${route.split('/').map(encodeURIComponent)
      .join('/')}?token=${encodeURIComponent(token)}`
    : undefined
}

export function AttachedImage({ path }: { path: string }) {
  const [
    failed,
    setFailed,
  ] = useState(false)
  const src = attachmentSource({ path })

  if (failed || !src) {
    return <>{imageLine({ path })}</>
  }

  return (
    <a
      className="attached-image"
      href={src}
      target="_blank"
      rel="noreferrer noopener"
      contentEditable={false}
    >
      <img src={src} alt="Attached image" onError={() => setFailed(true)} />
    </a>
  )
}

// An image that no longer loads leaves only its chip in the sentence.
function MessageImage({
  path,
  src,
  name,
}: {
  path: string
  src: string
  name: string
}) {
  const [
    failed,
    setFailed,
  ] = useState(false)
  const [
    open,
    setOpen,
  ] = useState(false)

  if (failed) {
    return null
  }

  return (
    <figure className="message-image" {...{ [CHIP_SOURCE]: imageLine({ path }) }}>
      <Button className="message-image-open" title="Show image" onClick={() => setOpen(true)}>
        <img src={src} alt={name} onError={() => setFailed(true)} />
      </Button>
      <figcaption>{name}</figcaption>
      {open && <ImageViewer path={path} label={name} close={() => setOpen(false)} />}
    </figure>
  )
}

// The chip keeps the image's place in the sentence; the image itself shows under the text, named like its chip.
export function MessageImages({ text }: { text: string }) {
  const stored = [...shownImageNames({ text })].flatMap(([
    path,
    name,
  ]) => {
    const src = attachmentSource({ path })

    return src ? [
      {
        path,
        src,
        name,
      },
    ] : []
  })

  if (!stored.length) {
    return null
  }

  return (
    <div className="message-images" contentEditable={false}>
      {stored.map(image => <MessageImage key={image.path} {...image} />)}
    </div>
  )
}

// Every clipboard takes PNG, so another format is redrawn as PNG; an animated GIF keeps its first frame.
async function asPng({ blob }: { blob: Blob }) {
  if (blob.type === 'image/png') {
    return blob
  }

  const bitmap = await createImageBitmap(blob)
  const canvas = new OffscreenCanvas(
    bitmap.width,
    bitmap.height,
  )
  canvas.getContext('2d')?.drawImage(
    bitmap,
    0,
    0,
  )

  return canvas.convertToBlob({ type: 'image/png' })
}

async function pngOf({ src }: { src: string }) {
  const response = await fetch(src)

  return asPng({ blob: await response.blob() })
}

// Safari only accepts a clipboard item made during the click, so the image arrives as a promise inside it.
const copyImage = ({ src }: { src: string }) => navigator.clipboard.write([new ClipboardItem({ 'image/png': pngOf({ src }) })])

// An image already on the page, as PNG data a copied selection can embed; nothing loads it for the copy.
export function shownImageData({ path }: { path: string }) {
  const src = attachmentSource({ path })
  const shown = [...document.images].find(image => image.getAttribute('src') === src && image.complete
    && image.naturalWidth > 0)

  if (!shown) {
    return undefined
  }

  const canvas = document.createElement('canvas')
  canvas.width = shown.naturalWidth
  canvas.height = shown.naturalHeight
  canvas.getContext('2d')?.drawImage(
    shown,
    0,
    0,
  )

  return canvas.toDataURL('image/png')
}

// The viewer is portaled out so the conversation's caret host never edits it.
export function ImageViewer({
  path,
  label,
  close,
}: {
  path: string
  label: string
  close(): void
}) {
  const src = attachmentSource({ path })

  return createPortal(
    <Dialog
      title={label}
      className="image-viewer"
      actions={src && <CopyButton label="Copy image" write={() => copyImage({ src })} />}
      close={close}
    >
      {src ? <img src={src} alt={label} /> : <p className="muted">{imageLine({ path })}</p>}
    </Dialog>,
    document.body,
  )
}

// The icon holds the slot until the thumbnail has arrived, so a slow download never leaves it blank.
export function ImageThumb({ path }: { path: string }) {
  const [
    failed,
    setFailed,
  ] = useState(false)
  const [
    loaded,
    setLoaded,
  ] = useState(false)
  const src = attachmentSource({ path })

  if (!src || failed) {
    return <Icon name="image" size={13} />
  }

  return (
    <>
      {!loaded && <Icon name="image" size={13} />}
      <img
        src={src}
        alt=""
        data-loading={!loaded || undefined}
        onLoad={() => setLoaded(true)}
        onError={() => setFailed(true)}
      />
    </>
  )
}

export function ImageChip({
  path,
  label,
  reference = false,
}: {
  path: string
  label: string
  reference?: boolean
}) {
  const [
    open,
    setOpen,
  ] = useState(false)

  return (
    <>
      <AttachmentCard
        slot={<ImageThumb path={path} />}
        label={label}
        title="Show image"
        tone={reference ? 'reference' : undefined}
        open={() => setOpen(true)}
      />
      {open && <ImageViewer path={path} label={label} close={() => setOpen(false)} />}
    </>
  )
}
