import { useEffect, useRef, type RefObject, type Dispatch, type SetStateAction } from 'react'
import { flushSync } from 'react-dom'
import { imageLine, imagePaths } from '#hydra/images.ts'
import { checkImages, uploadImage } from './image-upload.ts'
import { isPendingImage, pendingImage, placeImages, settleImage, withoutPendingImages } from './draft.ts'
import { selectionEnds } from './composer-caret.ts'

const uploadingImages = new Set<string>()

export function useComposerUploads({
  current,
  input,
  caretLast,
  latestChange,
  write,
  notify,
  setUploads,
}: {
  current: RefObject<string>
  input: RefObject<HTMLTextAreaElement | null>
  caretLast: RefObject<number>
  latestChange: RefObject<({ text }: { text: string }) => void>
  write({
    text,
    caret,
    anchor,
  }: {
    text: string
    caret: number
    anchor?: number
  }): void
  notify({ text }: { text: string }): void
  setUploads: Dispatch<SetStateAction<Record<string, number>>>
}) {
  // A placeholder lives only while this field's upload runs, so a restored one goes and leaving stops them.
  const uploading = useRef(new AbortController())
  const ownUploads = useRef(new Set<string>())
  useEffect(
    () => {
      const controller = new AbortController()
      uploading.current = controller
      const restored = current.current
      const pending = imagePaths({ text: restored }).filter(path => isPendingImage({ path }))
      // While any placeholder still uploads, every one stays; leftovers go on a later mount.
      const orphaned = pending.length > 0 && pending.every(path => !uploadingImages.has(path))

      if (orphaned) {
        latestChange.current({ text: withoutPendingImages({ text: restored }) })
      }

      // Leaving stops this field's uploads; their placeholders go too, so no draft keeps waiting for them.
      return () => {
        controller.abort()

        if (ownUploads.current.size) {
          latestChange.current({
            text: withoutPendingImages({
              text: current.current,
              paths: ownUploads.current,
            }),
          })
        }
      }
    },
    [],
  )

  const settle = ({
    path,
    line,
  }: {
    path: string
    line?: string
  }) => {
    if (uploading.current.signal.aborted) {
      return
    }

    const ends = input.current ? selectionEnds({ field: input.current }) : {
      anchor: caretLast.current,
      focus: caretLast.current,
    }
    const settled = settleImage({
      text: current.current,
      ...ends,
      path,
      line,
    })

    // Written before the next keystroke or upload reads the draft and caret.
    if (settled) {
      flushSync(() => write({
        text: settled.text,
        caret: settled.focus,
        anchor: settled.anchor,
      }))
    }
  }

  const upload = async ({
    file,
    path,
  }: {
    file: File
    path: string
  }) => {
    const { signal } = uploading.current
    uploadingImages.add(path)
    ownUploads.current.add(path)
    // eslint-disable-next-line pnyx/object-params -- React state setter callback contract.
    const track = ({ fraction }: { fraction: number }) => setUploads(progress => ({
      ...progress,
      [path]: fraction,
    }))

    track({ fraction: 0 })

    try {
      settle({
        path,
        line: await uploadImage({
          file,
          progress: track,
          signal,
        }),
      })
    } catch (error) {
      if (signal.aborted) {
        return
      }

      settle({ path })
      notify({ text: error instanceof Error ? error.message : 'Could not add the image.' })
    } finally {
      uploadingImages.delete(path)
      ownUploads.current.delete(path)
      // eslint-disable-next-line pnyx/object-params -- React state setter callback contract.
      setUploads(progress => Object.fromEntries(Object.entries(progress)
        .filter(([key]) => key !== path)))
    }
  }

  const attach = ({ files }: { files: File[] }) => {
    const {
      images,
      failures,
    } = checkImages({ files })

    if (failures.length) {
      notify({ text: failures.join(' ') })
    }

    if (!images.length) {
      return
    }

    const placed = images.map(file => ({
      file,
      path: pendingImage({ id: crypto.randomUUID() }),
    }))
    write(placeImages({
      text: current.current,
      caret: input.current?.selectionEnd,
      lines: placed.map(({ path }) => imageLine({ path })),
    }))
    input.current?.focus()

    for (const image of placed) {
      void upload(image)
    }
  }

  return attach
}
