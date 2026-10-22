import { useOraclePreferences } from './oracle-preferences.ts'
import { useHeadsDispatch } from './heads-dispatch.ts'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { AgentConfig, HydraState, ViewPreferences } from '../../../src/core/model.ts'
import { KEY_ACTIONS, bindingsFor } from '../../../src/core/keyboard.ts'
import type { HybridHit } from '../../../src/oracle/semantic.ts'
import { Button, Input, NumberField, Select, Switch } from '../components/ui/controls.tsx'
import { Markdown } from '../components/ui/markdown.tsx'
import { InlineTitle } from '../components/ui/inline-title.tsx'
import { InlineConfirm } from '../components/ui/inline-confirm.tsx'
import { Icon } from '../components/ui/icon.tsx'
import { ResultGrid, type ResultRow } from '../components/ui/result-grid.tsx'
import { focusElement, useKeyboard, useKeyAction, type ActionContext } from '../keyboard/registry.tsx'
import type { Command } from './connection.ts'
import { hydraConfig, LOCKED_DELETE, lockedColumn } from '../../../src/core/hydra.ts'
import { AgentKinds } from './agent-kinds.tsx'
import { columnsFor } from './view.ts'
import { commandQuery, matchesCommand, resetWidths, oracleSettings, queryWords, SHORTCUT_QUERY } from './oracle-catalog.ts'

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
  hits: HybridHit[]
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
    semantic,
    setSemantic,
  ] = useState<{
    query: string
    catalog: string
    matches: string[]
  } | null>(null)
  const [
    expanded,
    setExpanded,
  ] = useState(false)
  const {
    settings: preferences,
    set: persistSetting,
  } = useOraclePreferences({
    command,
    notify,
    enabled: expanded && connected,
  })
  const settings = preferences ?? {}
  const input = useRef<HTMLInputElement>(null), root = useRef<HTMLDivElement>(null)
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
  const persist = ({
    key,
    value,
  }: {
    key: string
    value: string
  }) =>
    persistSetting({
      key,
      value,
    }).catch((e: Error) => notify({ text: e.message }))

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

  for (const [
    key,
    label,
    options,
  ] of [
      [
        'oracle.semantic',
        'Semantic search',
        [
          'on',
          'off',
        ],
      ],
      [
        'oracle.rerank',
        'Rerank top results',
        [
          'auto',
          'on',
          'off',
        ],
      ],
      [
        'oracle.model',
        'Oracle model',
        [
          'auto',
          'granite-97m',
          'granite-311m',
        ],
      ],
    ] as const) {
    add({
      id: key,
      label,
      words: 'search meaning words local models',
      content: (
        <>
          <span>{label}</span>
          <Select
            label={label}
            value={settings[key] ?? options[0]}
            options={options.map(value => ({
              value,
              label: value,
            }))}
            onChange={({ value }) => void persist({
              key,
              value,
            })}
          />
        </>
      ),
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
    add({
      id: `binding:${entry.id}`,
      label: `${entry.label} shortcut`,
      words: 'keyboard binding keys',
      content: (
        <>
          <span>{entry.label} shortcut</span>
          <Input
            key={bindingsFor({
              prefs: view.keyboard,
              id: entry.id,
            }).join(';')}
            aria-label={`${entry.label} shortcut`}
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
  const catalog = JSON.stringify(rows.map(row => ({
    id: row.id,
    text: row.text.slice(
      0,
      500,
    ),
  })))
  const words = queryWords({ query })
  useEffect(
    () => {
      if (!expanded || !words || !connected) {
        return
      }

      let live = true
      const timer = setTimeout(
        () => {
          void command({
            name: 'oracle-commands',
            args: [
              words,
              catalog,
            ],
          }).then(
            receipt => {
              if (live) {
                setSemantic({
                  query: words,
                  catalog,
                  matches: receipt.matches as string[],
                })
              }
            },
            () => {},
          )
        },
        180,
      )

      return () => {
        live = false; clearTimeout(timer)
      }
    },
    [
      command,
      words,
      catalog,
      connected,
      expanded,
    ],
  )
  const meaning = semantic?.query === words && semantic.catalog === catalog ? semantic.matches : []
  const matchingRows = rows.filter(row =>
    matchesCommand({
      query,
      text: row.text.slice(
        0,
        500,
      ),
    }) || meaning.includes(row.id))

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
          {hit.match === 'semantic' ? ' · similar meaning' : ''}
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
        if (!e.currentTarget.contains(e.relatedTarget)) {
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
