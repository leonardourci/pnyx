import { useCallback, useState } from 'react'
import { CollapsibleText } from '#web-shared/ui/disclosure.tsx'
import { RichText } from '#web-shared/ui/rich-text.tsx'
import { Tooltip } from '#web-shared/ui/tooltip.tsx'
import { Icon } from '#web-shared/ui/icon.tsx'
import { TaskReference } from '#web-tasks/task-reference.tsx'
import { questionPreview, type AnswerLead } from './answer-leads.ts'

const PREVIEW_DELAY_MS = 400

function AnswerChoices({ lead }: { lead: AnswerLead }) {
  if (!lead.options.length) {
    return null
  }

  return (
    <ul className="answer-choices flex flex-wrap gap-1 m-0 p-0 list-none [&>li]:inline-flex [&>li]:items-center [&>li]:gap-0.75 [&>li]:py-0 [&>li]:px-1.75 [&>li]:border [&>li]:border-line [&>li]:rounded-full [&>li]:text-meta [&>li]:leading-answer [&>li]:text-muted [&>li[aria-current]]:border-gold-line [&>li[aria-current]]:bg-gold-wash [&>li[aria-current]]:text-gold [&>li[aria-current]]:font-semibold in-[.tooltip]:[&>li]:border-current in-[.tooltip]:[&>li]:text-inherit in-[.tooltip]:[&>li]:opacity-80 in-[.tooltip]:[&>li[aria-current]]:opacity-100 in-[.tooltip]:[&>li[aria-current]]:bg-transparent in-[.tooltip]:[&_span]:inline-flex" aria-label="Choices">
      {lead.options.map((
        option,
        i,
      ) => {
        const chosen = option === lead.choice

        return (
          <li key={option} aria-current={chosen || undefined}>
            {chosen && <span aria-hidden="true"><Icon name="check" size={12} /></span>}{option}
            {lead.recommended === i + 1 && <span className="answer-recommended font-normal italic"> · recommended</span>}
          </li>
        )
      })}
    </ul>
  )
}

function FullQuestion({ lead }: { lead: AnswerLead }) {
  return (
    <span className="answer-lead-preview grid gap-1.5 [&_.markdown]:text-[length:inherit] [&_.markdown]:leading-[inherit] [&_.markdown_:is(span,strong)]:inline">
      <RichText text={lead.question} />
      <AnswerChoices lead={lead} />
    </span>
  )
}

// A click anywhere on an answer's bubble opens its folded question; only Show less folds it again.
export function openFoldedQuestion({
  target,
  bubble,
}: {
  target: EventTarget
  bubble: Element
}) {
  const control = target instanceof Element && target.closest('a, button, [role="button"]')
  const selecting = !!getSelection()?.toString()
  const showMore = bubble.querySelector<HTMLButtonElement>('.answer-lead .show-more[aria-expanded="false"]')

  if (showMore && !control && !selecting) {
    showMore.click()
  }
}

export function AnswerLeadHead({ lead }: { lead: AnswerLead }) {
  const [
    open,
    setOpen,
  ] = useState(false)
  const [
    folded,
    setFolded,
  ] = useState(false)
  const preview = questionPreview({ question: lead.question })
  const measured = useCallback(
    ({ long }: { long: boolean }) => setFolded(long),
    [],
  )

  const question = (
    <div className="answer-lead-question grid gap-1 text-muted [&_.text-preview]:max-h-[2lh] [&_.text-preview]:line-clamp-2 [&_:is(.text-preview,.collapsible-text>div,.markdown)]:text-ui [&_:is(.text-preview,.collapsible-text>div,.markdown)]:leading-answer-question">
      <CollapsibleText
        text={lead.question}
        preview={preview}
        open={open}
        toggle={() => setOpen(!open)}
        measured={measured}
      />
      <AnswerChoices lead={lead} />
      {lead.discussion && <p className="answer-lead-state m-0 text-meta italic">Comment · the question stays open</p>}
    </div>
  )

  return (
    <div className="answer-lead grid justify-items-start gap-0.5 mb-1.5 pt-1.5 px-2.25 pb-1.75 border border-line rounded-control bg-answer-lead [&_.task-reference-space]:hidden [&_.draft-chip]:m-0 [&>.tooltip-anchor]:block [&>.tooltip-anchor]:w-full">
      <TaskReference id={lead.task} />
      <Tooltip
        content={<FullQuestion lead={lead} />}
        delay={PREVIEW_DELAY_MS}
        disabled={open || !folded}
      >{question}
      </Tooltip>
    </div>
  )
}
