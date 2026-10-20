import { HYDRA_CARD, hydraConfig } from './hydra.ts'
import { liveTask, rankOf } from './tasks.ts'
import type { Card, HydraState } from './model.ts'

// Everything Hydra keeps in memory is printed into every digest, so it shares one budget.
export const MEMORY_BUDGET = 6000
// The skill Hydra loads to curate and save its memory before a reset.
export const MEMORY_SKILL = 'inscribe'
export const MEMORY_DOCUMENTS = { preferences: 'Owner preferences', learnings: 'Learnings' } as const
// The share of the budget past which the digest asks Hydra to curate its memory.
const NEARLY_FULL = 0.8
// ponytail: a Hydra with more live tasks lists the first ones by column and rank; page the rest with task list.
const TASK_LIMIT = 40

export const memorySize = ({ state }: { state: HydraState }) =>
  Object.values(state.hydraMemory ?? {}).reduce((size, entry) => size + entry.text.length, 0)

const clip = ({ text, size = 160 }: { text: string; size?: number }) => {
  const clean = text.replace(/\s+/g, ' ').trim()

  return clean.length > size ? `${clean.slice(0, size - 1)}…` : clean
}

function taskLine({ state, card, column }: {
  state: HydraState
  card: Card
  column: string
}): string {
  const status = card.status ? `${card.status.state}${card.status.note ? `: ${clip({ text: card.status.note, size: 100 })}` : ''}` : 'no declaration'
  const session = card.sessionIds?.[0] ? state.sessions?.[card.sessionIds[0]] : undefined
  const activity = card.sessionActivity ?? card.activity
  const worker = card.agent
    ? `${card.agent.provider} ${activity ?? 'idle'}${session?.lastSeen ? `, seen ${session.lastSeen}` : ''}`
    : 'no worker'
  const waiting = [
    ...card.attention.filter(a => a.blocking && !a.answered).map(a => `${a.kind}${a.text ? ` "${clip({ text: a.text, size: 100 })}"` : ''}`),
    ...(card.permissions ?? []).filter(p => p.status === 'pending').map(p => `permission ${p.tool}`),
  ]

  return [
    `- ${card.id} · ${clip({ text: card.title, size: 80 })} · ${column} · ${status} · ${worker}${card.parentId ? ` · under ${card.parentId}` : ''}`,
    ...(waiting.length ? [`  waiting: ${waiting.join('; ')}`] : []),
  ].join('\n')
}

// What Hydra knows at the start of a session, after compaction and with each wake.
export function hydraDigest({ hydraId, state }: { hydraId: string; state: HydraState }): string {
  const config = hydraConfig({ state, id: hydraId })
  const titles = new Map(config.columns.map(c => [c.id as string, c.title]))
  const done = new Set(config.columns.filter(c => c.role === 'done').map(c => c.id as string))
  const order = new Map(config.columns.map((c, i) => [c.id as string, i]))
  const tasks = Object.values(state.cards)
    .filter(card => card.id !== HYDRA_CARD && liveTask({ card }))
  const place = ({ card }: { card: Card }) => order.get(card.column) ?? order.size
  const open = tasks.filter(card => !done.has(card.column))
    .sort((a, b) => place({ card: a }) - place({ card: b })
      || rankOf({ card: a }) - rankOf({ card: b }))
  const memory = state.hydraMemory ?? {}
  const others = Object.entries(memory).filter(([key]) => !Object.hasOwn(MEMORY_DOCUMENTS, key))
  const hydra = state.cards[HYDRA_CARD]

  return [
    `<pnyx-digest hydra="${hydraId}" through="${state.seq}">`,
    `Hydra ${hydraId} ("${config.name}") as of event ${state.seq}. \`pnyx-axi hydra check --after ${state.seq} --hydra ${hydraId}\` lists what changed since.`,
    ...(hydra?.attention.some(a => a.blocking && !a.answered) ? [`Your own chat waits on: ${hydra.attention.filter(a => a.blocking && !a.answered).map(a => clip({ text: a.text ?? a.kind }))
      .join('; ')}`] : []),
    '',
    'Columns (id · title · tasks · when):',
    ...config.columns.map(c => `- ${c.id} · ${c.title} · ${tasks.filter(t => t.column === c.id).length} · ${clip({ text: c.description ?? 'no description' })}`),
    '',
    'Open tasks (id · title · column · declared status · worker):',
    ...(open.length ? open.slice(0, TASK_LIMIT).map(card => taskLine({ state, card, column: titles.get(card.column) ?? card.column })) : ['none: no open tasks']),
    ...(open.length > TASK_LIMIT ? [`${open.length - TASK_LIMIT} more open tasks: run \`pnyx-axi task list --hydra ${hydraId}\``] : []),
    ...(tasks.length > open.length ? [`${tasks.length - open.length} done tasks not listed`] : []),
    '',
    ...Object.entries(MEMORY_DOCUMENTS).flatMap(([key, title]) => [`${title} (memory key ${key}):`, memory[key]?.text ?? 'none yet', '']),
    ...(others.length ? ['Other memory:', ...others.map(([key, entry]) => `- ${key}: ${entry.text}`), ''] : []),
    `Memory uses ${memorySize({ state })} of ${MEMORY_BUDGET} characters.${memorySize({ state }) > MEMORY_BUDGET * NEARLY_FULL ? ` Load the ${MEMORY_SKILL} skill and curate it before it fills.` : ''}`,
    '</pnyx-digest>',
  ].join('\n')
}
