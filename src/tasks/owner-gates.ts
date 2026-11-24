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
  return `Ask the owner a Go/Hold question in task ${task} through the UI`
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
    clear: `Ask the owner through task ${task} in the UI; release its hold there once they give the go`,
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
    clear: `Answer this ${prompt.kind} in task ${card.id} through the UI`,
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
    ? `Run \`othrys answer ${card.id} ${ask.id}${choice} --from-message <owner-message-id> --reason "<why>"\` once the owner answers`
    : `Run \`othrys answer ${card.id} ${ask.id} --text "<answer>" --reason "<why>"\``

  return {
    reason: `waiting for ${owner ? 'the owner' : 'Titan'} to answer question ${ask.id}: ${ask.question}`,
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
    clear: `Answer permission request ${id} in task ${card.id} through the UI`,
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
