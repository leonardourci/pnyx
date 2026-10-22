import type { MouseEvent, ReactNode } from 'react'
import { CollapsibleText, Disclosure } from '../components/ui/disclosure.tsx'
import { Icon } from '../components/ui/icon.tsx'
import { Tooltip } from '../components/ui/tooltip.tsx'
import { LINK_ICONS, LinkChip } from './card-links.tsx'
import type { TaskUpdate, UpdateGroup, UpdateKind } from './task-updates.ts'

const KINDS: Record<UpdateKind, {
  icon: string
  label: string
}> = {
  ask: {
    icon: 'you',
    label: 'You asked',
  },
  hydra: {
    icon: 'hydra',
    label: 'Hydra, from its chat reply',
  },
  told: {
    icon: 'send',
    label: 'Hydra told the worker',
  },
  decision: {
    icon: 'decision',
    label: 'Decision',
  },
  status: {
    icon: 'agent',
    label: 'Worker update',
  },
  worker: {
    icon: 'agent',
    label: 'Worker',
  },
  link: {
    icon: 'link',
    label: 'Link',
  },
  created: {
    icon: 'plus',
    label: 'Created',
  },
  moved: {
    icon: 'moved',
    label: 'Moved',
  },
  renamed: {
    icon: 'renamed',
    label: 'Renamed',
  },
  done: {
    icon: 'done',
    label: 'Done',
  },
  plain: {
    icon: 'summary',
    label: 'Update',
  },
}

const stateLabel = ({ state }: { state: string }) =>
  state === 'needs_you' ? 'Needs you' : state.replace(
    /^./,
    c => c.toUpperCase(),
  )

const shortTime = ({ at }: { at: string }) => new Date(at).toLocaleString(
  [],
  {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  },
)

function UpdateIcon({
  kind,
  icon = KINDS[kind].icon,
  label = KINDS[kind].label,
}: {
  kind: UpdateKind
  icon?: string
  label?: string
}) {
  return (
    <Tooltip content={label}>
      <span className={`update-icon update-icon-${kind}`} role="img" aria-label={label}><Icon name={icon} size={14} /></span>
    </Tooltip>
  )
}

// A folded row's summary holds the time as plain text: a summary takes no focusable content.
function UpdateTime({
  at,
  plain,
}: {
  at: string
  plain?: boolean
}) {
  const time = <time dateTime={at} tabIndex={plain ? undefined : 0}>{shortTime({ at })}</time>

  return plain ? time : <Tooltip content={new Date(at).toLocaleString()}>{time}</Tooltip>
}

function UpdateLine({
  kind,
  icon,
  label,
  at,
  plain,
  title,
  children,
}: {
  kind: UpdateKind
  icon?: string
  label?: string
  at?: string
  plain?: boolean
  title?: ReactNode
  children?: ReactNode
}) {
  return (
    <div className="update-line">
      <UpdateIcon kind={kind} icon={icon} label={label} />
      <div className="update-main">
        {at && <UpdateTime at={at} plain={plain} />}
        {title && <div className="update-title">{title}</div>}
        {children}
      </div>
    </div>
  )
}

const linkIcon = ({ update }: { update: TaskUpdate }) => LINK_ICONS[update.link?.kind ?? ''] ?? 'paperclip'

function UpdateTitle({ update }: { update: TaskUpdate }) {
  return update.kind === 'link' && update.link
    ? <>{update.state} <LinkChip link={update.link} expanded={false} /></>
    : <>{stateLabel({ state: update.state })}</>
}

function UpdateText({ update }: { update: TaskUpdate }) {
  return update.note ? <CollapsibleText text={update.note} /> : null
}

function UpdateEntry({ update }: { update: TaskUpdate }) {
  return (
    <UpdateLine
      kind={update.kind}
      icon={update.kind === 'link' ? linkIcon({ update }) : undefined}
      at={update.at}
      title={<UpdateTitle update={update} />}
    ><UpdateText update={update} />
    </UpdateLine>
  )
}

function Answer({ decision }: { decision: NonNullable<TaskUpdate['decision']> }) {
  if (!decision.answer) {
    return <p className="muted">{decision.ask?.to === 'hydra' ? 'Waiting for Hydra' : decision.ask ? 'Waiting for your answer' : 'Waiting for an answer'}</p>
  }

  const you = decision.actor === 'You'

  return (
    <div className="decision-answer">
      <UpdateIcon kind={you ? 'ask' : 'hydra'} label={`Answered by ${you ? 'you' : decision.actor}`} />
      <div className="decision-answer-text">
        {decision.choice && <strong>{decision.choice}</strong>}
        {decision.answer !== decision.choice && <CollapsibleText text={decision.answer} />}
      </div>
    </div>
  )
}

// A structured question: the question leads, then its context, choices and, folded away, the evidence.
function AskParts({
  ask,
  choice,
}: {
  ask: NonNullable<NonNullable<TaskUpdate['decision']>['ask']>
  choice?: string
}) {
  const escalation = ask.escalation

  return (
    <>
      {/* Only Hydra asks the owner directly; everyone else asks Hydra. */}
      {ask.from && <p className="decision-from">{ask.from} asked {ask.from === 'Hydra' ? 'you' : 'Hydra'}</p>}
      {ask.context && <CollapsibleText text={ask.context} />}
      {!!ask.options?.length && (
        <ol className="decision-choices">
          {ask.options.map((
            option,
            i,
          ) => (
            <li key={option.label} aria-current={choice === option.label || undefined}>
              <span>{option.label}</span>
              {ask.recommended === i + 1 && <span className="decision-recommended">Recommended</span>}
              {option.description && <span className="muted"> · {option.description}</span>}
            </li>
          ))}
        </ol>
      )}
      {escalation && (
        <div className="decision-escalation">
          <p className="decision-from">Hydra asked you{escalation.reason ? `: ${escalation.reason}` : ''}</p>
          {escalation.question && <p className="decision-headline">{escalation.question}</p>}
          {escalation.context && <CollapsibleText text={escalation.context} />}
        </div>
      )}
      {ask.details && (
        <Disclosure className="decision-details" title="Details">
          <CollapsibleText text={ask.details} />
        </Disclosure>
      )}
    </>
  )
}

function Decisions({ updates }: { updates: TaskUpdate[] }) {
  const many = updates.length > 1

  return (
    <>
      <UpdateLine kind="decision" at={updates[0]!.at} title={many ? `${updates.length} decisions` : 'Decision'} />
      <ol className="decision-list">
        {updates.map((
          update,
          index,
        ) => update.decision && (
          <li key={update.id}>
            <div className="decision-question">
              {many && <span className="decision-number">{index + 1}</span>}
              {update.decision.ask
                ? <p className="decision-headline">{update.decision.question}</p>
                : <CollapsibleText text={update.decision.question} />}
            </div>
            {update.decision.ask && (
              <AskParts
                ask={update.decision.ask}
                choice={update.decision.choice}
              />
            )}
            <Answer decision={update.decision} />
            {update.decision.reason && <p className="decision-why">{update.decision.reason}</p>}
          </li>
        ))}
      </ol>
    </>
  )
}

function Folded({ group }: { group: UpdateGroup }) {
  const workers = group.type === 'workers'
  const states = [...new Set(group.updates.map(update => stateLabel({ state: update.state })))].join(', ')

  return (
    <Disclosure
      className="update-fold"
      title={(
        <UpdateLine
          kind={workers ? 'status' : 'renamed'}
          label={workers ? 'Worker updates' : 'Card changes'}
          at={group.updates.at(-1)!.at}
          plain
          title={(
            <>
              {group.updates.length} {workers ? 'worker updates' : 'card changes'} <span className="update-states">{states}</span>
              <span className="update-fold-chevron" aria-hidden="true"><Icon name="chevron_right" size={14} /></span>
            </>
          )}
        />
      )}
    >
      {group.updates.map(update => <UpdateEntry key={update.id} update={update} />)}
    </Disclosure>
  )
}

function Moment({ updates }: { updates: TaskUpdate[] }) {
  const [
    first,
    ...rest
  ] = updates

  return (
    <UpdateLine kind={first!.kind} at={first!.at} title={<UpdateTitle update={first!} />}>
      <UpdateText update={first!} />
      {rest.map(update => (
        <div key={update.id} className="update-part">
          <UpdateTitle update={update} />
          {update.note && <span className="muted"> · {update.note}</span>}
        </div>
      ))}
    </UpdateLine>
  )
}

function GroupBody({ group }: { group: UpdateGroup }) {
  const first = group.updates[0]!

  switch (group.type) {
    case 'workers':
    case 'changes': return <Folded group={group} />
    case 'decisions': return <Decisions updates={group.updates} />
    case 'moment': return <Moment updates={group.updates} />
    default: return first.kind === 'decision'
      ? <Decisions updates={group.updates} />
      : group.updates.map(update => <UpdateEntry key={update.id} update={update} />)
  }
}

// A click anywhere in an expandable row opens or closes all of it, never the card; selecting text does neither.
function toggleRow({ event }: { event: MouseEvent<HTMLLIElement> }) {
  const row = event.currentTarget
  const folds = [...row.querySelectorAll<HTMLDetailsElement>('details.update-fold')]
  const more = [...row.querySelectorAll<HTMLButtonElement>('.show-more')]

  if (!folds.length && !more.length && !row.classList.contains('update-decision')) {
    return
  }

  event.stopPropagation()

  if (window.getSelection()?.toString() || (event.target instanceof Element && event.target.closest('a, button, summary'))) {
    return
  }

  const expanded = ({ button }: { button: HTMLButtonElement }) => button.getAttribute('aria-expanded') === 'true'
  const open = folds.length
    ? folds.some(fold => fold.open)
    : more.some(button => expanded({ button }))
  folds.forEach(fold => {
    fold.open = !open
  })
  // Opening a fold shows its text clamped; closing a row also closes any text opened in it.
  const toggled = more.filter(button => open
    ? expanded({ button })
    : !folds.length && !expanded({ button }))
  toggled.forEach(button => button.click())
}

export function UpdateGroupRow({ group }: { group: UpdateGroup }) {
  const decision = group.updates.every(update => update.kind === 'decision')

  return (
    <li className={decision ? 'update-decision' : undefined} onClick={event => toggleRow({ event })}>
      <GroupBody group={group} />
    </li>
  )
}
