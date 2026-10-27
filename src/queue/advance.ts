import { sameProjectPath } from '../projects/identity.ts'
import { landingContext, provesLanding } from '../landing/proof.ts'
import { taskReadiness } from '../core/dependencies.ts'
import { execFile, spawnSync } from 'node:child_process'
import { statSync, realpathSync } from 'node:fs'
import { promisify } from 'node:util'
import type { Decision, HydraState } from '../app/model.ts'
import { decideLink, decideSession } from '../core/decide.ts'
import { hydraConfig, hydraEvent, roleColumn } from '../core/hydra.ts'
import type { AgentSession, Card, LinkState, SessionEvent } from '../core/model.ts'
import { taskPrompt } from '../cli/start.ts'
import { confirmedMerge } from '../landing/confirmed.ts'
import { mergeObservation } from '../landing/merge-observation.ts'
import { sendReply } from '../cli/reply.ts'
import { pullRequestLanding, pullRequestState } from '../integrations/github/pull-request.ts'
import { checkAttachments, seenAt } from '../integrations/presence/check.ts'
import { drainSpool } from '../integrations/hooks/ingest.ts'
import { hydraIds } from '../app/home-migration.ts'
import { loadHydra } from '../app/store.ts'
import { readEvents } from '../app/event-log.ts'
import { withWriter, type Writer } from '../app/writer.ts'
import { QUEUE_CONTEXT_BYTES, QUEUE_MAX_TASKS, QUEUE_STALL_MS, workerQueue } from './state.ts'

const GIT_TIMEOUT_MS = 30_000
const exec = promisify(execFile)
const meta = () => ({
  actor: 'pnyx',
  at: new Date().toISOString(),
})

function append({
  writer,
  decision,
}: {
  writer: Writer
  decision: Decision
}) {
  if ('event' in decision) {
    writer.append({ event: decision.event })
  }
}

async function git({
  cwd,
  args,
}: {
  cwd: string
  args: string[]
}): Promise<string> {
  const { stdout } = await exec(
    'git',
    [
      '-C',
      cwd,
      ...args,
    ],
    {
      encoding: 'utf8',
      timeout: GIT_TIMEOUT_MS,
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: '0',
      },
    },
  )

  return stdout.trim()
}

function contextSize({ session }: { session: AgentSession }): number {
  try {
    return session.agent.transcriptPath ? statSync(session.agent.transcriptPath).size : 0
  } catch {
    return 0
  }
}

function releaseQueue({
  hydraId,
  session,
  reason,
  task,
}: {
  hydraId: string
  session: string
  reason: string
  task: AgentSession['taskId'] | undefined
}) {
  withWriter({
    hydraId,
    fn: ({ writer }) => {
      const current = writer.state.sessions?.[session]?.taskId

      if (current !== task) {
        return
      }

      const previous = current && writer.state.cards[current]
      const note = `Continue after ${previous ? `"${previous.title}" (${previous.id})` : session}. ${reason}. Read its task history before starting a fresh worker.`
      const column = roleColumn({
        columns: hydraConfig({ state: writer.state }).columns,
        role: 'queued',
      }) ?? 'queued'

      for (const card of workerQueue({
        state: writer.state,
        session,
      })) {
        append({
          writer,
          decision: hydraEvent({
            state: writer.state,
            meta: {
              ...meta(),
              reason,
            },
            cardId: card.id,
            change: {
              type: 'task.queue',
              data: {
                before: card.queue!,
                after: null,
                column,
                note,
              },
            },
          }),
        })
      }
    },
  })
}

function unsafeWorker({
  state,
  session,
  presence,
  now,
}: {
  state: HydraState
  session?: AgentSession
  presence?: string
  now: number
}): string | undefined {
  const card = session?.taskId ? state.cards[session.taskId] : undefined

  if (!session || !card || card.hidden || presence === 'gone' || session.activity === 'ended') {
    return 'The worker ended or detached'
  }

  if ((session.queueCompleted ?? 0) >= QUEUE_MAX_TASKS - 1) {
    return `The worker reached the ${QUEUE_MAX_TASKS}-task limit`
  }

  if (contextSize({ session }) >= QUEUE_CONTEXT_BYTES) {
    return `The worker transcript reached ${QUEUE_CONTEXT_BYTES} bytes`
  }

  const stalled = session.activity === 'working' || card.status?.state === 'blocked'
    || card.status?.state === 'paused' || session.attention.some(a => a.blocking && !a.answered)

  if (stalled && now - seenAt({ session }) >= QUEUE_STALL_MS) {
    return `The worker stalled for ${QUEUE_STALL_MS / 60_000} minutes`
  }

  return undefined
}

function checkoutRoot({ cwd }: { cwd: string }): string | undefined {
  const result = spawnSync(
    'git',
    [
      '-C',
      cwd,
      'rev-parse',
      '--show-toplevel',
    ],
    {
      encoding: 'utf8',
      timeout: GIT_TIMEOUT_MS,
    },
  )

  return result.status === 0 ? realpathSync(result.stdout.trim()) : undefined
}

function assertUnshared({
  hydraId,
  state,
  session,
  root,
}: {
  hydraId: string
  state: HydraState
  session: AgentSession
  root: string
}) {
  for (const id of hydraIds()) {
    const current = id === hydraId ? state : loadHydra({ hydraId: id }).state
    const others = Object.values(current.sessions ?? {}).filter(s =>
      (id !== hydraId || s.id !== session.id) && s.taskId && s.agent.cwd && s.activity !== 'ended')

    for (const other of others) {
      if (checkoutRoot({ cwd: other.agent.cwd! }) === root) {
        throw new Error('Another worker uses this folder')
      }
    }
  }
}

async function landedBranch({
  hydraId,
  card,
  session,
  readLanding,
}: {
  readLanding: typeof pullRequestLanding
  hydraId: string
  card: Card
  session: AgentSession
}) {
  const cwd = session.agent.cwd

  if (!cwd || !card.project) {
    throw new Error('The worker needs an isolated project folder')
  }

  const root = realpathSync(await git({
    cwd,
    args: [
      'rev-parse',
      '--show-toplevel',
    ],
  }))
  const projectRoot = realpathSync(await git({
    cwd: card.project,
    args: [
      'rev-parse',
      '--show-toplevel',
    ],
  }))

  if (root === projectRoot) {
    throw new Error('The worker needs an isolated project folder')
  }

  assertUnshared({
    hydraId,
    state: loadHydra({ hydraId }).state,
    session,
    root,
  })

  if (await git({
    cwd,
    args: [
      'status',
      '--porcelain',
    ],
  })) {
    throw new Error('The worker folder has uncommitted changes')
  }

  const head = await git({
    cwd,
    args: [
      'rev-parse',
      'HEAD',
    ],
  })
  const copy = card.copy ?? {
    path: cwd,
    project: card.project,
    via: 'worktree' as const,
    state: 'active' as const,
    branch: await git({
      cwd,
      args: [
        'branch',
        '--show-current',
      ],
    }),
  }
  const context = landingContext({
    copy: {
      ...copy,
      base: undefined,
    },
  })

  if (!context.tip || context.reason) {
    throw new Error(context.reason ?? 'The fetched default branch could not be read')
  }

  const prepared = {
    cwd,
    base: `origin/${context.base}`,
    tip: context.tip,
    head,
    root,
  }

  if (provesLanding({
    copy,
    head,
    context,
  })) {
    return prepared
  }

  const merged = card.links.filter(link => link.kind === 'github_pr' && link.state === 'merged')

  if (!merged.length) {
    return undefined
  }

  for (const pr of merged) {
    const landing = await readLanding({ url: pr.url })

    if (provesLanding({
      copy,
      head,
      context,
      url: pr.url,
      landing,
    })) {
      return prepared
    }
  }

  throw new Error('Local commits are outside the merged pull request or its fetched default branch')
}

async function refreshLinks({
  hydraId,
  card,
  readPR,
  readLanding,
}: {
  hydraId: string
  card: Card
  readPR: typeof pullRequestState
  readLanding: typeof pullRequestLanding
}) {
  for (const link of card.links.filter(l => l.kind === 'github_pr' && l.state !== 'merged')) {
    const state = await readPR({ url: link.url })
    const landing = state === 'merged' ? await readLanding({ url: link.url }) : undefined

    if (state === 'merged' && !landing) {
      continue
    }

    const at = meta().at

    if (state && state !== link.state) {
      withWriter({
        hydraId,
        fn: ({ writer }) => {
          const current = writer.state.cards[card.id]?.links.find(l => l.url === link.url)

          if (current && current.state !== 'merged' && current.state !== state) {
            let observed: typeof current = {
              ...current,
              state,
              checkedAt: at,
            }

            if (landing) {
              observed = mergeObservation({
                link: observed,
                at,
                outcome: {
                  outcome: 'merged',
                  head: landing.head,
                  commit: landing.merge,
                },
              })
            }

            append({
              writer,
              decision: decideLink({
                state: writer.state,
                ref: card.id,
                url: link.url,
                link: observed,
                meta: meta(),
              }),
            })
          }
        },
      })

      if (landing) {
        await confirmedMerge({
          hydraId,
          cardId: card.id,
          url: link.url,
          proof: {
            head: landing.head,
            commit: landing.merge,
            confirmedAt: at,
          },
        })
      }
    }
  }
}

async function deliverHandoffs({
  hydraId,
  active,
}: {
  hydraId: string
  active(): boolean
}) {
  const events = readEvents({ hydraId }).filter((e): e is SessionEvent =>
    e.type === 'task.session' && Boolean(e.data.handoff))

  for (const event of events) {
    const state = loadHydra({ hydraId }).state
    const card = state.cards[event.cardId]
    const id = `brief:${event.id}`

    const receipt = card?.replies?.find(r => r.id === id)

    if (!active() || !card || !taskReadiness({
      state,
      card,
    }).ready || card.sessionIds?.[0] !== event.data.session
      || receipt && receipt.state !== 'failed') {
      continue
    }

    await sendReply({
      hydraId,
      request: {
        card: card.id,
        expectedSession: event.data.session,
        text: event.data.brief!,
        actor: 'pnyx',
        id,
        homes: [],
      },
    })
  }

  const current = loadHydra({ hydraId }).state

  return events.some(event => {
    const card = current.cards[event.cardId]
    const receipt = card?.replies?.find(r => r.id === `brief:${event.id}`)

    return card?.sessionIds?.[0] === event.data.session && (!receipt || receipt.state === 'failed')
  })
}

export async function advanceQueues({
  hydraId,
  now = Date.now(),
  readPR = pullRequestState,
  readLanding = pullRequestLanding,
  presence = checkAttachments,
  active = () => true,
}: {
  hydraId: string
  now?: number
  readPR?({ url }: { url: string }): Promise<LinkState | undefined>
  readLanding?: typeof pullRequestLanding
  presence?: typeof checkAttachments
  active?(): boolean
}): Promise<boolean> {
  const initial = loadHydra({ hydraId }).state

  if (initial.config?.hydra.kind === 'firstmate' || !active()) {
    return false
  }

  const queued = Object.values(initial.cards).flatMap(c => c.queue ? [c.queue.session] : [])
  const ids = [...new Set(queued)]
  const agents = ids.length ? await presence({ state: initial }) : []

  for (const id of ids) {
    if (!active()) {
      return false
    }

    let state = loadHydra({ hydraId }).state
    const session = state.sessions?.[id]
    const reason = unsafeWorker({
      state,
      session,
      presence: agents.find(a => a.session === id)?.state,
      now,
    })

    if (reason) {
      releaseQueue({
        hydraId,
        session: id,
        task: session?.taskId,
        reason,
      })
      continue
    }

    if (agents.find(a => a.session === id)?.state !== 'present') {
      continue
    }

    const current = state.cards[session!.taskId!]!

    if (session!.activity === 'working' || session!.attention.some(a => a.blocking && !a.answered)
      || current.permissions?.some(p => p.status === 'pending')) {
      continue
    }

    try {
      await refreshLinks({
        hydraId,
        card: current,
        readPR,
        readLanding,
      })
      state = loadHydra({ hydraId }).state

      if (state.sessions?.[id]?.taskId !== current.id) {
        continue
      }

      const card = state.cards[current.id]!
      const prs = card.links.filter(l => l.kind === 'github_pr')

      const landed = prs.length ? prs.every(l => l.state === 'merged')
        : card.status?.state === 'done' || Boolean(card.doneAt)

      if (!landed) {
        continue
      }

      const next = workerQueue({
        state,
        session: id,
      })[0]

      if (!next || !taskReadiness({
        state,
        card: next,
      }).ready) {
        continue
      }

      if (!sameProjectPath({
        left: next.project,
        right: card.project,
      }) || next.hidden || next.sessionIds?.length
        || !next.brief?.trim()
        || next.copy && next.copy.state !== 'removed'
        || card.copy?.state === 'removed' || card.copy?.via === 'command') {
        throw new Error('The next task needs a brief and the same project with a reusable git folder')
      }

      const prepared = await landedBranch({
        readLanding,
        hydraId,
        card,
        session: session!,
      })

      if (!prepared || !active()) {
        continue
      }

      const branch = `pnyx/${hydraId}-${next.id}`
      const brief = taskPrompt({
        hydraId,
        card: next,
        prompt: `The previous task "${card.title}" has landed. Your folder is ${prepared.cwd}, on fresh branch ${branch} from fetched ${prepared.base}. Verify the branch and clean status before editing. Use this task's id for all declarations; the previous task is complete.`,
      })

      withWriter({
        hydraId,
        fn: ({ writer }) => {
          drainSpool({ writer })
          const source = writer.state.cards[card.id]
          const target = workerQueue({
            state: writer.state,
            session: id,
          })[0]

          if (source?.revision !== card.revision || target?.id !== next.id
            || !taskReadiness({
              state: writer.state,
              card: target,
            }).ready || target.revision !== next.revision
          || source.sessionIds?.[0] !== id || source.activity === 'working') {
            return
          }

          if (checkoutRoot({ cwd: prepared.cwd }) !== prepared.root) {
            throw new Error('The worker checkout changed during branch preparation')
          }

          assertUnshared({
            hydraId,
            state: writer.state,
            session: session!,
            root: prepared.root,
          })
          const status = spawnSync(
            'git',
            [
              '-C',
              prepared.cwd,
              'status',
              '--porcelain',
            ],
            { encoding: 'utf8' },
          )
          const head = spawnSync(
            'git',
            [
              '-C',
              prepared.cwd,
              'rev-parse',
              'HEAD',
            ],
            { encoding: 'utf8' },
          )

          if (status.status !== 0 || status.stdout.trim() || head.stdout.trim() !== prepared.head) {
            throw new Error('The worker folder changed during branch preparation')
          }

          const run = spawnSync(
            'git',
            [
              '-C',
              prepared.cwd,
              'switch',
              '--no-track',
              '-c',
              branch,
              prepared.tip,
            ],
            {
              encoding: 'utf8',
              timeout: GIT_TIMEOUT_MS,
            },
          )

          if (run.status !== 0) {
            throw new Error(`Cannot create a fresh branch: ${run.stderr?.trim()}`)
          }

          const decision = decideSession({
            state: writer.state,
            fromQueue: id,
            ref: id,
            task: next.id,
            meta: meta(),
          })

          if ('event' in decision && decision.event.type === 'task.session') {
            decision.event.data.handoff = {
              folder: prepared.cwd,
              column: roleColumn({
                columns: hydraConfig({ state: writer.state }).columns,
                role: 'in_progress',
              }) ?? next.column,
              ...(source.copy ? {
                copy: {
                  ...source.copy,
                  branch,
                  base: prepared.base.replace(
                    /^origin\//,
                    '',
                  ),
                  state: 'active',
                },
              } : {}),
            }
            decision.event.data.brief = brief
            writer.append({ event: decision.event })
          }
        },
      })
    } catch (error) {
      if (active()) {
        releaseQueue({
          hydraId,
          session: id,
          task: current.id,
          reason: (error as Error).message,
        })
      }
    }
  }

  if (active()) {
    return deliverHandoffs({
      hydraId,
      active,
    })
  }

  return false
}
