import { readSkillReference } from '#hydra/transcripts-skill-reference.ts'
import type { SavedLabelColor } from '#tasks/model.ts'
import { Icon } from '#web-shared/ui/icon.tsx'
import type { ReactNode } from 'react'
import { Fragment,type Ref } from 'react'
import { ImageThumb } from './attached-image.tsx'
import { AttachmentCard } from './attachment-card.tsx'
import { cardChip,CHIP_SPACE,draftView,isPendingImage,type PlacedChip } from './draft.ts'
import { ReferenceBadge } from './reference-badge.tsx'
import { SkillBadge } from './skill-badge.tsx'

export function markedPaths({
  display,
  from,
  to,
  paths,
}: {
  display: string
  from: number
  to: number
  paths: {
    from: number
    to: number
  }[]
}): ReactNode[] {
  const parts: ReactNode[] = []
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
    parts.push(
      display.slice(
        at,
        start,
      ),
      <span key={start} className="draft-path">{display.slice(
        start,
        end,
      )}
      </span>,
    )
    at = end
  }

  parts.push(display.slice(
    at,
    to,
  ))

  return parts
}

function UploadBar({ fraction }: { fraction: number }) {
  return (
    <span className="upload-bar">
      <span className="upload-bar-done" style={{ width: `${fraction * 100}%` }} />
    </span>
  )
}

export function DraftCard({
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
  display,
  paths,
  uploads,
  labelColors,
  removeCard,
  openChip,
  chipLook,
  mirror,
}: {
  view: ReturnType<typeof draftView>
  display: string
  paths: {
    from: number
    to: number
  }[]
  uploads: Record<string, number>
  labelColors?: SavedLabelColor[]
  removeCard({ chip }: { chip: PlacedChip }): void
  openChip({ chip }: { chip: PlacedChip }): void
  chipLook({ chip }: { chip: PlacedChip }): {
    icons: string[]
    tone: string
  }
  mirror: Ref<HTMLDivElement>
}) {
  const chipOccurrences = new Map<string, number>()

  return (
    <div className="draft-mirror" ref={mirror} aria-hidden="true">
      {view.chips.map((
        chip,
        index,
      ) => {
        const look = chip.kind === 'task' || chip.kind === 'column' ? chipLook({ chip }) : undefined
        const title = chip.kind === 'project' ? chip.value : chip.kind === 'task' ? 'Open task' : undefined
        const before = markedPaths({
          display,
          from: view.chips[index - 1]?.to ?? 0,
          to: chip.from,
          paths,
        })
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
              remove={() => removeCard({ chip })}
            />
          )
        } else if (cardChip({ chip })) {
          token = (
            <DraftCard
              chip={chip}
              progress={uploads[chip.value]}
              open={() => openChip({ chip })}
              remove={() => removeCard({ chip })}
            />
          )
        } else {
          token = (
            <ReferenceBadge
              icons={look?.icons ?? []}
              className={look?.tone ?? ''}
              data-kind={chip.kind}
              title={title}
              onClick={() => openChip({ chip })}
            >
              {look ? chip.name : chip.label}
            </ReferenceBadge>
          )
        }

        return (
          <Fragment key={key}>
            {before}
            <span className="draft-token" data-from={chip.from} data-to={chip.to}>
              {CHIP_SPACE}{token}{CHIP_SPACE}
            </span>
          </Fragment>
        )
      })}
      {markedPaths({
        display,
        from: view.chips.at(-1)?.to ?? 0,
        to: display.length,
        paths,
      })}
      {/* A trailing newline still gets a line box, as it does in the textarea. */}
      {'\u200B'}
    </div>
  )
}
