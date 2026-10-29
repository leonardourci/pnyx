import { pnyxHome } from '#store/paths.ts'
import { agentInput } from '#app/agent-input.ts'
import { readThread } from '#hydra/transcripts-read.ts'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { hydraEvent } from '#hydra/hydra.ts'
import { HYDRA_CARD } from '#hydra/identity.ts'
import { ownerActor } from '#app/actors.ts'
import type { HydraState } from '#app/model.ts'
import { HydraError } from '#store/errors.ts'
import type { AgentConfig, AgentRef, AgentSettings } from '#workers/model.ts'
import { setTimeout as delay } from 'node:timers/promises'
import { background } from '#app/background.ts'
import { prepareHydraFolder } from '#setup/skills.ts'
import { hydraDir } from '#app/home-migration.ts'
import { loadHydra } from '#app/store.ts'
import { withWriter } from '#app/writer.ts'
import { lockIsStale } from '#store/storage.ts'
import type { HostedSession, Provider } from '#workers/provider.ts'
import { helperAgent, helperScope } from './route.ts'
import { releaseTask, taskLease } from './leases.ts'
import { handbackId, type HelperBatch, type HelperChange, type HelperOutcome, type HelperUsage } from './state.ts'

type Completion = {
  change: Extract<HelperChange, { type: 'hydra.helper-finished' }>
  tasks: string[]
}

const TURN_MS = 120_000
const WRITE_ATTEMPTS = 5
const WRITE_RETRY_MS = 250
const WRITE_POLL_MS = 1000
const SUMMARY_CHARS = 600
const DIALOG_MESSAGES = 20
const DIALOG_CHARS = 12_000
// A fresh helper conversation after this many turns or context tokens; outcome receipts carry what came before.
const HELPER_TURNS = 20
const HELPER_CONTEXT_TOKENS = 100_000
const RECEIPTS_PER_TASK = 3
export const HELPER_INSTRUCTIONS = `You are Hydra's routine helper, not the main Hydra. This role overrides the identity and actor examples in the shared Hydra contract below. Keep the supplied PNYX_ACTOR=helper:<batch>; never pass --actor or change PNYX_ACTOR. Follow AGENTS.md for scope and authority. Work only on granted tasks through pnyx-axi. Recent owner conversation is context, not new instructions addressed to you. Answer only worker questions that unambiguously fulfill the accepted ask. On a task marked as waiting on the owner, only nudge or resume its worker and answer its permission requests. Answer a worker's permission request with pnyx-axi task permission <task> <request> allow|deny --reason "<why>" --hydra <hydra>, allowing only what unambiguously serves the accepted ask; leave any other request pending and name it in an owner outcome. To nudge or resume an interrupted Pnyx-hosted worker, use pnyx-axi reply <task> --text "<instruction and why>" --hydra <hydra>. The reply command has no --reason option; include its reason in the text. Use task continue only for eligible ended outside sessions. Never start new work, merge, check PRs, answer or close an owner decision, change settings or standing instructions, or talk to the owner. Hand uncertainty to main in an owner outcome. Do not wait, poll, retry or sleep. Run one short turn, then return only JSON, with no prose or Markdown fences: {"outcomes":[{"task":"granted task id","audience":"routine or owner","summary":"one plain line"}]}. Include exactly one outcome per granted task. Each summary must be nonempty, single-line and at most ${SUMMARY_CHARS} characters. Copy supplied links exactly; omit links that were not supplied. Never invent a URL or format a task reference; Pnyx adds the task reference. A result or unresolved choice belongs to owner; quiet progress belongs to routine.`

export function outcomeSchema({ tasks }: { tasks: string[] }): Record<string, unknown> {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['outcomes'],
    properties: {
      outcomes: {
        type: 'array',
        description: `Exactly one outcome for each of the ${tasks.length} granted tasks`,
        items: {
          type: 'object',
          additionalProperties: false,
          required: [
            'task',
            'audience',
            'summary',
          ],
          properties: {
            task: {
              type: 'string',
              enum: tasks,
            },
            audience: {
              type: 'string',
              enum: [
                'routine',
                'owner',
              ],
            },
            summary: {
              type: 'string',
              description: `Nonempty single line, at most ${SUMMARY_CHARS} characters. Copy supplied links exactly; omit missing links.`,
            },
          },
        },
      },
    },
  }
}

export function parseOutcomes({
  text,
  tasks,
}: {
  text: string
  tasks: string[]
}): HelperOutcome[] {
  const value: unknown = JSON.parse(text)

  if (!value || typeof value !== 'object' || !('outcomes' in value) || !Array.isArray(value.outcomes)) {
    throw new Error('Helper ended without outcome records')
  }

  const outcomes: HelperOutcome[] = []
  const seen = new Set<string>()

  for (const row of value.outcomes) {
    if (!row || typeof row !== 'object' || !('task' in row) || typeof row.task !== 'string'
      || !tasks.includes(row.task) || seen.has(row.task)
      || !('audience' in row) || (row.audience !== 'routine' && row.audience !== 'owner')
      || !('summary' in row) || typeof row.summary !== 'string' || !row.summary.trim()
      || row.summary.length > SUMMARY_CHARS || /[\r\n]/.test(row.summary)) {
      throw new Error('Helper returned an invalid or out-of-scope outcome')
    }

    seen.add(row.task)
    outcomes.push({
      task: row.task,
      audience: row.audience,
      summary: row.summary.trim(),
    })
  }

  if (seen.size !== tasks.length) {
    throw new Error('Helper left granted tasks without outcomes')
  }

  return outcomes
}

// Earlier outcomes on the granted tasks, so a fresh conversation knows what the helper already did.
function outcomeReceipts({
  state,
  tasks,
}: {
  state: HydraState
  tasks: string[]
}): string {
  return tasks.flatMap(task => (state.helper?.outcomes ?? [])
    .filter(outcome => outcome.task === task)
    .slice(-RECEIPTS_PER_TASK)
    .map(outcome => `- ${task} (${outcome.audience}): ${outcome.summary}`))
    .join('\n')
}

export function recentDialog({ state }: { state: HydraState }): string {
  return (state.hydraMessages ?? [])
    .filter(message => ownerActor({ actor: message.actor }) || message.actor === 'hydra')
    .slice(-DIALOG_MESSAGES)
    .map(message => `[${message.actor === 'hydra' ? 'Hydra' : 'owner'}] ${message.text}`)
    .join('\n')
    .slice(-DIALOG_CHARS)
}

export function createRoutineHelper({
  hydraId,
  provider,
  environment,
  context,
  changed,
  handback,
  outcomesReady,
  bound = TURN_MS,
  agentFor,
  deadline,
}: {
  hydraId: string
  provider({ harness }: { harness: 'claude' | 'codex' }): Provider
  environment({
    harness,
    actor,
  }: {
    harness: 'claude' | 'codex'
    actor: string
  }): NodeJS.ProcessEnv
  context(): string
  changed(): void
  handback({
    id,
    text,
  }: {
    id: string
    text: string
  }): void
  outcomesReady(): void
  bound?: number
  agentFor?(): AgentConfig | undefined
  deadline?({ expire }: { expire(): void }): () => void
}) {
  let busy = false
  let closed = false
  let active: HostedSession | undefined
  let abort: AbortController | undefined
  let agent: AgentRef | undefined
  let selection = ''
  let sessionCost = 0
  let sessionTurns = 0

  const stopping = new AbortController()
  const pendingDir = join(
    hydraDir({ hydraId }),
    'helper-pending',
  )

  const defer = async <T>({
    run,
    cleanup = false,
  }: {
    run(): T
    cleanup?: boolean
  }): Promise<T> => {
    for (let attempt = 0; ; attempt++) {
      if (closed && !cleanup) {
        throw new Error('Helper turn was stopped')
      }

      try {
        return run()
      } catch (error) {
        const contended = error instanceof HydraError && (error.code === 'LOCKED' || error.code === 'TASK_LEASED')

        if (!contended || closed) {
          throw error
        }

        console.error(
          'pnyx-axi helper deferred:',
          error,
        )

        if (attempt < WRITE_ATTEMPTS - 1) {
          await delay(
            WRITE_RETRY_MS * 2 ** attempt,
            undefined,
            {
              ref: false,
              signal: stopping.signal,
            },
          )
          continue
        }

        const lockPath = join(
          hydraDir({ hydraId }),
          'writer.lock',
        )

        if (error.code !== 'LOCKED' || !existsSync(lockPath)) {
          throw error
        }

        // A held lock gets availability probes, never repeated synchronous writer waits.
        await new Promise<void>((
          resolve,
          reject,
        ) => {
          const finish = ({ error }: { error?: unknown } = {}) => {
            clearInterval(timer)
            stopping.signal.removeEventListener(
              'abort',
              cancelled,
            )

            if (error) {
              reject(error)
            } else {
              resolve()
            }
          }

          const cancelled = () => finish({ error: new Error('Helper turn was stopped') })

          const check = () => {
            try {
              if (!existsSync(lockPath) || lockIsStale({ path: lockPath })) {
                finish()
              }
            } catch (error) {
              finish({ error })
            }
          }

          const timer = setInterval(
            check,
            WRITE_POLL_MS,
          )
          timer.unref()
          stopping.signal.addEventListener(
            'abort',
            cancelled,
            { once: true },
          )

          if (closed) {
            cancelled()
          } else {
            check()
          }
        })
      }
    }
  }

  const append = ({ change }: { change: Exclude<HelperChange, { type: 'hydra.helper-acknowledged' }> }) => {
    const id = change.type === 'hydra.helper-finished'
      ? `helper-finished:${change.data.batch}` : `helper-started:${change.data.id}`

    try {
      withWriter({
        hydraId,
        lockTimeout: 0,
        fn: ({ writer }) => {
          const decision = hydraEvent({
            state: writer.state,
            cardId: HYDRA_CARD,
            meta: {
              at: new Date().toISOString(),
              actor: 'pnyx',
              id,
            },
            change,
          })

          if ('event' in decision) {
            writer.append({ event: decision.event })
          }
        },
      })
    } catch (error) {
      // Snapshot replacement can fail after the append has already committed.
      if (!(id in loadHydra({ hydraId }).state.eventIds)) {
        throw error
      }

      console.error(
        'pnyx-axi helper snapshot:',
        error,
      )
    }

    background({
      name: 'helper changed',
      run: changed,
    })
  }

  const persistCompletion = async ({
    change,
    tasks,
  }: Completion) => {
    mkdirSync(
      pendingDir,
      {
        recursive: true,
        mode: 0o700,
      },
    )
    const path = join(
      pendingDir,
      `${change.data.batch}.json`,
    )
    const temporary = `${path}.tmp`
    writeFileSync(
      temporary,
      JSON.stringify({
        change,
        tasks,
      }),
      { mode: 0o600 },
    )
    renameSync(
      temporary,
      path,
    )
    await defer({
      run: () => append({ change }),
      cleanup: true,
    })
  }

  const giveBack = ({ batch }: { batch: HelperBatch }) => {
    const state = loadHydra({ hydraId }).state
    const base = handbackId({ id: batch.id })
    let id = base

    for (let attempt = 2; `${id}:hosted` in state.eventIds; attempt++) {
      id = `${base}.${attempt}`
    }

    handback({
      id,
      text: `${batch.prompt}\n<pnyx-wake>Routine helper handed this batch back: ${batch.error ?? 'its turn was interrupted'}. Check current task state before acting; earlier actions may have completed.</pnyx-wake>`,
    })
  }

  const run = async ({ batch }: { batch: HelperBatch }) => {
    const actor = `helper:${batch.id}`
    const releases: (() => void)[] = []
    let cancelDeadline = () => {}
    const usage: HelperUsage = {}

    try {
      const state = loadHydra({ hydraId }).state
      const candidate = agentFor ? agentFor() : helperAgent({ state })

      if (!candidate || !batch.tasks.every(task => helperScope({
        state,
        task,
      }))) {
        throw new Error('The batch now belongs to main')
      }

      for (const task of batch.tasks) {
        releases.push(await defer({
          run: () => taskLease({
            hydraId,
            task,
            actor,
            lockTimeout: 0,
          }),
        }))
      }

      if (closed) {
        throw new Error('Helper turn was stopped')
      }

      const cwd = join(
        hydraDir({ hydraId }),
        'helper',
      )
      prepareHydraFolder({
        folder: cwd,
        instructions: HELPER_INSTRUCTIONS,
      })
      abort = new AbortController()
      const signal = abort.signal
      const selected = JSON.stringify(candidate)

      if (selection !== selected) {
        agent = undefined
      }

      selection = selected

      if (!agent) {
        sessionCost = 0
        sessionTurns = 0
      }

      const costBefore = sessionCost
      const settings: AgentSettings = {}

      if (candidate.model) {
        settings.model = candidate.model
      }

      if (candidate.effort) {
        settings.effort = candidate.effort
      }

      const turn = async () => {
        if (closed || signal.aborted) {
          throw new Error('Helper turn was stopped')
        }

        const session = await provider({ harness: candidate.harness }).open({
          cwd,
          agent,
          settings,
          env: environment({
            harness: candidate.harness,
            actor,
          }),
          instructions: HELPER_INSTRUCTIONS,
          outputSchema: outcomeSchema({ tasks: batch.tasks }),
          context,
          allow: ['pnyx-axi'],
          signal,
        })

        if (signal.aborted) {
          session.close()
          throw new Error('Helper turn was stopped')
        }

        active = session
        agent = {
          provider: candidate.harness === 'claude' ? 'claude-code' : 'codex',
          sessionId: active.id,
          cwd,
          host: 'pnyx',
          transcriptPath: active.path,
        }

        const input = async function* () {
          const card = state.cards[HYDRA_CARD]
          const thread = card ? readThread({
            hydraId,
            state,
            card,
            homes: [],
          }).entries
            .filter(entry => entry.kind === 'message' && (entry.role === 'user' || entry.role === 'assistant'))
            .slice(-DIALOG_MESSAGES)
            .map(entry => `[${entry.role}] ${entry.text}`)
            .join('\n')
            .slice(-DIALOG_CHARS) : ''
          const granted = batch.tasks.map(task => helperScope({
            state,
            task,
          }) === 'owner' ? `${task} (waiting on the owner)` : task)
          const receipts = outcomeReceipts({
            state,
            tasks: batch.tasks,
          })
          const text = `Use pnyx-axi with --hydra ${hydraId}. Recent owner conversation (read-only context):\n${recentDialog({ state })}\n${thread}\n\nGranted tasks: ${granted.join(', ')}\n${receipts ? `Your earlier outcomes on these tasks:\n${receipts}\n` : ''}${batch.prompt}\n\n${HELPER_INSTRUCTIONS}`
          yield agentInput({
            id: batch.id,
            text,
            original: batch.prompt,
            hydras: join(
              pnyxHome(),
              'hydras',
            ),
          })
        }

        for await (const event of active.run({
          input: input(),
          permission: async () => ({
            behavior: 'deny',
            message: 'Leave this action to the main Hydra',
          }),
        })) {
          if (typeof event === 'object' && event.type === 'usage') {
            if (event.cost !== undefined) {
              usage.cost = Math.max(
                0,
                event.cost - costBefore,
              )
              sessionCost = event.cost
            }

            for (const field of [
              'used',
              'window',
              'inputTokens',
            ] as const) {
              if (event[field] !== undefined) {
                usage[field] = event[field]
              }
            }
          }

          if (typeof event === 'object' && event.type === 'turn-ended') {
            const { outcome } = event

            if (outcome.status !== 'completed') {
              throw new Error(outcome.error ?? `Helper turn ${outcome.status}`)
            }

            let text = outcome.assistant.at(-1)?.text ?? outcome.result ?? ''

            if (outcome.structured !== undefined) {
              text = JSON.stringify(outcome.structured)
            }

            return parseOutcomes({
              text,
              tasks: batch.tasks,
            })
          }
        }

        throw new Error('Helper ended without finishing its turn')
      }

      const timeout = new Promise<never>((
        _resolve,
        reject,
      ) => {
        const expire = () => {
          background({
            name: 'helper deadline',
            run: () => {
              abort?.abort()
              active?.close()
            },
          })
          reject(new Error('Helper turn reached its time bound'))
        }

        if (deadline) {
          cancelDeadline = deadline({ expire })
        } else {
          const timer = setTimeout(
            expire,
            bound,
          )
          cancelDeadline = () => clearTimeout(timer)
        }
      })
      const stopped = new Promise<never>((
        _resolve,
        reject,
      ) => {
        signal.addEventListener(
          'abort',
          () => reject(new Error('Helper turn was stopped')),
          { once: true },
        )
      })
      const outcomes = await Promise.race([
        turn(),
        timeout,
        stopped,
      ])
      sessionTurns++

      if (sessionTurns >= HELPER_TURNS || (usage.used ?? 0) >= HELPER_CONTEXT_TOKENS) {
        agent = undefined
      }

      await persistCompletion({
        tasks: batch.tasks,
        change: {
          type: 'hydra.helper-finished',
          data: {
            batch: batch.id,
            outcomes,
            usage,
          },
        },
      })

      if (outcomes.some(outcome => outcome.audience === 'owner')) {
        outcomesReady()
      }
    } catch (error) {
      agent = undefined
      const failure = closed ? 'Helper turn was stopped' : (error as Error).message

      if (!existsSync(join(
        pendingDir,
        `${batch.id}.json`,
      ))) {
        await persistCompletion({
          tasks: batch.tasks,
          change: {
            type: 'hydra.helper-finished',
            data: {
              batch: batch.id,
              outcomes: [],
              error: failure,
              usage,
            },
          },
        })
      }

      if (!closed) {
        giveBack({
          batch: {
            ...batch,
            error: failure,
          },
        })
      }
    } finally {
      const cleanups = [
        cancelDeadline,
        () => active?.close(),
        ...releases,
      ]

      let cleaned = true

      try {
        for (const cleanup of cleanups) {
          try {
            await defer({
              run: cleanup,
              cleanup: true,
            })
          } catch (error) {
            cleaned = false
            console.error(
              'pnyx-axi helper cleanup:',
              error,
            )
          }
        }
      } finally {
        active = undefined
        abort = undefined
        busy = false

        if (cleaned && `helper-finished:${batch.id}` in loadHydra({ hydraId }).state.eventIds) {
          rmSync(
            join(
              pendingDir,
              `${batch.id}.json`,
            ),
            { force: true },
          )
        }

        changed()
      }
    }
  }

  return {
    busy: () => busy,
    async offer({
      tasks,
      prompt,
      seqs,
      once,
    }: {
      tasks: string[]
      prompt: string
      seqs: number[]
      once?: string[]
    }): Promise<boolean> {
      if (closed || busy || !tasks.length) {
        return false
      }

      const batch: HelperBatch = {
        id: randomUUID(),
        tasks: [...new Set(tasks)],
        prompt,
        seqs,
        once,
      }
      busy = true

      try {
        await defer({
          run: () => append({
            change: {
              type: 'hydra.helper-started',
              data: batch,
            },
          }),
        })
      } catch (error) {
        busy = false
        changed()
        throw error
      }

      background({
        name: 'helper turn',
        run: () => run({ batch }),
      })

      return true
    },
    async recover() {
      const pending = new Map<string, Completion>()

      for (const name of existsSync(pendingDir) ? readdirSync(pendingDir) : []) {
        if (name.endsWith('.json')) {
          const completion = JSON.parse(readFileSync(
            join(
              pendingDir,
              name,
            ),
            'utf8',
          )) as Completion
          pending.set(
            completion.change.data.batch,
            completion,
          )
        }
      }

      const runs = Object.values(loadHydra({ hydraId }).state.helper?.runs ?? {})

      for (const batch of runs) {
        let cleaned = true

        for (const task of batch.tasks) {
          try {
            await defer({
              run: () => releaseTask({
                hydraId,
                task,
                actor: `helper:${batch.id}`,
                lockTimeout: 0,
              }),
            })
          } catch (error) {
            cleaned = false
            console.error(
              'pnyx-axi helper recovery cleanup:',
              error,
            )
          }
        }

        const completion = pending.get(batch.id)

        if (completion) {
          await persistCompletion(completion)
        } else if (!batch.error) {
          await persistCompletion({
            tasks: batch.tasks,
            change: {
              type: 'hydra.helper-finished',
              data: {
                batch: batch.id,
                outcomes: [],
                error: 'Pnyx restarted during its helper turn',
              },
            },
          })
        }

        if (!closed && (!completion || completion.change.data.error)) {
          giveBack({ batch })
        }

        if (cleaned) {
          rmSync(
            join(
              pendingDir,
              `${batch.id}.json`,
            ),
            { force: true },
          )
        }
      }

      // A committed outcome can outlive its lease cleanup or journal removal.
      for (const [
        id,
        completion,
      ] of pending) {
        if (!runs.some(batch => batch.id === id)) {
          let cleaned = true

          for (const task of completion.tasks) {
            try {
              await defer({
                run: () => releaseTask({
                  hydraId,
                  task,
                  actor: `helper:${id}`,
                  lockTimeout: 0,
                }),
              })
            } catch (error) {
              cleaned = false
              console.error(
                'pnyx-axi helper recovery cleanup:',
                error,
              )
            }
          }

          await persistCompletion(completion)

          if (cleaned) {
            rmSync(
              join(
                pendingDir,
                `${id}.json`,
              ),
              { force: true },
            )
          }
        }
      }

      outcomesReady()
    },
    close() {
      closed = true
      stopping.abort()
      abort?.abort()
      background({
        name: 'helper close',
        run: () => active?.close(),
      })
    },
  }
}
