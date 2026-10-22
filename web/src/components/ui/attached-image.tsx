import { useState } from 'react'
import { createPortal } from 'react-dom'
import { ATTACHMENT_NAME, imageLine } from '../../../../src/attachments/images.ts'
import { Button } from './controls.tsx'
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

  return (
    <Dialog title={label} className="image-viewer" close={close}>
      {src ? <img src={src} alt={label} /> : <p className="muted">{imageLine({ path })}</p>}
    </Dialog>
  )
}

// The viewer is portaled out so the conversation's caret host never edits it.
export function ImageChip({
  path,
  label,
}: {
  path: string
  label: string
}) {
  const [
    open,
    setOpen,
  ] = useState(false)

  return (
    <>
      <Button
        className="chip image-chip"
        contentEditable={false}
        title="Show image"
        onClick={() => setOpen(true)}
      >
        <Icon name="image" size={13} />
        {label}
      </Button>
      {open && createPortal(
        <ImageViewer path={path} label={label} close={() => setOpen(false)} />,
        document.body,
      )}
    </>
  )
}
