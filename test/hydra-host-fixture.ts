import { mkdirSync, appendFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { Options, PermissionResult } from '@anthropic-ai/claude-agent-sdk'
import { transcriptPath, type QueryFn } from '../src/server/claude.ts'

export function hydraSdk() {
  const calls: { options: Options; messages: string[] }[] = []
  const control = { hold: false, fail: false, ask: false }
  const permissions: PermissionResult[] = []
  let release = () => {}
  const query = (({ prompt, options }: {
    prompt: AsyncIterable<{ message: { content: string } }>
    options: Options
  }) => {
    const call = { options, messages: [] as string[] }
    calls.push(call)
    const path = transcriptPath({
      cwd: options.cwd!,
      session: options.sessionId ?? options.resume!,
      folder: options.env?.CLAUDE_CONFIG_DIR,
    })
    mkdirSync(dirname(path), { recursive: true })
    const record = ({ role, text }: { role: string; text: string }) => appendFileSync(path, JSON.stringify({ type: role, timestamp: new Date().toISOString(), message: { role, content: text } }) + '\n')

    async function* run() {
      if (control.fail) {
        throw new Error('Harness login is missing')
      }

      for await (const message of prompt) {
        const text = message.message.content
        call.messages.push(text)
        record({ role: 'user', text })
        yield { type: 'system', subtype: 'session_state_changed', state: 'running' }

        if (control.ask) {
          const result = await options.canUseTool!('Bash', { command: 'ls' }, { signal: new AbortController().signal, toolUseID: 'hydra-tool', requestId: 'hydra-request', decisionReason: 'List the folder' })
          permissions.push(result!)
        }

        if (control.hold) {
          await new Promise<void>(resolve => {
            release = resolve
          })
        }

        record({ role: 'assistant', text: `Hydra: ${text.split('\n\n').at(-1)}` })
        yield { type: 'system', subtype: 'session_state_changed', state: 'idle' }
      }
    }

    return Object.assign(run(), { close: () => release() })
  }) as unknown as QueryFn

  return {
    query,
    calls,
    control,
    permissions,
    release: () => {
      control.hold = false; release()
    },
  }
}
