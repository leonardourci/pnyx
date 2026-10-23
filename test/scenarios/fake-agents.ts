// Fake Claude Code and Codex that replay the real sessions recorded in test/fixtures/agents/
// (`pnpm refresh-agent-fixtures`), so scenarios run Pnyx's own provider code over real agent output.
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { createInterface } from 'node:readline'
import { PassThrough } from 'node:stream'
import type { ModelInfo, Options, SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import { transcriptPath, type QueryFn } from '../../src/server/claude.ts'
import type { SpawnCodex } from '../../src/server/codex.ts'

const FIXTURES = join(
  import.meta.dirname,
  '..',
  'fixtures',
  'agents',
)

const recording = <T>({ name }: { name: string }) => JSON.parse(readFileSync(
  join(
    FIXTURES,
    name,
  ),
  'utf8',
)) as T

export const claudeRecording = recording<{
  sdk: string
  claude: string
  models: ModelInfo[]
  turn: SDKMessage[]
}>({ name: 'claude.json' })

type Message = Record<string, unknown>

export const codexRecording = recording<{
  codex: string
  protocol: Record<'clientRequests' | 'serverRequests' | 'serverNotifications', string[]>
  // In order: each request Pnyx's side sent with its result, and the notifications Codex sent after it.
  session: ({
    method: string
    result: Message
  } | { notification: Message })[]
}>({ name: 'codex.json' })

// What one agent session was started with and every message it received, in order.
export interface AgentSession {
  cwd: string
  env: NodeJS.ProcessEnv
  received: string[]
  // Codex only: the method of each request Pnyx sent.
  requests?: string[]
}

const said = ({ message }: { message: SDKUserMessage }) => {
  const { content } = message.message

  return typeof content === 'string' ? content : content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
}

// Each message starts the recorded turn again under the session's own id; the transcript is written as Claude Code writes it.
export function replayClaude() {
  const sessions: AgentSession[] = []
  const reply = claudeRecording.turn.flatMap(m => m.type === 'assistant'
    ? m.message.content.flatMap(block => block.type === 'text' ? [block.text] : [])
    : []).join('')

  const query = (({
    prompt,
    options,
  }: {
    prompt: AsyncIterable<SDKUserMessage>
    options: Options
  }) => {
    // A catalog read opens no session.
    if (options.persistSession === false) {
      return {
        supportedModels: async () => claudeRecording.models,
        close: () => {},
      }
    }

    const id = options.sessionId ?? options.resume!
    const session: AgentSession = {
      cwd: options.cwd!,
      env: options.env ?? {},
      received: [],
    }
    sessions.push(session)
    const path = transcriptPath({
      cwd: session.cwd,
      session: id,
      folder: session.env.CLAUDE_CONFIG_DIR,
    })
    mkdirSync(
      dirname(path),
      { recursive: true },
    )
    const record = ({
      role,
      text,
    }: {
      role: string
      text: string
    }) => appendFileSync(
      path,
      `${JSON.stringify({
        type: role,
        timestamp: new Date().toISOString(),
        message: {
          role,
          content: text,
        },
      })}\n`,
    )

    async function* run() {
      for await (const message of prompt) {
        const text = said({ message })
        session.received.push(text)
        record({
          role: 'user',
          text,
        })

        for (const recorded of claudeRecording.turn) {
          yield {
            ...recorded,
            session_id: id,
          }
        }

        record({
          role: 'assistant',
          text: reply,
        })
      }
    }

    return Object.assign(
      run(),
      {
        close: () => {},
        interrupt: async () => {},
        setModel: async () => {},
        setPermissionMode: async () => {},
        applyFlagSettings: async () => {},
      },
    )
  }) as unknown as QueryFn

  return {
    query,
    sessions,
    reply,
  }
}

// An app-server in this process: each request gets its recorded result, followed by the notifications
// recorded after it. thread/resume answers as thread/start did, so a resumed thread keeps its id.
export function replayCodex() {
  const sessions: AgentSession[] = []
  const reply = codexRecording.session.flatMap(entry => {
    const item = 'notification' in entry && entry.notification.method === 'item/completed'
      ? (entry.notification.params as { item: Message }).item
      : undefined

    return item?.type === 'agentMessage' ? [String(item.text)] : []
  }).join('')

  const answer = ({ method }: { method: string }) => {
    const at = codexRecording.session.findIndex(entry => 'method' in entry && entry.method === (method === 'thread/resume' ? 'thread/start' : method))

    if (at === -1) {
      return undefined
    }

    const end = codexRecording.session.findIndex((
      entry,
      i,
    ) => i > at && 'method' in entry)

    return {
      result: (codexRecording.session[at] as { result: Message }).result,
      notifications: codexRecording.session.slice(
        at + 1,
        end === -1 ? undefined : end,
      ).map(entry => (entry as { notification: Message }).notification),
    }
  }

  const spawnCodex: SpawnCodex = ({
    cwd,
    env,
  }) => {
    const session: AgentSession = {
      cwd,
      env,
      received: [],
      requests: [],
    }
    const stdin = new PassThrough(), stdout = new PassThrough(), stderr = new PassThrough()
    let exited = false
    const child = Object.assign(
      new EventEmitter(),
      {
        stdin,
        stdout,
        stderr,
        kill: () => {
          if (!exited) {
            exited = true
            stdout.end()
            setImmediate(() => child.emit(
              'exit',
              null,
              'SIGTERM',
            ))
          }

          return true
        },
      },
    )

    const send = ({ message }: { message: Message }) => {
      if (!exited) {
        stdout.write(`${JSON.stringify(message)}\n`)
      }
    }

    createInterface({ input: stdin }).on(
      'line',
      line => {
        const message = JSON.parse(line) as Message

        if (typeof message.method !== 'string' || message.id === undefined) {
          return
        }

        session.requests!.push(message.method)

        // A model or config read is not a session; one that opens a thread is.
        if (message.method === 'thread/start' || message.method === 'thread/resume') {
          sessions.push(session)
        }

        if (message.method === 'turn/start') {
          const input = (message.params as { input?: { text?: string }[] }).input ?? []
          session.received.push(input.map(part => part.text ?? '').join('\n'))
        }

        const found = answer({ method: message.method })

        if (!found) {
          send({
            message: {
              id: message.id,
              error: {
                code: -32601,
                message: `no recorded ${message.method}`,
              },
            },
          })

          return
        }

        send({
          message: {
            id: message.id,
            result: found.result,
          },
        })

        for (const notification of found.notifications) {
          send({ message: notification })
        }
      },
    )

    return child as unknown as ChildProcessWithoutNullStreams
  }

  return {
    spawnCodex,
    sessions,
    reply,
  }
}
