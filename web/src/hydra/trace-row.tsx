import type { ComponentProps } from 'react'
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

function TraceText({ ...props }: ComponentProps<'pre'>) {
  return <pre {...props} className="trace-text m-0 overflow-auto max-w-full p-2.5 font-mono text-code leading-(--chat-line) whitespace-pre-wrap wrap-anywhere mt-1.5 max-h-100 border border-line rounded-lg bg-raised" />
}

const TraceBlock = ({
  label,
  text,
}: {
  label: string
  text: string
}) => (
  <div className="trace-block grid gap-1 mt-2 [&_.trace-text]:mt-0" role="group" aria-label={label}>
    <span className="eyebrow">{label}</span>
    <TraceText>{text}</TraceText>
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
      className="trace text-muted text-ui group"
      data-expandable="true"
      data-progress-kind={row.kind}
      open={open}
    >
      <summary className="flex items-center gap-2 min-w-0 py-1 px-0 cursor-pointer list-none [&::-webkit-details-marker]:hidden [&_strong]:shrink-0 [&_strong]:font-medium [&_span]:min-w-0 [&_span]:overflow-hidden [&_span]:text-ellipsis [&_span]:whitespace-nowrap [&_span]:opacity-80 [&>svg]:bg-raised [&>svg]:rounded-full [&>svg]:size-5 [&>svg]:p-0.75">
        <Icon name={label.icon} size={14} />
        <span className="trace-label">{words}</span>
        <CopyButton className="trace-copy ml-auto opacity-0 group-has-[:is(summary,.trace-summary):is(:hover,:focus-within)]:opacity-100 [@media(hover:none)]:opacity-100" label="Copy" text={() => copied} />
      </summary>
      {tool ? (
        <>
          {tool.input && <TraceBlock label="Input" text={tool.input} />}
          {tool.output && <TraceBlock label="Output" text={tool.output} />}
        </>
      ) : <TraceText>{row.entry.text}</TraceText>}
    </details>
  )
}
