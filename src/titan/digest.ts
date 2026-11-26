import { createHash } from 'node:crypto'
import { OWNER_CONTEXT_TOKENS } from './context-limits.ts'
import type { TitanState } from '#app/model.ts'
import type { Card } from '#tasks/model.ts'
import { unwatchedPullRequests } from '#tasks/delivery/following.ts'
import { taskReadiness } from '#tasks/dependencies.ts'
import { openAsks, askWording } from '#tasks/ask-state.ts'
import { queuePosition, workerQueue } from '#workers/queue.ts'
import { learningConditions, learningDigest, type LearningConditions } from '#memory/learnings.ts'
import { OWNER_DOCUMENTS, usage, OWNER_MEMORY_BUDGET, TITAN_MEMORY_BUDGET, type Memory } from '#memory/budgets.ts'
import { titanConfig } from './config.ts'
import { TITAN_CARD } from './identity.ts'
import { taskProjectGroup } from '#tasks/order.ts'
import { projectGroup } from '#projects/groups.ts'
import { cardStatus, currentState } from '#tasks/card-status.ts'
import { liveTask, rankOf, taskDone } from '#tasks/select.ts'
import { helperLeases } from '#routine-helper/state.ts'
import { pendingPermissions } from '#workers/permission-rules.ts'
import { countTokens, ESTIMATED_TOKEN_BYTES } from '#workers/token-count.ts'

export const TEMPLATE_NUDGE = 'Titan dispatch uses the shipped template until you save rules in Settings'

const TASK_LIMIT = 40
const DIGEST_HASH_CHARS = 12
const DIGEST_CHECKPOINT_VERSION = 2
const PENDING_CARD = '-'.repeat(DIGEST_HASH_CHARS)

export const clip = ({
  text,
  size = 160,
}: {
  text: string
  size?: number
}) => {
  const clean = text.replace(
    /\s+/g,
    ' ',
  ).trim()

  return clean.length > size ? `${clean.slice(
    0,
    size - 1,
  )}…` : clean
}

const latestOwnerMessage = ({ card }: { card: Card }) =>
  card.replies?.findLast(reply => reply.worker && reply.text?.trim())

function taskLine({
  state,
  card,
  column,
}: {
  state: TitanState
  card: Card
  column: string
}): string {
  const status = cardStatus({
    card,
    cards: state.cards,
    sessions: state.sessions,
  }).text
  const latest = currentState({
    card,
    workerOnly: true,
  })
  const ownerMessage = latestOwnerMessage({ card })
  const helperOutcome = state.helper?.outcomes.findLast(outcome => outcome.task === card.id)
  const session = card.sessionIds?.[0] ? state.sessions?.[card.sessionIds[0]] : undefined
  const activity = card.sessionActivity ?? card.activity
  const worker = card.agent
    ? `${card.agent.provider} ${activity ?? 'idle'}${session?.lastSeen ? `, seen ${session.lastSeen}` : ''}`
    : 'no worker'
  const unwatched = unwatchedPullRequests({ card })
  const waiting = [
    ...taskReadiness({
      state,
      card,
    }).unmet.map(item => `${item.title} (${item.id}): ${item.reason}`),
    ...card.attention.filter(a => a.blocking && !a.answered).map(a => `${a.kind}${a.text ? ` "${clip({
      text: a.text,
      size: 100,
    })}"` : ''}`),
    ...pendingPermissions({ card }).map(p => `permission ${p.tool}`),
    ...openAsks({ card }).map(ask => `question ${ask.id} to ${ask.audience === 'owner' ? 'the owner' : 'you'} "${clip({
      text: askWording({ ask }).question,
      size: 100,
    })}"`),
  ]

  const lines = [
    `- ${card.id} · ${clip({
      text: card.title,
      size: 80,
    })} · ${column} · ${status} · ${worker}${card.parentId ? ` · under ${card.parentId}` : ''}`,
    ...(card.queue ? [
      `  queue: next for ${card.queue.session}, position ${queuePosition({
        state,
        card,
      })?.position}`,
    ] : []),
    ...(card.sessionIds?.[0] ? [
      `  next tasks: ${workerQueue({
        state,
        session: card.sessionIds[0],
      }).map(c => c.id)
        .join(', ') || 'none'}`,
    ] : []),
    ...(card.hold ? [`  held for discussion: ${card.hold.reason}`] : []),
    ...(card.queueNote ? [`  handoff: ${card.queueNote}`] : []),
    ...(waiting.length ? [`  waiting: ${waiting.join('; ')}`] : []),
  ]

  if (ownerMessage?.text) {
    lines.push(`  owner: ${clip({ text: ownerMessage.text })}`)
  }

  if (latest) {
    lines.push(`  latest: ${clip({
      text: latest.text,
      size: 160,
    })}`)
  }

  if (helperOutcome) {
    lines.push(`helper: ${clip({ text: helperOutcome.summary })}`)
  }

  if (unwatched.length) {
    lines.push(`  unwatched pull request: ${unwatched.map(l => l.url).join(', ')} (no worker to wake with its news)`)
  }

  for (const link of card.links) {
    const details = [
      link.title,
      link.state,
      link.draft ? 'draft' : '',
      link.checks,
    ].filter(Boolean).join(', ')
    lines.push(`link: ${link.url}${details ? ` (${details})` : ''}`)
  }

  return lines.map(line => line.trim()).join(' · ')
}

function ownerDigest({
  owner,
  ownerWrite,
  conditions,
  now,
}: {
  owner: Memory
  ownerWrite: Memory
  conditions: LearningConditions
  now: string
}): string {
  const others = Object.entries(owner).filter(([key]) => key !== 'workers' && !Object.hasOwn(
    OWNER_DOCUMENTS,
    key,
  ))
  const text = [
    usage({
      layer: 'Owner',
      memory: ownerWrite,
      budget: OWNER_MEMORY_BUDGET,
    }),
    '',
    ...Object.entries(OWNER_DOCUMENTS).flatMap(([
      key,
      title,
    ]) => [
      `${title} (owner memory key ${key}):`,
      key === 'learnings' && owner[key]?.lines?.length ? learningDigest({
        lines: owner[key]!.lines!,
        conditions,
        now,
      }) : owner[key]?.text ?? 'none yet',
      '',
    ]),
    ...(owner.workers ? [
      'Standing worker instructions (owner memory key workers):',
      owner.workers.text,
      '',
    ] : []),
    ...(others.length ? [
      'Other owner memory:',
      ...others.map(([
        key,
        entry,
      ]) => `- ${key}: ${entry.text}`),
      '',
    ] : []),
  ].join('\n')

  if (countTokens({ text }) <= OWNER_CONTEXT_TOKENS) {
    return text
  }

  const notice = [
    '\nOwner memory omitted beyond the context budget.',
    'Read owner/memory.jsonl and the assigned owner/poleis/<polis>/memory.jsonl under OTHRYS_HOME before a decision needs an omitted preference or learning.',
  ].join(' ')
  const encoder = new TextEncoder()
  const budgetBytes = OWNER_CONTEXT_TOKENS * ESTIMATED_TOKEN_BYTES
  const bytes = budgetBytes - encoder.encode(notice).length - ESTIMATED_TOKEN_BYTES
  const prefix = new TextDecoder().decode(
    encoder.encode(text).subarray(
      0,
      bytes,
    ),
    { stream: true },
  )

  const complete = prefix.slice(
    0,
    Math.max(
      0,
      prefix.lastIndexOf('\n'),
    ),
  )

  return complete + notice
}

function digestParts({
  state,
  owner,
  projects,
  setup,
  onlyTasks,
}: {
  state: TitanState
  owner: string
  projects: string[]
  setup: string[]
  onlyTasks?: string[]
}): Map<string, string> {
  const projectOrder = [
    'ideas',
    ...(state.projects ?? []).map(project => projectGroup({ project }).id),
  ]
  const tasks = Object.values(state.cards)
    .filter(card => card.id !== TITAN_CARD && liveTask({ card }))
    .filter(card => !onlyTasks || onlyTasks.includes(card.id))

  const place = ({ card }: { card: Card }) => {
    const position = projectOrder.indexOf(taskProjectGroup({
      state,
      card,
    }))

    return position < 0 ? projectOrder.length : position
  }

  const open = tasks.filter(card => !taskDone({
    state,
    card,
  }))
  const ordered = tasks.sort((
    a,
    b,
  ) => place({ card: a }) - place({ card: b }) || rankOf({ card: a }) - rankOf({ card: b }))
  const memory = state.titanMemory ?? {}
  const titan = state.cards[TITAN_CARD]
  const parts = new Map<string, string>()
  let setupText = setup.join('\n')
  let projectText = projects.join('\n')

  if (!setupText.length) {
    setupText = 'Setup needed: none'
  }

  if (!projectText.length) {
    projectText = 'Attached projects: none'
  }

  const attention = titan?.attention.filter(item => item.blocking && !item.answered) ?? []
  parts.set(
    'attention',
    attention.length ? `Your own chat waits on: ${attention.map(item => clip({ text: item.text ?? item.kind })).join('; ')}` : 'Your own chat has no pending permission requests.',
  )
  parts.set(
    'setup',
    setupText,
  )
  const groups = new Map([
    [
      'ideas',
      'Ideas',
    ],
  ])

  for (const project of state.projects ?? []) {
    const group = projectGroup({ project })

    if (!project.detached || tasks.some(card => card.project === project.path)) {
      groups.set(
        group.id,
        group.name,
      )
    }
  }

  for (const card of tasks) {
    const group = taskProjectGroup({
      state,
      card,
    })

    if (!groups.has(group)) {
      groups.set(
        group,
        group,
      )
    }
  }

  parts.set(
    'columns',
    [
      'Project columns (id · name · needs you / running / waiting / done):',
      ...[...groups].map(([
        id,
        name,
      ]) => {
        const members = tasks.filter(card => taskProjectGroup({
          state,
          card,
        }) === id)
        const counts = {
          asks: 0,
          working: 0,
          waiting: 0,
          done: 0,
        }

        for (const card of members) {
          const status = cardStatus({
            card,
            cards: state.cards,
            sessions: state.sessions,
          }).kind

          if (status === 'asks') {
            counts.asks++
          } else if (status === 'working') {
            counts.working++
          } else if (taskDone({
            state,
            card,
          })) {
            counts.done++
          } else {
            counts.waiting++
          }
        }

        return `- ${id} · ${name} · ${counts.asks} / ${counts.working} / ${counts.waiting} / ${counts.done}`
      }),
      'Counts include sub-tasks. Read titan.log or use the UI for project grouping and task order.',
    ].join('\n'),
  )
  parts.set(
    'helper',
    helperLeases({ state }).join('\n'),
  )
  const totals = new Map<string, number>()

  for (const card of open) {
    const status = cardStatus({
      card,
      cards: state.cards,
      sessions: state.sessions,
    })
    const label = status.text
    totals.set(
      label,
      (totals.get(label) ?? 0) + 1,
    )
  }

  let totalText = [...totals].map(([
    status,
    count,
  ]) => `${count} ${status}`).join(', ')

  if (!totals.size) {
    totalText = 'none'
  }

  parts.set(
    'totals',
    `Open cards: ${totalText}`,
  )

  for (const card of ordered) {
    parts.set(
      `task:${card.id}`,
      taskLine({
        state,
        card,
        column: groups.get(taskProjectGroup({
          state,
          card,
        })) ?? card.project ?? 'Ideas',
      }),
    )
  }

  parts.set(
    'owner',
    owner,
  )
  parts.set(
    'memory',
    [
      'Titan memory (this Titan only):',
      ...Object.entries(memory).map(([
        key,
        entry,
      ]) => `- ${key}: ${entry.text}`),
      usage({
        layer: 'Titan',
        memory,
        budget: TITAN_MEMORY_BUDGET,
      }),
    ].join('\n'),
  )
  parts.set(
    'projects',
    projectText,
  )

  if (onlyTasks) {
    for (const key of [
      'attention',
      'setup',
      'columns',
      'memory',
      'projects',
    ]) {
      parts.delete(key)
    }

    parts.set(
      'scope',
      `Granted task context only: ${onlyTasks.join(', ')}. Other tasks are omitted.`,
    )
  }

  return parts
}

function digestHash({ text }: { text: string }): string {
  return createHash('sha256').update(text)
    .digest('base64url')
    .slice(
      0,
      DIGEST_HASH_CHARS,
    )
}

function previousCheckpoint({
  text,
  titanId,
}: {
  text?: string
  titanId: string
}): {
  parts: Record<string, string>
} | undefined {
  const encoded = text?.match(/^<othrys-digest\b[^>]* checkpoint="([A-Za-z0-9_-]+)"/)?.[1]

  if (!encoded) {
    return
  }

  let value: unknown

  try {
    value = JSON.parse(Buffer.from(
      encoded,
      'base64url',
    ).toString('utf8'))
  } catch (error) {
    if (error instanceof SyntaxError) {
      return
    }

    throw error
  }

  if (!value || typeof value !== 'object') {
    return
  }

  if (!('v' in value) || value.v !== DIGEST_CHECKPOINT_VERSION) {
    return
  }

  if (!('titan' in value) || value.titan !== titanId) {
    return
  }

  if (!('parts' in value) || !value.parts || typeof value.parts !== 'object' || Array.isArray(value.parts)) {
    return
  }

  const parts: Record<string, string> = {}

  for (const [
    key,
    hash,
  ] of Object.entries(value.parts)) {
    if (typeof hash !== 'string' || !new RegExp(`^[A-Za-z0-9_-]{${DIGEST_HASH_CHARS}}$`).test(hash)) {
      return
    }

    parts[key] = hash
  }

  return {
    parts,
  }
}

export function titanDigest({
  titanId,
  records,
  state,
  owner,
  ownerWrite = owner,
  projects = [],
  setup = [],
  previousDigest,
  checkpointed = false,
  onlyTasks,
  now = new Date().toISOString(),
  conditions = learningConditions({ states: { [titanId]: state } }),
}: {
  titanId: string
  records: string
  state: TitanState
  owner: Memory
  ownerWrite?: Memory
  projects?: string[]
  setup?: string[]
  previousDigest?: string
  checkpointed?: boolean
  onlyTasks?: string[]
  now?: string
  conditions?: LearningConditions
}): string {
  const parts = digestParts({
    onlyTasks,
    state,
    owner: ownerDigest({
      owner,
      ownerWrite,
      conditions,
      now,
    }),
    projects,
    setup,
  })
  const checkpointBefore = previousCheckpoint({
    text: previousDigest,
    titanId,
  })
  const before = checkpointBefore?.parts.totals ? checkpointBefore : undefined
  const hashes: Record<string, string> = {}
  const changed: string[] = []
  const cards: string[] = []
  let omitted = 0

  for (const [
    key,
    text,
  ] of parts) {
    const card = key.startsWith('task:') ? state.cards[key.slice('task:'.length)] : undefined
    const identity = card ? `task:${digestHash({ text: card.id })}` : key
    let fingerprint = text

    if (key === 'owner') {
      fingerprint += JSON.stringify(owner)
    }

    if (card) {
      const ownerMessage = latestOwnerMessage({ card })

      if (ownerMessage) {
        fingerprint += ownerMessage.id
      }
    }

    const hash = digestHash({ text: fingerprint })
    const previousHash = before?.parts[identity]

    if (card) {
      if (!previousHash && taskDone({
        state,
        card,
      })) {
        continue
      }

      if (before && hash !== previousHash && cards.length >= TASK_LIMIT) {
        hashes[identity] = previousHash ?? PENDING_CARD
        omitted++
        continue
      }

      if (hash !== previousHash) {
        cards.push(text)
      }
    } else if (text && hash !== previousHash && key !== 'totals') {
      changed.push(text)
    }

    hashes[identity] = hash
  }

  if (before) {
    for (const card of Object.values(state.cards)) {
      if (onlyTasks && !onlyTasks.includes(card.id)) {
        continue
      }

      const key = `task:${digestHash({ text: card.id })}`

      if (before.parts[key] && !parts.has(`task:${card.id}`)) {
        if (cards.length >= TASK_LIMIT) {
          hashes[key] = before.parts[key]
          omitted++
        } else {
          cards.push(`- ${card.id} is no longer listed in this digest; read its task.log for its current state.`)
        }
      }
    }
  }

  let checkpoint = ''

  if (checkpointed) {
    const encoded = Buffer.from(JSON.stringify({
      v: DIGEST_CHECKPOINT_VERSION,
      titan: titanId,
      parts: hashes,
    })).toString('base64url')
    checkpoint = ` checkpoint="${encoded}"`
  }

  const config = titanConfig({
    state,
    id: titanId,
  })
  const lines = [
    `<othrys-digest titan="${titanId}"${checkpoint}>`,
    `Titan ${titanId} ("${config.name}"). ${records}`,
  ]

  if (before) {
    lines.push('Changes since your previous digest; unlisted context still applies.')
  }

  lines.push(
    before ? 'Task cards (changed since your last turn):' : 'Task cards (all open cards):',
    ...cards,
    parts.get('totals') ?? 'Open cards: none',
  )

  if (omitted) {
    lines.push(`${omitted} more changed cards. Read their task.log files for details.`)
  }

  lines.push(
    ...changed,
    '</othrys-digest>',
  )

  return lines.join('\n\n')
}
