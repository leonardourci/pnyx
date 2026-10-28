import type { RefObject } from 'react'
import { openDecisions, type OpenDecision } from '../../../src/tasks/decisions.ts'
import type { HydraState } from '../../../src/app/model.ts'
import { Button } from '../shared/ui/controls.tsx'
import { conversationMessages, latestAgentMessage, placeMessageCaret } from '../hydra/caret.ts'
import { Popover } from '../shared/ui/popover.tsx'

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
      className="waiting-decisions"
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
        triggerRef={triggerRef}
        trigger={(
          <>
            <span>Waiting on you · {decisions.length}</span>
            <span className="waiting-decision-summary">{decisions[0].text} ▴</span>
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
                  <span className="waiting-decision-task">{decision.card.title}</span>
                  <span className="waiting-decision-question">{decision.text}</span>
                </Button>
              </li>
            ))}
          </ul>
        )}
      </Popover>
    </section>
  )
}
