import { EVENT_VERSION, HydraError, type HydraEvent, type HydraState, type Card, type PermissionRequest } from './model.ts'
import { checkAnswer, type Prompt } from './answer.ts'
import type { Meta } from './decide.ts'

const PREFIX = 'pnyx:permission:'

const text = ({ value }: { value: unknown }) => typeof value === 'string' && value.trim() ? value.trim() : undefined

// What a person reads to judge a request: what runs, on which files, where and why.
export function permissionDetails({ request }: {
  request: PermissionRequest
}): {
  label: string
  text: string
}[] {
  const input = request.input
  // Codex wraps a command in its shell (`zsh -lc '...'`) and also reports the command it parsed.
  const actions = Array.isArray(input.commandActions) ? input.commandActions : []
  const parsed = actions.length === 1
    ? text({ value: (actions[0] as { command?: unknown })?.command })
    : undefined
  const command = parsed ?? (Array.isArray(input.command)
    ? input.command.join(' ')
    : text({ value: input.command }))
  const changes = (Array.isArray(input.changes) ? input.changes : [])
    .flatMap(c => text({ value: (c as { path?: unknown })?.path }) ?? [])
  const file = text({ value: input.file_path ?? input.notebook_path ?? input.path })
  const files = [
    file ?? [],
    changes,
  ].flat()
  const rows = [
    {
      label: 'Command',
      text: command,
    },
    {
      label: files.length > 1 ? 'Files' : 'File',
      text: files.join(', ') || undefined,
    },
    {
      label: 'URL',
      text: text({ value: input.url }),
    },
    {
      label: 'Folder',
      text: text({ value: input.cwd }),
    },
    {
      label: 'Message',
      text: text({ value: input.message }),
    },
    {
      label: 'Reason',
      text: request.description ?? text({ value: input.reason ?? input.description }),
    },
  ]

  return rows.filter((row): row is {
    label: string
    text: string
  } => !!row.text)
}

function permissionText({ request }: { request: PermissionRequest }): string {
  const asked = request.questions?.map(q => q.question).join(' ')
  const details = permissionDetails({ request })

  return `${request.tool}: ${asked || (details.length ? details.map(d => d.text).join(' · ') : JSON.stringify(request.input))}`
}

export function permissionAnswer({
  request,
  value,
}: {
  request: PermissionRequest
  value: unknown
}): Pick<PermissionRequest, 'answers' | 'values'> {
  const questions = request.questions ?? []
  const prompt: Prompt | undefined = questions.length ? { kind: 'questions' } : request.form ? { kind: 'form' } : undefined

  if (!prompt) {
    throw new HydraError({
      message: `${request.tool} takes allow or deny without an answer`,
      code: 'VALIDATION_ERROR',
    })
  }

  if (value === undefined) {
    throw new HydraError({
      message: `${request.tool} needs an answer`,
      code: 'VALIDATION_ERROR',
      help: [prompt.kind === 'form' ? 'Pass --answer \'{"values":{"<field>":"<value>"}}\'' : 'Pass --answer \'{"answers":[{"pick":[1]}]}\' with one {"pick":[n,...]} or {"text":"..."} per question'],
    })
  }

  const given = typeof value === 'object' && value !== null ? {
    ...value,
    choice: 'accept',
  } : value
  const checked = checkAnswer({
    prompt,
    request: {
      kind: 'question',
      key: request.id,
      blocking: true,
      questions,
      ...(request.form ? { form: request.form } : {}),
    },
    value: given,
  })

  if ('error' in checked) {
    throw new HydraError({
      message: checked.error,
      code: 'VALIDATION_ERROR',
    })
  }

  if (prompt.kind === 'form') {
    return { values: checked.answer.values ?? {} }
  }

  return {
    answers: (checked.answer.answers ?? []).map((
      answer,
      i,
    ) => 'text' in answer
      ? [answer.text]
      : answer.pick.map(n => questions[i]!.options[n - 1]!.label)),
  }
}

export function permissionAttention({ card }: { card: Card }): void {
  card.attention = [
    ...card.attention.filter(a => !a.key.startsWith(PREFIX)),
    ...(card.permissions ?? []).filter(p => p.status === 'pending').map(p => ({
      kind: 'permission',
      key: `${PREFIX}${p.id}`,
      blocking: true,
      text: permissionText({ request: p }),
    })),
  ]
}

export function permissionEvent({
  state,
  card,
  request,
  meta,
}: {
  state: HydraState
  card: Card
  request: PermissionRequest
  meta: Meta
}): Extract<HydraEvent, { type: 'task.permission' }> {
  return {
    v: EVENT_VERSION,
    seq: state.seq + 1,
    id: meta.id ?? `permission:${request.id}:${request.status}`,
    at: meta.at,
    actor: meta.actor,
    cardId: card.id,
    ...(meta.reason ? { reason: meta.reason } : {}),
    type: 'task.permission',
    data: request,
  }
}

export function applyPermission({
  state,
  event,
}: {
  state: HydraState
  event: HydraEvent
}): boolean {
  if (event.type !== 'task.permission') {
    return false
  }

  const card = state.cards[event.cardId]

  if (card) {
    const requests = card.permissions ?? []
    const prior = requests.find(p => p.id === event.data.id)

    if ((!prior && event.data.status === 'pending') || (prior?.status === 'pending' && event.data.status !== 'pending' && prior.session === event.data.session)) {
      card.permissions = prior
        ? requests.map(p => p.id === prior.id
          ? {
            ...prior,
            status: event.data.status,
            ...(event.data.answers ? { answers: event.data.answers } : {}),
            ...(event.data.values ? { values: event.data.values } : {}),
          }
          : p)
        : [
          ...requests,
          {
            ...structuredClone(event.data),
            at: event.at,
          },
        ]
      permissionAttention({ card })
      card.revision++
      card.updatedSeq = event.seq
      card.updatedAt = event.at
    }
  }

  return true
}
