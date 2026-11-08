import { createHash } from 'node:crypto'
import type { HydraState } from '#app/model.ts'
import type { Card } from '#tasks/model.ts'
import { declaredState } from '#tasks/declarations.ts'
import { unwatchedPullRequests } from '#tasks/delivery/following.ts'
import { taskReadiness } from '#tasks/dependencies.ts'
import { openAsks, askWording } from '#tasks/ask-state.ts'
import { queuePosition, workerQueue } from '#workers/queue.ts'
import { learningConditions, learningDigest, type LearningConditions } from '#memory/learnings.ts'
import { OWNER_DOCUMENTS, usage, OWNER_MEMORY_BUDGET, HYDRA_MEMORY_BUDGET, type Memory } from '#memory/budgets.ts'
import { hydraConfig } from './config.ts'
import { HYDRA_CARD } from './identity.ts'
import { liveTask, rankOf } from '#tasks/select.ts'
import { helperLeases } from '#routine-helper/state.ts'
import { pendingPermissions } from '#workers/permission-rules.ts'
import { countTokens, ESTIMATED_TOKEN_BYTES } from '#workers/token-count.ts'

export const TEMPLATE_NUDGE = 'Heads dispatch runs on the shipped template rules until `pnyx-axi rule init` saves them in the Pnyx home to edit'

// ponytail: a Hydra with more live tasks lists the first ones by column and rank; page the rest with task list.
const TASK_LIMIT = 40
const OWNER_CONTEXT_TOKENS = 3_000
const DIGEST_HASH_CHARS = 12
const DIGEST_CHECKPOINT_VERSION = 1

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

function taskLine({
  state,
  card,
  column,
}: {
  state: HydraState
  card: Card
  column: string
}): string {
  const status = card.status ? `${declaredState({ declaration: card.status })}${card.status.note ? `: ${clip({
    text: card.status.note,
    size: 100,
  })}` : ''}` : 'no declaration'
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

  if (unwatched.length) {
    lines.push(`  unwatched pull request: ${unwatched.map(l => l.url).join(', ')} (no worker to wake with its news)`)
  }

  return lines.join('\n')
}

function ownerDigest({
  owner,
  conditions,
  now,
}: {
  owner: Memory
  conditions: LearningConditions
  now: string
}): string {
  const others = Object.entries(owner).filter(([key]) => !Object.hasOwn(
    OWNER_DOCUMENTS,
    key,
  ))
  const text = [
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
    ...(others.length ? [
      'Other owner memory:',
      ...others.map(([
        key,
        entry,
      ]) => `- ${key}: ${entry.text}`),
      '',
    ] : []),
    usage({
      layer: 'Owner',
      memory: owner,
      budget: OWNER_MEMORY_BUDGET,
    }),

  ].join('\n')

  if (countTokens({ text }) <= OWNER_CONTEXT_TOKENS) {
    return text
  }

  const notice = [
    '\nOwner memory omitted beyond the context budget.',
    'Read `pnyx-axi owner memory list` before a decision needs an omitted preference or learning.',
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
  hydraId,
  state,
  owner,
  projects,
  setup,
  onlyTasks,
}: {
  hydraId: string
  state: HydraState
  owner: string
  projects: string[]
  setup: string[]
  onlyTasks?: string[]
}): Map<string, string> {
  const config = hydraConfig({
    state,
    id: hydraId,
  })
  const titles = new Map(config.columns.map(column => [
    column.id as string,
    column.title,
  ]))
  const done = new Set(config.columns.filter(column => column.role === 'done').map(column => column.id as string))
  const order = new Map(config.columns.map((
    column,
    index,
  ) => [
    column.id as string,
    index,
  ]))
  const tasks = Object.values(state.cards)
    .filter(card => card.id !== HYDRA_CARD && liveTask({ card }))
    .filter(card => !onlyTasks || onlyTasks.includes(card.id))
  const place = ({ card }: { card: Card }) => order.get(card.column) ?? order.size
  const open = tasks.filter(card => !done.has(card.column)).sort((
    a,
    b,
  ) => place({ card: a }) - place({ card: b }) || rankOf({ card: a }) - rankOf({ card: b }))
  const memory = state.hydraMemory ?? {}
  const hydra = state.cards[HYDRA_CARD]
  const parts = new Map<string, string>()
  const attention = hydra?.attention.filter(item => item.blocking && !item.answered) ?? []
  parts.set(
    'attention',
    attention.length ? `Your own chat waits on: ${attention.map(item => clip({ text: item.text ?? item.kind })).join('; ')}` : 'Your own chat has no pending permission requests.',
  )
  parts.set(
    'setup',
    setup.join('\n') || 'Setup needed: none',
  )
  parts.set(
    'columns',
    [
      'Columns (id · title · tasks · description):',
      ...config.columns.map(column => `- ${column.id} · ${column.title} · ${tasks.filter(task => task.column === column.id).length} · ${clip({ text: column.description ?? 'no description' })}`),
      `Placement rules: \`pnyx-axi column list --hydra ${hydraId}\` when needed.`,
    ].join('\n'),
  )
  parts.set(
    'helper',
    helperLeases({ state }).join('\n'),
  )
  parts.set(
    'tasks',
    'Open tasks (id · title · column · declared status · worker):',
  )

  for (const card of open.slice(
    0,
    TASK_LIMIT,
  )) {
    parts.set(
      `task:${card.id}`,
      taskLine({
        state,
        card,
        column: titles.get(card.column) ?? card.column,
      }),
    )
  }

  if (!open.length) {
    parts.set(
      'empty',
      'none: no open tasks',
    )
  }

  parts.set(
    'more',
    open.length > TASK_LIMIT ? `${open.length - TASK_LIMIT} more open tasks: run \`pnyx-axi task list --hydra ${hydraId}\`` : 'All open tasks are listed.',
  )
  parts.set(
    'done',
    `${tasks.length - open.length} done tasks not listed`,
  )
  parts.set(
    'owner',
    owner,
  )
  parts.set(
    'memory',
    [
      'Hydra memory (this Hydra only):',
      ...Object.entries(memory).map(([
        key,
        entry,
      ]) => `- ${key}: ${entry.text}`),
      usage({
        layer: 'Hydra',
        memory,
        budget: HYDRA_MEMORY_BUDGET,
      }),
    ].join('\n'),
  )
  parts.set(
    'projects',
    projects.join('\n') || 'Attached projects: none',
  )

  if (onlyTasks) {
    for (const key of [
      'attention',
      'setup',
      'columns',
      'more',
      'done',
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
  hydraId,
  through,
}: {
  text?: string
  hydraId: string
  through: number
}): {
  through: number
  parts: Record<string, string>
} | undefined {
  const encoded = text?.match(/^<pnyx-digest\b[^>]* checkpoint="([A-Za-z0-9_-]+)"/)?.[1]

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

  if (!value || typeof value !== 'object' || !('v' in value) || value.v !== DIGEST_CHECKPOINT_VERSION || !('hydra' in value) || value.hydra !== hydraId
    || !('through' in value) || typeof value.through !== 'number' || !Number.isSafeInteger(value.through) || value.through < 0 || value.through > through
    || !('parts' in value) || !value.parts || typeof value.parts !== 'object' || Array.isArray(value.parts)) {
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
    through: value.through,
    parts,
  }
}

export function hydraDigest({
  hydraId,
  state,
  owner,
  projects = [],
  setup = [],
  previousDigest,
  checkpointed = false,
  onlyTasks,
  now = new Date().toISOString(),
  conditions = learningConditions({ states: { [hydraId]: state } }),
}: {
  hydraId: string
  state: HydraState
  owner: Memory
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
    hydraId,
    state,
    owner: ownerDigest({
      owner,
      conditions,
      now,
    }),
    projects,
    setup,
  })
  const before = previousCheckpoint({
    text: previousDigest,
    hydraId,
    through: state.seq,
  })
  const hashes: Record<string, string> = {}
  const changed: string[] = []

  for (const [
    key,
    text,
  ] of parts) {
    let identity = key

    if (key.startsWith('task:')) {
      identity = `task:${digestHash({ text: key.slice('task:'.length) })}`
    }

    let fingerprint = text

    if (key === 'owner') {
      fingerprint += JSON.stringify(owner)
    }

    const hash = digestHash({ text: fingerprint })
    hashes[identity] = hash

    if (text && hash !== before?.parts[identity]) {
      changed.push(text)
    }
  }

  if (before) {
    for (const card of Object.values(state.cards)) {
      const key = `task:${digestHash({ text: card.id })}`

      if (before.parts[key] && !hashes[key]) {
        changed.push(`- ${card.id} is no longer listed in this digest; read task show for its current state.`)
      }
    }
  }

  let checkpoint = ''

  if (checkpointed) {
    const encoded = Buffer.from(JSON.stringify({
      v: DIGEST_CHECKPOINT_VERSION,
      hydra: hydraId,
      through: state.seq,
      parts: hashes,
    })).toString('base64url')
    checkpoint = ` checkpoint="${encoded}"`
  }

  const config = hydraConfig({
    state,
    id: hydraId,
  })
  const checkAfter = before?.through ?? state.seq
  const lines = [
    `<pnyx-digest hydra="${hydraId}" through="${state.seq}"${checkpoint}>`,
    `Hydra ${hydraId} ("${config.name}") as of event ${state.seq}. \`pnyx-axi hydra check --after ${checkAfter} --hydra ${hydraId}\` lists what changed since.`,
  ]

  if (before) {
    lines.push(`Changes since event ${before.through}; unlisted context still applies.`)
  }

  lines.push(
    ...changed,
    '</pnyx-digest>',
  )

  return lines.join('\n\n')
}
