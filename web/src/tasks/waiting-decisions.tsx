import { ICON_SIZE } from '#web-shared/icons.tsx'
import type { RefObject } from 'react'
import { openDecisions, type OpenDecision } from '#tasks/decisions.ts'
import type { HydraState } from '#app/model.ts'
import { Button } from '#web-shared/ui/controls.tsx'
import { conversationMessages, latestAgentMessage, placeMessageCaret } from '#web-hydra/caret.ts'
import { Popover } from '#web-shared/ui/popover.tsx'
import { markdownText } from '#web-hydra/markdown-text.ts'

export function WaitingDecisions({
  state,
  open,
  loading,
  triggerRef,
}: {
  state: HydraState
  open({ decision }: { decision: OpenDecision }): Promise<void>
  loading: boolean
  triggerRef: RefObject<HTMLButtonElement | null>
}) {
  const decisions = openDecisions({ state }).filter(decision =>
    decision.kind === 'owner question' || decision.kind === 'permission' || decision.kind === 'blocking prompt')

  if (!decisions.length) {
    return null
  }

  return (
    <section
      className="waiting-decisions flex-none py-1.5 text-meta text-muted [&>.popover]:max-w-full [&>.popover>.button]:flex [&>.popover>.button]:w-full [&>.popover>.button]:justify-between [&>.popover>.button]:min-h-0 [&>.popover>.button]:py-1.5 [&>.popover>.button]:px-0 [&>.popover>.button]:gap-2 [&>.popover>.button]:text-gold [&>.popover>.button]:text-[length:inherit] [&>.popover>.button]:border-t [&>.popover>.button]:border-line [&_ul]:list-none [&_ul]:p-0 [&_ul]:m-0 [&_.popover-panel]:p-1.25 [&_.popover-panel]:max-h-waiting-menu [&_li_.button]:flex [&_li_.button]:flex-col [&_li_.button]:items-start [&_li_.button]:w-full [&_li_.button]:min-h-0 [&_li_.button]:p-1.75 [&_li_.button]:text-left [&_li_.button]:whitespace-normal [&_li_.button]:wrap-anywhere [&_li_.button]:text-[length:inherit] [&_li_.button]:leading-normal"
      aria-label="Waiting on you"
      onKeyDownCapture={event => {
        const trigger = triggerRef.current

        if (event.key === 'Escape' || (event.key === 'ArrowDown' && event.target === trigger)) {
          event.preventDefault()
          event.stopPropagation()

          if (trigger?.getAttribute('aria-expanded') === 'true') {
            trigger.click()
          }

          event.currentTarget.closest('.hydra-chat')?.querySelector<HTMLTextAreaElement>('.composer textarea')
            ?.focus()
        } else if (event.key === 'ArrowUp' && event.target === trigger) {
          event.preventDefault()
          event.stopPropagation()
          const host = conversationMessages({ from: event.currentTarget })

          if (host) {
            placeMessageCaret({
              host,
              target: latestAgentMessage({ host }),
              edge: 'end',
            })
          }
        } else if (event.key === ' ' && event.target === trigger) {
          event.preventDefault()
          event.stopPropagation()
        } else if (event.key === 'Tab' && !event.shiftKey && event.target === trigger) {
          event.preventDefault()
          event.stopPropagation(); trigger?.click()
        }
      }}
    >
      <Popover
        label="Waiting on you"
        chevronSize={ICON_SIZE.inline}
        triggerRef={triggerRef}
        trigger={(
          <>
            <span className="shrink-0 whitespace-nowrap">Waiting on you · {decisions.length}</span>
            <span className="waiting-decision-summary min-w-0 flex-1 truncate max-w-[58%] text-muted">{decisions[0].text}</span>
          </>
        )}
      >
        {({ close }) => (
          <ul
            aria-label="Items waiting on you"
            onKeyDown={event => {
              if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') {
                return
              }

              event.preventDefault()
              event.stopPropagation()
              const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')]
              const index = buttons.indexOf(document.activeElement as HTMLButtonElement)
              const next = index + (event.key === 'ArrowDown' ? 1 : -1)

              if (next < 0) {
                close()
              } else if (next >= buttons.length) {
                close()
                event.currentTarget.closest('.hydra-chat')?.querySelector<HTMLTextAreaElement>('.composer textarea')
                  ?.focus()
              } else {
                buttons[next].focus()
              }
            }}
          >
            {decisions.map(decision => (
              <li key={`${decision.card.id}:${decision.kind}:${decision.id}`}>
                <Button
                  disabled={loading}
                  onClick={async () => {
                    close(); await open({ decision })
                  }}
                >
                  <span className="waiting-decision-task text-muted">{decision.card.title}</span>
                  <span className="waiting-decision-question text-gold">{markdownText({ text: decision.text })}</span>
                </Button>
              </li>
            ))}
          </ul>
        )}
      </Popover>
    </section>
  )
}
