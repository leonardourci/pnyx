import { useEffect, useRef, useState } from 'react'
import type { HydraState } from '#app/model.ts'
import type { Candidate, Harness } from '#workers/dispatch-config.ts'
import { canonical, checkDispatch, pointer, type DispatchChange, type DispatchDocument, type DispatchIssue } from '#workers/dispatch-check.ts'
import type { RuleNow } from '#workers/dispatch.ts'
import type { Command } from '#web-app/connection.ts'
import { CommandFailure } from '#web-shared/pending-intents.ts'
import { Button, Input, Textarea } from '#web-shared/ui/controls.tsx'
import { Icon } from '#web-shared/ui/icon.tsx'
import { PendingStatus } from '#web-shared/ui/pending-status.tsx'
import { Segmented } from '#web-shared/ui/segmented.tsx'
import { Tooltip } from '#web-shared/ui/tooltip.tsx'
import { AgentPickers } from './agent-pickers.tsx'
import { useDispatchProposals } from './dispatch-proposals.tsx'
import type { SavedDispatch } from './dispatch-resource.ts'
import { DISPATCH_CHANGED, useDispatchDocument } from './heads-dispatch.ts'
import { candidateMarks, changeKind, changesBetween, documentOf, draftIssues, formatted, HYDRA_RULE, issuesAt, parseDocument, patchBetween, ruleSegments, toDraft, withCandidates, withNewRule, withoutRule, withRule, type Draft, type RuleAt } from './dispatch-draft.ts'

// Asking for Now waits until typing pauses; quota is read on the server.
const NOW_DELAY_MS = 600

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

const counted = ({
  count,
  word,
}: {
  count: number
  word: string
}) => `${count} ${word}${count === 1 ? '' : 's'}`

const errorsIn = ({ issues }: { issues: DispatchIssue[] }) => issues.filter(issue => issue.level === 'error')

const shown = ({ value }: { value: unknown }) => value === undefined ? '' : JSON.stringify(value)

// rule apply answers with what changed; reading the document in the same step lets the preview become the saved state without a gap.
const showingAfter = ({ command }: { command: Command }): Command => Object.assign(
  async ({
    name,
    args,
    onChecking,
  }: Parameters<Command>[0]) => {
    const applied = await command({
      name,
      args,
      onChecking,
    })

    // The change is saved; a failed read only leaves the next refresh to show it.
    return command({
      name: 'rule',
      args: ['show'],
    }).catch(() => applied)
  },
  { retain: command.retain },
)

// Which candidate each rule would start now, for a document without errors.
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

function ChangeList({ changes }: { changes: DispatchChange[] }) {
  return (
    <ul className="dispatch-changes">
      {changes.map(change => {
        const kind = changeKind({ change })
        const before = shown({ value: change.before })
        const after = shown({ value: change.after })
        const value = kind === 'changed' ? `${before} → ${after}` : before || after

        return (
          <li key={change.path} data-kind={kind}>
            <span className="dispatch-change-kind">{kind}</span>
            <span>
              <code>{change.path}</code>
              <span className="dispatch-change-value">{value}</span>
            </span>
          </li>
        )
      })}
    </ul>
  )
}

function Proposals({
  state,
  command,
  notify,
}: {
  state: HydraState
  command: Command
  notify({ text }: { text: string }): void
}) {
  const {
    proposals,
    busy,
    resolve,
  } = useDispatchProposals({
    state,
    command,
    notify,
  })

  return proposals.filter(({ proposal }) => proposal.kind !== 'command').map(({
    proposal,
    status,
    changes,
    name,
  }) => {
    const stale = status?.outOfDate === true
    const note = stale
      ? `${status.reason}. Dismiss it and ask Hydra again if you still want it.`
      : 'Hydra proposed this in its chat. This is the exact change; nothing applies until you confirm.'

    return (
      <section
        key={proposal.token}
        className="dispatch-proposal"
        data-stale={stale || undefined}
        aria-label={`Proposal: ${proposal.summary}`}
      >
        <h4>
          <span className="dispatch-tag">{stale ? 'Out of date' : <><Icon name="reminder" size={12} />Waiting for your Confirm</>}</span>
          {proposal.summary}
        </h4>
        <p>{note}</p>
        {!stale && changes.length > 0 && <ChangeList changes={changes} />}
        <div className="dispatch-actions">
          {!stale && (
            <Button
              variant="primary"
              disabled={Boolean(busy) || Boolean(proposal.status)}
              onClick={() => void resolve({
                name,
                token: proposal.token,
                action: 'confirm',
              })}
            ><Icon name="check" size={14} />Confirm
            </Button>
          )}
          <Button
            variant="surface"
            disabled={Boolean(busy)}
            onClick={() => void resolve({
              name,
              token: proposal.token,
              action: 'dismiss',
            })}
          ><Icon name="close" size={14} />Dismiss
          </Button>
        </div>
      </section>
    )
  })
}

function HowPicked() {
  return (
    <section className="dispatch-how" aria-labelledby="dispatch-how">
      <h4 id="dispatch-how"><Icon name="about" size={14} />How a worker’s agent is picked</h4>
      <ol>
        <li><strong><Icon name="dispatch" size={14} />1 · Rule</strong>Hydra picks the rule whose “when” fits the task, or you name one with <code>task start --rule</code>. Tasks without one use default.</li>
        <li><strong><Icon name="you" size={14} />2 · Account per candidate</strong>Each candidate takes the first account in its harness’s order below that is signed in and has quota left.</li>
        <li><strong><Icon name="effort" size={14} />3 · Quota decides</strong>quota-axi scores those accounts; the highest score starts the task, and on a tie or unknown quota the first listed candidate starts. The Now column shows the result.</li>
      </ol>
    </section>
  )
}

// Where in its rule a problem sits, such as "candidate 2 effort".
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
}: {
  issues: DispatchIssue[]
  prefix: string
}) {
  if (!issues.length) {
    return null
  }

  return (
    <ul className="dispatch-problems">
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

function NowCell({
  starts,
  index,
}: {
  starts?: RuleNow
  index: number
}) {
  if (starts?.candidate !== index) {
    return <span className="dispatch-now" />
  }

  return (
    <span className="dispatch-now">
      <Tooltip content={starts.reason}>
        <span className="dispatch-starts"><Icon name="check" size={14} /><span>{starts.account}</span></span>
      </Tooltip>
    </span>
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
  const span = { gridRow: `span ${candidates.length + 1}` }

  const setCandidates = ({ next }: { next: Candidate[] }) => edit({
    next: withCandidates({
      draft,
      rule: at,
      candidates: next,
    }),
  })

  return (
    <div className="dispatch-rule" data-rule={name}>
      <div className="dispatch-rule-cell" style={span}>
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
              rows={2}
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
        <Problems issues={mine} prefix={pointer({ segments: place })} />
        {blocked && <p className="dispatch-blocked">{blocked}</p>}
        {!fixed && (
          <Button
            className="dispatch-remove-rule"
            onClick={() => edit({
              next: withoutRule({
                draft,
                rule: at,
              }),
            })}
          ><Icon name="close" size={14} />Remove rule
          </Button>
        )}
      </div>
      {candidates.map((
        candidate,
        index,
      ) => (
        <div key={index} className="dispatch-candidate" data-starts={result?.candidate === index || undefined}>
          <AgentPickers
            label={`${name} candidate ${index + 1}`}
            agent={candidate}
            command={command}
            // Settings shows its rows only while connected.
            connected
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
          <NowCell starts={result} index={index} />
          <Button
            className="dispatch-remove"
            aria-label={`Remove ${name} candidate ${index + 1}`}
            disabled={candidates.length < 2}
            onClick={() => setCandidates({
              next: candidates.filter((
                _,
                position,
              ) => position !== index),
            })}
          ><Icon name="close" size={14} />
          </Button>
        </div>
      ))}
      <div className="dispatch-add">
        <Button
          onClick={() => setCandidates({
            next: [
              ...candidates,
              { harness: 'claude' },
            ],
          })}
        ><Icon name="plus" size={14} />Add candidate
        </Button>
      </div>
    </div>
  )
}

function nowStatus({
  ready,
  starts,
}: {
  ready: boolean
  starts?: Starts
}): string | undefined {
  if (!ready) {
    return 'Fix the problems to see which candidate starts now.'
  }

  if (!starts) {
    return 'Checking quota…'
  }

  return starts.error
}

function RulesTable({
  draft,
  base,
  issues,
  ready,
  starts,
  command,
  edit,
}: {
  draft: Draft
  base: DispatchDocument
  issues: DispatchIssue[]
  ready: boolean
  starts?: Starts
  command: Command
  edit: Edit
}) {
  const named = draft.rules.flatMap((
    rule,
    index,
  ) => rule.name === HYDRA_RULE ? [] : [index])
  const hydra = draft.rules.some(rule => rule.name === HYDRA_RULE)
  const status = nowStatus({
    ready,
    starts,
  })

  return (
    <section className="dispatch-rules" aria-labelledby="dispatch-rules">
      <h4 id="dispatch-rules"><Icon name="dispatch" size={14} />Rules</h4>
      <p className="dispatch-desc">Every rule and candidate in one table. Change any cell in place; changes are marked and wait below until you apply them.</p>
      <div className="dispatch-table">
        <div className="dispatch-head">
          <span>Rule · when Hydra picks it</span>
          <span><Icon name="model" size={14} />Model</span>
          <span><Icon name="effort" size={14} />Effort</span>
          <span>Permissions</span>
          <span>Fast</span>
          <span title="Which candidate would start now, from current quota">Now</span>
          <span />
        </div>
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
        {hydra && (
          <div className="dispatch-hydra-row">
            <span className="dispatch-rule-name"><Icon name="agent" size={14} />hydra</span>
            <span>Hydra’s own agent, not used for workers.</span>
          </div>
        )}
      </div>
      {status && <p className="dispatch-desc" role="status">{status}</p>}
      <Button variant="surface" className="dispatch-add-rule" onClick={() => edit({ next: withNewRule({ draft }) })}><Icon name="plus" size={14} />Add rule</Button>
    </section>
  )
}

function JsonView({
  text,
  write,
  changes,
}: {
  text: string
  write({ text }: { text: string }): void
  changes?: DispatchChange[]
}) {
  const removed = changes?.filter(change => changeKind({ change }) === 'removed').length ?? 0
  const empty = changes === undefined ? 'Fix the JSON to see the changes.' : 'None yet. Delete a rule or an account to see exactly what goes.'

  return (
    <section className="dispatch-json" aria-label="Heads dispatch JSON">
      <p className="dispatch-desc">The whole document. It formats itself when you leave the box, with the same checks, Review and Apply as the table.</p>
      <Textarea
        aria-label="Heads dispatch document"
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
      <div className="dispatch-json-changes">
        <h5>Changes from what is saved{removed > 0 && (
          <span data-kind="removed"> · {counted({
            count: removed,
            word: 'removal',
          })}
          </span>
        )}
        </h5>
        {changes?.length ? <ChangeList changes={changes} /> : <p className="dispatch-desc">{empty}</p>}
      </div>
    </section>
  )
}

function saveStatus({
  errors,
  changes,
}: {
  errors: number
  changes: number
}): string {
  if (errors) {
    return `${counted({
      count: errors,
      word: 'problem',
    })} to fix before saving`
  }

  return changes ? `${counted({
    count: changes,
    word: 'change',
  })} ready` : 'No changes yet'
}

function SaveBar({
  issues,
  changes,
  revision,
  reviewing,
  json,
  review,
  discard,
  apply,
}: {
  issues: DispatchIssue[]
  changes: DispatchChange[]
  revision: number
  reviewing: boolean
  json: boolean
  review({ on }: { on: boolean }): void
  discard(): void
  apply(): void
}) {
  const errors = errorsIn({ issues }).length
  const warnings = issues.length - errors
  const status = saveStatus({
    errors,
    changes: changes.length,
  })
  const warned = warnings ? ` · ${counted({
    count: warnings,
    word: 'warning',
  })}` : ''
  const listed = (json || errors > 0) && issues.length > 0

  return (
    <div className="dispatch-savebar" role="region" aria-label="Heads dispatch changes">
      <span className="dispatch-savebar-status" data-errors={errors > 0 || undefined}>{status}{warned}</span>
      <Button variant="surface" onClick={discard}><Icon name="close" size={14} />Discard</Button>
      {reviewing ? (
        <>
          <Button variant="surface" onClick={() => review({ on: false })}>Back to editing</Button>
          <Button variant="primary" disabled={errors > 0} onClick={apply}><Icon name="check" size={14} />Apply {counted({
            count: changes.length,
            word: 'change',
          })}
          </Button>
        </>
      ) : <Button variant="primary" disabled={errors > 0 || !changes.length} onClick={() => review({ on: true })}>Review changes</Button>}
      {listed && (
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
      )}
      {reviewing && (
        <div className="dispatch-review">
          <ChangeList changes={changes} />
          <p className="dispatch-desc">Saves on revision {revision}. If heads dispatch changed since, Apply refuses and saves nothing.</p>
        </div>
      )}
    </div>
  )
}

// A text that is not JSON has that one problem; a document has the checker's.
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
  state,
  command,
  notify,
}: {
  state: HydraState
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
    reviewing,
    setReviewing,
  ] = useState(false)
  // One event id per envelope, so applying the same change again after an uncertain answer never saves it twice.
  const attempt = useRef<{
    key: string
    id: string
  }>(undefined)
  const saved = snapshot.view
  const base = editor?.base ?? saved
  const savedDraft = saved ? toDraft({ document: saved.document }) : undefined
  const edited = editor && 'draft' in editor ? editor.draft : undefined
  const draft = editor ? edited : savedDraft
  const text = editor && 'text' in editor ? editor.text : undefined
  const json = !draft
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
    setReviewing(false)
  }

  const write = ({ text }: { text: string }) => {
    setEditor({
      base,
      text,
    })
    setReviewing(false)
  }

  const show = ({ value }: { value: string }) => {
    if (value === 'json') {
      write({ text: formatted({ document }) })

      return
    }

    const next = toDraft({ document })

    if (!next) {
      notify({ text: 'Fix the JSON first: the table needs rules and a default list with Claude Code or Codex candidates' })

      return
    }

    edit({ next })
  }

  const discard = () => {
    setEditor(undefined)
    setReviewing(false)
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
    discard()

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
        setEditor(current => current ?? applying)
      }
    }
  }

  const unsaved = json || (changes?.length ?? 0) > 0

  return (
    <div className="dispatch-settings">
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
      <Proposals state={state} command={command} notify={notify} />
      <HowPicked />
      {draft ? (
        <RulesTable
          draft={draft}
          base={base.document}
          issues={issues}
          ready={ready}
          starts={starts}
          command={command}
          edit={edit}
        />
      ) : (
        <JsonView text={shownText} write={write} changes={changes} />
      )}
      {unsaved && (
        <SaveBar
          issues={issues}
          changes={changes ?? []}
          revision={base.revision}
          reviewing={reviewing}
          json={json}
          review={({ on }) => setReviewing(on)}
          discard={discard}
          apply={() => void apply()}
        />
      )}
    </div>
  )
}
