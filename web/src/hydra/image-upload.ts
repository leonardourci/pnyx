import { MAX_IMAGE_BYTES, imageExtension } from '../../../src/attachments/images.ts'

// The server stores each image and answers with the line that carries it in a message.
export async function uploadImages({ files }: { files: File[] }) {
  const images = files.filter(file => imageExtension({ type: file.type }))
  const token = document.querySelector<HTMLMetaElement>('meta[name=pnyx-token]')?.content ?? ''
  const failures = images.length < files.length ? ['Only PNG, JPEG, GIF and WebP images can be added here.'] : []
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
    const body = await response.json().catch(() => ({})) as {
      line?: string
      error?: string
    }

    if (!response.ok || !body.line) {
      throw new Error(body.error ?? `Could not add ${file.name || 'an image'}.`)
    }

    return body.line
  }))

  return {
    lines: uploads.flatMap(upload => upload.status === 'fulfilled' ? [upload.value] : []),
    failures: [
      ...failures,
      ...uploads.flatMap(upload => upload.status === 'rejected' ? [(upload.reason as Error).message] : []),
    ],
  }
}
