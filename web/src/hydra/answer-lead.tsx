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
    <ul className="answer-choices" aria-label="Choices">
      {lead.options.map((
        option,
        i,
      ) => {
        const chosen = option === lead.choice

        return (
          <li key={option} aria-current={chosen || undefined}>
            {chosen && <span aria-hidden="true"><Icon name="check" size={12} /></span>}{option}
            {lead.recommended === i + 1 && <span className="answer-recommended"> · recommended</span>}
          </li>
        )
      })}
    </ul>
  )
}

function FullQuestion({ lead }: { lead: AnswerLead }) {
  return (
    <span className="answer-lead-preview">
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
    <div className="answer-lead-question">
      <CollapsibleText
        text={lead.question}
        preview={preview}
        open={open}
        toggle={() => setOpen(!open)}
        measured={measured}
      />
      <AnswerChoices lead={lead} />
      {lead.discussion && <p className="answer-lead-state">Comment · the question stays open</p>}
    </div>
  )

  return (
    <div className="answer-lead">
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
