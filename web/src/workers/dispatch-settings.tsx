import { useEffect, useId, useRef, useState, type ComponentProps } from 'react'
import type { Candidate } from '#workers/dispatch-config.ts'
import { canonical, checkDispatch, pointer, type DispatchDocument, type DispatchIssue } from '#workers/dispatch-check.ts'
import type { RuleNow } from '#workers/dispatch.ts'
import type { Command } from '#web-app/connection.ts'
import { CommandFailure } from '#web-shared/pending-intents.ts'
import { Button, Input, Textarea } from '#web-shared/ui/controls.tsx'
import { ICON_SIZE, Icon } from '#web-shared/icons.tsx'
import { PendingStatus } from '#web-shared/ui/pending-status.tsx'
import { Segmented } from '#web-shared/ui/segmented.tsx'
import { AgentPickers } from './agent-pickers.tsx'
import { AccountModelPicker } from './account-model-picker.tsx'
import type { SavedDispatch } from './dispatch-resource.ts'
import { DISPATCH_CHANGED, showingAfter, useDispatchDocument, useHeadsDispatch } from './heads-dispatch.ts'
import { candidateMarks, changesBetween, documentOf, draftIssues, formatted, HYDRA_RULE, issuesAt, parseDocument, patchBetween, ruleSegments, toDraft, withCandidates, withNewRule, withoutRule, withRule, type Draft, type RuleAt } from './dispatch-draft.ts'

function DispatchFrame({ ...props }: ComponentProps<'div'>) {
  return <div {...props} className="dispatch-settings flex flex-col gap-4 w-full min-w-0 text-ui [&_h4]:m-0 [&_h4]:flex [&_h4]:items-center [&_h4]:gap-1.5 [&_h4]:text-ui [&_h4_svg]:text-muted" />
}

function DispatchDescription({ ...props }: ComponentProps<'p'>) {
  return <p {...props} className="dispatch-desc text-muted text-meta" />
}

function DispatchSection({
  json = false,
  ...props
}: ComponentProps<'section'> & { json?: boolean }) {
  const appearance = json ? 'dispatch-json [&>.textarea]:min-h-90 [&>.textarea]:font-mono [&>.textarea]:text-meta [&>.textarea]:whitespace-pre [&>.textarea]:[tab-size:2] [&>.textarea]:resize-y' : 'dispatch-rules'

  return <section {...props} className={`flex flex-col gap-2 ${appearance}`} />
}

function CandidateRow({
  add = false,
  ...props
}: ComponentProps<'div'> & { add?: boolean }) {
  const appearance = add
    ? 'dispatch-add border-b-0 [&>.account-model-picker]:col-span-full [&>.account-model-picker]:justify-self-start [&>.account-model-picker>.button]:min-h-6 [&>.account-model-picker>.button]:gap-1 [&>.account-model-picker>.button]:text-meta'
    : 'dispatch-candidate border-b border-subtle [&>.hydra-agent-pickers]:col-span-7 [&>.hydra-agent-pickers]:col-start-1 [&>.hydra-agent-pickers]:grid [&>.hydra-agent-pickers]:grid-cols-subgrid [&>.hydra-agent-pickers]:gap-x-[normal] [&>.hydra-agent-pickers>:nth-child(2_of_.picker-field)]:col-start-3 [&>.hydra-agent-pickers>:nth-child(3_of_.picker-field)]:col-start-5 [&>.hydra-agent-pickers>.tooltip-anchor]:col-start-7 [&>.hydra-agent-pickers>[role=alert]]:col-span-full [&_.select-menu]:top-[calc(100%+4px)] [&_.select-menu]:bottom-auto [&>.dispatch-remove-slot]:col-start-[-2] [&>.dispatch-remove-slot]:justify-self-end [&>.hydra-agent-pickers>*]:justify-self-start [&>.hydra-agent-pickers>.tooltip-anchor]:justify-self-center max-[760px]:[&>.hydra-agent-pickers]:flex max-[760px]:[&>.hydra-agent-pickers]:basis-full'

  return <div {...props} className={`col-span-full grid grid-cols-subgrid items-center py-2 px-0 max-[760px]:flex max-[760px]:flex-wrap max-[760px]:gap-(--settings-column-gap) max-[760px]:py-(--settings-column-gap) ${appearance}`} />
}

const CELL_CLASSES = 'dispatch-cell [:where(&)]:w-full py-0.5 px-1.25 border-transparent bg-transparent hover:border-line focus:border-gold-line focus:bg-surface focus:outline-none'

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
    <section className="dispatch-how py-2.5 px-3 border border-subtle rounded-lg bg-background [&_ol]:mt-2 [&_ol]:mx-0 [&_ol]:mb-0 [&_ol]:p-0 [&_ol]:list-none [&_ol]:grid [&_ol]:grid-cols-3 [&_ol]:gap-2.5 [&_li]:pl-2 [&_li]:border-l-2 [&_li]:border-gold-line [&_li]:text-muted [&_li]:text-meta [&_li_strong]:flex [&_li_strong]:items-center [&_li_strong]:gap-1.25 [&_li_strong]:mb-0.5 [&_li_strong]:text-ink [&_li_strong]:text-ui [&>.dispatch-desc]:mt-2 [&>.dispatch-desc]:mx-0 [&>.dispatch-desc]:mb-0 max-[760px]:[&_ol]:grid-cols-1" aria-labelledby="dispatch-how">
      <h4 id="dispatch-how"><Icon name="about" size={ICON_SIZE.inline} />How a worker’s agent is picked</h4>
      <ol>
        <li><strong><Icon name="dispatch" size={ICON_SIZE.inline} />1 · Rule</strong>Hydra picks the rule whose “when” fits the task, or you name one with <code>task start --rule</code>. Tasks without one use default.</li>
        <li><strong><Icon name="you" size={ICON_SIZE.inline} />2 · Account per candidate</strong>A named account stays fixed. Otherwise the candidate takes the first usable account in its harness’s configured order.</li>
        <li><strong><Icon name="effort" size={ICON_SIZE.inline} />3 · Quota decides</strong>quota-axi scores those accounts; the highest score starts the task, and on a tie or unknown quota the first listed candidate starts.</li>
      </ol>
      <DispatchDescription>
        Fast on in a Hydra’s composer puts every worker that Hydra starts on Fast, whatever its
        candidate says, where the model has Fast.
      </DispatchDescription>
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
    <ul className="dispatch-problems m-0 p-0 list-none text-red text-meta leading-prose-heading [&_li[data-level=warning]]:text-gold [&_li[data-level=warning]]:text-meta" id={id}>
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
    <div className="dispatch-rule col-span-full grid grid-cols-subgrid pb-1.5 [&+.dispatch-rule]:border-t [&+.dispatch-rule]:border-line max-[760px]:block" data-rule={name}>
      <div className="dispatch-rule-head col-span-full grid grid-cols-[minmax(0,1fr)_auto] items-center gap-y-0.5 gap-x-3 pt-3 [&>.dispatch-remove-slot]:row-start-1 [&>.dispatch-remove-slot]:col-start-2">
        <div className="dispatch-rule-text contents [&>:first-child]:justify-self-start [&>:not(:first-child)]:col-span-full">
          {fixed ? (
            <>
              <span className="dispatch-rule-name inline-flex items-center gap-1 font-mono font-semibold px-1.5 [&_svg]:text-muted"><Icon name="dispatch" size={ICON_SIZE.inline} />default</span>
              <span className="dispatch-when-fixed px-1.5 text-muted text-meta">Tasks without a named rule.</span>
            </>
          ) : (
            <>
              <Input
                className={`${CELL_CLASSES} dispatch-rule-input w-auto max-w-full min-w-dispatch-name [field-sizing:content] font-mono font-semibold`}
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
                className={`${CELL_CLASSES} dispatch-when min-h-0 resize-none [field-sizing:content] text-muted text-meta`}
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
          {blocked && <p className="dispatch-blocked text-gold text-meta">{blocked}</p>}
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
        <CandidateRow key={index}>
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
        </CandidateRow>
      ))}
      <CandidateRow add>
        {effective && (
          <AccountModelPicker
            label={`Add ${name} candidate`}
            modelLabel="Model"
            agent={{ harness: 'claude' }}
            effective={effective}
            command={command}
            connected
            trigger={<><Icon name="plus" size={ICON_SIZE.inline} />Add candidate</>}
            change={({ next }) => setCandidates({
              next: [
                ...candidates,
                next,
              ],
            })}
          />
        )}
      </CandidateRow>
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
      className="dispatch-remove-slot relative flex justify-end has-[>.dispatch-confirm[data-open]]:[&>.dispatch-remove]:opacity-0 has-[>.dispatch-confirm[data-open]]:[&>.dispatch-remove]:transition-none"
      onKeyDown={event => {
        if (event.key === 'Escape' && open) {
          event.stopPropagation(); cancel()
        }
      }}
    >
      <Button
        ref={trigger}
        className="dispatch-remove min-h-6 gap-1 text-muted text-meta transition-opacity duration-instant delay-(--duration-dispatch) motion-reduce:transition-none"
        aria-label={label}
        title={label}
        aria-expanded={open}
        disabled={disabled}
        onClick={() => setOpen(true)}
      ><Icon name="close" size={ICON_SIZE.inline} />
      </Button>
      {/* Always mounted so it can unfold from the x; hidden, it cannot be reached. Focus starts on Cancel, the safe choice. */}
      <div
        className="dispatch-confirm absolute top-1/2 right-0 z-2 flex items-center gap-1.5 py-0.5 pr-0 pl-2.5 invisible [clip-path:inset(calc(-1*var(--spacing))_0_calc(-1*var(--spacing))_calc(100%_-_var(--agent-control-h)))] -translate-y-1/2 [transition:var(--transition-dispatch-closed)] bg-surface shadow-dispatch text-meta whitespace-nowrap data-open:visible data-open:[clip-path:inset(calc(-1*var(--spacing))_0_calc(-1*var(--spacing))_calc(-6*var(--spacing)))] data-open:[transition:var(--transition-dispatch-open)] motion-reduce:transition-none motion-reduce:data-open:transition-none [&_.button]:min-h-6.5 [&_.button]:py-0.5 [&_.button]:px-2.5 [&_.button]:text-meta"
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
    <DispatchSection aria-labelledby="dispatch-rules">
      <h4 id="dispatch-rules"><Icon name="dispatch" size={ICON_SIZE.inline} />Rules</h4>
      <DispatchDescription>
        Each rule, then the candidates Hydra tries for it. Change any cell in place. A valid
        change saves as soon as you pick it or leave the field; a problem shows beside its rule
        and saves nothing.
      </DispatchDescription>
      <div className="dispatch-table [--dispatch-space:minmax(calc(var(--settings-column-gap)/2),1fr)] grid grid-cols-[repeat(4,max-content_var(--dispatch-space))_max-content] py-0 px-5 border border-line rounded-lg bg-surface [&_.dispatch-cell[data-changed]]:bg-gold-wash [&_.picker-field[data-changed]>:is(.select,.account-model-picker)>.button]:bg-gold-wash [&_.fast-toggle[data-changed]]:bg-gold-wash [&_[aria-invalid=true]]:shadow-invalid [&_.picker-field[data-invalid]>:is(.select,.account-model-picker)>.button]:shadow-invalid max-[760px]:grid-cols-1">
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
      {starts?.error && <DispatchDescription role="status">{starts.error}</DispatchDescription>}
      <Button variant="surface" className="dispatch-add-rule self-start" onClick={() => edit({ next: withNewRule({ draft }) })}><Icon name="plus" size={ICON_SIZE.inline} />Add rule</Button>
    </DispatchSection>
  )
}

// Problems no rule row shows, listed by their place in the document.
function IssueList({ issues }: { issues: DispatchIssue[] }) {
  if (!issues.length) {
    return null
  }

  return (
    <ul className="dispatch-issues m-0 p-0 list-none text-meta [&_li]:grid [&_li]:grid-cols-[var(--spacing-dispatch-issue)_minmax(0,1fr)] [&_li]:items-baseline [&_li]:gap-2 [&_li]:py-0.75 [&_li]:px-0">
      {issues.map((
        issue,
        index,
      ) => (
        <li key={index}>
          <span className="dispatch-tag inline-flex items-center gap-1 py-px px-1.75 border border-line rounded-full text-muted text-meta font-medium whitespace-nowrap data-[level=error]:border-red/45 data-[level=error]:text-red data-[level=warning]:border-gold-line data-[level=warning]:text-gold" data-level={issue.level}>{issue.level}</span>
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
    <DispatchSection json aria-label="Heads dispatch JSON">
      <DispatchDescription>
        The whole document, with the same checks as the table. It formats itself and saves when
        you leave the box, if it is valid.
      </DispatchDescription>
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
    </DispatchSection>
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
      <DispatchFrame>
        <DispatchDescription role={snapshot.error ? 'alert' : 'status'}>{snapshot.error || 'Reading heads dispatch…'}</DispatchDescription>
      </DispatchFrame>
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
    <DispatchFrame ref={root} onBlur={() => setLeft(count => count + 1)}>
      <div className="dispatch-top flex items-center justify-between flex-wrap gap-3">
        <span className="dispatch-source inline-flex items-center gap-1.5 text-muted text-meta"><Icon name="file" size={ICON_SIZE.inline} />Shared by every Hydra · revision <code>{saved.revision}</code></span>
        <Segmented
          label="Heads dispatch view"
          value={json ? 'json' : 'table'}
          options={VIEWS}
          onChange={show}
        />
      </div>
      <PendingStatus intents={snapshot.intents} />
      {snapshot.error && <p className="dispatch-error text-red text-meta" role="alert">{snapshot.error}</p>}
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
    </DispatchFrame>
  )
}
