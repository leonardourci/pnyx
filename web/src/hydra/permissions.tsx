import { useState } from 'react'
import type { Attention, Card, PermissionRequest } from '../../../src/core/model.ts'
import { permissionDetails } from '../../../src/core/permissions.ts'
import { Button } from '../components/ui/controls.tsx'
import { Disclosure } from '../components/ui/disclosure.tsx'
import { Icon } from '../components/ui/icon.tsx'
import type { Command } from './connection.ts'
import { Form, Questions } from './questions.tsx'

const title = ({ request }: { request: PermissionRequest }) => request.questions
  ? 'Asking you'
  : request.form ? `Asking for input · ${request.tool}` : `Asking permission · ${request.tool}`

function Receipt({ request }: { request: PermissionRequest }) {
  const answered = request.answers
    ? request.answers.map(a => a.join(', ')).join(' · ')
    : request.values && Object.entries(request.values).map(([k, v]) => `${k}: ${String(v)}`)
      .join(' · ')

  return (
    <span className="receipt">
      {request.status === 'expired'
        ? 'Expired · agent no longer waiting'
        : request.status === 'allow' ? (answered ? `Answered · ${answered}` : 'Allowed') : request.questions || request.form ? 'Skipped' : 'Denied'}
    </span>
  )
}

export function InlinePermissions({ card, command, notify }: {
  card: Card
  command: Command
  notify({ text }: { text: string }): void
}) {
  const [busy, setBusy] = useState<string | null>(null)

  const answer = async ({ request, choice, value }: { request: string; choice: 'allow' | 'deny'; value?: unknown }) => {
    setBusy(request)

    try {
      await command({ name: 'task', args: ['permission', card.id, request, choice, ...(value === undefined ? [] : ['--answer', JSON.stringify(value)])] })
      notify({ text: value !== undefined ? 'Answer sent.' : choice === 'allow' ? 'Permission allowed.' : 'Permission denied.' })
    } catch (error) {
      notify({ text: (error as Error).message })
    } finally {
      setBusy(null)
    }
  }

  return (
    <>
      {(card.permissions ?? []).map(request => {
        const details = permissionDetails({ request })
        const pending = request.status === 'pending'
        const asked: Attention = { kind: 'question', key: request.id, blocking: true, ...(request.questions ? { questions: request.questions } : {}), ...(request.form ? { form: request.form } : {}) }

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
                <pre className="permission-input">{JSON.stringify(request.input, null, 2)}</pre>
              </Disclosure>
            )}
            {!pending
              ? <Receipt request={request} />
              : request.questions
                ? (
                  <>
                    <Questions request={asked} busy={busy === request.id} send={({ value }) => answer({ request: request.id, choice: 'allow', value })} />
                    <Button variant="surface" disabled={busy !== null} onClick={() => void answer({ request: request.id, choice: 'deny' })}>Skip</Button>
                  </>
                )
                : request.form
                  ? (
                    <Form
                      request={asked}
                      busy={busy === request.id}
                      send={({ value }) => (value as { choice: string }).choice === 'decline'
                        ? answer({ request: request.id, choice: 'deny' })
                        : answer({ request: request.id, choice: 'allow', value })}
                    />
                  )
                  : (
                    <div className="row wrap">
                      <Button variant="primary" disabled={busy !== null} onClick={() => void answer({ request: request.id, choice: 'allow' })}>Allow</Button>
                      <Button variant="surface" disabled={busy !== null} onClick={() => void answer({ request: request.id, choice: 'deny' })}>Deny</Button>
                    </div>
                  )}
          </article>
        )
      })}
    </>
  )
}
