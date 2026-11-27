import { DraftChip, ChipIcon } from './draft-chip.tsx'
import { CHIP_JOIN, ICON_SPACE, skillProjectLabel } from './draft.ts'
import type { SavedLabelColor } from '#tasks/model.ts'
import type { SkillReference } from '#titan/transcripts-skill-reference.ts'
import { skillIcon } from './skill-icons.ts'
import { Button } from '#web-shared/ui/controls.tsx'
import { ICON_SIZE, Icon } from '#web-shared/icons.tsx'
import { Label } from '#web-shared/ui/label.tsx'

export function SkillBadge({
  skill,
  colors,
  remove,
}: {
  skill: SkillReference
  colors?: SavedLabelColor[]
  remove?(): void
}) {
  const icon = skillIcon({ skill })

  return (
    <DraftChip
      className="draft-skill cursor-default! [&_.tooltip-anchor]:inline [&_.task-label]:inline [&_.task-label]:[font:inherit] [&_.task-label]:leading-none [&_.task-label]:whitespace-[inherit] [&_.task-label]:border-0 [&_.task-label]:px-(--spacing-skill-label) [&_.task-label]:py-0 [&_.task-label]:-mx-(--spacing-skill-label) [&_.task-label]:my-0 [&_.task-label]:rounded-preview [&_.task-label]:shadow-skill-label"
      data-kind="skill"
      onMouseDown={event => {
        if (remove) {
          event.preventDefault()
        }
      }}
    >
      <ChipIcon>{ICON_SPACE}<Icon name={icon} size={ICON_SIZE.inline} /></ChipIcon>{CHIP_JOIN}
      {skill.project && (
        <><Label
          project
          label={skill.projectPath ?? skill.project}
          text={skillProjectLabel({ text: skill.project })}
          colors={colors}
        />{CHIP_JOIN}
        </>
      )}
      /{skill.name}{remove && (
        <>
          {CHIP_JOIN}
          <span className="skill-remove-slot relative">
            {ICON_SPACE}
            <Button
              className="skill-remove absolute left-0 top-1/2 -translate-y-1/2 inline-flex align-baseline items-center justify-center size-attachment-icon min-h-0 p-0 border-0 [font:inherit] leading-none text-inherit"
              tabIndex={-1}
              aria-label={`Remove /${skill.name}`}
              onClick={remove}
            >
              <Icon name="close" size={ICON_SIZE.badge} />
            </Button>
          </span>
        </>
      )}
    </DraftChip>
  )
}
