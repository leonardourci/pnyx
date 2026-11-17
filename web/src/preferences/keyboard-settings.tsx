import { IconButton } from '#web-shared/ui/icon-button.tsx'
import { useEffect, useState, type ComponentProps } from 'react'
import { bindingsFor, keyboardError, keyLabel, type KeyboardPreferences } from '#preferences/keyboard.ts'
import { Button, useBusy } from '#web-shared/ui/controls.tsx'
import { Icon } from '#web-shared/ui/icon.tsx'
import { capturedKey } from './key-capture.ts'
import { useKeyAction, useKeyboard } from './keyboard-registry.tsx'
import { groupOf, keyActionsMatching } from './key-search.ts'

const MODIFIERS = [
  'Meta',
  'Control',
  'Shift',
  'Alt',
]

function KeyAction({
  reset = false,
  className = '',
  ...props
}: ComponentProps<typeof Button> & { reset?: boolean }) {
  const appearance = reset ? 'keymap-reset text-gold' : 'keymap-add'

  return <Button {...props} className={`min-h-6.5 py-0.5 px-1.75 text-meta ${appearance} ${className}`} />
}

export function KeyRows({
  prefs,
  save,
  query,
}: {
  prefs: KeyboardPreferences
  save({ patch }: { patch: unknown }): Promise<boolean>
  query: string
}) {
  const { platform } = useKeyboard(), [
      capturing,
      setCapturing,
    ] = useState<string | null>(null), [
      error,
      setError,
    ] = useState(''), [
      busy,
      run,
    ] = useBusy()
  useKeyAction({
    id: 'cancel',
    handler: ({ context: { scope } }) => {
      if (scope !== 'navigation' || !capturing || busy) {
        return false
      }

      setCapturing(null); setError('')

      return true
    },
  })

  const persist = ({ bindings }: { bindings: Record<string, string[] | null> | null }) => {
    const next = {
      ...prefs,
      bindings: bindings === null ? {} : { ...prefs.bindings },
    }

    if (bindings) {
      for (const [
        id,
        keys,
      ] of Object.entries(bindings)) {
        if (keys === null) {
          delete next.bindings[id]
        } else {
          next.bindings[id] = keys
        }
      }
    }

    const invalid = keyboardError({ prefs: next })

    if (invalid) {
      setError(invalid)

      return
    }

    setError(''); run({
      save: async () => {
        await save({ patch: { keyboard: { bindings } } })
      },
    })
  }

  // While a row waits for a key, the next key pressed is the new binding instead of running its action.
  useEffect(
    () => {
      if (!capturing) {
        return undefined
      }

      const take = (event: KeyboardEvent) => {
        if (MODIFIERS.includes(event.key)) {
          return
        }

        event.preventDefault(); event.stopPropagation()
        setCapturing(null)

        if (event.key === 'Escape') {
          return
        }

        const key = capturedKey({ event })
        const keys = bindingsFor({
          prefs,
          id: capturing,
        })

        if (!keys.includes(key)) {
          persist({
            bindings: {
              [capturing]: [
                ...keys,
                key,
              ],
            },
          })
        }
      }

      window.addEventListener(
        'keydown',
        take,
        true,
      )

      return () => window.removeEventListener(
        'keydown',
        take,
        true,
      )
    },
  )

  const shown = keyActionsMatching({ query })
  const groups = [...new Set(shown.map(action => groupOf({ action })))]

  return (
    <div className="keymap [&>[role=group]:first-of-type_.keymap-group]:mt-0" aria-label="Keyboard shortcuts">
      {error && <p role="alert" className="keymap-error mt-2 mx-5 mb-0 text-red text-meta">{error}</p>}
      {groups.map(group => (
        <div key={group} role="group" aria-label={group}>
          <div className="keymap-group mt-4 py-2.5 px-5 border-y border-line bg-raised text-ink text-meta font-semibold uppercase tracking-keymap">{group}</div>
          {shown.filter(action => groupOf({ action }) === group).map(a => {
            const keys = bindingsFor({
              prefs,
              id: a.id,
            })
            const customized = a.id in prefs.bindings

            return (
              <div className="keymap-row grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2.5 py-2 px-5 border-t border-subtle data-capturing:bg-gold-wash" key={a.id} data-capturing={capturing === a.id || undefined}>
                <span className="keymap-action font-medium">{a.label}</span>
                <span className="keymap-keys flex flex-wrap justify-end items-center gap-1">
                  {keys.map(key => (
                    <span className="keymap-key inline-flex items-center gap-0.75 py-px pl-1.5 pr-0.75 border border-line border-b-2 rounded-compact bg-raised text-muted font-mono text-meta whitespace-nowrap [&>kbd]:min-w-0 [&>kbd]:h-auto [&>kbd]:p-0 [&>kbd]:border-0 [&>kbd]:rounded-none [&>kbd]:bg-transparent [&>kbd]:shadow-none [&>kbd]:[font:inherit] [&>kbd]:text-ink" key={key}>
                      <kbd>{keyLabel({
                        keys: [key],
                        platform,
                      })}
                      </kbd>
                      <IconButton
                        size="key"
                        icon="close"
                        iconSize={12}
                        label={`Remove ${key} from ${a.label}`}
                        disabled={busy || keys.length < 2}
                        title={keys.length < 2 ? 'An action keeps at least one key' : undefined}
                        onClick={() => persist({
                          bindings: { [a.id]: keys.filter(k => k !== key) },
                        })}
                      />
                    </span>
                  ))}
                  {capturing === a.id
                    ? <span className="keymap-capture text-gold text-meta" role="status">Press a key… Esc cancels</span>
                    : (
                      <KeyAction
                        aria-label={`Add a key for ${a.label}`}
                        disabled={busy}
                        onClick={() => {
                          setCapturing(a.id); setError('')
                        }}
                      ><Icon name="plus" size={14} />
                      </KeyAction>
                    )}
                  {customized && (
                    <KeyAction
                      reset
                      disabled={busy}
                      onClick={() => persist({ bindings: { [a.id]: null } })}
                    >Reset
                    </KeyAction>
                  )}
                </span>
              </div>
            )
          })}
        </div>
      ))}
    </div>
  )
}
