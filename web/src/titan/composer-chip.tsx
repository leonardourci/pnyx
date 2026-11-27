import { readSkillReference } from '#titan/transcripts-skill-reference.ts'
import type { SavedLabelColor } from '#tasks/model.ts'
import { ICON_SIZE, Icon } from '#web-shared/icons.tsx'
import { ImageThumb } from './attached-image.tsx'
import { AttachmentCard } from './attachment-card.tsx'
import { cardChip, CHIP_SPACE, chipText, isPendingImage, type PlacedChip } from './draft.ts'
import { ReferenceBadge } from './reference-badge.tsx'
import { SkillBadge } from './skill-badge.tsx'

function UploadBar({ fraction }: { fraction: number }) {
  return (
    <span className="upload-bar absolute inset-x-0 bottom-0 h-0.5 bg-line">
      <span className="upload-bar-done block h-full bg-blue transition-[width] duration-200" style={{ width: `${fraction * 100}%` }} />
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
  const slot = stored ? <ImageThumb path={chip.value} /> : <Icon name={image ? 'image' : 'file'} size={ICON_SIZE.inline} />
  const label = loading ? <>{chip.name}<UploadBar fraction={progress} /></> : chip.name

  return (
    <span className="draft-card inline-block max-w-full align-middle data-loading:[&_.card-label]:text-muted" data-kind={chip.kind} data-loading={loading || undefined}>
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

const badgeTitle = ({ chip }: { chip: PlacedChip }) => {
  if (chip.kind === 'project') {
    return chip.value
  }

  return chip.kind === 'task' ? 'Open task' : undefined
}

export function ComposerChip({
  chip,
  progress,
  labelColors,
  look,
  open,
  remove,
}: {
  chip: PlacedChip
  progress?: number
  labelColors?: SavedLabelColor[]
  look?: {
    icons: string[]
    tone: string
  }
  open(): void
  remove(): void
}) {
  const skill = chip.kind === 'skill' ? readSkillReference({ value: chip.value }) : undefined
  let token

  if (skill) {
    token = <SkillBadge skill={skill} colors={labelColors} remove={remove} />
  } else if (cardChip({ chip })) {
    token = (
      <DraftCard
        chip={chip}
        progress={progress}
        open={open}
        remove={remove}
      />
    )
  } else {
    token = (
      <ReferenceBadge
        onMouseDown={event => event.preventDefault()}
        icons={look?.icons ?? []}
        className={look?.tone ?? ''}
        data-kind={chip.kind}
        title={badgeTitle({ chip })}
        onClick={open}
      >
        {chipText({ chip })}
      </ReferenceBadge>
    )
  }

  return <>{CHIP_SPACE}{token}{CHIP_SPACE}</>
}
