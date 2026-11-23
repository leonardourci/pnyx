import { randomUUID } from 'node:crypto'
import { git, checkoutRoot, checkoutState, matchesCheckout, restoreCheckout, saveHandoff, clearHandoff, readHandoffEvent, otherWorkers, handoffPending } from './handoff-checkout.ts'
import { sameProjectPath } from '#projects/identity.ts'
import { copySettling } from '#projects/copy-lease.ts'
import { createTaskBranch } from '#projects/git.ts'
import { branchHydraName, recordedBranches } from '#projects/copy-pool.ts'
import { landingContext, provesLanding } from '#tasks/delivery/proof.ts'
import { taskReadiness } from '#tasks/dependencies.ts'
import { statSync } from 'node:fs'
import type { HydraState } from '#app/model.ts'
import { decideLink } from '#tasks/delivery/links.ts'
import { decideSession } from './sessions.ts'
import { hydraEvent } from '#hydra/hydra.ts'
import type { Card } from '#tasks/model.ts'
import type { LinkState } from '#tasks/delivery/model.ts'
import type { AgentSession } from './model.ts'
import { taskPrompt } from './worker-brief.ts'
import { refreshConfirmedProject } from '#projects/refresh-confirmed.ts'
import { mergeObservation } from '#tasks/delivery/merge-observation.ts'
import { sendReply } from './reply.ts'
import { pullRequestLanding, pullRequestState } from '#integrations/github/pull-request.ts'
import { checkAttachments, seenAt } from './presence.ts'
import { drainSpool } from '#integrations/hooks/ingest.ts'
import { loadHydra } from '#app/store.ts'
import { log } from '#app/diagnostics.ts'
import { scanEvents } from '#app/event-log.ts'
import { withWriter } from '#app/writer.ts'
import { QUEUE_CONTEXT_BYTES, QUEUE_MAX_TASKS, QUEUE_STALL_MS, workerQueue } from './queue.ts'
import { pendingPermissions } from './permission-rules.ts'
import { applyDecision } from '#app/decision.ts'

const meta = () => ({
  actor: 'pnyx',
  at: new Date().toISOString(),
})

const errorText = ({ error }: { error: unknown }) =>
  error instanceof Error ? error.message : String(error)

function contextSize({ session }: { session: AgentSession }): number {
  try {
    return session.agent.transcriptPath ? statSync(session.agent.transcriptPath).size : 0
  } catch {
    return 0
  }
}

function handoffBlocked({
  hydraId,
  task,
}: {
  hydraId: string
  task: string
}): boolean {
  return handoffPending({
    hydraId,
    task,
  }) || copySettling({
    hydraId,
    task,
  })
}

function workerIdle({
  card,
  session,
}: {
  card: Card
  session: AgentSession
}): boolean {
  const busy = card.activity === 'working' || session.activity === 'working' || session.activity === 'ended'
  const waiting = session.attention.some(a => a.blocking && !a.answered)
    || pendingPermissions({ card }).length > 0

  return !busy && !waiting
}

async function releaseQueue({
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
  await withWriter({
    hydraId,
    fn: ({ writer }) => {
      const current = writer.state.sessions?.[session]?.taskId

      if (current !== task) {
        return
      }

      const previous = current && writer.state.cards[current]
      const note = `Continue after ${previous ? `"${previous.title}" (${previous.id})` : session}. ${reason}. Read its task.log and worker.log before starting a fresh worker.`

      for (const card of workerQueue({
        state: writer.state,
        session,
      })) {
        applyDecision({
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

  const stalled = session.activity === 'working'
    || card.workerLog?.status?.code === 'blocked'
     || session.attention.some(a => a.blocking && !a.answered)

  if (stalled && now - seenAt({ session }) >= QUEUE_STALL_MS) {
    return `The worker stalled for ${QUEUE_STALL_MS / 60_000} minutes`
  }

  return undefined
}

// The checkout each other live worker's folder belongs to, read before the write.
async function workerRoots({
  hydraId,
  session,
}: {
  hydraId: string
  session: AgentSession
}): Promise<Map<string, string | undefined>> {
  const roots = new Map<string, string | undefined>()

  for (const other of otherWorkers({
    hydraId,
    state: loadHydra({ hydraId }).state,
    session,
  })) {
    const cwd = other.agent.cwd

    if (cwd && !roots.has(cwd)) {
      roots.set(
        cwd,
        await checkoutRoot({ cwd }),
      )
    }
  }

  return roots
}

function assertUnshared({
  hydraId,
  state,
  session,
  root,
  roots,
}: {
  hydraId: string
  state: HydraState
  session: AgentSession
  root: string
  roots: ReadonlyMap<string, string | undefined>
}) {
  if (otherWorkers({
    hydraId,
    state,
    session,
  }).some(other => {
    const cwd = other.agent.cwd

    return cwd && (cwd === session.agent.cwd || !roots.has(cwd) || roots.get(cwd) === root)
  })) {
    throw new Error('Another worker uses this folder or its checkout could not be checked')
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

  const [
    root,
    projectRoot,
  ] = await Promise.all([
    checkoutRoot({ cwd }),
    checkoutRoot({ cwd: card.project }),
  ])

  if (!root || !projectRoot || root === projectRoot) {
    throw new Error('The worker needs an isolated project folder')
  }

  if (card.copy && !sameProjectPath({
    left: card.copy.path,
    right: root,
  })) {
    throw new Error('The worker checkout is outside its recorded task copy')
  }

  assertUnshared({
    hydraId,
    state: loadHydra({ hydraId }).state,
    session,
    root,
    roots: await workerRoots({
      hydraId,
      session,
    }),
  })

  const checkout = await checkoutState({ cwd })

  if (checkout.dirty) {
    throw new Error('The worker folder has uncommitted changes')
  }

  const {
    head,
    branch: previousBranch,
  } = checkout

  const copy = card.copy ?? {
    path: cwd,
    project: card.project,
    via: 'worktree' as const,
    state: 'active' as const,
    branch: previousBranch,
  }
  const context = await landingContext({
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
    project: copy.project,
    base: `origin/${context.base}`,
    tip: context.tip,
    head,
    previousBranch,
    root,
  }

  if (await provesLanding({
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

    if (await provesLanding({
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
      await withWriter({
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

            applyDecision({
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
        await refreshConfirmedProject({
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
  const events = scanEvents({
    hydraId,
    types: ['task.session'],
  })

  for (const event of events) {
    if (event.type !== 'task.session' || !event.data.handoff || event.data.brief === undefined) {
      continue
    }

    const state = loadHydra({ hydraId }).state
    const card = state.cards[event.cardId]
    const id = `brief:${event.id}`

    const receipt = card?.replies?.find(r => r.id === id)

    if (!active() || !card || !taskReadiness({
      state,
      card,
    }).ready || card.sessionIds?.[0] !== event.data.session
      || receipt && receipt.state !== 'failed' || handoffPending({
      hydraId,
      task: card.id,
    })) {
      continue
    }

    await sendReply({
      hydraId,
      request: {
        card: card.id,
        expectedSession: event.data.session,
        text: event.data.brief,
        actor: 'pnyx',
        id,
      },
    })
  }

  const current = loadHydra({ hydraId }).state

  return Boolean(scanEvents({
    hydraId,
    types: ['task.session'],
  }).find(event => {
    if (event.type !== 'task.session' || !event.data.handoff || event.data.brief === undefined) {
      return false
    }

    const card = current.cards[event.cardId]
    const receipt = card?.replies?.find(r => r.id === `brief:${event.id}`)

    return card?.sessionIds?.[0] === event.data.session && (!receipt || receipt.state === 'failed')
  }))
}

export async function advanceQueues({
  hydraId,
  now = Date.now(),
  readPR = pullRequestState,
  readLanding = pullRequestLanding,
  presence = checkAttachments,
  active = () => true,
  state: initial,
}: {
  hydraId: string
  now?: number
  readPR?({ url }: { url: string }): Promise<LinkState | undefined>
  readLanding?: typeof pullRequestLanding
  presence?: typeof checkAttachments
  active?(): boolean
  // The Hydra the server already holds; each queued session is read again from disk.
  state: HydraState
}): Promise<boolean> {
  if (!active()) {
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
      await releaseQueue({
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

    const current = session?.taskId ? state.cards[session.taskId] : undefined

    if (!session || !current || !workerIdle({
      card: current,
      session,
    })) {
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

      const attached = state.sessions?.[id]

      if (attached?.taskId !== current.id) {
        continue
      }

      const card = state.cards[current.id]

      if (!card) {
        continue
      }

      const sourceRevision = card.revision
      const prs = card.links.filter(l => l.kind === 'github_pr')

      const landed = prs.length ? prs.every(l => l.state === 'merged')
        : card.workerLog?.status?.code === 'done' || Boolean(card.doneAt)

      if (!landed) {
        continue
      }

      const next = workerQueue({
        state,
        session: id,
      })[0]

      if (!next || handoffBlocked({
        hydraId,
        task: card.id,
      })
        || handoffBlocked({
          hydraId,
          task: next.id,
        }) || !taskReadiness({
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

      const targetRevision = next.revision
      const prepared = await landedBranch({
        readLanding,
        hydraId,
        card,
        session: attached,
      })

      if (!prepared || !active()) {
        continue
      }

      let brief: string | undefined

      const prepare = async ({ branch }: { branch: string }) => {
        if (await checkoutRoot({ cwd: prepared.cwd }) !== prepared.root) {
          throw new Error('The worker checkout changed during branch preparation')
        }

        brief = await taskPrompt({
          hydraId,
          card: next,
          prompt: `The previous task "${card.title}" has landed. Your folder is ${prepared.cwd}, on fresh branch ${branch} from fetched ${prepared.base}. Verify the branch and clean status before editing. Append updates to this task's worker.log.`,
        })

        const currentState = loadHydra({ hydraId }).state
        const currentSource = currentState.cards[card.id]
        const currentTarget = workerQueue({
          state: currentState,
          session: id,
        })[0]

        return currentSource?.revision === sourceRevision && currentTarget?.id === next.id
          && currentTarget.revision === targetRevision
          && currentState.sessions?.[id]?.agent.cwd === prepared.cwd
      }

      const branch = await createTaskBranch({
        cwd: prepared.cwd,
        start: prepared.tip,
        active,
        prepare,
        hydraName: branchHydraName({
          hydraId,
          state,
        }),
        task: next.id,
        title: next.title,
        reserved: recordedBranches({
          hydraId,
          state,
          project: prepared.project,
        }),
      })

      if (!active()) {
        return false
      }

      if (!branch || brief === undefined) {
        continue
      }

      const roots = await workerRoots({
        hydraId,
        session: attached,
      })
      const unchanged = await matchesCheckout({
        cwd: prepared.cwd,
        root: prepared.root,
        branch: prepared.previousBranch,
        head: prepared.head,
      })

      if (!unchanged) {
        throw new Error('The worker folder changed during branch preparation')
      }

      assertUnshared({
        hydraId,
        state: loadHydra({ hydraId }).state,
        session: attached,
        root: prepared.root,
        roots,
      })

      if (!active()) {
        return false
      }

      if (handoffBlocked({
        hydraId,
        task: card.id,
      }) || handoffBlocked({
        hydraId,
        task: next.id,
      })) {
        continue
      }

      const eventId = randomUUID()
      const handoffFile = saveHandoff({
        hydraId,
        intent: {
          eventId,
          session: id,
          source: card.id,
          target: next.id,
          cwd: prepared.cwd,
          root: prepared.root,
          branch,
          tip: prepared.tip,
          previousBranch: prepared.previousBranch,
          previousHead: prepared.head,
        },
      })
      let appendAttempted = false
      let recorded = false
      let failure: { error: unknown } | undefined

      try {
        await git({
          cwd: prepared.cwd,
          args: [
            'switch',
            '--no-guess',
            branch,
          ],
        })
        const switched = await matchesCheckout({
          cwd: prepared.cwd,
          root: prepared.root,
          branch,
          head: prepared.tip,
        })

        if (!switched) {
          throw new Error('The worker folder changed during handoff checkout')
        }

        recorded = Boolean(await withWriter({
          hydraId,
          fn: ({ writer }) => {
            drainSpool({ writer })
            const source = writer.state.cards[card.id]
            const target = workerQueue({
              state: writer.state,
              session: id,
            })[0]
            const currentSession = writer.state.sessions?.[id]

            if (!active() || source?.revision !== sourceRevision || target?.id !== next.id
              || target.revision !== targetRevision || source.sessionIds?.[0] !== id
              || currentSession?.taskId !== card.id || currentSession.agent.cwd !== prepared.cwd) {
              return
            }

            if (!workerIdle({
              card: source,
              session: currentSession,
            })) {
              return
            }

            if (!taskReadiness({
              state: writer.state,
              card: target,
            }).ready) {
              return
            }

            assertUnshared({
              hydraId,
              state: writer.state,
              session: attached,
              root: prepared.root,
              roots,
            })
            const decision = decideSession({
              state: writer.state,
              fromQueue: id,
              ref: id,
              task: next.id,
              meta: {
                ...meta(),
                id: eventId,
              },
            })

            if ('event' in decision && decision.event.type === 'task.session') {
              decision.event.data.handoff = {
                folder: prepared.cwd,
              }

              if (source.copy) {
                decision.event.data.handoff.copy = {
                  ...source.copy,
                  branch,
                  base: prepared.base.replace(
                    /^origin\//,
                    '',
                  ),
                  state: 'active',
                }
              }

              decision.event.data.brief = brief
              appendAttempted = true
              writer.append({ event: decision.event })

              return true
            }
          },
        }))
      } catch (error) {
        failure = { error }

        if (appendAttempted) {
          try {
            recorded = Boolean(readHandoffEvent({
              hydraId,
              eventId,
            }))
          } catch (outcomeError) {
            throw new AggregateError(
              [
                error,
                outcomeError,
              ],
              `Handoff outcome unknown; checkout retained on ${branch}`,
              { cause: outcomeError },
            )
          }
        }

        if (recorded) {
          log({
            level: 'warn',
            operation: 'confirm committed worker handoff',
            hydraId,
            taskId: next.id,
            error,
          })
        }
      }

      if (!recorded) {
        try {
          const rollbackRoots = await workerRoots({
            hydraId,
            session: attached,
          })
          assertUnshared({
            hydraId,
            state: loadHydra({ hydraId }).state,
            session: attached,
            root: prepared.root,
            roots: rollbackRoots,
          })
          await restoreCheckout({
            cwd: prepared.cwd,
            root: prepared.root,
            branch,
            tip: prepared.tip,
            previousBranch: prepared.previousBranch,
            previousHead: prepared.head,
          })
        } catch (restoreError) {
          if (failure) {
            throw new AggregateError(
              [
                failure.error,
                restoreError,
              ],
              `${errorText({ error: failure.error })}; ${errorText({ error: restoreError })}`,
              { cause: restoreError },
            )
          }

          throw restoreError
        }
      }

      clearHandoff({ path: handoffFile })

      if (failure && !recorded) {
        throw failure.error
      }
    } catch (error) {
      log({
        level: 'error',
        operation: 'worker handoff',
        hydraId,
        taskId: current.id,
        error,
      })

      if (active()) {
        await releaseQueue({
          hydraId,
          session: id,
          task: current.id,
          reason: errorText({ error }),
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
