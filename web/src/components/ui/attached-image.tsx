import { useState } from 'react'
import { createPortal } from 'react-dom'
import { ATTACHMENT_NAME, imageLine } from '../../../../src/attachments/images.ts'
import { AttachmentCard } from './attachment-card.tsx'
import { Dialog } from './dialog.tsx'
import { Icon } from './icon.tsx'

// Only images this Hydra stored are served here.
function attachmentSource({ path }: { path: string }) {
  const name = path.split('/').at(-1) ?? ''
  const token = document.querySelector<HTMLMetaElement>('meta[name=pnyx-token]')?.content

  return token && path.includes('/attachments/') && ATTACHMENT_NAME.test(name)
    ? `attachments/${name}?token=${encodeURIComponent(token)}` : undefined
}

// Images another Hydra stored are not served here, so they stay their text line.
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
    <Dialog title={label} className="image-viewer" close={close}>
      {src ? <img src={src} alt={label} /> : <p className="muted">{imageLine({ path })}</p>}
    </Dialog>,
    document.body,
  )
}

// A thumbnail stands in for the image icon; an image this Hydra does not serve keeps the icon.
export function ImageThumb({ path }: { path: string }) {
  const [
    failed,
    setFailed,
  ] = useState(false)
  const src = attachmentSource({ path })

  return src && !failed
    ? (
      <img
        src={src}
        alt=""
        onError={() => setFailed(true)}
      />
    )
    : <Icon name="image" size={13} />
}

// An image in a message is a compact card where the owner placed it; a reference to one is dashed.
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
