import { useHeadsDispatch } from '../workers/heads-dispatch.ts'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { HydraState } from '../../../src/app/model.ts'
import type { ViewPreferences } from '../../../src/preferences/model.ts'
import type { AgentConfig } from '../../../src/workers/model.ts'
import { KEY_ACTIONS, bindingsFor } from '../../../src/preferences/keyboard.ts'
import type { Hit } from '../../../src/oracle/index.ts'
import { Button, Input, NumberField, Select, Switch } from '../shared/ui/controls.tsx'
import { Markdown } from '../components/ui/markdown.tsx'
import { InlineTitle } from '../shared/ui/inline-title.tsx'
import { InlineConfirm } from '../shared/ui/inline-confirm.tsx'
import { Icon } from '../shared/ui/icon.tsx'
import { ResultGrid, type ResultRow } from '../shared/ui/result-grid.tsx'
import { focusElement, useKeyboard, useKeyAction, type ActionContext } from '../preferences/keyboard-registry.tsx'
import type { Command } from '../app/connection.ts'
import { LOCKED_DELETE, lockedColumn } from '../../../src/tasks/column-rules.ts'
import { hydraConfig } from '../../../src/hydra/config.ts'
import { Projects } from '../projects/projects.tsx'
import { AgentKinds } from '../workers/agent-kinds.tsx'
import { columnsFor } from '../tasks/view.ts'
import { commandQuery, matchesCommand, resetWidths, oracleSettings, SHORTCUT_QUERY, shortcutLabel } from './oracle-catalog.ts'

export function Oracle({
  state,
  view,
  command,
  query,
  setQuery,
  hits,
  save,
  openTask,
  openHydra,
  showPanel,
  createTask,
  createColumn,
  action,
  notify,
  connected,
}: {
  selected: string | null
  state: HydraState
  view: ViewPreferences
  command: Command
  query: string
  setQuery({ query }: { query: string }): void
  hits: Hit[]
  save({ patch }: { patch: unknown }): Promise<boolean>
  openTask({ id }: { id: string }): void
  openHydra(): void
  showPanel(): void
  createTask({ column }: { column: string }): void
  createColumn(): void
  action({
    id,
    context,
  }: {
    id: string
    context: ActionContext
  }): boolean
  notify({ text }: { text: string }): void
  connected: boolean
}) {
  const [
    expanded,
    setExpanded,
  ] = useState(false)
  const input = useRef<HTMLInputElement>(null), root = useRef<HTMLDivElement>(null)
  useEffect(
    () => {
      if (!expanded) {
        return
      }

      const outside = (event: PointerEvent) => {
        if (event.target instanceof Node && !root.current?.contains(event.target)) {
          setExpanded(false)
        }
      }

      document.addEventListener(
        'pointerdown',
        outside,
      )

      return () => document.removeEventListener(
        'pointerdown',
        outside,
      )
    },
    [expanded],
  )
  const context = useRef<ActionContext>({
    scope: 'navigation',
    target: document.body,
  })
  const { handlers } = useKeyboard()

  const focus = () => {
    if (input.current?.disabled) {
      return false
    }

    showPanel(); requestAnimationFrame(() => {
      input.current?.focus(); setExpanded(true)
    })

    return true
  }

  useKeyAction({
    id: 'palette',
    handler: focus,
  })
  useKeyAction({
    id: 'find',
    handler: focus,
  })
  useKeyAction({
    id: 'help',
    handler: () => {
      setQuery({ query: SHORTCUT_QUERY })

      return focus()
    },
  })
  const editColumn = ({ args }: { args: string[] }) => command({
    name: 'column',
    args: [
      ...args,
      '--if-revision',
      String(state.configRevision ?? 0),
      '--event-id',
      crypto.randomUUID(),
    ],
  })

  const run = ({ work }: { work: () => unknown }) => {
    setExpanded(false); setQuery({ query: '' })
    context.current.target.focus(); work()
  }

  const rows: (ResultRow & { text: string })[] = []

  const add = ({
    id,
    label,
    words = '',
    content,
  }: {
    id: string
    label: string
    words?: string
    content: ReactNode
  }) => {
    rows.push({
      id,
      label,
      text: `${label} ${words}`,
      content,
    })
  }

  for (const setting of oracleSettings({
    state,
    view,
  })) {
    const control = setting.type === 'toggle'
      ? (
        <Switch
          label={setting.label}
          checked={setting.value}
          onChange={({ value }) => save({ patch: setting.patch({ value }) })}
        />
      )
      : setting.type === 'number'
        ? (
          <NumberField
            label={setting.label}
            value={setting.value}
            min={setting.min}
            max={setting.max}
            step={1}
            onChange={({ value }) => save({ patch: setting.patch({ value }) })}
          />
        )
        : (
          <><span>{setting.label}</span><Select
            label={setting.label}
            value={setting.value}
            options={setting.options}
            onChange={({ value }) => save({ patch: setting.patch({ value }) })}
          />
          </>
        )
    add({
      id: setting.id,
      label: setting.label,
      words: setting.words,
      content: control,
    })
  }

  add({
    id: 'reset-widths',
    label: 'Reset widths to defaults',
    words: 'layout resize panel column restore',
    content: (
      <Button onClick={() => void save({ patch: resetWidths({ view }) })}>
        Reset widths to defaults
      </Button>
    ),
  })
  add({
    id: 'new-column',
    label: 'New column',
    words: 'create add layout',
    content: (
      <Button disabled={!connected} onClick={() => run({ work: createColumn })}>
        New column
      </Button>
    ),
  })

  for (const column of columnsFor({ state })) {
    add({
      id: `task:${column.id}`,
      label: `New task in ${column.title}`,
      words: 'create add card',
      content: (
        <Button
          disabled={!connected}
          onClick={() => run({ work: () => createTask({ column: column.id }) })}
        >
          New task in {column.title}
        </Button>
      ),
    })
    add({
      id: `describe:${column.id}`,
      label: `${column.title} description`,
      words: 'column template when why rules',
      content: (
        <>
          <span>{column.title} description</span>
          <Input
            key={column.description ?? ''}
            aria-label={`${column.title} description from Oracle`}
            defaultValue={column.description ?? ''}
            onBlur={e => {
              if (e.target.value !== (column.description ?? '')) {
                void editColumn({
                  args: [
                    'describe',
                    column.id,
                    '--description',
                    e.target.value,
                  ],
                }).catch((error: Error) => notify({ text: error.message }))
              }
            }}
          />
        </>
      ),
    })

    add({
      id: `rename:${column.id}`,
      label: `Rename ${column.title} column`,
      words: 'layout title name',
      content: (
        <>
          <span>Rename column</span>
          <InlineTitle
            value={column.title}
            label={`Rename ${column.title} column from Oracle`}
            save={({ title }) => editColumn({
              args: [
                'rename',
                column.id,
                `--title=${title}`,
              ],
            })}
          />
        </>
      ),
    })
    add({
      id: `delete:${column.id}`,
      label: `Delete ${column.title} column`,
      words: 'layout remove',
      content: lockedColumn({
        state,
        id: column.id,
      }) ? <p role="status">{LOCKED_DELETE}</p> : (
          <InlineConfirm
            label={`Delete ${column.title} column from Oracle`}
            action="Delete column"
            message={`Delete “${column.title}”? Its tasks move to a remaining column.`}
            disabled={!connected || columnsFor({ state }).length === 1}
            confirm={() => editColumn({
              args: [
                'delete',
                column.id,
              ],
            }).then(
              () => true,
              (e: Error) => {
                notify({ text: e.message })

                return false
              },
            )}
          />
        ),
    })
  }

  for (const entry of KEY_ACTIONS.filter(entry => ![
    'palette',
    'cancel',
    'send',
    'find',
  ].includes(entry.id))) {
    const enabled = entry.scopes.includes(context.current.scope)

    add({
      id: `action:${entry.id}`,
      label: entry.label,
      words: 'action',
      content: (
        <Button
          disabled={!enabled}
          onClick={() => run({
            work: () => {
              const registered = [...(handlers.get(entry.id) ?? [])].reverse()

              if (!registered.some(run => run({ context: context.current }))) {
                action({
                  id: entry.id,
                  context: context.current,
                })
              }
            },
          })}
        >
          {entry.label}
        </Button>
      ),
    })
  }

  for (const entry of KEY_ACTIONS) {
    const label = shortcutLabel({ label: entry.label })

    add({
      id: `binding:${entry.id}`,
      label,
      words: 'keyboard binding keys',
      content: (
        <>
          <span>{label}</span>
          <Input
            key={bindingsFor({
              prefs: view.keyboard,
              id: entry.id,
            }).join(';')}
            aria-label={label}
            defaultValue={bindingsFor({
              prefs: view.keyboard,
              id: entry.id,
            }).join('; ')}
            onBlur={e => {
              const bindings = e.target.value.split(';').map(value => value.trim())
                .filter(Boolean)

              const current = bindingsFor({
                prefs: view.keyboard,
                id: entry.id,
              })

              if (JSON.stringify(bindings) !== JSON.stringify(current)) {
                void save({ patch: { keyboard: { bindings: { [entry.id]: bindings } } } })
              }
            }}
            onKeyDown={e => e.key === 'Enter' && e.currentTarget.blur()}
          />
        </>
      ),
    })
  }

  const hydra = hydraConfig({ state }).hydra
  add({
    id: 'hydra-identity',
    label: 'Hydra identity',
    words: 'assistant name orchestrator',
    content: (
      <>
        <span>Hydra identity</span>
        <Input
          key={hydra.id}
          aria-label="Hydra identity"
          defaultValue={hydra.id}
          onBlur={e => {
            if (e.target.value.trim() && e.target.value.trim() !== hydra.id) {
              void command({
                name: 'hydra',
                args: [
                  'set',
                  '--identity',
                  e.target.value.trim(),
                  '--if-revision',
                  String(state.configRevision ?? 0),
                  '--event-id',
                  crypto.randomUUID(),
                ],
              }).catch((e: Error) => notify({ text: e.message }))
            }
          }}
          onKeyDown={e => e.key === 'Enter' && e.currentTarget.blur()}
        />
      </>
    ),
  })
  const {
    effective,
    saveHydra,
  } = useHeadsDispatch({ command })
  const agent = effective?.dispatch.rules.hydra?.candidates[0] ?? { harness: 'claude' }

  const saveAgent = ({ patch }: { patch: Partial<AgentConfig> }) =>
    saveHydra({ patch }).catch((e: Error) => notify({ text: e.message }))

  add({
    id: 'hydra-harness',
    label: 'Hydra harness',
    words: 'agent model Claude Code Codex',
    content: (
      <>
        <span>Hydra harness</span>
        <Select
          label="Hydra harness"
          disabled={!effective}
          value={agent.harness}
          options={[
            {
              value: 'claude',
              label: 'Claude Code',
            },
            {
              value: 'codex',
              label: 'Codex',
            },
          ]}
          onChange={({ value }) => void saveAgent({ patch: { harness: value as AgentConfig['harness'] } })}
        />
      </>
    ),
  })

  for (const field of [
    'model',
    'effort',
    'mode',
  ] as const) {
    const label = `Hydra default ${field}`
    add({
      id: `hydra-${field}`,
      label,
      words: 'agent launch settings assistant',
      content: (
        <>
          <span>{label}</span>
          <Input
            key={agent[field] ?? ''}
            aria-label={label}
            disabled={!effective}
            defaultValue={agent[field] ?? ''}
            placeholder="Harness default"
            onBlur={e => {
              if (e.target.value !== (agent[field] ?? '')) {
                void saveAgent({ patch: { [field]: e.target.value } })
              }
            }}
            onKeyDown={e => e.key === 'Enter' && e.currentTarget.blur()}
          />
        </>
      ),
    })
  }

  add({
    id: 'agents',
    label: 'Hydra identity and default model; heads dispatch rules',
    words: `harness effort mode quota launch worker ${Object.keys(state.config?.agents ?? {}).join(' ')}`,
    content: <AgentKinds state={state} command={command} notify={notify} />,
  })
  add({
    id: 'projects',
    label: 'Projects',
    words: 'folder attach clone detach landing command',
    content: <Projects
      state={state}
      command={command}
      connected={connected}
      notify={notify}
    />,
  })
  const matchingRows = rows.filter(row =>
    matchesCommand({
      query,
      text: row.text.slice(
        0,
        500,
      ),
    }))

  const visibleHits = commandQuery({ query }) ? [] : hits.filter(hit => hit.kind === 'hydra' || (state.cards[hit.card] && !state.cards[hit.card].hidden))
  const searchRows: ResultRow[] = visibleHits.map(hit => ({
    id: `hit:${hit.card}`,
    label: hit.title,
    content: (
      <div className="oracle-hit">
        <Button onClick={() => run({ work: () => hit.kind === 'hydra' ? openHydra() : openTask({ id: hit.card }) })}>
          <strong>{hit.title}</strong>
        </Button>
        <small>
          {hit.kind === 'hydra' ? 'Hydra conversation' : 'Task'}
        </small>
        {hit.snippets.map((
          snippet,
          index,
        ) => <Markdown key={index} text={snippet.snippet} />)}
      </div>
    ),
  }))

  return (
    <div
      className="oracle"
      data-oracle-slot
      ref={root}
      onKeyDown={e => {
        if (e.key === 'Escape' && !e.nativeEvent.isComposing && !e.defaultPrevented) {
          e.preventDefault(); e.stopPropagation()

          if (context.current.target.isConnected) {
            context.current.target.focus()
          } else {
            input.current?.focus()
          }

          setExpanded(false)
        }
      }}
      onFocus={e => {
        if (!root.current?.contains(e.relatedTarget)) {
          const target = e.relatedTarget instanceof HTMLElement ? e.relatedTarget : document.body
          context.current = {
            target,
            scope: (target.closest<HTMLElement>('[data-key-scope]')?.dataset.keyScope as ActionContext['scope']) ?? 'navigation',
          }
        }

        setExpanded(true)
      }}
      onBlur={e => {
        if (e.relatedTarget && !e.currentTarget.contains(e.relatedTarget)) {
          setExpanded(false)
        }
      }}
    >
      <Icon name="search" size={15} />
      <Input
        ref={input}
        aria-label="Oracle"
        aria-expanded={expanded}
        aria-controls={expanded ? 'hydra-oracle-results' : undefined}
        type="search"
        placeholder="Oracle… ⌘K"
        value={query}
        onChange={e => {
          setQuery({ query: e.target.value }); setExpanded(true)
        }}
        onKeyDown={e => {
          if (e.nativeEvent.isComposing) {
            return
          }

          if (e.key === 'Escape') {
            e.preventDefault(); e.stopPropagation()
            setQuery({ query: '' }); setExpanded(false)

            if (context.current.target.isConnected) {
              context.current.target.focus()
            } else {
              focusElement({ selector: '[data-card]' })
            }
          } else if ([
            'ArrowDown',
            'ArrowUp',
            'Enter',
          ].includes(e.key)) {
            e.preventDefault(); e.stopPropagation()
            const results = root.current?.querySelectorAll<HTMLElement>('[data-result-id]')
            results?.[e.key === 'ArrowUp' ? results.length - 1 : 0]?.focus()
          }
        }}
      />
      {expanded && (
        <ResultGrid
          id="hydra-oracle-results"
          label="Oracle results"
          search={() => input.current?.focus()}
          groups={[
            ...(!commandQuery({ query }) && query.trim() ? [
              {
                label: 'Tasks & messages',
                rows: searchRows,
                message: !visibleHits.length ? 'No matching tasks or messages.' : undefined,
              },
            ] : []),
            {
              label: 'Settings & actions',
              rows: matchingRows,
              message: !matchingRows.length ? 'No matching settings or actions.' : undefined,
            },
          ]}
        />
      )}
    </div>
  )
}
