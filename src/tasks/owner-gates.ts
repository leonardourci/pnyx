import { requestId } from '#workers/answers.ts'
import type { Ask, Card } from './model.ts'
import type { Attention } from '#workers/model.ts'
import { INTERRUPTED } from '#workers/session-attachments.ts'
import { PERMISSION_PREFIX, pendingPermissions } from '#workers/permission-rules.ts'
import { openAsks } from './ask-state.ts'

export interface Blocker {
  reason: string
  clear: string
}

const waitingAttention = ({ card }: { card: Card }) =>
  card.attention.filter(a => a.key !== INTERRUPTED && a.blocking && !a.answered)

export function ownerGates({ card }: { card: Card }): string[] {
  return [
    ...waitingAttention({ card }).map(a => `attention:${requestId({ request: a })}`),
    ...pendingPermissions({ card }).map(p => `permission:${p.id}`),
    ...(card.asks ?? []).filter(a => a.audience === 'owner' && !a.answered && !a.closed).map(a => `ask:${a.id}`),
  ]
}

const QUESTION_CHOICES: Record<NonNullable<Ask['kind']>, string> = {
  go: 'Go|Hold',
  merge: 'Merge|Hold',
}

export function goQuestionCommand({ task }: { task: string }): string {
  return `pnyx-axi task ask ${task} --to owner --kind go --question "<go question?>" --context "<what Go changes>. [Card](pnyx-task:${encodeURIComponent(task)})"`
}

export function holdBlocker({
  task,
  reason,
}: {
  task: string
  reason: string
}): Blocker {
  return {
    reason: `held for discussion: ${reason}`,
    clear: `Ask the owner with \`${goQuestionCommand({ task })}\`, or once they give the go, run \`pnyx-axi task release ${task} --from-message <owner-message-id> --reason "<why>"\``,
  }
}

function promptBlocker({
  card,
  prompt,
}: {
  card: Card
  prompt: Attention
}): Blocker {
  const id = requestId({ request: prompt })
  const detail = prompt.text ? `: ${prompt.text}` : ''

  return {
    reason: `waiting for an answer to the worker's ${prompt.kind} ${id}${detail}`,
    clear: `Run \`pnyx-axi reply ${card.id} --answer ${prompt.key} --json '<answer>' --seen ${id}\``,
  }
}

function askBlocker({
  card,
  ask,
}: {
  card: Card
  ask: Ask
}): Blocker {
  const owner = ask.audience === 'owner'
  const choice = ask.kind ? ` --choice ${QUESTION_CHOICES[ask.kind]}` : ''
  const answer = owner
    ? `Run \`pnyx-axi task answer ${card.id} ${ask.id}${choice} --from-message <owner-message-id>\` once the owner answers`
    : `Run \`pnyx-axi task answer ${card.id} ${ask.id} --text "<answer>"\``

  return {
    reason: `waiting for ${owner ? 'the owner' : 'Hydra'} to answer question ${ask.id}: ${ask.question}`,
    clear: answer,
  }
}

export function questionBlockers({ card }: { card: Card }): Blocker[] {
  const attention = waitingAttention({ card })
  const prompts = attention.filter(a => !a.key.startsWith(PERMISSION_PREFIX))
    .map(prompt => promptBlocker({
      card,
      prompt,
    }))
  const permissionIds = new Set([
    ...pendingPermissions({ card }).map(permission => permission.id),
    ...attention.filter(a => a.key.startsWith(PERMISSION_PREFIX))
      .map(a => a.key.slice(PERMISSION_PREFIX.length)),
  ])
  const permissions = [...permissionIds].map(id => ({
    reason: `waiting for permission request ${id}`,
    clear: `Run \`pnyx-axi task permission ${card.id} ${id} allow|deny\``,
  }))
  const asks = openAsks({ card }).map(ask => askBlocker({
    card,
    ask,
  }))

  return [
    ...prompts,
    ...permissions,
    ...asks,
  ]
}
