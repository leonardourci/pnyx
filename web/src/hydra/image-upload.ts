import { MAX_IMAGE_BYTES, imageExtension } from '#hydra/images.ts'

// Office apps put a picture of copied text next to the text itself; the text wins.
export const pastedImages = ({ clipboardData }: { clipboardData: DataTransfer }) =>
  clipboardData.types.includes('text/plain') ? [] : [...clipboardData.files]

// The files Pnyx can add as images, and why each other one can't be added.
export function checkImages({ files }: { files: File[] }) {
  const images = files.filter(file => imageExtension({ type: file.type }))
  const unsupported = images.length < files.length ? ['Only PNG, JPEG, GIF and WebP images can be added here.'] : []
  const large = images.filter(file => file.size > MAX_IMAGE_BYTES)

  return {
    images: images.filter(file => file.size <= MAX_IMAGE_BYTES),
    failures: [
      ...unsupported,
      ...large.map(file => `${file.name || 'An image'} is over ${MAX_IMAGE_BYTES / 1024 / 1024} MB.`),
    ],
  }
}

// XMLHttpRequest, because fetch reports no upload progress.
export function uploadImage({
  file,
  progress,
}: {
  file: File
  progress?({ fraction }: { fraction: number }): void
}) {
  const token = document.querySelector<HTMLMetaElement>('meta[name=pnyx-token]')?.content ?? ''
  const failed = `Could not add ${file.name || 'an image'}.`

  return new Promise<string>((
    resolve,
    reject,
  ) => {
    const request = new XMLHttpRequest()
    request.open(
      'POST',
      'attachments',
    )
    request.setRequestHeader(
      'authorization',
      `Bearer ${token}`,
    )
    request.setRequestHeader(
      'content-type',
      file.type,
    )
    request.upload.addEventListener(
      'progress',
      event => {
        if (event.lengthComputable) {
          progress?.({ fraction: event.loaded / event.total })
        }
      },
    )
    request.addEventListener(
      'load',
      () => {
        let body: {
          line?: string
          error?: string
        } = {}

        try {
          body = JSON.parse(request.responseText) as typeof body
        } catch { /* A body that isn't JSON falls through to the generic error below. */ }

        if (request.status >= 200 && request.status < 300 && body.line) {
          resolve(body.line)
        } else {
          reject(new Error(body.error ?? failed))
        }
      },
    )
    request.addEventListener(
      'error',
      () => reject(new Error(failed)),
    )
    request.send(file)
  })
}

export async function uploadImages({ files }: { files: File[] }) {
  const {
    images,
    failures,
  } = checkImages({ files })
  const uploads = await Promise.allSettled(images.map(file => uploadImage({ file })))

  return {
    lines: uploads.flatMap(upload => upload.status === 'fulfilled' ? [upload.value] : []),
    failures: [
      ...failures,
      ...uploads.flatMap(upload => upload.status === 'rejected'
        ? [(upload.reason as Error).message] : []),
    ],
  }
}
