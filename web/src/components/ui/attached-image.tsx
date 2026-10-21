import { useState } from 'react'
import { ATTACHMENT_NAME, imageLine } from '../../../../src/attachments/images.ts'

// Images another Hydra stored are not served here, so they stay their text line.
export function AttachedImage({ path }: { path: string }) {
  const [
    failed,
    setFailed,
  ] = useState(false)
  const name = path.split('/').at(-1) ?? ''
  const token = document.querySelector<HTMLMetaElement>('meta[name=pnyx-token]')?.content

  if (failed || !token || !path.includes('/attachments/') || !ATTACHMENT_NAME.test(name)) {
    return <>{imageLine({ path })}</>
  }

  const src = `attachments/${name}?token=${encodeURIComponent(token)}`

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
