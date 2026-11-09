import { CopyButton } from '#web-shared/ui/copy-button.tsx'
import { Icon } from '#web-shared/ui/icon.tsx'
import { SentencePart } from './action-bubble.tsx'
import { actionLabel, type ActionLabel } from './action-label.ts'
import type { PnyxLookup } from './pnyx-action.ts'
import type { TraceRow } from './progress-rows.ts'

export const roleLabel = ({
  role,
  assistantLabel = 'Agent',
}: {
  role: string
  assistantLabel?: string
}) => role === 'assistant' ? assistantLabel : role === 'user' ? 'You' : role

const THINKING: ActionLabel = {
  icon: 'thinking',
  sentence: ['Thinking'],
}

function rowLabel({
  row,
  lookup,
}: {
  row: TraceRow
  lookup: PnyxLookup
}): ActionLabel {
  if (row.kind === 'thinking') {
    return THINKING
  }

  const named = row.call && actionLabel({
    action: {
      calls: [row.call],
      done: true,
    },
    lookup,
  })

  return named || {
    icon: 'tool',
    sentence: [row.call ? `Used ${row.call.tool}` : 'Tool output'],
  }
}

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
  const label = rowLabel({
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
          {tool.input && <pre className="trace-text" aria-label="Input">{tool.input}</pre>}
          {tool.output && <pre className="trace-text" aria-label="Output">{tool.output}</pre>}
        </>
      ) : <pre className="trace-text">{row.entry.text}</pre>}
    </details>
  )
}
