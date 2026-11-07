import type { ThreadEntry } from '#hydra/transcripts-read.ts'
import { CopyButton } from '#web-shared/ui/copy-button.tsx'
import { Icon } from '#web-shared/ui/icon.tsx'
import { shellCommand } from './pnyx-action.ts'

export const roleLabel = ({
  role,
  assistantLabel = 'Agent',
}: {
  role: string
  assistantLabel?: string
}) => role === 'assistant' ? assistantLabel : role === 'user' ? 'You' : role

export function Trace({
  entry,
  details,
}: {
  entry: ThreadEntry
  details: boolean
}) {
  const firstLine = entry.text.split(
    '\n',
    1,
  )[0]?.slice(
    0,
    200,
  )
  const label = entry.kind === 'thinking' ? 'Thinking' : roleLabel(entry)
  const summary = (
    <>
      <Icon name={entry.kind} size={14} />
      <strong>{label}</strong>
      <span>{firstLine}</span>
    </>
  )

  const copy = entry.kind === 'tool' && <CopyButton className="trace-copy" label="Copy" text={() => shellCommand({ text: entry.text }) ?? entry.text} />

  return details ? <details className="trace" data-expandable="true"><summary>{summary}{copy}</summary><pre className="trace-text">{entry.text}</pre></details>
    : <div className="trace" data-expandable="false"><div className="trace-summary">{summary}{copy}</div></div>
}
