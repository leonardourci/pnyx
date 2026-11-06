import { commandOf } from './tool-input.ts'
import { withoutInjected } from '#oracle/text.ts'
import type { FoundSettings, TranscriptMessage, TranscriptCall } from './provider.ts'

export const transcriptString = ({ value }: { value: unknown }): string | undefined =>
  typeof value === 'string' && value.trim() !== '' ? value : undefined

export function foundSettings({ settings }: {
  settings: Record<string, string | null | undefined>
}): FoundSettings | undefined {
  const found = Object.fromEntries(Object.entries(settings).filter(([
    , value,
  ]) => value !== undefined)) as FoundSettings

  return Object.keys(found).length ? found : undefined
}

export function onOff({ fast }: { fast: boolean | undefined }) {
  if (fast === undefined) {
    return undefined
  }

  return fast ? 'on' : 'off'
}

const wakeInput = ({ text }: { text: string }) => /^\s*<pnyx-wake>[\s\S]*<\/pnyx-wake>/.test(text)

export function transcriptText({
  texts,
  at,
}: {
  texts: {
    text: string
    hidden?: boolean
  }[]
  at?: string
}): TranscriptMessage[] {
  const messages = texts.map(({
    text,
    hidden,
  }) => hidden || wakeInput({ text }) ? '' : withoutInjected({ text }))
    .filter(Boolean)
    .map(text => at ? {
      at,
      text,
    } : { text })

  if (messages.length === 0 && texts.some(({ text }) => wakeInput({ text }))) {
    return [
      {
        text: '',
        at,
        internal: true,
      },
    ]
  }

  return messages
}

export function transcriptCall({
  id,
  tool,
  input,
}: {
  id: string
  tool: string
  input: Record<string, unknown>
}): TranscriptCall {
  const call: TranscriptCall = {
    id,
    tool,
  }
  const fields = {
    command: commandOf({ input }),
    file: input.file_path ?? input.notebook_path ?? input.path,
    query: input.pattern ?? input.query,
    url: input.url,
    skill: input.skill ?? input.subagent_type,
    description: input.description,
  }

  for (const name of Object.keys(fields) as (keyof typeof fields)[]) {
    const value = fields[name]

    if (typeof value === 'string') {
      call[name] = value
    }
  }

  return call
}
