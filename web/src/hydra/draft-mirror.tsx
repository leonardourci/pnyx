import { readSkillReference } from '#hydra/transcripts-skill-reference.ts'
import type { SavedLabelColor } from '#tasks/model.ts'
import { Icon } from '#web-shared/ui/icon.tsx'
import { Fragment,useLayoutEffect,type ReactNode,type RefObject } from 'react'
import { ImageThumb } from './attached-image.tsx'
import { AttachmentCard } from './attachment-card.tsx'
import { cardChip,CHIP_SPACE,draftView,isPendingImage,type PlacedChip } from './draft.ts'
import { ReferenceBadge } from './reference-badge.tsx'
import { SkillBadge } from './skill-badge.tsx'

// React owns the badges; browser edits update only the mirror's plain text and offsets.
export function writeDraftMirror({
  element,
  view,
  paths,
}: {
  element: HTMLDivElement
  view: ReturnType<typeof draftView>
  paths: {
    from: number
    to: number
  }[]
}) {
  element.querySelectorAll<HTMLElement>('[data-draft-gap]').forEach((
    gap,
    index,
  ) => {
    const from = view.chips[index - 1]?.to ?? 0
    const to = view.chips[index]?.from ?? view.display.length
    const parts: Node[] = []
    let at = from

    for (const path of paths.filter(path => path.to > from && path.from < to)) {
      const start = Math.max(
        path.from,
        at,
      )
      const end = Math.min(
        path.to,
        to,
      )
      const marked = document.createElement('span')
      marked.className = 'draft-path'
      marked.textContent = view.display.slice(
        start,
        end,
      )
      parts.push(
        document.createTextNode(view.display.slice(
          at,
          start,
        )),
        marked,
      )
      at = end
    }

    parts.push(document.createTextNode(view.display.slice(
      at,
      to,
    )))
    gap.replaceChildren(...parts)
  })
  element.querySelectorAll<HTMLElement>('.draft-token').forEach((
    token,
    index,
  ) => {
    const chip = view.chips[index]

    if (chip) {
      token.dataset.from = String(chip.from)
      token.dataset.to = String(chip.to)
    }
  })
}

function UploadBar({ fraction }: { fraction: number }) {
  return (
    <span className="upload-bar">
      <span className="upload-bar-done" style={{ width: `${fraction * 100}%` }} />
    </span>
  )
}

function DraftCard({
  chip,
  progress = 0,
  open,
  remove,
}: {
  chip: PlacedChip
  progress?: number
  open(): void
  remove(): void
}) {
  const image = chip.kind === 'image'
  const loading = image && isPendingImage({ path: chip.value })
  const stored = image && !loading
  const slot = stored ? <ImageThumb path={chip.value} /> : <Icon name={image ? 'image' : 'file'} size={13} />
  const label = loading ? <>{chip.name}<UploadBar fraction={progress} /></> : chip.name

  return (
    <span className="draft-chip draft-card" data-kind={chip.kind} data-loading={loading || undefined}>
      {chip.label}
      <AttachmentCard
        keepsInputFocus
        slot={slot}
        label={label}
        title={stored ? 'Show image' : chip.name}
        tone={chip.attached ? undefined : 'reference'}
        open={stored ? open : undefined}
        remove={remove}
        removeLabel={`Remove ${chip.name}`}
      />
    </span>
  )
}

export function DraftMirror({
  view,
  paths,
  uploads,
  labelColors,
  removeCard,
  openChip,
  chipLook,
  mirror,
}: {
  view: ReturnType<typeof draftView>
  paths: {
    from: number
    to: number
  }[]
  uploads: Record<string, number>
  labelColors?: SavedLabelColor[]
  removeCard({ index }: { index: number }): void
  openChip({ index }: { index: number }): void
  chipLook({ chip }: { chip: PlacedChip }): {
    icons: string[]
    tone: string
  }
  mirror: RefObject<HTMLDivElement | null>
}) {
  useLayoutEffect(() => {
    if (mirror.current) {
      writeDraftMirror({
        element: mirror.current,
        view,
        paths,
      })
    }
  })
  const chipOccurrences = new Map<string, number>()

  return (
    <div className="draft-mirror" ref={mirror} aria-hidden="true">
      {view.chips.map((
        chip,
        index,
      ) => {
        const look = chip.kind === 'task' || chip.kind === 'column' ? chipLook({ chip }) : undefined
        const title = chip.kind === 'project' ? chip.value : chip.kind === 'task' ? 'Open task' : undefined
        const identity = JSON.stringify([
          chip.kind,
          chip.attached,
          chip.value,
        ])
        const occurrence = chipOccurrences.get(identity) ?? 0
        chipOccurrences.set(
          identity,
          occurrence + 1,
        )
        const key = JSON.stringify([
          identity,
          occurrence,
        ])

        const skill = chip.kind === 'skill' ? readSkillReference({
          value: chip.value,
        }) : undefined

        let token: ReactNode

        if (skill) {
          token = (
            <SkillBadge
              skill={skill}
              colors={labelColors}
              remove={() => removeCard({ index })}
            />
          )
        } else if (cardChip({ chip })) {
          token = (
            <DraftCard
              chip={chip}
              progress={uploads[chip.value]}
              open={() => openChip({ index })}
              remove={() => removeCard({ index })}
            />
          )
        } else {
          token = (
            <ReferenceBadge
              icons={look?.icons ?? []}
              className={look?.tone ?? ''}
              data-kind={chip.kind}
              title={title}
              onClick={() => openChip({ index })}
            >
              {look ? chip.name : chip.label}
            </ReferenceBadge>
          )
        }

        return (
          <Fragment key={key}>
            <span data-draft-gap={index} />
            <span className="draft-token" data-from={chip.from} data-to={chip.to}>
              {CHIP_SPACE}{token}{CHIP_SPACE}
            </span>
          </Fragment>
        )
      })}
      <span data-draft-gap={view.chips.length} />
      {/* A trailing newline still gets a line box, as it does in the textarea. */}
      {'\u200B'}
    </div>
  )
}
