import type { CurrentAction } from '#hydra/calls.ts'
import { Icon } from '#web-shared/ui/icon.tsx'
import { LiveLabel } from '#web-shared/ui/live-label.tsx'
import { currentLabel } from './action-label.ts'
import { SentencePart } from './messages.tsx'
import type { PnyxLookup, Segment } from './pnyx-action.ts'

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
    <span className="action-text">
      {value.sentence.map((
        part,
        index,
      ) => <SentencePart key={index} part={part} />)}
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
    <span className={look === 'inline' ? 'action-label' : 'action-bubble'}>
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
