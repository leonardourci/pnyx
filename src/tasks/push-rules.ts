import type { HydraState } from '../app/model.ts'
import { AUTO_TITLE_SOURCES, type Card, type AutoTitle } from './model.ts'
import { FORM_FIELD_TYPES, type Attention, type FormField, type Question, type TerminalFacts } from '../workers/model.ts'
import { HydraError } from '../store/errors.ts'
import { invalid, asRecord, onlyKeys, optionalText, text } from '../app/command-validation.ts'
import { HYDRA_CARD } from '../core/hydra.ts'
import { liveTask } from './select.ts'

export function findCard({
  state,
  ref,
}: {
  state: HydraState
  ref: string
}): Card {
  const card = state.cards[ref] ?? state.cards[state.keys[ref] ?? '']

  if (!card) {
    throw new HydraError({
      message: `card not found: ${ref}`,
      code: 'NOT_FOUND',
      help: ['Run `pnyx-axi` to list cards'],
    })
  }

  return card
}

export function strip({ card }: { card: Card | undefined }) {
  if (!card) {
    return undefined
  }

  const content: Partial<Card> = { ...card }
  delete content.revision
  delete content.updatedSeq
  delete content.updatedAt

  return content
}

export function checkRevision({
  card,
  ifRevision,
}: {
  card: Card | undefined
  ifRevision: number | undefined
}): void {
  const revision = card?.revision ?? 0

  if (ifRevision !== undefined && revision !== ifRevision) {
    throw new HydraError({
      message: `card ${card?.id ?? '(new)'} is at revision ${revision}, not ${ifRevision}`,
      code: 'REVISION_CONFLICT',
      help: [card ? `Run \`pnyx-axi card ${card.id}\` and retry with the current revision` : 'Use --if-revision 0 for a new card'],
    })
  }
}

export function parseAttention({ value }: { value: unknown }): Attention[] {
  if (!Array.isArray(value)) {
    throw invalid({ message: 'attention must be a list' })
  }

  return value.map((
    rawItem,
    i,
  ) => {
    const item = asRecord({ value: rawItem })

    if (!item) {
      throw invalid({ message: `attention[${i}] must be an object` })
    }

    onlyKeys({
      value: item,
      allowed: [
        'kind',
        'key',
        'blocking',
        'text',
        'questions',
        'form',
        'answered',
      ],
      what: `attention[${i}]`,
    })

    if (item.blocking !== undefined && typeof item.blocking !== 'boolean') {
      throw invalid({ message: `attention[${i}].blocking must be true or false` })
    }

    const note = optionalText({
      value: item.text,
      what: `attention[${i}].text`,
    })
    const answered = optionalText({
      value: item.answered,
      what: `attention[${i}].answered`,
    })

    return {
      kind: text({
        value: item.kind,
        what: `attention[${i}].kind`,
      }),
      key: text({
        value: item.key,
        what: `attention[${i}].key`,
      }),
      blocking: item.blocking === true,
      ...(note ? { text: note } : {}),
      ...(item.questions !== undefined ? {
        questions: parseQuestions({
          value: item.questions,
          what: `attention[${i}].questions`,
        }),
      } : {}),
      ...(item.form !== undefined ? {
        form: parseForm({
          value: item.form,
          what: `attention[${i}].form`,
        }),
      } : {}),
      ...(answered ? { answered } : {}),
    }
  })
}

function parseForm({
  value,
  what,
}: {
  value: unknown
  what: string
}): FormField[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw invalid({ message: `${what} must be a non-empty list` })
  }

  return value.map((
    rawItem,
    i,
  ) => {
    const at = `${what}[${i}]`
    const item = asRecord({ value: rawItem })

    if (!item) {
      throw invalid({ message: `${at} must be an object` })
    }

    onlyKeys({
      value: item,
      allowed: [
        'name',
        'title',
        'type',
        'options',
        'required',
      ],
      what: at,
    })
    const type = FORM_FIELD_TYPES.find(t => t === item.type)

    if (!type) {
      throw invalid({ message: `${at}.type must be one of ${FORM_FIELD_TYPES.join(', ')}` })
    }

    if (item.options !== undefined && (!Array.isArray(item.options) || !item.options.every(o => typeof o === 'string' && o !== ''))) {
      throw invalid({ message: `${at}.options must be a list of strings` })
    }

    const title = optionalText({
      value: item.title,
      what: `${at}.title`,
    })

    return {
      name: text({
        value: item.name,
        what: `${at}.name`,
      }),
      ...(title ? { title } : {}),
      type,
      ...(item.options ? { options: item.options as string[] } : {}),
      ...(item.required === true ? { required: true } : {}),
    }
  })
}

function parseQuestions({
  value,
  what,
}: {
  value: unknown
  what: string
}): Question[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw invalid({ message: `${what} must be a non-empty list` })
  }

  return value.map((
    rawItem,
    i,
  ) => {
    const at = `${what}[${i}]`
    const item = asRecord({ value: rawItem })

    if (!item) {
      throw invalid({ message: `${at} must be an object` })
    }

    onlyKeys({
      value: item,
      allowed: [
        'question',
        'header',
        'options',
        'multiSelect',
      ],
      what: at,
    })

    if (!Array.isArray(item.options)) {
      throw invalid({ message: `${at}.options must be a list` })
    }

    const header = optionalText({
      value: item.header,
      what: `${at}.header`,
    })
    const options = item.options.map((
      rawOption,
      j,
    ) => {
      const option = asRecord({ value: rawOption })

      if (!option) {
        throw invalid({ message: `${at}.options[${j}] must be an object` })
      }

      onlyKeys({
        value: option,
        allowed: [
          'label',
          'description',
        ],
        what: `${at}.options[${j}]`,
      })
      const description = optionalText({
        value: option.description,
        what: `${at}.options[${j}].description`,
      })

      return {
        label: text({
          value: option.label,
          what: `${at}.options[${j}].label`,
        }),
        ...(description ? { description } : {}),
      }
    })

    return {
      question: text({
        value: item.question,
        what: `${at}.question`,
      }),
      ...(header ? { header } : {}),
      options,
      ...(item.multiSelect === true ? { multiSelect: true } : {}),
    }
  })
}

export function parseAutoTitle({ value: rawValue }: { value: unknown }): AutoTitle {
  const value = asRecord({ value: rawValue })

  if (!value) {
    throw invalid({ message: 'autoTitle must be an object' })
  }

  onlyKeys({
    value,
    allowed: [
      'from',
      'text',
    ],
    what: 'autoTitle',
  })

  if (!(AUTO_TITLE_SOURCES as readonly unknown[]).includes(value.from)) {
    throw invalid({ message: `autoTitle.from must be one of ${AUTO_TITLE_SOURCES.join(', ')}` })
  }

  return {
    from: value.from as AutoTitle['from'],
    text: text({
      value: value.text,
      what: 'autoTitle.text',
    }),
  }
}

// Explicit attachments survive folder changes; Firstmate joins also honor its recorded terminal.
// task is the PNYX_TASK a session was started with: the task it works on, or
// Hydra's own marker; it outranks the folder join for a session not seen yet.
export function joinedKey({
  state,
  key,
  folder,
  terminal,
  probed = false,
  task,
}: {
  state: HydraState
  key: string
  folder: string | undefined
  terminal?: TerminalFacts
  probed?: boolean
  task?: string
}): string {
  const recorded = Object.values(state.sessions ?? {}).find(s => s.sourceRefs.some(r =>
    r.adapter === 'hooks' && `${r.instanceId}:${r.objectId}` === key))

  if (recorded) {
    const task = recorded.taskId ? state.cards[recorded.taskId] : undefined
    const managed = task?.sourceRefs.some(r => r.adapter === 'firstmate')

    const matchesTerminal = !task?.terminal?.paseoTerminal
      || task.terminal.paseoTerminal === terminal?.paseoTerminal

    return task && (!managed || matchesTerminal)
      ? task.key : key
  }

  if (key in state.keys) {
    return key
  }

  const colon = key.indexOf(':')
  const sessionId = key.slice(colon + 1)
  const joined = Object.values(state.cards).find(c => c.sourceRefs.some(r =>
    r.adapter === 'hooks' && r.instanceId === key.slice(
      0,
      colon,
    ) && r.objectId === sessionId))

  const session = terminal?.paseoTerminal
  const hinted = task ? state.cards[task] : undefined

  if (!joined && task === HYDRA_CARD) {
    return key
  }

  if (!joined && hinted && liveTask({ card: hinted }) && !hinted.sessionIds?.length) {
    return hinted.key
  }

  if (joined) {
    return (!joined.agent || joined.agent.sessionId === sessionId)
      && (!joined.terminal?.paseoTerminal || joined.terminal.paseoTerminal === session)
      ? joined.key
      : key
  }

  if (!folder || (probed && !terminal?.tty)) {
    return key
  }

  const tty = terminal?.tty
  const ownTerminal = ({ card: c }: { card: Card }) =>
    !!session && c.terminal?.paseoTerminal === session
  const succeeds = ({ card: c }: { card: Card }) => !!tty
    && (c.activity === 'ended' || !c.terminal?.tty || c.terminal.tty === tty)
  const matches = Object.values(state.cards).filter(c => c.folder === folder
    && (c.agent
      ? ownTerminal({ card: c }) && succeeds({ card: c })
      : !c.terminal?.paseoTerminal || ownTerminal({ card: c })))
  const own = matches.filter(card => ownTerminal({ card }))

  return own.length === 1 ? own[0]!.key : matches.length === 1 ? matches[0]!.key : key
}

// The card's value for a push field, null when absent. An auto title counts as absent.
export function pushedValue({
  card,
  field,
}: {
  card: Card
  field: string
}): unknown {
  if (field === 'title' && !card.titleSet) {
    return null
  }

  return (card as unknown as Record<string, unknown>)[field] ?? null
}
