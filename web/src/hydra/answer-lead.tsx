import { useState } from 'react'
import { CollapsibleText } from '#web-shared/ui/disclosure.tsx'
import { RichText } from '#web-shared/ui/rich-text.tsx'
import { Tooltip } from '#web-shared/ui/tooltip.tsx'
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
            {chosen && '✓ '}{option}
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

// The task chip carries the question an owner message answers: folded to its opening lines, with every choice.
export function AnswerLeadHead({ lead }: { lead: AnswerLead }) {
  const [
    open,
    setOpen,
  ] = useState(false)
  const preview = questionPreview({ question: lead.question })

  const expand = ({ target }: { target: EventTarget }) => {
    const control = target instanceof Element && target.closest('a, button')

    if (!open && !control) {
      setOpen(true)
    }
  }

  const question = (
    <div className="answer-lead-question" onClick={({ target }) => expand({ target })}>
      <CollapsibleText
        text={lead.question}
        preview={preview}
        open={open}
        toggle={() => setOpen(!open)}
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
        disabled={open}
      >{question}
      </Tooltip>
    </div>
  )
}
