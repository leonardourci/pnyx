import { useEffect, useId, useRef, useState } from 'react'
import type { Candidate } from '#workers/dispatch-config.ts'
import { canonical, checkDispatch, pointer, type DispatchDocument, type DispatchIssue } from '#workers/dispatch-check.ts'
import type { RuleNow } from '#workers/dispatch.ts'
import type { Command } from '#web-app/connection.ts'
import { CommandFailure } from '#web-shared/pending-intents.ts'
import { Button, Input, Textarea } from '#web-shared/ui/controls.tsx'
import { Icon } from '#web-shared/ui/icon.tsx'
import { PendingStatus } from '#web-shared/ui/pending-status.tsx'
import { Segmented } from '#web-shared/ui/segmented.tsx'
import { AgentPickers } from './agent-pickers.tsx'
import { AccountModelPicker } from './account-model-picker.tsx'
import type { SavedDispatch } from './dispatch-resource.ts'
import { DISPATCH_CHANGED, showingAfter, useDispatchDocument, useHeadsDispatch } from './heads-dispatch.ts'
import { candidateMarks, changesBetween, documentOf, draftIssues, formatted, HYDRA_RULE, issuesAt, parseDocument, patchBetween, ruleSegments, toDraft, withCandidates, withNewRule, withoutRule, withRule, type Draft, type RuleAt } from './dispatch-draft.ts'

// Refreshing the resolved account waits until typing pauses; quota is read on the server.
const NOW_DELAY_MS = 600

// Problems a rule shows beside itself.
const BESIDE_A_RULE = /^\/(rules|default)(\/|$)/

const VIEWS = [
  {
    value: 'table',
    label: 'Table',
  },
  {
    value: 'json',
    label: 'JSON',
  },
]

type Editor = { base: SavedDispatch } & ({ draft: Draft } | { text: string })

type Edit = ({ next }: { next: Draft }) => void

interface Starts {
  now?: RuleNow[]
  error?: string
}

const errorsIn = ({ issues }: { issues: DispatchIssue[] }) => issues.filter(issue => issue.level === 'error')

function useStartsNow({
  command,
  document,
  ready,
}: {
  command: Command
  document: unknown
  ready: boolean
}): Starts | undefined {
  const key = ready ? canonical({ value: document }) : ''
  const [
    found,
    setFound,
  ] = useState<Starts & { key: string }>()

  useEffect(
    () => {
      if (!key) {
        return
      }

      let active = true
      const timer = setTimeout(
        () => {
          void command({
            name: 'rule',
            args: [
              'now',
              '--json',
              key,
            ],
          }).then(
            receipt => {
              if (active) {
                setFound({
                  key,
                  now: receipt.now as RuleNow[],
                })
              }
            },
            (error: Error) => {
              if (active) {
                setFound({
                  key,
                  error: error.message,
                })
              }
            },
          )
        },
        NOW_DELAY_MS,
      )

      return () => {
        active = false
        clearTimeout(timer)
      }
    },
    [
      command,
      key,
    ],
  )

  return found?.key === key ? found : undefined
}

function HowPicked() {
  return (
    <section className="dispatch-how" aria-labelledby="dispatch-how">
      <h4 id="dispatch-how"><Icon name="about" size={14} />How a worker’s agent is picked</h4>
      <ol>
        <li><strong><Icon name="dispatch" size={14} />1 · Rule</strong>Hydra picks the rule whose “when” fits the task, or you name one with <code>task start --rule</code>. Tasks without one use default.</li>
        <li><strong><Icon name="you" size={14} />2 · Account per candidate</strong>A named account stays fixed. Otherwise the candidate takes the first usable account in its harness’s configured order.</li>
        <li><strong><Icon name="effort" size={14} />3 · Quota decides</strong>quota-axi scores those accounts; the highest score starts the task, and on a tie or unknown quota the first listed candidate starts.</li>
      </ol>
      <p className="dispatch-desc">Fast on in a Hydra’s composer puts every worker that Hydra starts on Fast, whatever its candidate says, where the model has Fast.</p>
    </section>
  )
}

function placeOf({
  issue,
  prefix,
}: {
  issue: DispatchIssue
  prefix: string
}): string {
  const rest = issue.path.slice(prefix.length).split('/')
    .filter(Boolean)
  const place = rest[0] === 'candidates' ? rest.slice(1) : rest
  const candidate = place[0] !== undefined && /^\d+$/.test(place[0]) ? [
    `candidate ${Number(place[0]) + 1}`,
    ...place.slice(1),
  ] : place

  return candidate.join(' ')
}

function Problems({
  issues,
  prefix,
  id,
}: {
  issues: DispatchIssue[]
  prefix: string
  id: string
}) {
  if (!issues.length) {
    return null
  }

  return (
    <ul className="dispatch-problems" id={id}>
      {issues.map((
        issue,
        index,
      ) => {
        const place = placeOf({
          issue,
          prefix,
        })

        return <li key={index} data-level={issue.level}>{place ? `${place}: ` : ''}{issue.problem}</li>
      })}
    </ul>
  )
}

function RuleGroup({
  draft,
  at,
  base,
  issues,
  starts,
  command,
  edit,
}: {
  draft: Draft
  at: RuleAt
  base: DispatchDocument
  issues: DispatchIssue[]
  starts?: Starts
  command: Command
  edit: Edit
}) {
  const { effective } = useHeadsDispatch({ command })
  const problemsId = useId()
  const fixed = at === 'default'
  const rule = fixed ? undefined : draft.rules[at]
  const name = rule?.name ?? 'default'
  const candidates = fixed ? draft.default : rule!.candidates
  const saved = !fixed && Object.hasOwn(
    base.rules,
    name,
  ) ? base.rules[name] : undefined
  const savedCandidates = fixed ? base.default : saved?.candidates ?? []
  const segments = ruleSegments({ name })
  const place = fixed ? ['default'] : [
    'rules',
    name,
  ]
  const mine = issuesAt({
    issues,
    segments: place,
    under: true,
  })
  const broken = ({ field = [] }: { field?: string[] }) => errorsIn({
    issues: issuesAt({
      issues,
      segments: [
        ...place,
        ...field,
      ],
    }),
  }).length > 0
  const result = starts?.now?.find(item => item.rule === name)
  const blocked = result && result.candidate === undefined ? `Cannot start now: ${result.reason}` : undefined

  const setCandidates = ({ next }: { next: Candidate[] }) => edit({
    next: withCandidates({
      draft,
      rule: at,
      candidates: next,
    }),
  })

  return (
    <div className="dispatch-rule" data-rule={name}>
      <div className="dispatch-rule-head">
        <div className="dispatch-rule-text">
          {fixed ? (
            <>
              <span className="dispatch-rule-name"><Icon name="dispatch" size={14} />default</span>
              <span className="dispatch-when-fixed">Tasks without a named rule.</span>
            </>
          ) : (
            <>
              <Input
                className="dispatch-cell dispatch-rule-input"
                aria-label="Rule name"
                aria-invalid={broken({}) || undefined}
                data-changed={!saved || undefined}
                value={name}
                onChange={event => edit({
                  next: withRule({
                    draft,
                    rule: at,
                    change: { name: event.target.value },
                  }),
                })}
              />
              <Textarea
                className="dispatch-cell dispatch-when"
                rows={1}
                aria-label={`When Hydra picks ${name}`}
                aria-invalid={broken({ field: ['when'] }) || undefined}
                data-changed={saved?.when !== rule!.when || undefined}
                placeholder="When should Hydra pick this rule?"
                value={rule!.when}
                onChange={event => edit({
                  next: withRule({
                    draft,
                    rule: at,
                    change: { when: event.target.value },
                  }),
                })}
              />
            </>
          )}
          <Problems issues={mine} prefix={pointer({ segments: place })} id={problemsId} />
          {blocked && <p className="dispatch-blocked">{blocked}</p>}
        </div>
        {!fixed && (
          <ConfirmRemove
            label={`Remove the ${name} rule`}
            question="Remove rule?"
            then=".dispatch-add-rule"
            remove={() => edit({
              next: withoutRule({
                draft,
                rule: at,
              }),
            })}
          />
        )}
      </div>
      {candidates.map((
        candidate,
        index,
      ) => (
        <div key={index} className="dispatch-candidate">
          <AgentPickers
            label={`${name} candidate ${index + 1}`}
            agent={candidate}
            inherited={{ account: draft.workers[candidate.harness]?.[0] }}
            command={command}
            // Settings shows its rows only while connected.
            connected
            describedBy={mine.length ? problemsId : undefined}
            marks={candidateMarks({
              saved: savedCandidates[index],
              candidate,
              issues,
              segments: [
                ...segments,
                String(index),
              ],
            })}
            onChange={({ next }) => setCandidates({
              next: candidates.map((
                item,
                position,
              ) => position === index ? next : item),
            })}
          />
          <ConfirmRemove
            label={`Remove ${name} candidate ${index + 1}`}
            question="Remove?"
            then=".dispatch-add button"
            disabled={candidates.length < 2}
            remove={() => setCandidates({
              next: candidates.filter((
                _,
                position,
              ) => position !== index),
            })}
          />
        </div>
      ))}
      <div className="dispatch-add">
        {effective && (
          <AccountModelPicker
            label={`Add ${name} candidate`}
            modelLabel="Model"
            agent={{ harness: 'claude' }}
            effective={effective}
            command={command}
            connected
            trigger={<><Icon name="plus" size={14} />Add candidate</>}
            change={({ next }) => setCandidates({
              next: [
                ...candidates,
                next,
              ],
            })}
          />
        )}
      </div>
    </div>
  )
}

// A remove button that asks in its own spot: the question covers the button instead of adding a line.
function ConfirmRemove({
  label,
  question,
  disabled = false,
  then,
  remove,
}: {
  label: string
  question: string
  disabled?: boolean
  // Where focus lands once the row is gone: the nearest element matching this selector.
  then: string
  remove(): void
}) {
  const [
    open,
    setOpen,
  ] = useState(false)
  const trigger = useRef<HTMLButtonElement>(null)
  const keep = useRef<HTMLButtonElement>(null)

  useEffect(
    () => {
      if (open) {
        keep.current?.focus()
      }
    },
    [open],
  )

  const cancel = () => {
    setOpen(false); trigger.current?.focus()
  }

  return (
    <div
      className="dispatch-remove-slot"
      onKeyDown={event => {
        if (event.key === 'Escape' && open) {
          event.stopPropagation(); cancel()
        }
      }}
    >
      <Button
        ref={trigger}
        className="dispatch-remove"
        aria-label={label}
        title={label}
        aria-expanded={open}
        disabled={disabled}
        onClick={() => setOpen(true)}
      ><Icon name="close" size={14} />
      </Button>
      {/* Always mounted so it can unfold from the x; hidden, it cannot be reached. Focus starts on Cancel, the safe choice. */}
      <div
        className="dispatch-confirm"
        role="group"
        aria-label={label}
        data-open={open || undefined}
        aria-hidden={!open}
      >
        <span>{question}</span>
        <Button ref={keep} onClick={cancel}>Cancel</Button>
        <Button
          variant="primary"
          onClick={() => {
            setOpen(false)
            trigger.current?.closest(`:has(${then})`)?.querySelector<HTMLElement>(then)
              ?.focus()
            remove()
          }}
        >Remove
        </Button>
      </div>
    </div>
  )
}

function RulesTable({
  draft,
  base,
  issues,
  starts,
  command,
  edit,
}: {
  draft: Draft
  base: DispatchDocument
  issues: DispatchIssue[]
  starts?: Starts
  command: Command
  edit: Edit
}) {
  const named = draft.rules.flatMap((
    rule,
    index,
  ) => rule.name === HYDRA_RULE ? [] : [index])

  return (
    <section className="dispatch-rules" aria-labelledby="dispatch-rules">
      <h4 id="dispatch-rules"><Icon name="dispatch" size={14} />Rules</h4>
      <p className="dispatch-desc">Each rule, then the candidates Hydra tries for it. Change any cell in place. A valid change saves as soon as you pick it or leave the field; a problem shows beside its rule and saves nothing.</p>
      <div className="dispatch-table">
        <RuleGroup
          draft={draft}
          at="default"
          base={base}
          issues={issues}
          starts={starts}
          command={command}
          edit={edit}
        />
        {named.map(index => (
          <RuleGroup
            key={index}
            draft={draft}
            at={index}
            base={base}
            issues={issues}
            starts={starts}
            command={command}
            edit={edit}
          />
        ))}
      </div>
      <IssueList issues={issues.filter(issue => !BESIDE_A_RULE.test(issue.path))} />
      {starts?.error && <p className="dispatch-desc" role="status">{starts.error}</p>}
      <Button variant="surface" className="dispatch-add-rule" onClick={() => edit({ next: withNewRule({ draft }) })}><Icon name="plus" size={14} />Add rule</Button>
    </section>
  )
}

// Problems no rule row shows, listed by their place in the document.
function IssueList({ issues }: { issues: DispatchIssue[] }) {
  if (!issues.length) {
    return null
  }

  return (
    <ul className="dispatch-issues">
      {issues.map((
        issue,
        index,
      ) => (
        <li key={index}>
          <span className="dispatch-tag" data-level={issue.level}>{issue.level}</span>
          <span><code>{issue.path || '/'}</code> {issue.problem}</span>
        </li>
      ))}
    </ul>
  )
}

function JsonView({
  text,
  write,
  issues,
}: {
  text: string
  write({ text }: { text: string }): void
  issues: DispatchIssue[]
}) {
  return (
    <section className="dispatch-json" aria-label="Heads dispatch JSON">
      <p className="dispatch-desc">The whole document, with the same checks as the table. It formats itself and saves when you leave the box, if it is valid.</p>
      <Textarea
        aria-label="Heads dispatch document"
        aria-invalid={errorsIn({ issues }).length > 0 || undefined}
        spellCheck={false}
        value={text}
        onChange={event => write({ text: event.target.value })}
        onBlur={() => {
          const { document } = parseDocument({ text })

          if (document !== undefined) {
            write({ text: formatted({ document }) })
          }
        }}
      />
      <IssueList issues={issues} />
    </section>
  )
}

function jsonIssues({
  document,
  problem,
}: {
  document: unknown
  problem?: string
}): DispatchIssue[] {
  if (problem) {
    return [
      {
        path: '',
        level: 'error',
        problem,
      },
    ]
  }

  return checkDispatch({ document })
}

export function DispatchSettings({
  command,
  notify,
}: {
  command: Command
  notify({ text }: { text: string }): void
}) {
  const {
    snapshot,
    resource,
  } = useDispatchDocument({ command })
  const [
    editor,
    setEditor,
  ] = useState<Editor>()
  const [
    view,
    setView,
  ] = useState('table')
  // Bumped when focus leaves a field, so an edit typed there saves once it is left.
  const [
    left,
    setLeft,
  ] = useState(0)
  const root = useRef<HTMLDivElement>(null)
  const save = useRef<() => void>(undefined)
  // A change the server refused is not sent again until it changes.
  const refused = useRef('')
  // One event id per envelope, so applying the same change again after an uncertain answer never saves it twice.
  const attempt = useRef<{
    key: string
    id: string
  }>(undefined)
  const saved = snapshot.view
  const base = editor?.base ?? saved
  const savedDraft = saved ? toDraft({ document: saved.document }) : undefined
  const edited = editor && 'draft' in editor ? editor.draft : undefined
  const json = view === 'json' || !(edited ?? savedDraft)
  const draft = json ? undefined : edited ?? savedDraft
  const text = editor && 'text' in editor ? editor.text : undefined
  const shownText = text ?? formatted({ document: saved?.document })
  const parsed = json ? parseDocument({ text: shownText }) : undefined
  const tableDocument = draft ? documentOf({ draft }) : undefined
  const document = tableDocument ?? parsed?.document
  const issues = draft ? draftIssues({ draft }) : jsonIssues({
    document,
    problem: parsed?.problem,
  })
  const changes = base && document !== undefined ? changesBetween({
    before: base.document,
    after: document,
  }) : undefined
  const ready = document !== undefined && !errorsIn({ issues }).length
  const starts = useStartsNow({
    command,
    document,
    ready,
  })
  const pending = editor && ready && changes?.length ? canonical({
    value: {
      revision: base?.revision,
      document,
    },
  }) : ''

  useEffect(
    () => {
      const focused = window.document.activeElement
      // A field being typed in saves when it is left, so a renamed rule never moves mid-word.
      const typing = !!focused && !!root.current?.contains(focused) && focused.matches('input, textarea')

      if (pending && pending !== refused.current && !typing) {
        save.current?.()
      }
    },
    [
      pending,
      left,
    ],
  )

  if (!saved || !base) {
    return (
      <div className="dispatch-settings">
        <p className="dispatch-desc" role={snapshot.error ? 'alert' : 'status'}>{snapshot.error || 'Reading heads dispatch…'}</p>
      </div>
    )
  }

  const edit: Edit = ({ next }) => {
    setEditor({
      base,
      draft: next,
    })
  }

  const write = ({ text }: { text: string }) => {
    setEditor({
      base,
      text,
    })
  }

  const show = ({ value }: { value: string }) => {
    if (value === 'json') {
      write({ text: formatted({ document }) })
      setView('json')

      return
    }

    const next = toDraft({ document })

    if (!next) {
      notify({ text: 'Fix the JSON first: the table needs rules and a default list with Claude Code or Codex candidates' })

      return
    }

    edit({ next })
    setView('table')
  }

  const apply = async () => {
    if (document === undefined) {
      return
    }

    const envelope = {
      version: 1,
      expected: { revision: base.revision },
      patch: patchBetween({
        before: base.document,
        after: document,
      }),
    }
    const key = canonical({ value: envelope })

    if (attempt.current?.key !== key) {
      attempt.current = {
        key,
        id: crypto.randomUUID(),
      }
    }

    const applying = editor
    const sent = pending
    setEditor(undefined)

    try {
      await resource.write({
        command: showingAfter({ command }),
        name: 'rule',
        args: [
          'apply',
          '--json',
          JSON.stringify(envelope),
          '--event-id',
          attempt.current.id,
        ],
        patch: envelope.patch,
        targets: ['dispatch'],
      })
      window.dispatchEvent(new Event(DISPATCH_CHANGED))
    } catch (error) {
      if (!(error instanceof CommandFailure)) {
        throw error
      }

      // The section shows the reason; a refused draft comes back unless a newer edit started.
      if (error.outcome === 'refused') {
        refused.current = sent
        setEditor(current => current ?? applying)
      }
    }
  }

  save.current = () => void apply().catch((error: Error) => notify({ text: error.message }))

  return (
    <div className="dispatch-settings" ref={root} onBlur={() => setLeft(count => count + 1)}>
      <div className="dispatch-top">
        <span className="dispatch-source"><Icon name="file" size={14} />Shared by every Hydra · revision <code>{saved.revision}</code></span>
        <Segmented
          label="Heads dispatch view"
          value={json ? 'json' : 'table'}
          options={VIEWS}
          onChange={show}
        />
      </div>
      <PendingStatus intents={snapshot.intents} />
      {snapshot.error && <p className="dispatch-error" role="alert">{snapshot.error}</p>}
      <HowPicked />
      {draft ? (
        <RulesTable
          draft={draft}
          base={base.document}
          issues={issues}
          starts={starts}
          command={command}
          edit={edit}
        />
      ) : (
        <JsonView text={shownText} write={write} issues={issues} />
      )}
    </div>
  )
}
