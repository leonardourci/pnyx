import { OVERRIDE_FIELDS, overrideOf, type Override } from './dispatch.ts'
import { TitanError } from '#store/errors.ts'
import type { TitanEvent, TitanState } from '#app/model.ts'
import type { Output } from '#app/cli-support.ts'
import type { Meta } from '#app/command-meta.ts'
import { loadTitan } from '#app/store.ts'
import { sendReply } from './reply.ts'
import { taskPrompt } from './worker-brief.ts'
import { selfSession } from './session-attachments.ts'
import { requestEnv } from '#app/request-context.ts'

export function startOverride({
  values,
}: {
  values: Record<string, unknown>
}): Override | undefined {
  const { fast } = values

  if (fast !== undefined && fast !== 'on' && fast !== 'off') {
    throw new TitanError({
      message: '--fast takes on or off',
      code: 'VALIDATION_ERROR',
    })
  }

  const named = OVERRIDE_FIELDS.filter(name => name !== 'fast' && values[name] !== undefined)
  const empty = named.find(name => !String(values[name]).trim())

  if (empty) {
    throw new TitanError({
      message: `--${empty} needs a value`,
      code: 'VALIDATION_ERROR',
    })
  }

  return overrideOf({
    value: Object.fromEntries([
      ...named.map(name => [
        name,
        values[name],
      ]),
      ...(fast === undefined ? [] : [
        [
          'fast',
          fast === 'on',
        ],
      ]),
    ]),
  })
}

export const START_FLAGS = [
  'via',
  'rule',
  'harness',
  'account',
  'model',
  'effort',
  'mode',
  'fast',
  'prompt',
  'tool',
  'in-place',
  'command',
]

export const flagGiven = ({ value }: { value: unknown }) =>
  Array.isArray(value) ? value.length > 0 : value !== undefined && value !== false

export function startFlags({ values }: { values: Record<string, unknown> }) {
  return {
    via: values.via as string | undefined,
    rule: values.rule as string | undefined,
    harness: values.harness as string | undefined,
    override: startOverride({ values }),
    tools: values.tool as string[] | undefined,
    prompt: values.prompt as string | undefined,
    inPlace: Boolean(values['in-place']),
    commandName: values.command as string | undefined,
  }
}

type Attachment = Extract<TitanEvent, { type: 'task.session' }>

// Attachment is durable even when delivery fails.
export async function afterAttach({
  hydraId,
  result,
  attachment,
  meta,
}: {
  hydraId: string
  result: Output
  attachment: Attachment
  meta: Meta
}): Promise<Output> {
  if (!attachment.data.brief) {
    return result
  }

  const state = loadTitan({ hydraId }).state

  try {
    const brief = await sendReply({
      hydraId,
      request: {
        card: attachment.cardId,
        text: await taskPrompt({
          hydraId,
          card: state.cards[attachment.cardId]!,
        }),
        expectedSession: attachment.data.session,
        actor: meta.actor,
        id: `brief:${attachment.id}`,
      },
    })

    return {
      ...result,
      brief,
    }
  } catch (error) {
    return {
      ...result,
      brief: {
        state: 'failed',
        detail: error instanceof Error ? error.message : String(error),
      },
      help: ['The attachment was recorded; inspect the task before retrying its brief with the same --event-id'],
    }
  }
}

export function sessionRef({
  state,
  ref,
}: {
  state: TitanState
  ref: string
}): string {
  return ref === 'self'
    ? selfSession({
      state,
      here: {
        tmuxPane: requestEnv().TMUX_PANE,
        herdrPane: requestEnv().HERDR_PANE_ID,
      },
    }).id
    : ref
}
