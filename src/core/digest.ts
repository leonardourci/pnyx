import { describeColumnRule } from './columns.ts'
import { learningDigest, type Learning } from '../memory/learnings.ts'
import { queuePosition, workerQueue } from '../queue/state.ts'
import { HYDRA_CARD, declaredState, hydraConfig, unwatchedPullRequests } from './hydra.ts'
import { liveTask, rankOf } from './tasks.ts'
import { askWording, openAsks } from './asks.ts'
import { HydraError, type Card, type HydraState } from './model.ts'

// Owner memory is Pnyx-wide: the owner's preferences and general learnings, printed in every Hydra's digest.
export const OWNER_MEMORY_BUDGET = 8000
// Hydra memory holds only what this Hydra needs: its scope, where it left off, its check cursor.
export const HYDRA_MEMORY_BUDGET = 1500
// The skill Hydra loads to curate and save its memory before a reset.
export const MEMORY_SKILL = 'inscribe'
export const OWNER_DOCUMENTS = {
  preferences: 'Owner preferences',
  learnings: 'Learnings',
} as const
// The share of a budget past which the digest asks Hydra to curate that memory.
const NEARLY_FULL = 0.8
export const TEMPLATE_NUDGE = 'Heads dispatch runs on the shipped template rules until `pnyx-axi rule init --shared` copies them into the Pnyx home to edit'
// ponytail: a Hydra with more live tasks lists the first ones by column and rank; page the rest with task list.
const TASK_LIMIT = 40

export type Memory = Record<string, {
  text: string
  at: string
  lines?: Learning[]
}>

export const memorySize = ({ memory }: { memory: Memory }) =>
  Object.values(memory).reduce(
    (
      size,
      entry,
    ) => size + entry.text.length,
    0,
  )

// A save over budget is refused unless it shrinks the memory, so curating an overfull memory still works.
export function checkBudget({
  memory,
  key,
  after,
  budget,
  layer,
}: {
  memory: Memory
  key: string
  after: string | null
  budget: number
  layer: string
}): void {
  const used = memorySize({ memory })
  const size = used - (Object.hasOwn(
    memory,
    key,
  ) ? memory[key]!.text.length : 0) + (after?.length ?? 0)

  if (after !== null && size > budget && size > used) {
    throw new HydraError({
      message: `${layer} memory would use ${size} of ${budget} characters`,
      code: 'MEMORY_FULL',
      help: [`Load the ${MEMORY_SKILL} skill: merge, shorten or forget entries, then save again`],
    })
  }
}

const usage = ({
  layer,
  memory,
  budget,
}: {
  layer: string
  memory: Memory
  budget: number
}) => {
  const used = memorySize({ memory })

  return `${layer} memory uses ${used} of ${budget} characters.${used > budget * NEARLY_FULL ? ` Load the ${MEMORY_SKILL} skill and curate it before it fills.` : ''}`
}

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
    ...card.attention.filter(a => a.blocking && !a.answered).map(a => `${a.kind}${a.text ? ` "${clip({
      text: a.text,
      size: 100,
    })}"` : ''}`),
    ...(card.permissions ?? []).filter(p => p.status === 'pending').map(p => `permission ${p.tool}`),
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

export function hydraDigest({
  hydraId,
  state,
  owner,
  projects = [],
  setup = [],
  now = new Date().toISOString(),
}: {
  hydraId: string
  state: HydraState
  owner: Memory
  projects?: string[]
  setup?: string[]
  now?: string
}): string {
  const config = hydraConfig({
    state,
    id: hydraId,
  })
  const titles = new Map(config.columns.map(c => [
    c.id as string,
    c.title,
  ]))
  const done = new Set(config.columns.filter(c => c.role === 'done').map(c => c.id as string))
  const order = new Map(config.columns.map((
    c,
    i,
  ) => [
    c.id as string,
    i,
  ]))
  const tasks = Object.values(state.cards)
    .filter(card => card.id !== HYDRA_CARD && liveTask({ card }))
  const place = ({ card }: { card: Card }) => order.get(card.column) ?? order.size
  const open = tasks.filter(card => !done.has(card.column))
    .sort((
      a,
      b,
    ) => place({ card: a }) - place({ card: b })
      || rankOf({ card: a }) - rankOf({ card: b }))
  const memory = state.hydraMemory ?? {}
  const others = Object.entries(owner).filter(([key]) => !Object.hasOwn(
    OWNER_DOCUMENTS,
    key,
  ))
  const hydra = state.cards[HYDRA_CARD]

  return [
    `<pnyx-digest hydra="${hydraId}" through="${state.seq}">`,
    `Hydra ${hydraId} ("${config.name}") as of event ${state.seq}. \`pnyx-axi hydra check --after ${state.seq} --hydra ${hydraId}\` lists what changed since.`,
    ...(hydra?.attention.some(a => a.blocking && !a.answered) ? [
      `Your own chat waits on: ${hydra.attention.filter(a => a.blocking && !a.answered).map(a => clip({ text: a.text ?? a.kind }))
        .join('; ')}`,
    ] : []),
    ...(setup.length ? [
      '',
      ...setup,
    ] : []),
    '',
    'Columns (id · title · tasks · when):',
    ...config.columns.map(c => `- ${c.id} · ${c.title} · ${tasks.filter(t => t.column === c.id).length} · ${describeColumnRule({ column: c })} · ${clip({ text: c.description ?? 'no description' })}`),
    '',
    'Open tasks (id · title · column · declared status · worker):',
    ...(open.length ? open.slice(
      0,
      TASK_LIMIT,
    ).map(card => taskLine({
      state,
      card,
      column: titles.get(card.column) ?? card.column,
    })) : ['none: no open tasks']),
    ...(open.length > TASK_LIMIT ? [`${open.length - TASK_LIMIT} more open tasks: run \`pnyx-axi task list --hydra ${hydraId}\``] : []),
    ...(tasks.length > open.length ? [`${tasks.length - open.length} done tasks not listed`] : []),
    '',
    ...Object.entries(OWNER_DOCUMENTS).flatMap(([
      key,
      title,
    ]) => [
      `${title} (owner memory key ${key}):`,
      key === 'learnings' && owner[key]?.lines?.length ? learningDigest({
        lines: owner[key]!.lines!,
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
    '',
    'Hydra memory (this Hydra only):',
    ...(Object.keys(memory).length ? Object.entries(memory).map(([
      key,
      entry,
    ]) => `- ${key}: ${entry.text}`) : ['none yet']),
    usage({
      layer: 'Hydra',
      memory,
      budget: HYDRA_MEMORY_BUDGET,
    }),
    ...(projects.length ? [
      '',
      ...projects,
    ] : []),
    '</pnyx-digest>',
  ].join('\n')
}
