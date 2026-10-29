import type { HydraState } from '#app/model.ts'
import type { Card } from '#tasks/model.ts'
import { declaredState } from '#tasks/declarations.ts'
import { unwatchedPullRequests } from '#tasks/delivery/following.ts'
import { taskReadiness } from '#tasks/dependencies.ts'
import { openAsks, askWording } from '#tasks/questions.ts'
import { queuePosition, workerQueue } from '#workers/queue.ts'
import { learningConditions, learningDigest, type LearningConditions } from '#memory/learnings.ts'
import { OWNER_DOCUMENTS, usage, OWNER_MEMORY_BUDGET, HYDRA_MEMORY_BUDGET, type Memory } from '#memory/budgets.ts'
import { hydraConfig } from './config.ts'
import { HYDRA_CARD } from './identity.ts'
import { liveTask, rankOf } from '#tasks/select.ts'
import { describeColumnRule } from '#tasks/columns.ts'
import { helperLeases } from '#routine-helper/state.ts'

export const TEMPLATE_NUDGE = 'Heads dispatch runs on the shipped template rules until `pnyx-axi rule init` copies them into the Pnyx home to edit'

// ponytail: a Hydra with more live tasks lists the first ones by column and rank; page the rest with task list.
const TASK_LIMIT = 40

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
  conditions = learningConditions({ states: { [hydraId]: state } }),
}: {
  hydraId: string
  state: HydraState
  owner: Memory
  projects?: string[]
  setup?: string[]
  now?: string
  conditions?: LearningConditions
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
    ...helperLeases({ state }),
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
