import { useEffect, useRef, type RefObject, type Dispatch, type SetStateAction } from 'react'
import { flushSync } from 'react-dom'
import { imageLine, imagePaths } from '#titan/images.ts'
import { checkImages, uploadImage } from './image-upload.ts'
import { isPendingImage, pendingImage, placeImages, settleImage, withoutPendingImages } from './draft.ts'
import { selectionEnds, selectionRange } from './composer-editable.ts'
import { rewriteSteps, type Snapshot, type UndoHistory } from './composer-history.ts'

// Placeholders whose upload still runs; a field that mounts on the same text keeps them.
const uploadingImages = new Set<string>()

type Write = ({
  text,
  caret,
  anchor,
}: {
  text: string
  caret: number
  anchor?: number
}) => void

export function useComposerUploads({
  current,
  input,
  composing,
  latestChange,
  history,
  write,
  writeWithoutUndoStep,
  notify,
  setUploads,
}: {
  current: RefObject<string>
  input: RefObject<HTMLDivElement | null>
  composing: RefObject<boolean>
  latestChange: RefObject<({ text }: { text: string }) => void>
  history: RefObject<UndoHistory>
  write: Write
  writeWithoutUndoStep: Write
  notify({ text }: { text: string }): void
  setUploads: Dispatch<SetStateAction<Record<string, number>>>
}) {
  // A placeholder lives only while this field's upload runs, so a restored one goes and leaving stops them.
  const uploading = useRef(new AbortController())
  const ownUploads = useRef(new Set<string>())
  const waitingForComposition = useRef<(() => void)[]>([])
  useEffect(
    () => {
      const controller = new AbortController()
      uploading.current = controller
      const restored = current.current
      const pending = imagePaths({ text: restored }).filter(path => isPendingImage({ path }))
      // While any placeholder still uploads, every one stays; leftovers go on a later mount.
      const orphaned = pending.length > 0 && pending.every(path => !uploadingImages.has(path))

      if (orphaned) {
        writeWithoutUndoStep({
          text: withoutPendingImages({ text: restored }),
          caret: input.current ? selectionEnds({ field: input.current }).focus : 0,
        })
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

    if (composing.current) {
      waitingForComposition.current.push(() => settle({
        path,
        line,
      }))

      return
    }

    const settleIn = ({ snapshot }: { snapshot: Snapshot }) => settleImage({
      ...snapshot,
      path,
      line,
    })
    rewriteSteps({
      history: history.current,
      rewrite: settleIn,
    })
    const ends = input.current ? selectionEnds({ field: input.current }) : {
      anchor: 0,
      focus: 0,
    }
    const settled = settleIn({
      snapshot: {
        text: current.current,
        ...ends,
      },
    })

    // Written before the next keystroke or upload reads the draft and caret.
    if (settled) {
      flushSync(() => writeWithoutUndoStep({
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
    // eslint-disable-next-line othrys/object-params -- React state setter callback contract.
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
      // eslint-disable-next-line othrys/object-params -- React state setter callback contract.
      setUploads(progress => Object.fromEntries(Object.entries(progress)
        .filter(([key]) => key !== path)))
    }
  }

  // Each image takes its place at the caret at once, so typing goes on while it uploads.
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
      caret: input.current ? selectionRange({ field: input.current }).end : undefined,
      lines: placed.map(({ path }) => imageLine({ path })),
    }))
    input.current?.focus()

    // Each upload settles its own placeholder and reports its own failure.
    for (const image of placed) {
      void upload(image)
    }
  }

  const settleAfterComposition = () => {
    const waiting = waitingForComposition.current
    waitingForComposition.current = []

    for (const settleWaiting of waiting) {
      settleWaiting()
    }
  }

  return {
    attach,
    settleAfterComposition,
  }
}
