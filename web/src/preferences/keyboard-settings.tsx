import { useEffect, useState } from 'react'
import { KEY_ACTIONS, bindingsFor, keyboardError, keyLabel, type KeyboardPreferences } from '#preferences/keyboard.ts'
import { Button, Input, Switch, useBusy } from '#web-shared/ui/controls.tsx'
import { Icon } from '#web-shared/ui/icon.tsx'
import { capturedKey } from './key-capture.ts'
import { useKeyAction, useKeyboard } from './keyboard-registry.tsx'

const MODIFIERS = [
  'Meta',
  'Control',
  'Shift',
  'Alt',
]

export function KeyboardSettings({
  prefs,
  save,
  embedded = false,
}: {
  prefs: KeyboardPreferences
  save({ patch }: { patch: unknown }): Promise<boolean>
  // Inside a setting row, which already names the section.
  embedded?: boolean
}) {
  const { platform } = useKeyboard(), [
      filter,
      setFilter,
    ] = useState(''), [
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

  return (
    <section className="settings-box keyboard-settings" aria-label="Keyboard shortcuts">
      <div className="row between">
        {!embedded && (
          <div>
            <span className="eyebrow">MOVE THROUGH YOUR WORK</span>
            <h2>Keyboard shortcuts</h2>
          </div>
        )}
        <Button variant="surface" disabled={busy} onClick={() => persist({ bindings: null })}>Reset all bindings</Button>
      </div>
      <p className="muted">Bindings apply to every Hydra. Text fields keep normal typing; Enter adds a newline. Browsers may reserve some shortcuts; commands and the Settings button always remain available.</p>
      <Switch label="Character shortcuts" checked={prefs.characterShortcuts} onChange={({ value: characterShortcuts }) => save({ patch: { keyboard: { characterShortcuts } } })} />
      <Input
        type="search"
        aria-label="Filter shortcuts"
        placeholder="Find an action…"
        value={filter}
        onChange={e => setFilter(e.target.value)}
      />
      {error && <p role="alert" className="gold">{error}</p>}
      <div className="keymap">
        {KEY_ACTIONS.filter(a => a.label.toLowerCase().includes(filter.toLowerCase())).map(a => {
          const keys = bindingsFor({
            prefs,
            id: a.id,
          })
          const customized = a.id in prefs.bindings

          return (
            <div className="keymap-row" key={a.id} data-capturing={capturing === a.id || undefined}>
              <span className="keymap-action">
                <strong>{a.label}</strong>
                <small>{a.scopes.filter(s => s !== 'hints' && s !== 'overlay').join(' · ')}</small>
              </span>
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
                      onClick={() => persist({ bindings: { [a.id]: keys.filter(k => k !== key) } })}
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
    </section>
  )
}
