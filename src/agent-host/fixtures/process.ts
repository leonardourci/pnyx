import { spawn, type ChildProcess } from 'node:child_process'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { spawn, type ChildProcess } from 'node:child_process'
import { join } from 'node:path'
import { serveAgentHost } from '#agent-host/server.ts'
import { deferred } from '#agent-host/deferred.ts'
import { errorResult } from '#agent-host/protocol.ts'
import { kernelBootIdentity } from '#agent-host/boot.ts'
import { nativeSession, type NativeEvent } from '#workers/native-session.ts'
import type { AskPermission, HostedInput, Provider } from '#workers/provider.ts'

type State = {
  id: string
  closed: boolean
  tree?: ChildProcess
  input: HostedInput[]
  settings: string[]
  interrupts: number
  turn?: string
  permission?: AskPermission
  emit?: ({ event }: { event: NativeEvent }) => void
  gate?: ReturnType<typeof deferred<void>>
  context?(): string
  answers: number
  valueMatched?: boolean
}
const states = new Map<string, State>()
const provider = (): Provider => ({
  models: async () => [
    {
      value: 'fixture',
      label: 'Fixture',
    },
  ],
  defaults: async ({ models }) => models,
  async open({
    context,
    settings,
    agent,
    cwd,
    ownProcess,
  }) {
    if (process.env.PNYX_TEST_VERBOSE === '1') {
      console.error(
        'fixture native open',
        process.pid,
        cwd,
      )
    }

    const state: State = {
      id: agent?.sessionId ?? randomUUID(),
      closed: false,
      input: [],
      settings: [],
      interrupts: 0,
      answers: 0,
      context,
    }

    if (settings.fixtureTree === '1' || process.env.FIXTURE_GROUPS === '1') {
      state.tree = spawn(
        process.execPath,
        [
          '--conditions=source',
          join(
            import.meta.dirname,
            'owned-tree.ts',
          ),
          cwd,
        ],
        {
          detached: true,
          stdio: 'ignore',
        },
      )

      if (state.tree.pid !== undefined) {
        try {
          ownProcess?.({ pid: state.tree.pid })
        } catch (error) {
          process.kill(
            -state.tree.pid,
            'SIGKILL',
          )
          throw error
        }
      }
    }

    states.set(
      state.id,
      state,
    )

    if (settings.fixtureOpen === 'hold') {
      state.gate = deferred<void>()
      await state.gate.promise
    }

    const events: NativeEvent[] = []
    let wake = () => {}
    const session = nativeSession({
      native: {
        id: state.id,
        commands: async () => [
          {
            name: 'fixture',
            description: 'Synthetic command',
          },
        ],
        async* run({
          input,
          permission,
          emit,
        }) {
          state.permission = permission
          state.emit = emit

          const feed = async () => {
            for await (const message of input) {
              if (process.env.PNYX_TEST_VERBOSE === '1') {
                console.error(
                  'fixture native input',
                  state.id,
                  message.id,
                )
              }

              state.input.push(message)
              const turn = randomUUID()
              state.turn = turn
              emit({
                event: {
                  type: 'turn-started',
                  turn,
                },
              })
              emit({
                event: {
                  type: 'input',
                  receipt: {
                    inputId: message.id,
                    phase: 'confirmed',
                    turn,
                  },
                },
              })
              emit({ event: 'working' })
            }
          }

          feed().catch(() => {
            events.push({
              type: 'ended',
              reason: 'failed',
              error: 'Synthetic input failed',
            })
            wake()
          })

          while (!state.closed) {
            const event = events.shift()

            if (event !== undefined) {
              yield event
            } else {
              await new Promise<void>(resolve => {
                wake = resolve
              })
            }
          }
        },
        async set({
          setting,
          value,
        }) {
          state.settings.push(`${setting}=${value}`)

          if (value === 'hold') {
            state.gate = deferred<void>()
            await state.gate.promise
          }
        },
        async interrupt() {
          state.interrupts++
        },
        close() {
          state.closed = true

          if (state.tree?.pid) {
            try {
              process.kill(
                -state.tree.pid,
                'SIGKILL',
              )
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
                throw error
              }
            }
          }

          state.gate?.resolve(); wake()
        },
      },
    })

    return session
  },
})
const [
  directory,
  installation,
] = process.argv.slice(2)

try {
  const host = await serveAgentHost({
    directory,
    installation,
    build: 'fixture',
    bootIdentity: () => {
      if (process.env.FIXTURE_BOOT === undefined) {
        return kernelBootIdentity()
      }

      return process.env.FIXTURE_BOOT || undefined
    },
    controlTimeout: process.env.FIXTURE_TIMEOUT === '1' ? 50 : undefined,
    providers: {
      'claude-code': provider(),
      codex: provider(),
    },
    limits: process.env.FIXTURE_PRESSURE === '1'
      ? {
        viewEvents: 4,
        viewBytes: 2048,
        criticalBytes: 1200,
        emergencyBytes: 16000,
      } : undefined,
  })
  process.send?.({
    type: 'ready',
    socket: host.socket,
  })

  const stop = async () => {
    await host.close()
    process.disconnect()
  }

  process.on(
    'disconnect',
    () => host.close().catch(() => {
      process.exitCode = 1
    }),
  )
  process.on(
    'message',
    async message => {
      const request = message as {
        id: string
        kind: string
        nativeId?: string
        event?: NativeEvent
        nextEvent?: NativeEvent
        expected?: string
        submit?: boolean
        count?: number
        textBytes?: number
      }

      try {
        const state = request.nativeId ? states.get(request.nativeId) : undefined

        if (request.kind === 'stats') {
          process.send?.({
            id: request.id,
            states: [...states.values()].map(state => ({
              id: state.id,
              closed: state.closed,
              input: state.input,
              settings: state.settings,
              interrupts: state.interrupts,
              turn: state.turn,
              answers: state.answers,
              valueMatched: state.valueMatched,
              context: state.context?.(),
            })),
          })
        } else if (request.kind === 'burst' && state?.emit && request.count) {
          for (let index = 0; index < request.count; index++) {
            state.emit({
              event: {
                type: 'text',
                id: 'burst',
                text: request.textBytes ? 'x'.repeat(request.textBytes) : String(index),
              },
            })
          }

          state.emit({
            event: {
              type: 'structured',
              value: { afterBurst: true },
            },
          })
          process.send?.({
            id: request.id,
            ok: true,
          })
        } else if (request.kind === 'event' && state?.emit && request.event) {
          if (process.env.PNYX_TEST_VERBOSE === '1') {
            console.error(
              'fixture native emitted',
              state.id,
              typeof request.event === 'string' ? request.event : request.event.type,
            )
          }

          state.emit({ event: request.event })

          if (request.nextEvent) {
            state.emit({ event: request.nextEvent })
          }

          process.send?.({
            id: request.id,
            ok: true,
          })
        } else if (request.kind === 'release' && state) {
          state.gate?.resolve()
          process.send?.({
            id: request.id,
            ok: true,
          })
        } else if (request.kind === 'ask' && state?.permission) {
          const decision = await state.permission({
            id: 'native-ask',
            tool: 'Question',
            input: { prompt: 'Fixture question' },
            signal: new AbortController().signal,
          })
          state.valueMatched = decision.behavior === 'allow' && decision.values?.password === request.expected
          state.answers++

          if (request.submit !== false) {
            state.emit?.({
              event: {
                type: 'answer-submitted',
                id: 'native-ask',
              },
            })
          }

          process.send?.({
            id: request.id,
            ok: true,
          })
        } else if (request.kind === 'stop') {
          process.send?.({
            id: request.id,
            ok: true,
          })
          await stop()
        } else {
          throw new Error('Unknown fixture control')
        }
      } catch {
        process.send?.({
          id: request.id,
          error: 'Fixture control failed',
        })
      }
    },
  )
} catch (error) {
  process.send?.({
    type: 'fatal',
    ...errorResult({ error }),
  })
  process.disconnect()
  process.exitCode = 1
}
