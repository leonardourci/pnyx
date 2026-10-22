import type { CurrentAction } from '../../../src/thread/calls.ts'
import { Icon } from '../components/ui/icon.tsx'
import { LiveLabel } from '../components/ui/live-label.tsx'
import { actionLabel, type ActionLabel } from './action-label.ts'
import { SentencePart } from './messages.tsx'
import type { PnyxLookup } from './pnyx-action.ts'

// A call made before the turn began belongs to the last turn. The slack covers a turn
// start and a transcript line stamped by different processes.
const TURN_SLACK_MS = 5000

const labelKey = ({ value }: { value: ActionLabel }) => `${value.icon}:${value.sentence.map(part => typeof part === 'string' ? part : part.label).join('')}`

// What the agent is running now, after the running dots or in a working card's pill.
// idle is what shows while no call is known yet; without it the bubble stays empty.
export function ActionBubble({
  action,
  since,
  lookup,
  idle,
}: {
  action?: CurrentAction
  since?: string | null
  lookup: PnyxLookup
  idle?: string
}) {
  const turnStart = since ? Date.parse(since) - TURN_SLACK_MS : undefined
  const earlier = turnStart !== undefined && !!action?.at && Date.parse(action.at) < turnStart
  const stale = !action || earlier
  // Bookkeeping calls give no label (undefined), which keeps the one shown.
  const label = stale ? null : actionLabel({
    action,
    lookup,
  })
  const value = label === null && idle ? {
    icon: '',
    sentence: [idle],
  } : label

  return (
    <span className={idle ? 'action-label' : 'action-bubble'}>
      <LiveLabel
        value={value}
        keyOf={labelKey}
        done={!stale && action.done}
        render={({ value: shown }) => (
          <>
            {shown.icon && <Icon name={shown.icon} size={13} />}
            <span className="action-text">
              {shown.sentence.map((
                part,
                index,
              ) => <SentencePart key={index} part={part} />)}
            </span>
          </>
        )}
      />
    </span>
  )
}
