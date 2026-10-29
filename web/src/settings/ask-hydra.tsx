import { useState } from 'react'
import type { Command } from '#web-app/connection.ts'
import { Button, Textarea } from '#web-shared/ui/controls.tsx'
import { Icon } from '#web-shared/ui/icon.tsx'

// A small composer that sends one message to Hydra's chat, opened with the setting or section it asks about.
export function AskHydra({
  place,
  command,
  notify,
  section,
  done,
}: {
  place: 'header' | 'row'
  command: Command
  notify({ text }: { text: string }): void
  // The setting or section asked about; none means all of Settings.
  section?: string
  done(): void
}) {
  const [
    text,
    setText,
  ] = useState('')
  const [
    sending,
    setSending,
  ] = useState(false)
  const message = text.trim()
  const context = section ? `Settings › ${section}` : 'Settings'

  // A form action, so React awaits the send; it reports its own errors.
  const send = async () => {
    if (!message || sending) {
      return
    }

    setSending(true)

    try {
      await command({
        name: 'hydra',
        args: [
          'send',
          `--text=${context}: ${message}`,
          '--event-id',
          crypto.randomUUID(),
        ],
      })
      setText('')
      done()
      notify({ text: 'Sent to Hydra’s chat.' })
    } catch (error) {
      notify({ text: error instanceof Error ? error.message : String(error) })
    } finally {
      setSending(false)
    }
  }

  return (
    <form
      className="ask-hydra"
      data-place={place}
      aria-label="Ask Hydra"
      action={send}
    >
      <span className="ask-hydra-context"><Icon name="hydra" size={16} />{context}</span>
      <Textarea
        autoFocus
        rows={1}
        aria-label={`Ask Hydra about ${section ?? 'settings'}`}
        placeholder="Ask Hydra to change or explain this"
        value={text}
        onChange={event => setText(event.target.value)}
        onKeyDown={event => {
          if (event.key === 'Escape') {
            done()
          } else if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
            event.preventDefault()
            event.currentTarget.form?.requestSubmit()
          }
        }}
      />
      <Button
        type="submit"
        variant="primary"
        aria-label="Send to Hydra"
        disabled={!message || sending}
      ><Icon name="send" size={16} />
      </Button>
      <Button aria-label="Close" onClick={done}><Icon name="close" size={14} /></Button>
    </form>
  )
}
