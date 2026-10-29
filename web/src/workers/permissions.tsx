import { useState } from 'react'
import type { Card } from '#tasks/model.ts'
import type { Attention, PermissionRequest } from '#workers/model.ts'
import { permissionDetails } from '#workers/permission-rules.ts'
import { Button } from '#web-shared/ui/controls.tsx'
import { Disclosure } from '#web-shared/ui/disclosure.tsx'
import { Icon } from '#web-shared/ui/icon.tsx'
import type { Command } from '#web-app/connection.ts'
import { Form, Questions } from '#web-tasks/questions.tsx'

const title = ({ request }: { request: PermissionRequest }) => request.questions
  ? 'Asking you'
  : request.form ? `Asking for input · ${request.tool}` : `Asking permission · ${request.tool}`

function Receipt({ request }: { request: PermissionRequest }) {
  const delivery = request.delivery
  const message = delivery === 'unknown' ? 'Answer delivery is unknown. Checking the existing receipt; do not resend.'
    : delivery === 'received' ? 'Answer received · native submission pending'
      : delivery === 'submitted' ? 'Answer submitted to the agent' : undefined

  if (message) {
    return <span className="receipt" role="status">{message}</span>
  }

  const answered = request.answers
    ? request.answers.map(a => a.join(', ')).join(' · ')
    : request.values && Object.entries(request.values).map(([
      k,
      v,
    ]) => `${k}: ${String(v)}`)
      .join(' · ')

  return (
    <span className="receipt">
      {request.status === 'expired'
        ? 'Expired · agent no longer waiting'
        : request.status === 'allow' ? (answered ? `Answered · ${answered}` : 'Allowed') : request.questions || request.form ? 'Skipped' : 'Denied'}
    </span>
  )
}

export function InlinePermissions({
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

  const answer = async ({
    request,
    choice,
    value,
  }: {
    request: string
    choice: 'allow' | 'deny'
    value?: unknown
  }) => {
    setBusy(request)

    try {
      await command({
        name: 'task',
        args: [
          'permission',
          card.id,
          request,
          choice,
          ...(value === undefined ? [] : [
            '--answer',
            JSON.stringify(value),
          ]),
        ],
      })
      notify({ text: value !== undefined ? 'Answer sent.' : choice === 'allow' ? 'Permission allowed.' : 'Permission denied.' })
    } catch (error) {
      notify({ text: (error as Error).message })
    } finally {
      setBusy(null)
    }
  }

  return (
    <>
      {(card.permissions ?? []).filter(request => !pendingOnly || !request.questions || request.status === 'pending' || request.delivery === 'needs_reentry' || request.delivery === 'unknown').map(request => {
        const details = permissionDetails({ request })
        const reentry = request.delivery === 'needs_reentry'
        const pending = request.status === 'pending' || reentry
        const asked: Attention = {
          kind: 'question',
          key: request.id,
          blocking: true,
          ...(request.questions ? { questions: request.questions } : {}),
          ...(request.form ? { form: request.form } : {}),
        }

        return (
          <article key={request.id} className={`ask${pending ? '' : ' answered'}`} aria-label={request.questions ? 'Agent question' : 'Tool permission'}>
            <strong className="ask-title"><Icon name="agent" size={14} />{title({ request })}</strong>
            {details.length > 0 && (
              <dl className="permission-details">
                {details.map(row => (
                  <div key={row.label}>
                    <dt>{row.label}</dt>
                    <dd>{row.label === 'Command' ? <code>{row.text}</code> : row.text}</dd>
                  </div>
                ))}
              </dl>
            )}
            {!request.questions && !request.form && (
              <Disclosure title={<span className="small muted">Full request</span>}>
                <pre className="permission-input">{JSON.stringify(
                  request.input,
                  null,
                  2,
                )}
                </pre>
              </Disclosure>
            )}
            {reentry && <p className="muted small" role="status">The host never received this answer. Enter the missing secret again for the saved decision.</p>}
            {!pending
              ? <Receipt request={request} />
              : request.questions
                ? (
                  <>
                    <Questions
                      request={asked}
                      reentry={reentry}
                      savedAnswers={request.answers}
                      busy={busy === request.id}
                      send={({ value }) => answer({
                        request: request.id,
                        choice: 'allow',
                        value,
                      })}
                    />
                    {!reentry && (
                      <Button
                        variant="surface"
                        disabled={busy !== null}
                        onClick={() => void answer({
                          request: request.id,
                          choice: 'deny',
                        })}
                      >Skip
                      </Button>
                    )}
                  </>
                )
                : request.form
                  ? (
                    <Form
                      request={asked}
                      reentry={reentry}
                      busy={busy === request.id}
                      send={({ value }) => (value as { choice: string }).choice === 'decline'
                        ? answer({
                          request: request.id,
                          choice: 'deny',
                        })
                        : answer({
                          request: request.id,
                          choice: 'allow',
                          value,
                        })}
                    />
                  )
                  : (
                    <div className="row wrap">
                      <Button
                        variant="primary"
                        disabled={busy !== null}
                        onClick={() => void answer({
                          request: request.id,
                          choice: 'allow',
                        })}
                      >Allow
                      </Button>
                      <Button
                        variant="surface"
                        disabled={busy !== null}
                        onClick={() => void answer({
                          request: request.id,
                          choice: 'deny',
                        })}
                      >Deny
                      </Button>
                    </div>
                  )}
          </article>
        )
      })}
    </>
  )
}
