import { withoutInjected } from '#oracle/text.ts'
import type { FoundSettings, TranscriptMessage } from './provider.ts'

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

export const wakeInput = ({ text }: { text: string }) => /^\s*<pnyx-wake>[\s\S]*<\/pnyx-wake>/.test(text)

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
