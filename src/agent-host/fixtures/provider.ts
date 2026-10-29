import { spawn, type ChildProcess } from 'node:child_process'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { deferred } from '#agent-host/deferred.ts'
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
export const states = new Map<string, State>()
export const fixtureProvider = (): Provider => ({
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
