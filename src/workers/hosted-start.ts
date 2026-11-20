import { nativeIdle } from './native-session.ts'
import { decideReply } from './reply-rules.ts'
import { requireHandoffAvailable } from './handoff-checkout.ts'
import { realpathSync } from 'node:fs'
import { BROWSER_TOOL, requireToolAuthority, toolNames, writeTools } from './tools.ts'
import { requireCopyAvailable } from '#projects/copy-lease.ts'
import { transcriptPath } from './claude.ts'
import type { trackChildren } from './children.ts'
import { accountEnvironment } from './dispatch.ts'
import { isFolder } from './folders.ts'
import { WORKER_COMMANDS } from './host.ts'
import type { AgentRef, AgentSession } from './model.ts'
import type { Presence } from './presence.ts'
import type { HostedSession, Provider } from './provider.ts'
import { DEFAULT_PROVIDER, PROVIDERS, harnessOf, knownProvider } from './providers.ts'
import { sessionId, withoutInterrupted } from './session-attachments.ts'
import { decideSession } from './sessions.ts'
import { freeTask } from './start.ts'
import { hydraEvent } from '#hydra/hydra.ts'
import { decideOutcome } from '#tasks/delivery/outcome.ts'
import { requireUnheld } from '#tasks/holds.ts'
import type { Card } from '#tasks/model.ts'
import { decidePush } from '#tasks/push.ts'
import { findCard } from '#tasks/push-rules.ts'
import { taskInstructions } from '#tasks/owner-ask.ts'
import { liveTask } from '#tasks/select.ts'
import { HydraError } from '#store/errors.ts'
import { applyDecision } from '#app/decision.ts'
import type { Host, Live } from '#app/host-types.ts'
import { withWriter, type Writer } from '#app/writer.ts'
import { loadHydra } from '#app/store.ts'
import { base } from '#app/command-meta.ts'

// Starting a worker in Pnyx, and continuing an outside Claude Code or Codex session in Pnyx.
export function createWorkerStarts({
  hydraId,
  live,
  closing,
  at,
  write,
  changed,
  presence,
  providerOf,
  environment,
  controller,
  children,
  open,
  folderOf,
}: {
  hydraId: string
  live: Map<string, Live>
  closing(): boolean
  at(): string
  write<T>({ fn }: { fn: ({ writer }: { writer: Writer }) => T }): T
  changed(): void
  presence({ session }: { session: AgentSession }): Presence
  providerOf({
    provider,
    taskId,
  }: {
    provider: string
    taskId?: string
  }): Provider
  environment({
    task,
    steeringWorker,
  }: {
    task?: string
    steeringWorker?: string
  }): NodeJS.ProcessEnv
  controller: AbortController
  children: ReturnType<typeof trackChildren>
  open({
    card,
    session,
  }: {
    card: Card & { agent: AgentRef }
    session?: HostedSession
  }): Live
  folderOf({ card }: { card: Card & { agent: AgentRef } }): string
}) {
  const starting = new Set<string>()

  const outsideSession = ({
    writer,
    card,
  }: {
    writer: Writer
    card: Card
  }): AgentSession => {
    const agent = card.agent

    if (!liveTask({ card }) || !agent || !knownProvider({ name: agent.provider })
      || agent.host || agent.agentId || agent.paseoAgentId) {
      throw new HydraError({
        message: 'Continue in Pnyx needs an outside Claude Code or Codex session attached to a task',
        code: 'NO_ROUTE',
      })
    }

    const session = writer.state.sessions?.[sessionId({ agent })]

    if (!session || session.taskId !== card.id) {
      throw new HydraError({
        message: 'the session is no longer attached to this task',
        code: 'SESSION_CONFLICT',
      })
    }

    return session
  }

  const requireGone = ({ current }: { current: Presence }) => {
    if (current.state !== 'gone') {
      throw new HydraError({
        message: current.state === 'present' ? 'the outside session still runs in its terminal; end it before continuing in Pnyx' : `cannot confirm the outside session has ended: ${current.detail}`,
        code: 'SESSION_RUNNING',
        help: ['End the outside session, then try Continue in Pnyx again'],
      })
    }
  }

  const startTarget = ({
    writer,
    ref,
    replacement,
    inputId,
  }: {
    writer: Writer
    ref: string
    replacement?: string
    inputId?: string
  }): Card => {
    const target = findCard({
      state: writer.state,
      ref,
    })
    requireHandoffAvailable({
      hydraId,
      task: target.id,
    })

    requireCopyAvailable({
      hydraId,
      task: target.id,
    })

    if (!replacement) {
      return freeTask({
        state: writer.state,
        ref,
      })
    }

    const card = findCard({
      state: writer.state,
      ref,
    })

    if (inputId && card.agent?.host === 'pnyx') {
      const queued = card.replies?.find(reply => reply.id === inputId && reply.state === 'queued' && reply.worker)
      const current = sessionId({ agent: card.agent })
      const running = live.get(current)
      const busy = running && (running.activity === 'working' || !running.session
        || !nativeIdle({ work: running.session.snapshot().work }))

      if (!queued || current !== replacement || busy) {
        throw new HydraError({
          message: 'The worker changed or is still working',
          code: 'SESSION_CONFLICT',
        })
      }

      return card
    }

    const previous = outsideSession({
      writer,
      card,
    })

    if (previous.id !== replacement) {
      throw new HydraError({
        message: 'the task has a different session now; reopen its card before starting fresh',
        code: 'SESSION_CONFLICT',
      })
    }

    requireGone({ current: presence({ session: previous }) })

    return card
  }

  const start: Host['start'] = async ({
    task,
    prompt,
    folder,
    settings,
    id,
    actor,
    reason,
    replacement,
    inputId,
    dispatch,
    tools,
  }) => {
    const {
      target,
      duplicate,
    } = write({
      fn: ({ writer }) => {
        const target = findCard({
          state: writer.state,
          ref: task,
        })
        const duplicate = `${id}:attach` in writer.state.eventIds

        if (!duplicate) {
          startTarget({
            writer,
            ref: task,
            replacement,
            inputId,
          })
        }

        return {
          target,
          duplicate,
        }
      },
    })

    if (duplicate) {
      return {
        task: target.id,
        event: 'none: duplicate',
        help: ['This start was already recorded; nothing was started again'],
      }
    }

    if (tools) {
      requireToolAuthority({
        meta: {
          actor,
          at: at(),
        },
      })
    }

    if (starting.has(target.id)) {
      throw new HydraError({
        message: `task ${target.id} is already starting`,
        code: 'TASK_STARTING',
        help: [`Check \`pnyx-axi task show ${target.id}\` once its session opens`],
      })
    }

    const requestedFolder = folder ?? target.folder

    if (!requestedFolder || !isFolder({ path: requestedFolder })) {
      throw new HydraError({
        message: requestedFolder ? `folder not found: ${requestedFolder}` : 'choose the folder the agent works in',
        code: 'VALIDATION_ERROR',
        help: ['Pass --folder <absolute path>'],
      })
    }

    const cwd = realpathSync(requestedFolder)
    const toolsRevision = target.toolsRevision

    const {
      provider: requested,
      ...options
    } = settings
    const provider = requested ?? DEFAULT_PROVIDER
    settings = options
    starting.add(target.id)
    let session: HostedSession | undefined

    try {
      const prepared = await providerOf({
        provider,
        taskId: target.id,
      }).open({
        cwd,
        capabilities: tools ? toolNames({
          names: [
            ...(target.tools ?? []).filter(name => name === BROWSER_TOOL),
            ...tools,
          ],
        }) : undefined,
        settings,
        allow: WORKER_COMMANDS,
        env: dispatch ? accountEnvironment({
          account: {
            provider: dispatch.provider,
            folder: dispatch.folder,
          },
          env: environment({
            task: target.id,
            steeringWorker: `${id}:attach`,
          }),
        }) : environment({
          task: target.id,
          steeringWorker: `${id}:attach`,
        }),
        signal: controller.signal,
        spawned: children.spawned,
      })
      session = prepared

      if (closing()) {
        throw new Error('Pnyx is stopping')
      }

      const transaction = tools ? {
        id: `${id}:claim`,
        digest: JSON.stringify({
          task,
          tools,
          actor,
        }),
      } : undefined

      const claim = ({ writer }: { writer: Writer }) => {
        const card = findCard({
          state: writer.state,
          ref: task,
        })

        if (`${id}:attach` in writer.state.eventIds) {
          return {
            task: card.id,
            duplicate: true,
          }
        }

        if (card.toolsRevision !== toolsRevision) {
          throw new HydraError({
            message: 'the task tools changed while its agent was starting; retry the start',
            code: 'CONFLICT',
          })
        }

        startTarget({
          writer,
          ref: task,
          replacement,
          inputId,
        })

        if ((folder ?? card.folder) !== requestedFolder) {
          throw new HydraError({
            message: 'the task folder changed while its agent was starting; retry the start',
            code: 'CONFLICT',
          })
        }

        if (!isFolder({ path: cwd })) {
          throw new HydraError({
            message: `folder not found: ${cwd}`,
            code: 'VALIDATION_ERROR',
            help: ['Pass --folder <absolute path>'],
          })
        }

        const meta = {
          at: at(),
          actor,
          ...(reason ? { reason } : {}),
        }

        const agent: AgentRef = {
          provider,
          sessionId: prepared.id,
          cwd,
          ...(prepared.path ? { transcriptPath: prepared.path } : {}),
          host: 'pnyx',
          ...(dispatch ? {
            account: dispatch.account,
            loginFolder: dispatch.folder,
          } : {}),
        }
        const sessionKey = sessionId({ agent })

        if (writer.state.sessions?.[sessionKey]) {
          return {
            task: card.id,
            duplicate: true,
            existing: sessionKey,
          }
        }

        if (replacement) {
          applyDecision({
            writer,
            decision: decideSession({
              state: writer.state,
              ref: replacement,
              task: null,
              meta: {
                ...meta,
                id: `${id}:detach`,
              },
            }),
          })
        }

        const attention = withoutInterrupted({ attention: card.attention })
        const input = {
          ...(cwd !== card.folder ? { folder: cwd } : {}),
          ...(attention.length !== card.attention.length ? { attention } : {}),
        }

        if (Object.keys(input).length) {
          applyDecision({
            writer,
            decision: decidePush({
              state: writer.state,
              key: card.key,
              input,
              meta: {
                ...meta,
                id: `${id}:folder`,
              },
            }),
          })
        }

        applyDecision({
          writer,
          decision: {
            event: {
              ...base({
                state: writer.state,
                cardId: card.id,
                meta: {
                  ...meta,
                  id: `${id}:attach`,
                },
              }),
              type: 'task.session',
              data: {
                session: sessionKey,
                before: null,
                after: card.id,
                started: {
                  agent,
                  settings,
                },
                working: true,
                brief: taskInstructions({ card }),
              },
            },
          },
        })

        if (tools) {
          writeTools({
            writer,
            task: card.id,
            grant: tools,
            meta: {
              ...meta,
              id: `${id}:tools`,
            },
          })
          prepared.toolsRevision = writer.state.cards[card.id]?.toolsRevision
        }

        if (dispatch) {
          applyDecision({
            writer,
            decision: hydraEvent({
              state: writer.state,
              meta: {
                ...meta,
                id: `${id}:dispatch`,
              },
              cardId: card.id,
              change: {
                type: 'task.launched',
                data: {
                  via: 'pnyx',
                  at: meta.at,
                  folder: cwd,
                  harness: dispatch.provider,
                  dispatch: dispatch.reason,
                  ...(dispatch.override ? { override: dispatch.override } : {}),
                },
              },
            }),
          })
        }

        if (transaction) {
          writer.append({
            event: {
              ...base({
                state: writer.state,
                meta: {
                  ...meta,
                  id: transaction.id,
                },
                cardId: '$board',
              }),
              type: 'apply.recorded',
              data: { digest: transaction.digest },
            },
            effects: false,
          })
        }

        if (inputId) {
          const queued = card.replies?.find(reply => reply.id === inputId && reply.worker)

          if (!queued?.worker) {
            throw new HydraError({
              message: 'The starting message is missing',
              code: 'CONFLICT',
            })
          }

          applyDecision({
            writer,
            decision: decideReply({
              state: writer.state,
              ref: card.id,
              data: {
                reply: inputId,
                state: 'queued',
                route: 'pnyx',
                worker: {
                  agent: queued.worker.agent,
                  session: sessionKey,
                },
              },
              meta,
            }),
          })
        }

        // The receipt is saved in the log, so it names the card rather than copying it.
        return {
          task: card.id,
          duplicate: false,
        }
      }

      const claimed = transaction ? withWriter({
        hydraId,
        transaction,
        fn: claim,
      }) as ReturnType<typeof claim> : write({ fn: claim })

      if (tools) {
        changed()
      }

      if (claimed.duplicate) {
        session.close()

        if ('existing' in claimed && claimed.existing) {
          return {
            task: claimed.task,
            launch: 'pending',
            session: claimed.existing,
            information: 'The provider returned an existing session. Pnyx kept its current worker unchanged.',
            help: ['Retry the same start request to open a fresh worker, or use `pnyx-axi task sessions` to see the existing session'],
          }
        }

        return {
          task: claimed.task,
          event: 'none: duplicate',
          help: ['This start was already recorded; nothing was started again'],
        }
      }

      const started = loadHydra({ hydraId }).state.cards[claimed.task] as Card & { agent: AgentRef }
      const entry = open({
        card: started,
        session,
      })
      entry.activity = 'working'
      entry.sentAt = Date.now()

      if (inputId) {
        entry.pendingDirect.set(
          inputId,
          {
            card: started.id,
            taken: false,
          },
        )
      }

      entry.input.push({
        id: inputId ?? `${id}:launch-input`,
        text: prompt,
      })

      return {
        task: started.id,
        agent: {
          harness: harnessOf({ provider }),
          session: started.agent.sessionId,
          folder: started.agent.cwd,
          host: 'pnyx',
        },
        help: [`Run \`pnyx-axi reply ${started.id} --text <text>\` to continue; the Pnyx server runs the agent`],
      }
    } catch (error) {
      session?.close()
      throw error
    } finally {
      starting.delete(target.id)
    }
  }

  const continueInPnyx: Host['continue'] = ({
    task,
    id,
    actor,
    reason,
    check,
  }) => write({
    fn: ({ writer }) => {
      const card = findCard({
        state: writer.state,
        ref: task,
      })

      requireUnheld({ card })

      if (!check && `${id}:continue` in writer.state.eventIds) {
        return {
          task: card.id,
          event: 'none: duplicate',
        }
      }

      const session = outsideSession({
        writer,
        card,
      })
      const agent = session.agent

      const current = presence({ session })

      if (check) {
        return {
          task: card.id,
          canContinue: current.state === 'gone',
          folderMissing: !agent.cwd || !isFolder({ path: agent.cwd }),
          ...current,
        }
      }

      requireGone({ current })

      const cwd = folderOf({
        card: {
          ...card,
          agent,
        },
      })
      const meta = {
        at: at(),
        actor,
        ...(reason ? { reason } : {}),
      }
      applyDecision({
        writer,
        decision: decidePush({
          state: writer.state,
          key: card.key,
          input: {
            agent: {
              ...agent,
              host: 'pnyx',
              resume: true,
              ...(agent.provider === PROVIDERS.claude.provider && !agent.transcriptPath ? {
                transcriptPath: transcriptPath({
                  cwd,
                  session: agent.sessionId,
                }),
              } : {}),
            },
            terminal: {},
            activity: 'finished',
            source: {
              adapter: 'pnyx',
              objectId: agent.sessionId,
              observedAt: at(),
            },
            attention: card.attention.filter(a => !a.key.startsWith('hook:')),
          },
          meta: {
            ...meta,
            id: `${id}:continue`,
          },
        }),
      })

      if (card.outcome?.source === 'hooks') {
        applyDecision({
          writer,
          decision: decideOutcome({
            state: writer.state,
            ref: card.id,
            outcome: null,
            source: 'hooks',
            meta: {
              ...meta,
              id: `${id}:outcome`,
            },
          }),
        })
      }

      return {
        task: card.id,
        agent: {
          harness: harnessOf({ provider: agent.provider }),
          session: agent.sessionId,
          folder: agent.cwd,
          host: 'pnyx',
        },
        help: [`Send a message with \`pnyx-axi reply ${card.id} --text <text>\` to resume the session in Pnyx`],
      }
    },
  })

  return {
    start,
    continueInPnyx,
    starting: ({ task }: { task: string }) => starting.has(task),
  }
}
