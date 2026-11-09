import { CopyButton } from '#web-shared/ui/copy-button.tsx'
import { Icon } from '#web-shared/ui/icon.tsx'
import { SentencePart } from './action-bubble.tsx'
import type { PnyxLookup } from './pnyx-action.ts'
import { progressLabel, type TraceRow } from './progress-rows.ts'

export const roleLabel = ({
  role,
  assistantLabel = 'Agent',
}: {
  role: string
  assistantLabel?: string
}) => role === 'assistant' ? assistantLabel : role === 'user' ? 'You' : role

const TraceBlock = ({
  label,
  text,
}: {
  label: string
  text: string
}) => (
  <div className="trace-block" role="group" aria-label={label}>
    <span className="eyebrow">{label}</span>
    <pre className="trace-text">{text}</pre>
  </div>
)

// A tool call or thinking in Hydra's progress: a plain label that opens to the command, input and output.
export function ProgressTrace({
  row,
  open,
  lookup,
}: {
  row: TraceRow
  open: boolean
  lookup: PnyxLookup
}) {
  const label = progressLabel({
    row,
    lookup,
  })
  const tool = row.kind === 'tool' ? row : undefined
  const copied = tool?.input ?? tool?.output ?? row.entry.text
  const words = label.sentence.map((
    part,
    index,
  ) => <SentencePart key={index} part={part} />)

  return (
    <details
      className="trace"
      data-expandable="true"
      data-progress-kind={row.kind}
      open={open}
    >
      <summary>
        <Icon name={label.icon} size={14} />
        <span className="trace-label">{words}</span>
        <CopyButton className="trace-copy" label="Copy" text={() => copied} />
      </summary>
      {tool ? (
        <>
          {tool.input && <TraceBlock label="Input" text={tool.input} />}
          {tool.output && <TraceBlock label="Output" text={tool.output} />}
        </>
      ) : <pre className="trace-text">{row.entry.text}</pre>}
    </details>
  )
}
