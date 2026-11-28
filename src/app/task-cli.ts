import { inform } from '#app/command-notices.ts'
import { ownerQuestionGroups, decisionKey } from '#tasks/question-groups.ts'
import { taskSessions } from '#workers/session-history.ts'
import type { AgentConfig } from '#workers/model.ts'
import { queueCardInput, validateCardInput } from '#workers/card-input.ts'
import { knownHarness } from '#workers/providers.ts'
import { reorderTask } from '#tasks/reorder.ts'
import { taskRank } from '#tasks/order.ts'
import { toolsCommand } from '#workers/tools-cli.ts'
import { MESSAGE_LOOKUP_OPTIONS, messageLookup } from '#titan/message-lookup-cli.ts'
import { localTaskCommand, validateLocalTaskFlags } from '#tasks/plans-cli.ts'
import { randomUUID } from 'node:crypto'
import { WRITE, parse, meta, required, commit, explained, integer, HISTORY_LIMIT, clip, type Options, type Output } from './cli-support.ts'
import { sourceCommand } from '#task-sources/cli.ts'
import { inboxCommand } from '#workers/inbox-cli.ts'
import { taskLandingCommand } from '#tasks/delivery/task-delivery.ts'
import { mergeCommand } from '#tasks/delivery/merge.ts'
import { reminderRepeat, waitingReminders } from '#tasks/reminders.ts'
import { loadTitan } from './store.ts'
import { findCard } from '#tasks/push-rules.ts'
import { decidePush } from '#tasks/push.ts'
import { decideSession } from '#workers/sessions.ts'
import { cardStatus, currentState } from '#tasks/card-status.ts'
import { titanEvent } from '#titan/titan.ts'
import { TitanError } from '#store/errors.ts'
import { reminderTime } from '#tasks/time.ts'
import { askHost } from './server-state.ts'
import { requireUnheld } from '#tasks/holds.ts'
import { startTask } from '#workers/start.ts'
import { createCommand } from '#workers/create.ts'
import { continueInProject } from '#workers/project-attach.ts'
import { workerGap } from '#tasks/card-status.ts'
import { taskUpdates } from '#tasks/updates-page.ts'
import { taskFields, attentionLabel, cardRow, taskHistory, type TaskField } from '#tasks/cli.ts'
import { startOverride, startFlags, sessionRef, afterAttach } from '#workers/cli.ts'
import { copyCommand } from '#projects/copies-cli.ts'
import { liveTask, isManagedTask } from '#tasks/select.ts'
import { interactive, findSession } from '#workers/session-attachments.ts'
import { findProject } from '#projects/read.ts'
import { decideQueue, queueRequestGap } from '#workers/queue-decisions.ts'
import { hideDone } from '#tasks/retention.ts'
import { queuePosition, workerQueue } from '#workers/queue.ts'
import { taskSpend } from '#workers/task-spend.ts'
import { readEvents, scanEvents } from './event-log.ts'
import { taskReadiness } from '#tasks/dependencies.ts'
import { askRows, askCommand } from '#tasks/asks.ts'
import { readThread } from '#titan/transcripts-read.ts'
import { TITAN_CARD } from '#titan/identity.ts'
import { hideAfterHours, MAX_DONE_HOURS } from '#tasks/retention-rules.ts'
import { moveTask } from '#tasks/move.ts'
import { requireStopAuthority } from './stop-authority.ts'
import { workerIdentity } from '#workers/worker-identity.ts'

const TASK_DETAIL_LIMIT = 5

export const TASK_OPTIONS: Options = {
  ...WRITE,
  ...MESSAGE_LOOKUP_OPTIONS,
  available: { type: 'boolean' },
  grant: {
    type: 'string',
    multiple: true,
  },
  revoke: {
    type: 'string',
    multiple: true,
  },
  tool: {
    type: 'string',
    multiple: true,
  },
  start: { type: 'boolean' },
  'no-start': { type: 'boolean' },
  title: { type: 'string' },
  project: { type: 'string' },
  brief: { type: 'string' },
  intent: { type: 'string' },
  ask: { type: 'string' },
  message: { type: 'string' },
  key: { type: 'string' },
  folder: { type: 'string' },
  session: { type: 'string' },
  'replace-session': { type: 'string' },
  parent: { type: 'string' },
  note: { type: 'string' },
  limit: { type: 'string' },
  before: { type: 'string' },
  behind: { type: 'string' },
  on: {
    type: 'string',
    multiple: true,
  },
  full: { type: 'boolean' },
  fields: { type: 'string' },
  harness: { type: 'string' },
  account: { type: 'string' },
  prompt: { type: 'string' },
  check: { type: 'boolean' },
  via: { type: 'string' },
  command: { type: 'string' },
  rule: { type: 'string' },
  answer: { type: 'string' },
  model: { type: 'string' },
  effort: { type: 'string' },
  mode: { type: 'string' },
  fast: { type: 'string' },
  'in-place': { type: 'boolean' },
  safe: { type: 'boolean' },
  discard: { type: 'boolean' },
  question: { type: 'string' },
  context: { type: 'string' },
  evidence: { type: 'string' },
  choice: {
    type: 'string',
    multiple: true,
  },
  recommend: { type: 'string' },
  'details-file': { type: 'string' },
  kind: { type: 'string' },
  text: { type: 'string' },
  to: { type: 'string' },
  undelivered: { type: 'boolean' },
  'from-message': { type: 'string' },
  questions: { type: 'string' },
  file: { type: 'string' },
  url: { type: 'string' },
  landing: { type: 'string' },
  merge: { type: 'string' },
  clear: { type: 'boolean' },
  until: { type: 'string' },
  'wait-for': { type: 'string' },
  'ready-when': { type: 'string' },
  every: { type: 'string' },
  hold: { type: 'boolean' },
  'to-titan': { type: 'string' },
}

export async function taskCommand({ args }: { args: string[] }): Promise<Output> {
  if (args[0] === 'source') {
    return await sourceCommand({ args: args.slice(1) })
  }

  if (args[0] === 'inbox') {
    return await inboxCommand({ args: args.slice(1) })
  }

  const {
    values,
    positionals,
    titanId,
  } = parse({
    args,
    options: TASK_OPTIONS,
    positionals: 4,
  })
  const action = positionals[0]
  validateLocalTaskFlags({
    action,
    values,
    positionals,
  })
  const m = meta({ values })
  let creatingWorker: AgentConfig | undefined
  const createText = String(values.ask ?? values.brief ?? values.title ?? '')

  if (action === 'create' && values.start) {
    const createHarness = knownHarness({ name: values.harness })

    if (!createHarness) {
      throw new TitanError({
        message: 'Choose --harness claude|codex',
        code: 'VALIDATION_ERROR',
      })
    }

    creatingWorker = {
      harness: createHarness,
      ...startOverride({ values }),
    }
    validateCardInput({
      text: createText,
      agent: creatingWorker,
      actor: m.actor,
    })
  }

  if (action === 'create' && values.kind !== undefined) {
    throw new TitanError({
      message: 'Tasks have no --kind; describe the work in --brief',
      code: 'VALIDATION_ERROR',
    })
  }

  if (action === 'create' && !values.start) {
    return createCommand({
      titanId,
      positionals,
      values,
      meta: m,
    })
  }

  const local = await localTaskCommand({
    action,
    values,
    positionals,
    titanId,
    meta: m,
  })

  if (local) {
    if (creatingWorker) {
      const card = local.card as { id: string }
      const input = await queueCardInput({
        titanId,
        task: card.id,
        text: createText,
        agent: creatingWorker,
        meta: {
          ...m,
          id: `${m.id ?? card.id}:worker`,
        },
      })

      return {
        ...local,
        input,
      }
    }

    return local
  }

  if (action === 'tools') {
    return toolsCommand({
      titanId,
      ref: positionals[1],
      values,
      meta: m,
    })
  }

  if (action === 'refresh-links') {
    return askHost({
      titanId,
      body: {
        action: 'refresh-links',
        task: required({
          value: positionals[1],
          what: 'task',
        }),
      },
    })
  }

  if (action === 'questions') {
    const state = loadTitan({ titanId }).state
    const groups = ownerQuestionGroups({ state }).map(group => ({
      task: group.card.id,
      title: group.card.title,
      count: group.decisions.length,
      questions: group.decisions.map(decision => ({
        key: decisionKey({ decision }),
        kind: decision.kind,
        question: decision.text,
      })),
      choices: group.choices,
    }))

    return {
      groups: groups.length ? groups : 'none: no owner questions',
      count: groups.length,
    }
  }

  if (action === 'landing') {
    return await taskLandingCommand({
      titanId,
      ref: positionals[1],
      landing: values.landing as string | undefined,
      merge: values.merge as string | undefined,
      clear: values.clear === true,
      meta: m,
    })
  }

  if (action === 'merge') {
    return mergeCommand({
      titanId,
      ref: positionals[1],
      url: values.url as string | undefined,
      meta: m,
    })
  }

  if (action === 'reminders') {
    const reminders = waitingReminders({ state: loadTitan({ titanId }).state })

    return {
      titanId,
      count: reminders.length,
      reminders: reminders.length ? reminders : 'none: no waiting reminders',
    }
  }

  if (action === 'remind') {
    const ref = required({
      value: positionals[1],
      what: 'task id',
    })
    const when = required({
      value: positionals[2],
      what: 'reminder time or clear',
    })

    return await commit({
      titanId,
      meta: m,
      intent: {
        type: 'task.reminder',
        card: ref,
      },
      decide: ({ state }) => {
        const task = findCard({
          state,
          ref,
        })

        if (isManagedTask({ card: task })) {
          throw new TitanError({
            message: 'Choose a task for the reminder',
            code: 'VALIDATION_ERROR',
          })
        }

        const after = when === 'clear' ? null : reminderTime({
          when,
          now: m.at,
        })
        const repeat = reminderRepeat({
          card: task,
          when,
          every: values.every as string | undefined,
          until: values.until as string | undefined,
          question: values.question as string | undefined,
        })

        return after === (task.reminder?.at ?? null) && !task.reminder?.dueAt
          && JSON.stringify(repeat) === JSON.stringify(task.reminder?.repeat) ? { skipped: 'unchanged' }
          : titanEvent({
            state,
            meta: m,
            cardId: task.id,
            change: {
              type: 'task.reminder',
              data: {
                before: task.reminder?.at ?? null,
                after,
                repeat,
              },
            },
          })
      },
    })
  }

  if (action === 'permission') {
    const reason = explained({ meta: m })
    const choice = positionals[3]

    if (choice !== 'allow' && choice !== 'deny') {
      // A quoted "<task> <request>" arrives as one argument, so say what was parsed.
      const got = positionals.slice(1).map(arg => `'${arg}'`)
        .join(' ') || 'nothing'

      throw new TitanError({
        message: `Use task permission <task> <request> allow|deny (got ${got})`,
        code: 'VALIDATION_ERROR',
        help: ['Pass the task, the request id and allow or deny as separate arguments'],
      })
    }

    let answer: unknown

    try {
      answer = typeof values.answer === 'string' ? JSON.parse(values.answer) : undefined
    } catch {
      throw new TitanError({
        message: '--answer must be JSON',
        code: 'VALIDATION_ERROR',
      })
    }

    return askHost({
      titanId,
      body: {
        action: 'permission',
        task: required({
          value: positionals[1],
          what: 'task id',
        }),
        request: required({
          value: positionals[2],
          what: 'request id',
        }),
        choice,
        ...(answer !== undefined ? { answer } : {}),
        actor: m.actor,
        ...(reason ? { reason } : {}),
        ...(m.details ? { details: m.details } : {}),
      },
    })
  }

  if (action === 'send') {
    if (values.mode !== undefined || values.fast !== undefined) {
      throw new TitanError({
        message: 'task send takes harness, account, model and effort',
        code: 'VALIDATION_ERROR',
      })
    }

    const harness = knownHarness({ name: values.harness })

    if (!harness) {
      throw new TitanError({
        message: 'Choose --harness claude|codex',
        code: 'VALIDATION_ERROR',
      })
    }

    return await queueCardInput({
      titanId,
      task: required({
        value: positionals[1],
        what: 'task id',
      }),
      text: required({
        value: values.text as string | undefined,
        what: '--text',
      }),
      agent: {
        harness,
        ...startOverride({ values }),
      },
      meta: m,
    })
  }

  if (action === 'stop') {
    requireStopAuthority({ meta: meta({ values }) })
    const card = findCard({
      state: loadTitan({ titanId }).state,
      ref: required({
        value: positionals[1],
        what: 'task id',
      }),
    })

    return askHost({
      titanId,
      body: {
        action: 'stop',
        card: card.id,
        actor: meta({ values }).actor,
      },
    })
  }

  if (action === 'continue') {
    requireUnheld({
      card: findCard({
        state: loadTitan({ titanId }).state,
        ref: required({
          value: positionals[1],
          what: 'task id',
        }),
      }),
    })
  }

  if (action === 'continue' && values.check) {
    return askHost({
      titanId,
      body: {
        action: 'continue',
        task: required({
          value: positionals[1],
          what: 'task id',
        }),
        check: true,
        id: m.id ?? randomUUID(),
        actor: m.actor,
      },
    })
  }

  if (action === 'start' || action === 'continue') {
    explained({ meta: m })
    const ref = required({
      value: positionals[1],
      what: 'task id',
    })
    const started = action === 'continue' ? askHost({
      titanId,
      body: {
        action: 'continue',
        task: ref,
        id: m.id ?? randomUUID(),
        actor: m.actor,
        ...(m.reason ? { reason: m.reason } : {}),
      },
    }) : startTask({
      titanId,
      task: ref,
      replacement: values['replace-session'] as string | undefined,
      folder: values.folder as string | undefined,
      ...startFlags({ values }),
      meta: m,
    })

    return started
  }

  if (action === 'copy') {
    return copyCommand({
      titanId,
      ref: required({
        value: positionals[1],
        what: 'task id',
      }),
      action: positionals[2],
      values,
      meta: m,
    })
  }

  if (action === 'sessions' && values.full) {
    return { sessions: Object.values(loadTitan({ titanId }).state.sessions ?? {}) }
  }

  if (action === 'sessions') {
    const sessions = Object.values(loadTitan({ titanId }).state.sessions ?? {}).map(s => ({
      id: s.id,
      provider: s.agent.provider,
      title: s.title ?? 'none',
      activity: s.sessionActivity ?? s.activity ?? 'unknown',
      task: s.taskId ?? 'none',
      interactive: interactive({ session: s }),
    }))

    return { sessions: sessions.length ? sessions : 'none: no sessions recorded' }
  }

  if (action === 'queue' || action === 'unqueue' || action === 'reorder') {
    const task = required({
      value: positionals[1],
      what: 'task id',
    })
    const behind = action === 'unqueue' ? undefined : required({
      value: values.behind as string | undefined,
      what: '--behind <task|session>',
    })
    const state = loadTitan({ titanId }).state
    const card = findCard({
      state,
      ref: task,
    })
    const replayed = m.id !== undefined && Object.hasOwn(
      state.eventIds,
      m.id,
    )
    const gap = replayed ? undefined : queueRequestGap({
      state,
      card,
      reorder: action === 'reorder',
      behind,
    })

    if (gap) {
      return {
        task: card.id,
        queued: false,
        reason: gap.reason,
        help: [gap.clear],
      }
    }

    return await commit({
      titanId,
      meta: m,
      intent: {
        type: 'task.queue',
        card: task,
      },
      decide: ({ state }) => {
        const unqueuedSince = action === 'reorder' && !findCard({
          state,
          ref: task,
        }).queue

        if (unqueuedSince) {
          return { skipped: 'stale' }
        }

        return decideQueue({
          state,
          task,
          behind,
          meta: m,
        })
      },
    })
  }

  if (action === 'list') {
    await hideDone({ titanId })
    const state = loadTitan({ titanId }).state

    const fields = taskFields({ value: values.fields as string | undefined })
    const tasks = Object.values(state.cards).filter(c => liveTask({ card: c }))
      .map(c => {
        const extra: Record<TaskField, string> = {
          attention: attentionLabel({ card: c }),
          parent: c.parentId ?? 'none',
          status: cardStatus({
            card: c,
            cards: state.cards,
            sessions: state.sessions,
          }).text,
          worker: c.sessionIds?.[0] ?? 'none',
          hold: c.hold?.reason ?? 'none',
          queue: c.queue ? String(queuePosition({
            state,
            card: c,
          })) : 'none',
        }

        return {
          ...cardRow({
            state,
            card: c,
          }),
          ...Object.fromEntries(fields.map(field => [
            field,
            extra[field],
          ])),
        }
      })

    if (!tasks.length) {
      return {
        titanId,
        tasks: 'none: no tasks on this Titan',
        help: [`Run \`othrys task create --title <title> --titan ${titanId}\` to add one`],
      }
    }

    return {
      titanId,
      count: tasks.length,
      tasks,
    }
  }

  if (action === 'move') {
    if (workerIdentity({ actor: m.actor })) {
      inform({
        reason: 'Task moved by a worker',
        clear: 'Move the task to its intended Titan in the UI',
      })
    }

    explained({ meta: m })

    return moveTask({
      titanId,
      ref: required({
        value: positionals[1],
        what: 'task id',
      }),
      to: required({
        value: values['to-titan'] as string | undefined,
        what: '--to-titan <titan>',
      }),
      meta: m,
    })
  }

  if (action === 'history') {
    return taskHistory({
      titanId,
      ref: required({
        value: positionals[1],
        what: 'task id',
      }),
      before: values.before as string | undefined,
      limit: integer({
        value: values.limit,
        flag: '--limit',
      }) ?? HISTORY_LIMIT,
      full: Boolean(values.full),
    })
  }

  if (action === 'updates') {
    return taskUpdates({
      titanId,
      ref: required({
        value: positionals[1],
        what: 'task id',
      }),
      before: integer({
        value: values.before,
        flag: '--before',
      }),
      limit: integer({
        value: values.limit,
        flag: '--limit',
      }),
    })
  }

  if (action === 'show') {
    const state = loadTitan({ titanId }).state
    const task = findCard({
      state,
      ref: required({
        value: positionals[1],
        what: 'task id',
      }),
    })

    const spend = taskSpend({
      state,
      events: [
        ...scanEvents({
          titanId,
          types: [
            'titan.configured',
            'task.session',
          ],
        }),
      ],
      task: task.id,
    })

    if (values.full) {
      return {
        task,
        spend,
        worker: task.sessionIds?.[0] ? state.sessions?.[task.sessionIds[0]] : undefined,
      }
    }

    const shown: {
      task: Output
      help: string[]
    } = {
      task: {
        ...cardRow({
          state,
          card: task,
        }),
        attention: attentionLabel({ card: task }),
        key: task.key,
        ...(task.notices?.length ? { notices: task.notices } : {}),
        ...(task.copy ? { copy: `${task.copy.path} (${task.copy.state}${task.copy.reason ? `: ${task.copy.reason}` : ''})` } : {}),
        ask: task.ask?.length ? task.ask.slice(-TASK_DETAIL_LIMIT).map(ask => ({
          ...ask,
          text: clip({ text: ask.text }),
        })) : 'none: no owner words recorded',
        ownerAsks: task.ask?.length ?? 0,
        spend,
        intent: task.intent === undefined ? 'none' : clip({ text: task.intent }),
        brief: task.brief === undefined ? 'none' : clip({ text: task.brief }),
        parent: task.parentId ?? 'none',
        latest: clip({ text: currentState({ card: task })?.text ?? 'none' }),
        status: cardStatus({
          card: task,
          cards: state.cards,
          sessions: state.sessions,
        }).text,
        worker: task.sessionIds?.[0] ?? workerGap({ card: task }),
        ...(task.queue ? {
          queue: queuePosition({
            state,
            card: task,
          }),
        } : {}),
        prerequisites: (task.prerequisites ?? []).map(id => ({
          id,
          title: state.cards[id]?.title ?? id,
        })),
        readiness: taskReadiness({
          state,
          card: task,
        }),
        next: task.sessionIds?.[0] ? workerQueue({
          state,
          session: task.sessionIds[0],
        }).map(c => ({
          id: c.id,
          title: c.title,
          ...queuePosition({
            state,
            card: c,
          }),
        })) : [],
        ...(task.hold ? { hold: task.hold } : {}),
      },
      help: [`Read tasks/${task.id}/task.log in Titan ${titanId} for its record`],
    }

    if (task.asks?.length) {
      shown.task.questionCount = task.asks.length
      const unresolved = task.asks.filter(ask => !ask.answered && !ask.closed)
      const resolved = task.asks.filter(ask => ask.answered || ask.closed).slice()
        .reverse()
      shown.task.openQuestions = unresolved.length
      const questions = askRows({
        card: {
          ...task,
          asks: [
            ...unresolved,
            ...resolved,
          ],
        },
      })
      shown.task.questions = questions.slice(
        0,
        TASK_DETAIL_LIMIT,
      )
        .map(question => {
          const row = {
            ...question,
            question: clip({ text: question.question }),
            state: clip({ text: question.state }),
          }

          if ('choices' in row && row.choices) {
            row.choices = clip({ text: row.choices })
          }

          return row
        })
    }

    if (task.queueNote) {
      shown.task.handoff = clip({ text: task.queueNote })
    }

    return shown
  }

  if (action === 'messages') {
    return messageLookup({
      values,
      titanId,
      task: required({
        value: positionals[1],
        what: 'task id',
      }),
    })
  }

  if (action === 'chat') {
    const state = loadTitan({ titanId }).state
    const task = findCard({
      state,
      ref: required({
        value: positionals[1],
        what: 'task id',
      }),
    })
    const session = values.session ? findSession({
      state,
      ref: String(values.session),
    }) : undefined

    const titanSession = task.id === TITAN_CARD && session !== undefined
      && Boolean(state.titanSessions?.includes(session.id))

    if (session && !titanSession && !taskSessions({
      titanId,
      ids: new Set([task.id]),
    }).has(session.id)) {
      throw new TitanError({
        message: 'this session has no recorded membership on the task',
        code: 'NOT_FOUND',
      })
    }

    const card = session ? {
      ...task,
      agent: session.agent,
      sessionIds: [session.id],
    } : task

    return {
      thread: readThread({
        titanId,
        state,
        card,
        selectedSession: session !== undefined,
        before: values.before as string | undefined,
      }),
    }
  }

  if (action === 'project') {
    const ref = required({
      value: positionals[1],
      what: 'task id',
    })
    const project = required({
      value: values.project as string | undefined,
      what: '--project <name|path>',
    })

    const attached = await commit({
      titanId,
      meta: m,
      intent: {
        type: 'task.project',
        card: ref,
      },
      decide: ({ state }) => {
        const task = findCard({
          state,
          ref,
        })
        const after = findProject({
          state,
          ref: project,
          attached: true,
        }).path

        return task.project === after ? { skipped: 'unchanged' }
          : titanEvent({
            state,
            meta: m,
            cardId: task.id,
            change: {
              type: 'task.project',
              data: {
                before: task.project ?? null,
                after,
              },
            },
          })
      },
    })

    return {
      ...attached,
      ...await continueInProject({
        titanId,
        task: ref,
        project,
        meta: m,
      }),
    }
  }

  if (action === 'hide-after') {
    const ref = required({
      value: positionals[1],
      what: 'task id',
    })
    const after = hideAfterHours({
      value: required({
        value: positionals[2],
        what: 'hours or default',
      }),
    })

    if (after === undefined) {
      throw new TitanError({
        message: `use hours from 0 to ${MAX_DONE_HOURS}, or default (0 keeps the card visible)`,
        code: 'VALIDATION_ERROR',
      })
    }

    return await commit({
      titanId,
      meta: m,
      intent: {
        type: 'task.retention',
        card: ref,
      },
      decide: ({ state }) => {
        const task = findCard({
          state,
          ref,
        })

        if (isManagedTask({ card: task })) {
          throw new TitanError({
            message: 'choose a task',
            code: 'VALIDATION_ERROR',
          })
        }

        const before = task.doneAfterHours ?? null

        return before === after && !task.keepDone ? { skipped: 'unchanged' }
          : titanEvent({
            state,
            meta: m,
            cardId: task.id,
            change: {
              type: 'task.retention',
              data: {
                before,
                after,
              },
            },
          })
      },
    })
  }

  if (action === 'intent') {
    throw new TitanError({
      message: 'task intent is now task owner-ask <task> --text <owner words>; the card\'s Intent changes with task brief --intent',
      code: 'VALIDATION_ERROR',
    })
  }

  if (action === 'hide' || action === 'unhide') {
    const ref = required({
      value: positionals[1],
      what: 'task id',
    })

    return await commit({
      titanId,
      meta: m,
      intent: {
        type: 'task.visibility',
        card: ref,
      },
      decide: ({ state }) => {
        const task = findCard({
          state,
          ref,
        })

        if (isManagedTask({ card: task })) {
          throw new TitanError({
            message: 'choose a task',
            code: 'VALIDATION_ERROR',
          })
        }

        const after = action === 'hide'

        return Boolean(task.hidden) === after ? { skipped: 'unchanged' } : titanEvent({
          state,
          meta: m,
          cardId: task.id,
          change: {
            type: 'task.visibility',
            data: {
              before: Boolean(task.hidden),
              after,
            },
          },
        })
      },
    })
  }

  if (action === 'arrange') {
    const ref = required({
      value: positionals[1],
      what: 'task id',
    })

    return await commit({
      titanId,
      meta: m,
      intent: {
        type: 'task.edited',
        card: ref,
        arrangement: true,
      },
      decide: ({ state }) => reorderTask({
        state,
        ref,
        before: values.before as string | undefined,
        meta: m,
      }),
    })
  }

  if (action === 'parent') {
    const ref = required({
      value: positionals[1],
      what: 'task id',
    })
    const parent = required({
      value: positionals[2],
      what: 'parent task or none',
    })

    return await commit({
      titanId,
      meta: m,
      intent: {
        type: 'task.edited',
        card: ref,
      },
      decide: ({ state }) => {
        const task = findCard({
          state,
          ref,
        })
        const target = parent === 'none' ? undefined : findCard({
          state,
          ref: parent,
        })
        const managedTarget = target !== undefined && isManagedTask({ card: target })

        if (isManagedTask({ card: task }) || managedTarget) {
          throw new TitanError({
            message: 'Choose work tasks for a parent and sub-task',
            code: 'VALIDATION_ERROR',
          })
        }

        if (values.before !== undefined && parent !== 'none') {
          throw new TitanError({
            message: '--before places a detached task in the root order; use parent none',
            code: 'VALIDATION_ERROR',
          })
        }

        const rank = parent === 'none' ? taskRank({
          state,
          card: {
            ...task,
            parentId: undefined,
          },
          before: values.before as string | undefined,
        }) : undefined

        return decidePush({
          state,
          key: task.key,
          input: { parent: target?.id ?? null },
          rank,
          meta: m,
        })
      },
    })
  }

  if (action === 'rename') {
    if (values.title === undefined && values.project === undefined) {
      throw new TitanError({
        message: 'pass --title or --project (empty text clears the label)',
        code: 'VALIDATION_ERROR',
      })
    }

    const ref = required({
      value: positionals[1],
      what: 'task id',
    })

    return await commit({
      titanId,
      meta: m,
      intent: {
        type: 'task.edited',
        card: ref,
      },
      decide: ({ state }) => decidePush({
        state,
        key: findCard({
          state,
          ref,
        }).key,
        input: {
          ...(values.title !== undefined ? {
            title: required({
              value: values.title as string,
              what: '--title',
            }),
          } : {}),
          ...(values.project !== undefined ? { project: values.project } : {}),
        },
        meta: m,
      }),
    })
  }

  if (action === 'ask' || action === 'answer-group' || action === 'answer' || action === 'escalate' || action === 'close-question' || action === 'reopen-question' || action === 'reask'
    || action === 'defer-question' || action === 'discuss-question') {
    return await askCommand({
      action,
      positionals,
      values,
      titanId,
      meta: m,
    })
  }

  if (action !== 'attach' && action !== 'detach') {
    throw new TitanError({
      message: 'Use task create, list, show, ask, answer, escalate, history, updates, messages, rename, parent, arrange, send, start, copy, move, permission, sessions, attach or detach',
      code: 'VALIDATION_ERROR',
    })
  }

  const ref = required({
    value: positionals[1],
    what: 'task id',
  })

  const result = await commit({
    titanId,
    meta: m,
    intent: {
      type: 'task.session',
      card: ref,
    },
    decide: ({
      state,
      meta: current,
    }) => {
      if (!liveTask({
        card: findCard({
          state,
          ref,
        }),
      })) {
        throw new TitanError({
          message: 'choose an explicit task; use titan set to configure Titan',
          code: 'VALIDATION_ERROR',
        })
      }

      if (action === 'detach' && !findCard({
        state,
        ref,
      }).sessionIds?.length) {
        return { skipped: 'unchanged' }
      }

      const session = action === 'attach'
        ? sessionRef({
          state,
          ref: required({
            value: values.session as string | undefined,
            what: '--session',
          }),
        })
        : findSession({
          state,
          ref,
        }).id

      return decideSession({
        state,
        ref: session,
        task: action === 'attach' ? ref : null,
        meta: current,
      })
    },
  })

  if (action === 'attach' && typeof result.event === 'object' && result.event !== null && 'id' in result.event && typeof result.event.id === 'string') {
    const eventId = result.event.id
    const attachment = readEvents({
      titanId,
      ids: [eventId],
    })[0]

    if (attachment?.type === 'task.session') {
      return afterAttach({
        titanId,
        result,
        attachment,
        meta: m,
      })
    }
  }

  return result
}
