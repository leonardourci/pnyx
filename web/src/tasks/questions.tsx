import { ChoiceOption } from '../shared/ui/choice-option.tsx'
import { CollapsibleText } from '../shared/ui/disclosure.tsx'
import { useState } from 'react'
import { answerPrompt, requestId, type Choice, type QuestionAnswer } from '../../../src/workers/answers.ts'
import type { Card } from '../../../src/tasks/model.ts'
import type { Attention, FormField, Question } from '../../../src/workers/model.ts'
import { Button, Input } from '../shared/ui/controls.tsx'
import { markdownText } from '../hydra/markdown.tsx'
import { Icon } from '../shared/ui/icon.tsx'
import type { Command } from '../app/connection.ts'

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
  change,
}: {
  question: Question
  index: number
  draft: Draft
  change({ next }: { next: Draft }): void
}) {
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
    <fieldset className="ask-question">
      <legend>Question {index + 1}{question.multiSelect && <span className="small muted"> · pick any</span>}</legend>
      {question.header && <CollapsibleText className="ask-header" text={question.header} />}
      <CollapsibleText text={question.question} />
      <div className="ask-options">
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
      </div>
      {!question.multiSelect && (
        <Input
          type={question.secret ? 'password' : undefined}
          aria-label={`Other answer to question ${index + 1}`}
          placeholder="Or type your own answer"
          value={draft.text}
          onChange={e => {
            const text = e.target.value
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
}: {
  request: Attention
  busy: boolean
  send: Send
}) {
  const questions = request.questions ?? []
  const [
    drafts,
    setDrafts,
  ] = useState<Draft[]>(() => questions.map(() => ({
    pick: [],
    text: '',
  })))
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
          change={({ next }) => setDrafts(all => all.map((
            d,
            j,
          ) => (j === i ? next : d)))}
        />
      ))}
      <Button type="submit" variant="primary" disabled={!ready || busy}>
        {busy ? 'Sending…' : 'Answer'}
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
      <div className="ask-question" role="group" aria-label={name}>
        <CollapsibleText text={label} />
        <div className="ask-options">
          {field.options.map(option => (
            <ChoiceOption
              key={option}
              label={option}
              selected={value === option}
              choose={() => change({ value: option })}
            />
          ))}
        </div>
      </div>
    )
  }

  return (
    <div className="ask-question">
      <CollapsibleText text={label} />
      <Input
        aria-label={name}
        placeholder={name}
        inputMode={field.type === 'string' ? undefined : 'decimal'}
        value={typeof value === 'string' ? value : ''}
        onChange={e => change({ value: e.target.value })}
      />
    </div>
  )
}

export function Form({
  request,
  busy,
  send,
}: {
  request: Attention
  busy: boolean
  send: Send
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
    <div className="ask-choices">
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
      </div>
    </div>
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
    <div className="ask-choices">
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
    </div>
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
          <article key={requestId({ request })} className={`ask${request.answered ? ' answered' : ''}`} aria-label={TITLE[request.kind] ?? 'Agent request'}>
            <strong className="ask-title">
              <Icon name="agent" size={14} />
              {TITLE[request.kind] ?? 'Agent request'}
            </strong>
            {request.kind !== 'question' && <CollapsibleText text={request.text ?? ''} />}
            {request.answered
              ? <span className="receipt">Answered · waiting for the session to move on</span>
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
          </article>
        )
      })}
    </>
  )
}
