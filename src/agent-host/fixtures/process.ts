import { serveAgentHost } from '#agent-host/server.ts'
import { errorResult } from '#agent-host/protocol.ts'
import { kernelBootIdentity } from '#agent-host/boot.ts'
import type { NativeEvent } from '#workers/native-session.ts'
import { fixtureProvider as provider, states } from './provider.ts'

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
  host.closed.then(() => {
    if (process.connected) {
      process.disconnect()
    }
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
