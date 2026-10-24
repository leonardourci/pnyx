import { CHIP_JOIN, ICON_SPACE, skillProjectLabel } from '../../hydra/draft.ts'
import type { SavedLabelColor } from '../../../../src/core/model.ts'
import type { SkillReference } from '../../../../src/thread/skill-reference.ts'
import { Button } from './controls.tsx'
import { Icon } from './icon.tsx'
import { Label } from './label.tsx'

export function SkillBadge({
  skill,
  colors,
  remove,
}: {
  skill: SkillReference
  colors?: SavedLabelColor[]
  remove(): void
}) {
  return (
    <span className="draft-chip reference draft-skill" data-kind="skill" onMouseDown={event => event.preventDefault()}>
      <span className="chip-icon">{ICON_SPACE}<Icon name="star" size={14} /></span>{CHIP_JOIN}
      {skill.project && (
        <><Label
          project
          label={skill.projectPath ?? skill.project}
          text={skillProjectLabel({ text: skill.project })}
          colors={colors}
        />{CHIP_JOIN}
        </>
      )}
      /{skill.name}{CHIP_JOIN}
      <span className="skill-remove-slot">
        {ICON_SPACE}
        <Button
          className="skill-remove"
          tabIndex={-1}
          aria-label={`Remove /${skill.name}`}
          onClick={remove}
        >
          <Icon name="close" size={12} />
        </Button>
      </span>
    </span>
  )
}
