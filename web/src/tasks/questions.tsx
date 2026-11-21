import { ReceiptStatus } from '#web-shared/ui/receipt-status.tsx'
import { QuestionFields, QuestionOptions, QuestionHeading, QuestionPanel } from '#web-shared/ui/question-panel.tsx'
import { ChoiceOption } from '#web-shared/ui/choice-option.tsx'
import { CollapsibleText } from '#web-shared/ui/disclosure.tsx'
import { useState } from 'react'
import { answerPrompt, requestId, type Choice, type QuestionAnswer } from '#workers/answers.ts'
import type { Card } from '#tasks/model.ts'
import type { Attention, FormField, Question } from '#workers/model.ts'
import { Button, Input, NativeInput } from '#web-shared/ui/controls.tsx'
import { markdownText } from '#web-hydra/markdown-text.ts'
import { ICON_SIZE, Icon } from '#web-shared/icons.tsx'
import type { Command } from '#web-app/connection.ts'

const QUESTION_FIELD_CLASS = 'ask-question m-0 flex min-w-0 flex-col gap-1 border-0 p-0 [&_legend]:mb-1 [&_legend]:p-0 [&_legend]:font-chat [&_legend]:text-meta [&_legend]:leading-question [&_legend]:font-normal [&_legend]:text-ink [&_legend]:not-italic'

type Send = ({
  request,
  value,
}: {
  request: Attention
  value: unknown
}) => Promise<void>

type Draft = {
  pick: number[]
  text: string
}

function QuestionField({
  question,
  index,
  draft,
  locked = false,
  change,
}: {
  question: Question
  index: number
  draft: Draft
  locked?: boolean
  change({ next }: { next: Draft }): void
}) {
  const AnswerInput = question.secret ? NativeInput : Input
  const toggle = ({ n }: { n: number }) => change({
    next: {
      text: '',
      pick: question.multiSelect
        ? (draft.pick.includes(n) ? draft.pick.filter(p => p !== n) : [
          ...draft.pick,
          n,
        ])
        : [n],
    },
  })

  return (
    <fieldset className={QUESTION_FIELD_CLASS} disabled={locked}>
      <legend>Question {index + 1}{question.multiSelect && <span className="small muted"> · pick any</span>}</legend>
      {question.header && <CollapsibleText className="ask-header mr-1.75 rounded-sm bg-subtle px-1.5 py-px align-middle font-sans text-meta leading-browser font-normal tracking-question text-gold uppercase" text={question.header} />}
      <CollapsibleText text={question.question} />
      <QuestionOptions>
        {question.options.map((
          option,
          i,
        ) => (
          <ChoiceOption
            key={option.label}
            label={option.label}
            description={option.description}
            selected={draft.pick.includes(i + 1)}
            choose={() => toggle({ n: i + 1 })}
          />
        ))}
      </QuestionOptions>
      {!question.multiSelect && (
        <AnswerInput
          type={question.secret ? 'password' : undefined}
          aria-label={`Other answer to question ${index + 1}`}
          placeholder="Or type your own answer"
          value={draft.text}
          onChange={({ target }) => {
            const text = target.value
            change({
              next: {
                pick: text ? [] : draft.pick,
                text,
              },
            })
          }}
        />
      )}
    </fieldset>
  )
}

export function Questions({
  request,
  busy,
  send,
  reentry = false,
  savedAnswers,
}: {
  request: Attention
  busy: boolean
  send: Send
  reentry?: boolean
  savedAnswers?: string[][]
}) {
  const questions = request.questions ?? []
  const [
    drafts,
    setDrafts,
  ] = useState<Draft[]>(() => questions.map((
    question,
    index,
  ) => {
    const saved = reentry && !question.secret ? savedAnswers?.[index] ?? [] : []
    const pick = question.options.flatMap((
      option,
      index,
    ) => saved.includes(option.label) ? [index + 1] : [])

    return {
      pick,
      text: pick.length === saved.length ? '' : saved.join(', '),
    }
  }))
  const answers: QuestionAnswer[] = drafts
    .map(d => (d.text.trim() ? { text: d.text } : { pick: d.pick }))
  const ready = drafts.every(d => d.text.trim() || d.pick.length)

  return (
    <form
      onSubmit={e => {
        e.preventDefault()

        if (ready) {
          void send({
            request,
            value: { answers },
          })
        }
      }}
    >
      {questions.map((
        question,
        i,
      ) => (
        <QuestionField
          key={question.question}
          question={question}
          index={i}
          draft={drafts[i]!}
          locked={reentry && !question.secret}
          change={({ next }) => setDrafts(all => all.map((
            d,
            j,
          ) => (j === i ? next : d)))}
        />
      ))}
      <Button type="submit" variant="primary" disabled={!ready || busy}>
        {busy ? 'Sending…' : reentry ? 'Send missing secret' : 'Answer'}
      </Button>
    </form>
  )
}

type Values = Record<string, string | boolean>

function FormInput({
  field,
  value,
  change,
}: {
  field: FormField
  value: string | boolean | undefined
  change({ value }: { value: string | boolean }): void
}) {
  const label = `${field.title ?? field.name}${field.required ? ' *' : ''}`

  const name = markdownText({ text: label })

  if (field.type === 'boolean') {
    return (
      <ChoiceOption
        label={label}
        selected={value === true}
        choose={() => change({ value: value !== true })}
      />
    )
  }

  if (field.options) {
    return (
      <div className={QUESTION_FIELD_CLASS} role="group" aria-label={name}>
        <CollapsibleText text={label} />
        <QuestionOptions>
          {field.options.map(option => (
            <ChoiceOption
              key={option}
              label={option}
              selected={value === option}
              choose={() => change({ value: option })}
            />
          ))}
        </QuestionOptions>
      </div>
    )
  }

  const FieldInput = field.type === 'string' ? Input : NativeInput

  return (
    <div className={QUESTION_FIELD_CLASS}>
      <CollapsibleText text={label} />
      <FieldInput
        aria-label={name}
        placeholder={name}
        inputMode={field.type === 'string' ? undefined : 'decimal'}
        value={typeof value === 'string' ? value : ''}
        onChange={({ target }) => change({ value: target.value })}
      />
    </div>
  )
}

export function Form({
  request,
  busy,
  send,
  reentry = false,
}: {
  request: Attention
  busy: boolean
  send: Send
  reentry?: boolean
}) {
  const fields = request.form ?? []
  const [
    values,
    setValues,
  ] = useState<Values>({})
  const filled = Object.fromEntries(fields.flatMap(f => {
    const v = values[f.name]

    if (v === undefined || (typeof v === 'string' && !v.trim())) {
      return []
    }

    return [
      [
        f.name,
        f.type === 'number' || f.type === 'integer' ? Number(v) : v,
      ],
    ]
  }))
  const ready = fields.every(f => !f.required || filled[f.name] !== undefined)

  return (
    <QuestionFields>
      {fields.map(field => (
        <FormInput
          key={field.name}
          field={field}
          value={values[field.name]}
          change={({ value }) => setValues(all => ({
            ...all,
            [field.name]: value,
          }))}
        />
      ))}
      <div className="row wrap">
        <Button
          variant="primary"
          disabled={busy || !ready}
          onClick={() => void send({
            request,
            value: {
              choice: 'accept',
              values: filled,
            },
          })}
        >
          Accept
        </Button>
        {!reentry && (
          <Button
            variant="surface"
            disabled={busy}
            onClick={() => void send({
              request,
              value: { choice: 'decline' },
            })}
          >
            Decline
          </Button>
        )}
      </div>
    </QuestionFields>
  )
}

type ChoicesProps = {
  request: Attention
  choices: Choice[]
  busy: boolean
  send: Send
}

function Choices({
  request,
  choices,
  busy,
  send,
}: ChoicesProps) {
  const [
    text,
    setText,
  ] = useState('')
  const typed = choices.find(c => c.text !== 'none')

  return (
    <QuestionFields>
      {typed && (
        <Input
          aria-label={typed.text === 'required' ? `${typed.label}: what to change` : `${typed.label}: what to do instead`}
          placeholder={typed.text === 'required' ? 'What should change?' : 'What to do instead (optional, with No)'}
          value={text}
          onChange={e => setText(e.target.value)}
        />
      )}
      <div className="row wrap">
        {choices.map(choice => (
          <Button
            key={choice.choice}
            variant={choice.choice === 'allow' || choice.choice === 'approve' ? 'primary' : 'surface'}
            disabled={busy || (choice.text === 'required' && !text.trim())}
            onClick={() => void send({
              request,
              value: {
                choice: choice.choice,
                ...(choice.text !== 'none' && text.trim() ? { text } : {}),
              },
            })}
          >
            {choice.label}
          </Button>
        ))}
      </div>
    </QuestionFields>
  )
}

const TITLE: Record<string, string> = {
  question: 'Asking you',
  permission: 'Asking permission',
  plan: 'Plan to approve',
  input: 'Asking for input',
}

export function InlineQuestions({
  card,
  command,
  notify,
  pendingOnly = false,
}: {
  card: Card
  pendingOnly?: boolean
  command: Command
  notify({ text }: { text: string }): void
}) {
  const [
    busy,
    setBusy,
  ] = useState<string | null>(null)
  const shown = card.attention
    .filter(request => (!pendingOnly || !request.answered) && (request.answered || answerPrompt({
      card,
      request,
    })))

  if (!shown.length) {
    return null
  }

  const send: Send = async ({
    request,
    value,
  }) => {
    setBusy(requestId({ request }))

    try {
      const id = requestId({ request })
      const args = [
        card.id,
        request.key,
        JSON.stringify(value),
        crypto.randomUUID(),
        id,
      ]
      const r = await command({
        name: 'answer',
        args,
      })
      const receipt = r.reply as {
        state: string
        detail?: string
      } | undefined
      const why = receipt?.detail ? ` (${receipt.detail})` : ''
      notify({
        text: receipt?.state === 'delivered'
          ? 'Answer typed into the session. It shows as answered until the session moves on.'
          : receipt?.state === 'delivery_unknown'
            ? `Answer may be half typed${why}. Check the session before answering again.`
            : `Answer not sent${why}.`,
      })
    } catch (e) {
      notify({ text: (e as Error).message })
    } finally {
      setBusy(null)
    }
  }

  return (
    <>
      {shown.map(request => {
        const prompt = answerPrompt({
          card,
          request,
        })
        const pending = busy === requestId({ request })

        return (
          <QuestionPanel key={requestId({ request })} answered={!!request.answered} aria-label={TITLE[request.kind] ?? 'Agent request'}>
            <QuestionHeading>
              <Icon name="agent" size={ICON_SIZE.inline} />
              {TITLE[request.kind] ?? 'Agent request'}
            </QuestionHeading>
            {request.kind !== 'question' && <CollapsibleText text={request.text ?? ''} />}
            {request.answered
              ? <ReceiptStatus>Answered · waiting for the session to move on</ReceiptStatus>
              : prompt?.kind === 'questions'
                ? <Questions request={request} busy={pending} send={send} />
                : prompt?.kind === 'form'
                  ? <Form request={request} busy={pending} send={send} />
                  : prompt && (
                    <Choices
                      request={request}
                      choices={prompt.choices}
                      busy={pending}
                      send={send}
                    />
                  )}
          </QuestionPanel>
        )
      })}
    </>
  )
}
