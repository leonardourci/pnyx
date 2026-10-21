import { useState } from 'react'
import { KEY_ACTIONS, bindingsFor, keyboardError, keyLabel, type KeyboardPreferences } from '../../../src/core/keyboard.ts'
import { Button, Input, Switch, Textarea, useBusy } from '../components/ui/controls.tsx'
import { useKeyAction, useKeyboard } from './registry.tsx'

export function KeyboardSettings({
  prefs,
  save,
}: {
  prefs: KeyboardPreferences
  save({ patch }: { patch: unknown }): Promise<boolean>
}) {
  const { platform } = useKeyboard(), [
      filter,
      setFilter,
    ] = useState(''), [
      editing,
      setEditing,
    ] = useState<string | null>(null), [
      draft,
      setDraft,
    ] = useState(''), [
      error,
      setError,
    ] = useState(''), [
      busy,
      run,
    ] = useBusy()
  useKeyAction({
    id: 'cancel',
    handler: ({ context: { scope } }) => {
      if (scope !== 'navigation' || !editing || busy) {
        return false
      }

      setEditing(null); setError('')

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
        if (await save({ patch: { keyboard: { bindings } } })) {
          setEditing(null)
        }
      },
    })
  }

  return (
    <section className="settings-box keyboard-settings" aria-label="Keyboard shortcuts">
      <div className="row between">
        <div>
          <span className="eyebrow">MOVE THROUGH YOUR WORK</span>
          <h2>Keyboard shortcuts</h2>
        </div>
        <Button variant="surface" disabled={busy} onClick={() => persist({ bindings: null })}>Reset all bindings</Button>
      </div>
      <p className="muted">Bindings follow this Hydra. Text fields keep normal typing; Enter adds a newline. Browsers may reserve the settings shortcut—Commands and the Settings button always remain available.</p>
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
        {KEY_ACTIONS.filter(a => a.label.toLowerCase().includes(filter.toLowerCase())).map(a => (
          <div className="keymap-row" key={a.id}>
            <div className="row between">
              <span>
                <strong>{a.label}</strong>
                <small>{a.scopes.filter(s => s !== 'hints' && s !== 'overlay').join(' · ')}</small>
              </span>
              <Button
                disabled={busy}
                aria-label={`Rebind ${a.label}`}
                onClick={() => {
                  setEditing(a.id); setDraft(bindingsFor({
                    prefs,
                    id: a.id,
                  }).join('\n')); setError('')
                }}
              >
                <kbd>{keyLabel({
                  keys: bindingsFor({
                    prefs,
                    id: a.id,
                  }),
                  platform,
                })}
                </kbd>
                <span className="muted">Edit</span>
              </Button>
            </div>
            {editing === a.id && (
              <form
                className="binding-editor"
                onSubmit={e => {
                  e.preventDefault(); persist({
                    bindings: {
                      [a.id]: draft.split('\n').map(s => s.trim())
                        .filter(Boolean),
                    },
                  })
                }}
              >
                <label className="small" htmlFor={`binding-${a.id}`}>One binding per line</label>
                <Textarea
                  autoFocus
                  id={`binding-${a.id}`}
                  value={draft}
                  rows={3}
                  onChange={e => setDraft(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === 'Escape' && !e.nativeEvent.isComposing && !busy) {
                      setEditing(null); setError('')
                    }
                  }}
                />
                <p className="muted">Use Mod+Enter, ArrowDown, or a sequence like g s. Up to four alternatives. Leave empty to unbind. Mod means ⌘ on Mac and Ctrl elsewhere.</p>
                <div className="row wrap">
                  <Button type="submit" variant="primary" disabled={busy}>Save binding</Button>
                  <Button
                    disabled={busy}
                    onClick={() => persist({ bindings: { [a.id]: null } })}
                  >
                    Reset action
                  </Button>
                  <Button
                    disabled={busy}
                    onClick={() => {
                      setEditing(null); setError('')
                    }}
                  >
                    Cancel edit
                  </Button>
                </div>
              </form>
            )}
          </div>
        ))}
      </div>
    </section>
  )
}
