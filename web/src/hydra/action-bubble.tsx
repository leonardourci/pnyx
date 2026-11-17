import { Icon } from '#web-shared/ui/icon.tsx'
import { ColumnChip } from '#web-tasks/column-chip.tsx'
import { TaskReference } from '#web-tasks/task-reference.tsx'
import { columnLook } from '#web-tasks/view.ts'
import type { CurrentAction } from '#hydra/calls.ts'
import { LiveLabel } from '#web-shared/ui/live-label.tsx'
import { currentLabel } from './action-label.ts'
import type { PnyxLookup,Segment } from './pnyx-action.ts'

interface Shown {
  icon?: string
  sentence: Segment[]
  done: boolean
}

const shownKey = ({ value }: { value: Shown }) => {
  const words = value.sentence.map(part => typeof part === 'string' ? part : part.label)

  return `${value.icon}:${words.join('')}`
}

const ShownLabel = ({ value }: { value: Shown }) => (
  <>
    {value.icon && <Icon name={value.icon} size={13} />}
    <span className="action-text flex items-center gap-1 min-w-0 overflow-hidden">
      {value.sentence.map((
        part,
        index,
      ) => {
        const className = typeof part === 'string' ? 'action-words flex-[0_1_auto] min-w-0 truncate'
          : 'action-reference flex-[1_1_38%] min-w-action-reference max-w-[55%] [&_.button.task-reference]:inline-flex [&_.button.task-reference]:items-center [&_.button.task-reference]:w-full [&_.button.task-reference]:min-w-0 [&_.task-reference_.reference]:inline-flex [&_.task-reference_.reference]:items-center [&_.task-reference_.reference]:min-w-0 [&_.task-reference_.reference]:max-w-full [&_.task-reference_.reference]:m-0 [&_.task-reference_.reference]:py-0 [&_.task-reference-space]:hidden [&_.chip-icon]:shrink-0 [&_.task-reference-title]:min-w-0 [&_.task-reference-title]:truncate'

        return <span key={index} className={className}><SentencePart part={part} /></span>
      })}
    </span>
  </>
)

const idleLabel = ({ idle }: { idle?: string }): Shown | undefined => {
  if (idle === undefined) {
    return undefined
  }

  return {
    sentence: [idle],
    done: false,
  }
}

// A bubble after the running dots, or inline words inside a working card's pill, where idle shows until a call is known.
export function ActionBubble({
  action,
  since,
  lookup,
  look = 'bubble',
  idle,
}: {
  action?: CurrentAction
  since?: string | null
  lookup: PnyxLookup
  look?: 'bubble' | 'inline'
  idle?: string
}) {
  const label = currentLabel({
    action,
    since,
    lookup,
  })
  const done = !!action?.done
  const value = label ? {
    ...label,
    done,
  } : label

  return (
    <span
      className={look === 'inline' ? 'action-label inline-flex min-w-0'
        : 'action-bubble inline-flex items-center flex-[0_1_auto] w-max min-w-0 max-w-action h-5.5 py-0 px-2 border border-line rounded-full bg-background text-ink font-medium empty:hidden [&_svg]:text-muted [&_img]:text-muted'}
    >
      <LiveLabel<Shown>
        value={value}
        fallback={idleLabel({ idle })}
        keyOf={shownKey}
        render={ShownLabel}
        dimmed={({ value: shown }) => shown.done}
      />
    </span>
  )
}

export function SentencePart({ part }: { part: Segment }) {
  if (typeof part === 'string') {
    return part
  }

  if ('column' in part) {
    return <ColumnChip {...columnLook({ column: part.column })} label={part.label} />
  }

  return (
    // A click on the chip opens the task without folding the row.
    <span onClick={event => event.preventDefault()}>
      <TaskReference id={part.task}>{part.label}</TaskReference>
    </span>
  )
}
