import { useState, type Ref } from 'react'
import type { Command } from '#web-app/connection.ts'
import { Button, Textarea } from '#web-shared/ui/controls.tsx'
import { Icon } from '#web-shared/ui/icon.tsx'

// A small composer pinned to the page's foot: the message goes to Hydra's chat, opened with the section it asks about.
export function AskHydra({
  command,
  notify,
  context,
  clearContext,
  inputRef,
}: {
  command: Command
  notify({ text }: { text: string }): void
  context: string
  clearContext(): void
  inputRef?: Ref<HTMLTextAreaElement>
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
  const scoped = context !== 'Settings'

  const send = async () => {
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
      clearContext()
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
      aria-label="Ask Hydra"
      onSubmit={event => {
        event.preventDefault()

        if (message && !sending) {
          void send()
        }
      }}
    >
      <span className="ask-hydra-context">
        <Icon name="hydra" size={16} />{context}
        {scoped && <Button aria-label="Ask about all of Settings" onClick={clearContext}><Icon name="close" size={12} /></Button>}
      </span>
      <Textarea
        ref={inputRef}
        rows={1}
        aria-label="Ask Hydra about settings"
        placeholder="Ask Hydra to change a setting"
        value={text}
        onChange={event => setText(event.target.value)}
        onKeyDown={event => {
          if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
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
    </form>
  )
}
