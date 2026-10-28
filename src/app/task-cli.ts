import { randomUUID } from 'node:crypto'
import { AxiError } from 'axi-sdk-js'
import { WRITE, parse, meta, required, commit, explained, withHelp, integer, HISTORY_LIMIT, clip, type Options, type Output } from './cli-support.ts'
import { sourceCommand } from '../task-sources/cli.ts'
import { inboxCommand } from '../workers/inbox-cli.ts'
import { reportReviewCommand, reportCommand, buildCommand } from '../investigations/cli.ts'
import { taskLandingCommand } from '../tasks/delivery/task-delivery.ts'
import { mergeCommand } from '../tasks/delivery/merge.ts'
import { waitingReminders } from '../tasks/reminders.ts'
import { loadHydra } from './store.ts'
import { findCard } from '../tasks/push-rules.ts'
import { decidePush } from '../tasks/push.ts'
import { decideSession } from '../workers/sessions.ts'
import { declaredState, declareTask } from '../tasks/declarations.ts'
import { HYDRA_CARD, hydraEvent, hydraConfig } from '../core/hydra.ts'
import { HydraError } from '../store/errors.ts'
import { reminderTime } from '../tasks/time.ts'
import { askHost } from './server-state.ts'
import { paseoStatus } from '../integrations/paseo/launch.ts'
import { requireUnheld, decideHold } from '../tasks/holds.ts'
import { startTask } from '../cli/start.ts'
import { taskBrief, taskFields, attentionLabel, cardRow, TASK_FIELDS, taskHistory, untilTime, type TaskCreated, type TaskField } from '../tasks/cli.ts'
import { startOverride, taskSessions, sessionRef, afterAttach } from '../cli/commands.ts'
import { copyCommand } from '../projects/copies-cli.ts'
import { liveTask } from '../tasks/select.ts'
import { interactive, findSession } from '../workers/session-attachments.ts'
import { decideDependencies } from '../tasks/dependency-decisions.ts'
import { canonical } from '../store/paths.ts'
import { parseKind } from '../investigations/report.ts'
import { taskProject, findProject } from '../projects/read.ts'
import { ownerAsk } from '../tasks/intent.ts'
import { decideQueue } from '../workers/queue-decisions.ts'
import { hideDone } from '../tasks/retention.ts'
import { queuePosition, workerQueue } from '../workers/queue.ts'
import { taskSpend } from '../workers/task-spend.ts'
import { readEvents } from './event-log.ts'
import { taskReadiness } from '../tasks/dependencies.ts'
import { askRows, askCommand } from '../tasks/asks.ts'
import { readThread } from '../thread/read.ts'
import { refuseEarlyDone } from '../tasks/delivery/done.ts'
import { MAX_DONE_HOURS } from '../tasks/retention-rules.ts'

export const TASK_OPTIONS: Options = {
  ...WRITE,
  title: { type: 'string' },
  project: { type: 'string' },
  brief: { type: 'string' },
  ask: { type: 'string' },
  message: { type: 'string' },
  key: { type: 'string' },
  folder: { type: 'string' },
  session: { type: 'string' },
  'replace-session': { type: 'string' },
  parent: { type: 'string' },
  column: { type: 'string' },
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
  prompt: { type: 'string' },
  'paseo-url': { type: 'string' },
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
  text: { type: 'string' },
  to: { type: 'string' },
  undelivered: { type: 'boolean' },
  'from-message': { type: 'string' },
  'from-report': { type: 'string' },
  report: { type: 'string' },
  none: { type: 'boolean' },
  call: {
    type: 'string',
    multiple: true,
  },
  kind: { type: 'string' },
  file: { type: 'string' },
  url: { type: 'string' },
  landing: { type: 'string' },
  merge: { type: 'string' },
  clear: { type: 'boolean' },
  until: { type: 'string' },
  hold: { type: 'boolean' },
}

export function taskCommand({ args }: { args: string[] }): Output | Promise<Output> {
  if (args[0] === 'source') {
    return sourceCommand({ args: args.slice(1) })
  }

  if (args[0] === 'inbox') {
    return inboxCommand({ args: args.slice(1) })
  }

  const {
    values,
    positionals,
    hydraId,
  } = parse({
    args,
    options: TASK_OPTIONS,
    positionals: 4,
  })
  const action = positionals[0]
  const m = meta({ values })
  const url = values['paseo-url'] as string | undefined

  if (action === 'report-review') {
    return reportReviewCommand({
      hydraId,
      ref: positionals[1],
      report: values.report as string | undefined,
      calls: (values.call ?? []) as string[],
      none: values.none === true,
      meta: m,
    })
  }

  if (action === 'report') {
    return reportCommand({
      hydraId,
      ref: positionals[1],
      file: values.file as string | undefined,
      meta: m,
    })
  }

  if (action === 'build') {
    return buildCommand({
      hydraId,
      ref: positionals[1],
      meta: m,
    })
  }

  if (action === 'landing') {
    return taskLandingCommand({
      hydraId,
      ref: positionals[1],
      landing: values.landing as string | undefined,
      merge: values.merge as string | undefined,
      clear: values.clear === true,
      meta: m,
    })
  }

  if (action === 'merge') {
    return mergeCommand({
      hydraId,
      ref: positionals[1],
      url: values.url as string | undefined,
      meta: m,
    })
  }

  if (action === 'reminders') {
    const reminders = waitingReminders({ state: loadHydra({ hydraId }).state })

    return {
      hydraId,
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

    return commit({
      hydraId,
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

        if (task.automaticTask || task.id === HYDRA_CARD) {
          throw new HydraError({
            message: 'Choose a task for the reminder',
            code: 'VALIDATION_ERROR',
          })
        }

        const after = when === 'clear' ? null : reminderTime({
          when,
          now: m.at,
        })

        return after === (task.reminder?.at ?? null) && !task.reminder?.dueAt ? { skipped: 'unchanged' }
          : hydraEvent({
            state,
            meta: m,
            cardId: task.id,
            change: {
              type: 'task.reminder',
              data: {
                before: task.reminder?.at ?? null,
                after,
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

      throw new HydraError({
        message: `Use task permission <task> <request> allow|deny (got ${got})`,
        code: 'VALIDATION_ERROR',
        help: ['Pass the task, the request id and allow or deny as separate arguments'],
      })
    }

    let answer: unknown

    try {
      answer = typeof values.answer === 'string' ? JSON.parse(values.answer) : undefined
    } catch {
      throw new HydraError({
        message: '--answer must be JSON',
        code: 'VALIDATION_ERROR',
      })
    }

    return askHost({
      hydraId,
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

  if (action === 'paseo') {
    return paseoStatus({ url })
  }

  if (action === 'continue') {
    requireUnheld({
      card: findCard({
        state: loadHydra({ hydraId }).state,
        ref: required({
          value: positionals[1],
          what: 'task id',
        }),
      }),
    })
  }

  if (action === 'continue' && values.check) {
    return askHost({
      hydraId,
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
      hydraId,
      body: {
        action: 'continue',
        task: ref,
        id: m.id ?? randomUUID(),
        actor: m.actor,
        ...(m.reason ? { reason: m.reason } : {}),
      },
    }) : startTask({
      hydraId,
      task: ref,
      replacement: values['replace-session'] as string | undefined,
      commandName: values.command as string | undefined,
      via: values.via as string | undefined,
      rule: values.rule as string | undefined,
      harness: values.harness as string | undefined,
      override: startOverride({ values }),
      prompt: values.prompt as string | undefined,
      folder: values.folder as string | undefined,
      inPlace: Boolean(values['in-place']),
      url,
      meta: m,
    })

    return started
  }

  if (action === 'copy') {
    return copyCommand({
      hydraId,
      ref: required({
        value: positionals[1],
        what: 'task id',
      }),
      action: positionals[2],
      values,
      meta: m,
    })
  }

  if (action === 'sessions') {
    const sessions = Object.values(loadHydra({ hydraId }).state.sessions ?? {}).map(s => ({
      id: s.id,
      provider: s.agent.provider,
      task: s.taskId ?? 'none',
      interactive: interactive({ session: s }),
    }))

    return { sessions: sessions.length ? sessions : 'none: no sessions recorded' }
  }

  if (action === 'depend' || action === 'undepend') {
    const ref = required({
      value: positionals[1],
      what: 'task id',
    })
    const prerequisites = values.on as string[] | undefined

    if (!prerequisites?.length) {
      throw new HydraError({
        message: 'pass --on <prerequisite task>; repeat --on for several tasks',
        code: 'VALIDATION_ERROR',
      })
    }

    return commit({
      hydraId,
      meta: m,
      intent: {
        type: 'task.dependencies',
        card: ref,
      },
      decide: ({ state }) => decideDependencies({
        state,
        ref,
        prerequisites,
        remove: action === 'undepend',
        meta: m,
      }),
    })
  }

  if (action === 'hold' || action === 'release') {
    const ref = required({
      value: positionals[1],
      what: 'task id',
    })

    return commit({
      hydraId,
      meta: m,
      intent: {
        type: action === 'hold' ? 'task.held' : 'task.released',
        card: ref,
      },
      decide: ({ state }) => decideHold({
        state,
        ref,
        release: action === 'release',
        message: values['from-message'] as string | undefined,
        meta: m,
      }),
    })
  }

  if (action === 'create') {
    const title = required({
      value: values.title as string | undefined,
      what: '--title',
    }).trim()
    required({
      value: title,
      what: '--title',
    })
    const key = values.key as string | undefined ?? `task:${m.id ?? randomUUID()}`

    if (key.startsWith('$')) {
      throw new HydraError({
        message: 'task keys beginning with $ are reserved',
        code: 'VALIDATION_ERROR',
      })
    }

    const folder = canonical({ path: values.folder })
    const brief = taskBrief({ value: values.brief })
    const kind = values.kind === undefined ? 'build' : parseKind({ value: String(values.kind) })

    return withHelp({
      output: commit({
        hydraId,
        meta: m,
        intent: {
          type: 'task.created',
          card: key,
        },
        decide: ({ state }) => {
          if (state.keys[key]) {
            throw new HydraError({
              message: `task key already exists: ${key}`,
              code: 'CONFLICT',
            })
          }

          const project = values.project
            ? taskProject({
              state,
              ref: String(values.project),
            }) : undefined
          const parent = values.parent ? findCard({
            state,
            ref: String(values.parent),
          }) : undefined

          if (parent?.parentId || parent?.automaticTask || parent?.id === HYDRA_CARD) {
            throw new HydraError({
              message: 'subtasks have one level under a task',
              code: 'VALIDATION_ERROR',
            })
          }

          const columns = hydraConfig({
            state,
            id: hydraId,
          }).columns
          const selected = values.column
            ? columns.find(c => c.id === values.column || c.title === values.column
              || c.role === values.column) : undefined

          if (values.column && !selected) {
            throw new HydraError({
              message: 'unknown Hydra column',
              code: 'VALIDATION_ERROR',
            })
          }

          const cardId = `task-${randomUUID()}`
          const holdReason = m.reason?.trim() || title
          const created: TaskCreated['data'] = {
            key,
            title,
          }

          if (values.hold) {
            created.hold = holdReason
          }

          if (project) {
            created.project = project
          }

          if (brief !== undefined) {
            created.brief = brief
          }

          if (folder) {
            created.folder = folder
          }

          if (parent) {
            created.parentId = parent.id
          }

          if (selected) {
            created.column = selected.id
          }

          // A build task, the default, records no kind.
          if (kind === 'investigation') {
            created.kind = kind
          }

          const ask = values.ask

          if (ask !== undefined && String(ask).trim()) {
            created.ask = ownerAsk({
              state,
              text: String(ask),
              message: values.message as string | undefined,
              actor: m.actor,
              at: m.at,
            })
          }

          return hydraEvent({
            state,
            meta: m,
            cardId,
            change: {
              type: 'task.created',
              data: created,
            },
          })
        },
      }),
      help: ({ output }) => {
        const id = (output.card as { id?: string } | undefined)?.id ?? '<id>'

        return [
          `Run \`pnyx-axi task start ${id} --hydra ${hydraId}\` to start a worker`,
          `Run \`pnyx-axi task show ${id} --hydra ${hydraId}\` for the task`,
        ]
      },
    })
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

    return commit({
      hydraId,
      meta: m,
      intent: {
        type: 'task.queue',
        card: task,
      },
      decide: ({ state }) => {
        if (action === 'reorder' && !findCard({
          state,
          ref: task,
        }).queue) {
          throw new HydraError({
            message: 'only a queued task can be reordered',
            code: 'CONFLICT',
          })
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
    hideDone({ hydraId })
    const state = loadHydra({ hydraId }).state

    const fields = taskFields({ value: values.fields as string | undefined })
    const tasks = Object.values(state.cards).filter(c => liveTask({ card: c }))
      .map(c => {
        const extra: Record<TaskField, string> = {
          attention: attentionLabel({ card: c }),
          parent: c.parentId ?? 'none',
          status: c.status?.state ?? 'paused',
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
        hydraId,
        tasks: 'none: no tasks on this Hydra',
        help: [`Run \`pnyx-axi task create --title <title> --hydra ${hydraId}\` to add one`],
      }
    }

    const help = [`Run \`pnyx-axi task show <id> --hydra ${hydraId}\` for one task`]

    if (!fields.length) {
      help.push(`Run \`pnyx-axi task list --fields status,worker --hydra ${hydraId}\` for more fields (${TASK_FIELDS.join(', ')})`)
    }

    return {
      hydraId,
      count: tasks.length,
      tasks,
      help,
    }
  }

  if (action === 'history') {
    return taskHistory({
      hydraId,
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
      }) ?? HISTORY_LIMIT,
      full: Boolean(values.full),
    })
  }

  if (action === 'show') {
    const state = loadHydra({ hydraId }).state
    const task = findCard({
      state,
      ref: required({
        value: positionals[1],
        what: 'task id',
      }),
    })

    const spend = taskSpend({
      state,
      events: readEvents({ hydraId }),
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
        ...(task.copy ? { copy: `${task.copy.path} (${task.copy.state}${task.copy.reason ? `: ${task.copy.reason}` : ''})` } : {}),
        ask: task.ask?.length ? task.ask.map(ask => ({
          ...ask,
          text: clip({ text: ask.text }),
        })) : 'none: no owner words recorded',
        spend,
        brief: task.brief === undefined ? 'none' : clip({ text: task.brief }),
        parent: task.parentId ?? 'none',
        status: task.status ? `${declaredState({ declaration: task.status })}${task.status.note ? `: ${task.status.note}` : ''}` : 'none: no declaration yet',
        worker: task.sessionIds?.[0] ?? 'none',
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
        declarations: task.statusLog?.length ?? 0,
        ...(task.hold ? { hold: task.hold } : {}),
        ...(task.asks?.length ? { questions: askRows({ card: task }) } : {}),
        firstmate: task.mirror ? 'mirrored' : 'none',
      },
      help: [`Run \`pnyx-axi task show ${task.id} --full --hydra ${hydraId}\` for the full record, or \`pnyx-axi task history ${task.id} --hydra ${hydraId}\` for its events`],
    }

    if (task.queueNote) {
      shown.task.handoff = clip({ text: task.queueNote })
    }

    return shown
  }

  if (action === 'chat') {
    const state = loadHydra({ hydraId }).state
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

    if (session && !taskSessions({
      hydraId,
      ids: new Set([task.id]),
    }).has(session.id)) {
      throw new HydraError({
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
        hydraId,
        state,
        card,
        homes: [],
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

    return commit({
      hydraId,
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
          : hydraEvent({
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
  }

  if (action === 'status') {
    const ref = required({
      value: positionals[1],
      what: 'task id',
    })

    if (positionals[2] === 'done') {
      const state = loadHydra({ hydraId }).state
      refuseEarlyDone({
        state,
        card: findCard({
          state,
          ref,
        }),
        hydraId,
      })
    }

    return commit({
      hydraId,
      meta: m,
      intent: {
        type: 'task.declared',
        card: ref,
      },
      decide: ({ state }) => declareTask({
        state,
        ref,
        status: required({
          value: positionals[2],
          what: 'status',
        }),
        note: String(values.note ?? ''),
        meta: m,
        until: untilTime({
          until: values.until as string | undefined,
          now: m.at,
        }),
        hold: values.hold as boolean | undefined,
      }),
    })
  }

  if (action === 'hide-after') {
    const ref = required({
      value: positionals[1],
      what: 'task id',
    })
    const raw = required({
      value: positionals[2],
      what: 'hours or default',
    }).trim()
    const after = raw === 'default' ? null : Number(raw)

    if (after !== null
      && (!raw || !Number.isFinite(after) || after < 0 || after > MAX_DONE_HOURS)) {
      throw new HydraError({
        message: `use hours from 0 to ${MAX_DONE_HOURS}, or default (0 keeps the card visible)`,
        code: 'VALIDATION_ERROR',
      })
    }

    return commit({
      hydraId,
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

        if (task.automaticTask || task.id === HYDRA_CARD) {
          throw new HydraError({
            message: 'choose a task',
            code: 'VALIDATION_ERROR',
          })
        }

        const before = task.doneAfterHours ?? null

        return before === after && !task.keepDone ? { skipped: 'unchanged' }
          : hydraEvent({
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
    const ref = required({
      value: positionals[1],
      what: 'task id',
    })

    return commit({
      hydraId,
      meta: m,
      intent: {
        type: 'task.intent',
        card: ref,
      },
      decide: ({ state }) => {
        const task = findCard({
          state,
          ref,
        })

        if (task.automaticTask || task.id === HYDRA_CARD) {
          throw new HydraError({
            message: 'Choose a task for the owner ask',
            code: 'VALIDATION_ERROR',
          })
        }

        const entry = ownerAsk({
          state,
          text: required({
            value: values.text as string | undefined,
            what: '--text',
          }),
          message: values.message as string | undefined,
          actor: m.actor,
          at: m.at,
        })

        const recorded = task.ask?.some(ask => ask.message === entry.message
          && ask.text === entry.text)

        if (entry.message && recorded) {
          return { skipped: 'unchanged' }
        }

        return hydraEvent({
          state,
          meta: m,
          cardId: task.id,
          change: {
            type: 'task.intent',
            data: entry,
          },
        })
      },
    })
  }

  if (action === 'brief' || action === 'hide' || action === 'unhide') {
    const ref = required({
      value: positionals[1],
      what: 'task id',
    })

    return commit({
      hydraId,
      meta: m,
      intent: {
        type: action === 'brief' ? 'task.brief' : 'task.visibility',
        card: ref,
      },
      decide: ({ state }) => {
        const task = findCard({
          state,
          ref,
        })

        if (task.automaticTask || task.id === HYDRA_CARD) {
          throw new HydraError({
            message: 'choose a task',
            code: 'VALIDATION_ERROR',
          })
        }

        if (action === 'brief') {
          const after = taskBrief({ value: values.brief })

          if (after === undefined) {
            throw new HydraError({
              message: 'pass --brief <text> (empty text clears it)',
              code: 'VALIDATION_ERROR',
            })
          }

          return after === (task.brief ?? '') ? { skipped: 'unchanged' } : hydraEvent({
            state,
            meta: m,
            cardId: task.id,
            change: {
              type: 'task.brief',
              data: {
                before: task.brief ?? '',
                after,
              },
            },
          })
        }

        const after = action === 'hide'

        return Boolean(task.hidden) === after ? { skipped: 'unchanged' } : hydraEvent({
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

  if (action === 'rename') {
    if (values.title === undefined && values.project === undefined) {
      throw new HydraError({
        message: 'pass --title or --project (empty text clears the label)',
        code: 'VALIDATION_ERROR',
      })
    }

    const ref = required({
      value: positionals[1],
      what: 'task id',
    })

    return commit({
      hydraId,
      meta: m,
      intent: {
        type: 'card.pushed',
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

  if (action === 'ask' || action === 'answer' || action === 'escalate' || action === 'close-question' || action === 'reopen-question') {
    return askCommand({
      action,
      positionals,
      values,
      hydraId,
      meta: m,
    })
  }

  if (action !== 'attach' && action !== 'detach') {
    throw new AxiError(
      'Use task create, list, show, status, ask, answer, escalate, history, rename, start, copy, permission, paseo, sessions, attach or detach',
      'VALIDATION_ERROR',
    )
  }

  const ref = required({
    value: positionals[1],
    what: 'task id',
  })

  const result = commit({
    hydraId,
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
        throw new HydraError({
          message: 'choose an explicit task; use hydra set to configure Hydra',
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

  if (action === 'attach' && typeof result.event === 'object' && result.event !== null && 'id' in result.event) {
    const eventId = result.event.id
    const attachment = readEvents({ hydraId }).find(e => e.id === eventId)

    if (attachment?.type === 'task.session') {
      return afterAttach({
        hydraId,
        result,
        attachment,
        meta: m,
      })
    }
  }

  return result
}
