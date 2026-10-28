import { MAX_IMAGE_BYTES, imageExtension } from '../../../src/hydra/images.ts'

// Office apps put a picture of copied text next to the text itself; the text wins.
export const pastedImages = ({ clipboardData }: { clipboardData: DataTransfer }) =>
  clipboardData.types.includes('text/plain') ? [] : [...clipboardData.files]

export async function uploadImages({ files }: { files: File[] }) {
  const images = files.filter(file => imageExtension({ type: file.type }))
  const token = document.querySelector<HTMLMetaElement>('meta[name=pnyx-token]')?.content ?? ''
  const unsupported = 'Only PNG, JPEG, GIF and WebP images can be added here.'
  const failures = images.length < files.length ? [unsupported] : []
  const uploads = await Promise.allSettled(images.map(async file => {
    if (file.size > MAX_IMAGE_BYTES) {
      throw new Error(`${file.name || 'An image'} is over ${MAX_IMAGE_BYTES / 1024 / 1024} MB.`)
    }

    const response = await fetch(
      'attachments',
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': file.type,
        },
        body: file,
      },
    )
    let body: {
      line?: string
      error?: string
    } = {}

    try {
      body = await response.json() as typeof body
    } catch { /* A body that isn't JSON falls through to the generic error below. */ }

    if (!response.ok || !body.line) {
      throw new Error(body.error ?? `Could not add ${file.name || 'an image'}.`)
    }

    return body.line
  }))

  return {
    lines: uploads.flatMap(upload => upload.status === 'fulfilled' ? [upload.value] : []),
    failures: [
      ...failures,
      ...uploads.flatMap(upload => upload.status === 'rejected'
        ? [(upload.reason as Error).message] : []),
    ],
  }
}
