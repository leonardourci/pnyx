import { commandOf } from './tool-input.ts'
import { object } from './transcript-usage.ts'
import { withoutInjected } from '#oracle/text.ts'
import type { FoundSettings, TranscriptMessage, TranscriptCall, TranscriptTrace } from './provider.ts'

const TEXT_BLOCKS = [
  'text',
  'input_text',
  'output_text',
]
const UNRECORDED_DETAIL = 'Recorded details unavailable'
const UNNAMED_TOOL = 'tool'

export function injectedDigest({ text }: { text: string }): string | undefined {
  return /^\s*(<pnyx-digest\b[^>]*>[\s\S]*?<\/pnyx-digest>)/.exec(text)?.[1]
}

export const transcriptString = ({ value }: { value: unknown }): string | undefined =>
  typeof value === 'string' && value.trim() !== '' ? value : undefined

export const trimmedString = ({ value }: { value: unknown }): string | undefined =>
  transcriptString({ value })?.trim()

export function blockText({ value }: { value: unknown }): string {
  if (typeof value === 'string') {
    return value
  }

  const block = object({ value })
  const text = TEXT_BLOCKS.includes(String(block.type))

  return text && typeof block.text === 'string' ? block.text : ''
}

export function transcriptTrace({
  index,
  kind,
  name,
  detail,
  call,
}: {
  index: number
  kind: TranscriptTrace['kind']
  name: unknown
  detail: unknown
  call: unknown
}): TranscriptTrace {
  const recorded = detail ?? UNRECORDED_DETAIL
  const trace: TranscriptTrace = {
    index,
    kind,
    role: typeof name === 'string' ? name : kind,
    text: typeof recorded === 'string' ? recorded : JSON.stringify(recorded),
  }

  if (kind === 'tool' && typeof call === 'string') {
    trace.call = call
  }

  return trace
}

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

// Pnyx's own wake turns are not anyone's words.
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
  tool: unknown
  input: Record<string, unknown>
}): TranscriptCall {
  const call: TranscriptCall = {
    id,
    tool: typeof tool === 'string' ? tool : UNNAMED_TOOL,
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
