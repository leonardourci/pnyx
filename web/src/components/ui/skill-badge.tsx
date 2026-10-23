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
      <span className="chip-icon"><Icon name="star" size={14} /></span>
      {skill.project && (
        <><Label
          project
          label={skill.projectPath ?? skill.project}
          text={skill.project}
          colors={colors}
        />{' '}
        </>
      )}
      /{skill.name}
      <Button
        className="skill-remove"
        tabIndex={-1}
        aria-label={`Remove /${skill.name}`}
        onClick={remove}
      >
        <Icon name="close" size={12} />
      </Button>
    </span>
  )
}
