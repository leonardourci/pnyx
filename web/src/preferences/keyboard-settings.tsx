import { useEffect, useState } from 'react'
import { bindingsFor, keyboardError, keyLabel, type KeyboardPreferences } from '#preferences/keyboard.ts'
import { Button, useBusy } from '#web-shared/ui/controls.tsx'
import { Icon } from '#web-shared/ui/icon.tsx'
import { useKeyAction, useKeyboard } from './keyboard-registry.tsx'
import { groupOf, keyActionsMatching } from './key-search.ts'

const MODIFIERS = [
  'Meta',
  'Control',
  'Shift',
  'Alt',
]

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

        const key = `${event.metaKey || event.ctrlKey ? 'Mod+' : ''}${event.key.length === 1 ? event.key.toLowerCase() : event.key}`
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
    <div className="keymap" aria-label="Keyboard shortcuts">
      {error && <p role="alert" className="keymap-error">{error}</p>}
      {groups.map(group => (
        <div key={group} role="group" aria-label={group}>
          <div className="keymap-group">{group}</div>
          {shown.filter(action => groupOf({ action }) === group).map(a => {
            const keys = bindingsFor({
              prefs,
              id: a.id,
            })
            const customized = a.id in prefs.bindings

            return (
              <div className="keymap-row" key={a.id} data-capturing={capturing === a.id || undefined}>
                <span className="keymap-action">{a.label}</span>
                <span className="keymap-keys">
                  {keys.map(key => (
                    <span className="keymap-key" key={key}>
                      <kbd>{keyLabel({
                        keys: [key],
                        platform,
                      })}
                      </kbd>
                      <button
                        type="button"
                        aria-label={`Remove ${key} from ${a.label}`}
                        disabled={busy || keys.length < 2}
                        title={keys.length < 2 ? 'An action keeps at least one key' : undefined}
                        onClick={() => persist({
                          bindings: { [a.id]: keys.filter(k => k !== key) },
                        })}
                      ><Icon name="close" size={12} />
                      </button>
                    </span>
                  ))}
                  {capturing === a.id
                    ? <span className="keymap-capture" role="status">Press a key… Esc cancels</span>
                    : (
                      <Button
                        className="keymap-add"
                        aria-label={`Add a key for ${a.label}`}
                        disabled={busy}
                        onClick={() => {
                          setCapturing(a.id); setError('')
                        }}
                      ><Icon name="plus" size={14} />
                      </Button>
                    )}
                  {customized && (
                    <Button
                      className="keymap-reset"
                      disabled={busy}
                      onClick={() => persist({ bindings: { [a.id]: null } })}
                    >Reset
                    </Button>
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
