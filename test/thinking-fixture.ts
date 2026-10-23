import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { transcriptPath, type QueryFn } from '../src/server/claude.ts'

export function thinkingSdk() {
  let release = () => {}
  const wait = () => new Promise<void>(resolve => {
    release = resolve
  })
  const query = (({
    prompt,
    options,
  }: Parameters<QueryFn>[0]) => {
    if (options?.persistSession === false) {
      return {
        supportedModels: async () => [
          {
            value: 'opus',
            displayName: 'Opus',
            description: '',
          },
        ],
        close() {},
      }
    }

    const path = transcriptPath({
      cwd: options!.cwd!,
      session: options!.sessionId!,
      folder: options!.env?.CLAUDE_CONFIG_DIR,
    })
    mkdirSync(
      dirname(path),
      { recursive: true },
    )
    const record = ({ message }: { message: unknown }) => appendFileSync(
      path,
      JSON.stringify({
        timestamp: new Date().toISOString(),
        ...message as object,
      }) + '\n',
    )
    const stream = ({ event }: { event: unknown }) => ({
      type: 'stream_event',
      parent_tool_use_id: null,
      event,
    })

    async function* run() {
      for await (const input of prompt as AsyncIterable<unknown>) {
        record({ message: input })
        yield stream({
          event: {
            type: 'message_start',
            message: { id: 'reasoning-message' },
          },
        })
        yield stream({
          event: {
            type: 'content_block_start',
            index: 0,
            content_block: {
              type: 'thinking',
              thinking: '',
              signature: '',
            },
          },
        })

        for (let index = 0; index < 100; index++) {
          yield stream({
            event: {
              type: 'content_block_delta',
              index: 0,
              delta: {
                type: 'thinking_delta',
                thinking: 'Private reasoning',
              },
            },
          })
        }

        await wait()
        const tool = {
          type: 'assistant',
          parent_tool_use_id: null,
          message: {
            id: 'command',
            content: [
              {
                type: 'tool_use',
                id: 'command',
                name: 'Bash',
                input: { command: 'pnpm test' },
              },
            ],
          },
        }
        record({ message: tool })
        yield tool
        await wait()
        const result = {
          type: 'user',
          parent_tool_use_id: null,
          message: {
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'command',
                content: 'All checks passed',
              },
            ],
          },
        }
        record({ message: result })
        yield result
        await wait()
        yield stream({
          event: {
            type: 'content_block_stop',
            index: 0,
          },
        })
        await wait()
        yield {
          type: 'result',
          subtype: 'success',
          is_error: false,
        }
      }
    }

    return Object.assign(
      run(),
      {
        close() {
          release()
        },
        async interrupt() {
          release()
        },
      },
    )
  }) as QueryFn

  return {
    query,
    advance() {
      release()
    },
  }
}
