import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createInterface } from 'node:readline'
import type { Provider } from './provider.ts'

export type SpawnCodex = ({ cwd, env }: {
  cwd: string
  env: NodeJS.ProcessEnv
}) => ChildProcessWithoutNullStreams

type ObjectValue = Record<string, unknown>
const object = ({ value }: { value: unknown }): ObjectValue =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? value as ObjectValue : {}

function connection({ child }: { child: ChildProcessWithoutNullStreams }) {
  let next = 0, stopped = false, failure: Error | undefined, stderr = ''
  const pending = new Map<number, {
    resolve({ value }: { value: ObjectValue }): void
    reject({ error }: { error: Error }): void
  }>()
  let end: ({ error }: { error: Error }) => void = () => {}
  const ended = new Promise<Error>(resolve => {
    end = ({ error }) => resolve(error)
  })
  const events: ObjectValue[] = []
  let wake: (() => void) | undefined
  const lines = createInterface({ input: child.stdout })

  const stop = ({ error }: { error: Error }) => {
    if (failure) {
      return
    }

    failure = error
    end({ error })

    for (const request of pending.values()) {
      request.reject({ error })
    }

    pending.clear()
    wake?.()
  }

  const write = ({ message }: { message: ObjectValue }) => {
    if (failure) {
      throw failure
    }

    child.stdin.write(`${JSON.stringify(message)}\n`)
  }

  child.stderr.on('data', data => {
    stderr = (stderr + String(data)).slice(-2000)
  })
  child.stdin.on('error', error => stop({ error }))
  child.on('error', error => stop({ error }))
  child.on('exit', (code, signal) => stop({ error: new Error(`Codex app-server exited (${signal ?? code})${stderr ? `: ${stderr}` : ''}`) }))
  lines.on('line', line => {
    try {
      const message = object({ value: JSON.parse(line) })

      if (typeof message.method === 'string') {
        if (message.id !== undefined) {
          const result = ['item/commandExecution/requestApproval', 'item/fileChange/requestApproval'].includes(message.method)
            ? { decision: 'decline' } : undefined
          write({ message: { id: message.id, ...(result ? { result } : { error: { code: -32601, message: 'Pnyx cannot answer this request yet' } }) } })
        } else if (message.method === 'turn/completed') {
          events.push(object({ value: message.params }))
          wake?.()
        }
      } else if (typeof message.id === 'number') {
        const request = pending.get(message.id)
        pending.delete(message.id)

        if (message.error) {
          const error = object({ value: message.error })
          request?.reject({ error: new Error(String(error.message ?? 'Codex request failed')) })
        } else {
          request?.resolve({ value: object({ value: message.result }) })
        }
      }
    } catch (error) {
      stop({ error: error as Error })
    }
  })
  lines.on('close', () => stop({ error: new Error('Codex app-server closed its output') }))

  return {
    ended,
    async request({ method, params }: {
      method: string
      params: ObjectValue
    }): Promise<ObjectValue> {
      const id = ++next
      let timer: ReturnType<typeof setTimeout> | undefined

      try {
        return await new Promise<ObjectValue>((resolve, reject) => {
          timer = setTimeout(() => {
            pending.delete(id)
            reject(new Error(`Codex ${method} timed out`))
          }, 30000).unref()
          pending.set(id, {
            resolve: ({ value }) => resolve(value),
            reject: ({ error }) => reject(error),
          })

          try {
            write({ message: { id, method, params } })
          } catch (error) {
            pending.delete(id)
            reject(error)
          }
        })
      } finally {
        clearTimeout(timer)
      }
    },
    notify({ method }: { method: string }) {
      write({ message: { method } })
    },
    async completed({ threadId, turnId }: { threadId: string; turnId: string }) {
      for (;;) {
        if (failure) {
          throw failure
        }

        const event = events.shift()

        if (event) {
          const turn = object({ value: event.turn })

          if (event.threadId === threadId && turn.id === turnId) {
            return turn
          }
        } else {
          await new Promise<void>(resolve => {
            wake = resolve
          })
          wake = undefined
        }
      }
    },
    close() {
      if (stopped) {
        return
      }

      stopped = true
      stop({ error: new Error('Codex app-server closed') })
      lines.close()
      child.stdin.end()
      child.kill()
      const kill = setTimeout(() => child.kill('SIGKILL'), 2000).unref()
      child.once('exit', () => clearTimeout(kill))
    },
  }
}

export function codexProvider({ spawnCodex = ({ cwd, env }) => spawn('codex', ['app-server', '--listen', 'stdio://'], { cwd, env, stdio: 'pipe' }) }: { spawnCodex?: SpawnCodex }): Provider {
  return {
    async open({ cwd, agent, settings, env, signal }) {
      const rpc = connection({ child: spawnCodex({ cwd, env }) })

      const close = () => {
        signal.removeEventListener('abort', close)
        rpc.close()
      }

      signal.addEventListener('abort', close, { once: true })

      if (signal.aborted) {
        close()
      }

      try {
        await rpc.request({ method: 'initialize', params: { clientInfo: { name: 'pnyx', version: '0.0.0' }, capabilities: null } })
        rpc.notify({ method: 'initialized' })
        const options = { ...settings }
        const result = await rpc.request({
          method: agent ? 'thread/resume' : 'thread/start',
          params: {
            ...(agent ? { threadId: agent.sessionId } : {}),
            cwd,
            ...(options.model ? { model: options.model } : {}),
            ...(options.mode ? { approvalPolicy: options.mode } : {}),
          },
        })
        const thread = object({ value: result.thread })

        if (typeof thread.id !== 'string' || !thread.id || (agent && thread.id !== agent.sessionId)) {
          throw new Error('Codex returned an unexpected thread id')
        }

        const id = thread.id

        return {
          id,
          ...(typeof thread.path === 'string' ? { path: thread.path } : {}),
          async* run({ input }) {
            const messages = input[Symbol.asyncIterator]()

            for (;;) {
              const next = await Promise.race([
                messages.next(), rpc.ended.then(error => {
                  throw error
                }),
              ])

              if (next.done) {
                return
              }

              const text = next.value
              yield 'working'
              const result = await rpc.request({
                method: 'turn/start',
                params: {
                  threadId: id,
                  input: [{ type: 'text', text, text_elements: [] }],
                  ...(options.model ? { model: options.model } : {}),
                  ...(options.effort ? { effort: options.effort } : {}),
                  ...(options.mode ? { approvalPolicy: options.mode } : {}),
                },
              })
              const turn = object({ value: result.turn })

              if (typeof turn.id !== 'string') {
                throw new Error('Codex returned no turn id')
              }

              const completed = await rpc.completed({ threadId: id, turnId: turn.id })

              if (completed.status !== 'completed') {
                throw new Error(String(object({ value: completed.error }).message ?? `Codex turn ${completed.status}`))
              }

              yield 'finished'
            }
          },
          async set({ setting, value }) {
            options[setting] = value
          },
          close,
        }
      } catch (error) {
        close()
        throw error
      }
    },
  }
}
