import { useState } from 'react'
import { createPortal } from 'react-dom'
import { ATTACHMENT_NAME, imageLine, imageNames } from '#hydra/images.ts'
import { AttachmentCard } from './attachment-card.tsx'
import { Dialog } from '#web-shared/ui/dialog.tsx'
import { Icon } from '#web-shared/ui/icon.tsx'

function attachmentSource({ path }: { path: string }) {
  const stored = /\/(?:hydras|boards)\/([a-z0-9][a-z0-9._-]{0,63})\/attachments\/([^/]+)$/i.exec(path)
  const token = document.querySelector<HTMLMetaElement>('meta[name=pnyx-token]')?.content

  // Cached chat can render while navigation still has the previous Hydra's base URL.
  return token && stored && ATTACHMENT_NAME.test(stored[2]!)
    ? `/hydra/${encodeURIComponent(stored[1]!)}/attachments/${stored[2]}?token=${encodeURIComponent(token)}` : undefined
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

// The chip keeps the image's place in the sentence; the image itself shows under the text, named like its chip.
export function MessageImages({ text }: { text: string }) {
  const stored = [...imageNames({ text })].filter(([path]) => attachmentSource({ path }))

  if (!stored.length) {
    return null
  }

  return (
    <div className="message-images">
      {stored.map(([
        path,
        name,
      ]) => (
        <figure key={path} className="message-image">
          <AttachedImage path={path} />
          <figcaption>{name}</figcaption>
        </figure>
      ))}
    </div>
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
