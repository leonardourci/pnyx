import { decideSessionFacts, isSessionSource } from '#workers/session-facts.ts'
import { sessionId } from '#workers/session-attachments.ts'
import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import type { HydraState, Decision } from '#app/model.ts'
import { base, type Meta } from '#app/command-meta.ts'
import { text, asRecord, invalid, onlyKeys, optionalText } from '#app/command-validation.ts'
import type { PushFields } from './model.ts'
import { projectLabel } from '#projects/labels.ts'
import { parseAutoTitle, parseAttention, findCard, pushedValue } from './push-rules.ts'
import { parseAgent, mergeSettings, parseTerminal, parseSource } from '#workers/sessions.ts'
import { wouldCycle, isStaleSource } from './events.ts'
import { decided } from '#app/decision.ts'

const TASK_EDIT_FIELDS: readonly (keyof PushFields)[] = [
  'title',
  'project',
  'workspace',
  'tags',
  'folder',
  'parentId',
  'rank',
  'settings',
]

export function decidePush({
  state,
  key,
  input: rawInput,
  meta,
  rank,
  newCardId = `task-${randomUUID()}`,
}: {
  newCardId?: string
  state: HydraState
  key: string
  input: unknown
  meta: Meta
  rank?: number
}): Decision {
  text({
    value: key,
    what: 'key',
  })

  const input = asRecord({ value: rawInput })

  if (!input) {
    throw invalid({ message: 'card must be a JSON object' })
  }

  onlyKeys({
    value: input,
    allowed: [
      'title',
      'autoTitle',
      'project',
      'workspace',
      'tags',
      'parent',
      'activity',
      'agent',
      'settings',
      'terminal',
      'folder',
      'attention',
      'source',
    ],
    what: 'card',
  })

  const cardId = state.keys[key] ?? newCardId
  const fields: PushFields = {}

  if (rank !== undefined) {
    fields.rank = rank
  }

  const title = input.title === null ? null : optionalText({
    value: input.title,
    what: 'title',
  })
  const workspace = optionalText({
    value: input.workspace,
    what: 'workspace',
  })
  const activity = optionalText({
    value: input.activity,
    what: 'activity',
  })
  const folder = input.folder === null ? null : optionalText({
    value: input.folder,
    what: 'folder',
  })

  if (title !== undefined) {
    fields.title = title
  }

  if (input.project !== undefined) {
    fields.project = projectLabel({ value: input.project })
  }

  if (workspace) {
    fields.workspace = workspace
  }

  if (activity) {
    fields.activity = activity
  }

  if (folder === null) {
    fields.folder = null
  } else if (folder) {
    if (!folder.startsWith('/')) {
      throw invalid({ message: 'folder must be an absolute path' })
    }

    fields.folder = folder
  }

  if (input.tags !== undefined) {
    if (!Array.isArray(input.tags)) {
      throw invalid({ message: 'tags must be a list of strings' })
    }

    fields.tags = [
      ...new Set(input.tags.map((
        t,
        i,
      ) => text({
        value: t,
        what: `tags[${i}]`,
      }))),
    ]
  }

  if (input.autoTitle !== undefined) {
    fields.autoTitle = parseAutoTitle({ value: input.autoTitle })
  }

  if (input.agent !== undefined) {
    fields.agent = parseAgent({ value: input.agent })
  }

  const session = fields.agent ? state.sessions?.[sessionId({ agent: fields.agent })]
    : Object.values(state.sessions ?? {}).find(known => known.id === key || known.sourceRefs.some(ref => `${ref.instanceId}:${ref.objectId}` === key))

  if (input.settings !== undefined) {
    fields.settings = mergeSettings({
      current: session?.settings ?? state.cards[cardId]?.settings,
      value: input.settings,
    })
  }

  if (input.terminal !== undefined) {
    fields.terminal = parseTerminal({ value: input.terminal })
  }

  if (input.attention !== undefined) {
    fields.attention = parseAttention({ value: input.attention })
  }

  const source = input.source === undefined ? undefined : parseSource({ value: input.source })
  const card = state.cards[cardId]

  const sessionSource = isSessionSource({ source })

  const agent = fields.agent ?? session?.agent

  if (!(sessionSource && agent) || card) {
    if (input.parent === null) {
      fields.parentId = null
    } else if (input.parent !== undefined) {
      const parent = findCard({
        state,
        ref: text({
          value: input.parent,
          what: 'parent',
        }),
      })

      if (wouldCycle({
        cards: state.cards,
        cardId,
        parentId: parent.id,
      })) {
        throw invalid({ message: `parent ${parent.id} would make a cycle` })
      }

      const hasChildren = Object.values(state.cards).some(c => c.parentId === cardId)

      if (parent.parentId || hasChildren) {
        throw invalid({ message: 'subtasks have one level; a subtask cannot have children' })
      }

      fields.parentId = parent.id
    }
  }

  const editsTask = card && !source && TASK_EDIT_FIELDS.some(field => field in fields)

  if (sessionSource && agent && !editsTask) {
    return decideSessionFacts({
      state,
      key,
      fields: {
        ...fields,
        agent,
      },
      source,
      meta,
      task: card,
      session,
    })
  }

  if (source && isStaleSource({
    card,
    source,
  })) {
    return { skipped: 'stale' }
  }

  let before: PushFields | undefined

  if (card) {
    const changed = Object.entries(fields)
      .filter(([
        field,
        value,
      ]) => !isDeepStrictEqual(
        pushedValue({
          card,
          field,
        }),
        value,
      ))
    before = Object.fromEntries(
      changed.map(([field]) => [
        field,
        pushedValue({
          card,
          field,
        }),
      ]),
    ) as PushFields
  }

  const edited = !source && (!card || TASK_EDIT_FIELDS.some(field => field in fields))

  return decided({
    state,
    meta,
    event: {
      ...base({
        state,
        meta,
        cardId,
      }),
      type: edited ? 'task.edited' : 'card.pushed',
      data: {
        key,
        ...fields,
        ...(source ? { source } : {}),
        ...(before ? { before } : {}),
      },
    },
  })
}
