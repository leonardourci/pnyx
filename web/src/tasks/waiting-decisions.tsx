import { ICON_SIZE } from '#web-shared/icons.tsx'
import type { RefObject } from 'react'
import type { OpenDecision } from '#tasks/decisions.ts'
import { ownerQuestionGroups } from '#tasks/question-groups.ts'
import { Disclosure } from '#web-shared/ui/disclosure.tsx'
import { RichText } from '#web-shared/ui/rich-text.tsx'
import { askWording } from '#tasks/ask-state.ts'
import type { Command } from '#web-app/connection.ts'
import { QuestionGroupAnswers } from './question-group.tsx'
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
  command,
  notify,
}: {
  state: HydraState
  command: Command
  notify({ text }: { text: string }): void
  open({ decision }: { decision: OpenDecision }): Promise<void>
  loading: boolean
  triggerRef: RefObject<HTMLButtonElement | null>
}) {
  const groups = ownerQuestionGroups({ state })

  if (!groups.length) {
    return null
  }

  return (
    <section
      className="waiting-decisions flex-none py-1.5 text-meta text-muted [&>.popover]:max-w-full [&>.popover>.button]:flex [&>.popover>.button]:w-full [&>.popover>.button]:justify-between [&>.popover>.button]:min-h-0 [&>.popover>.button]:py-1.5 [&>.popover>.button]:px-0 [&>.popover>.button]:gap-2 [&>.popover>.button]:text-gold [&>.popover>.button]:text-[length:inherit] [&>.popover>.button]:border-t [&>.popover>.button]:border-t-line [&_ul]:list-none [&_ul]:p-0 [&_ul]:m-0 [&_.popover-panel]:p-1.25 [&_.popover-panel]:max-h-waiting-menu [&_li_.button]:flex [&_li_.button]:flex-col [&_li_.button]:items-start [&_li_.button]:w-full [&_li_.button]:min-h-0 [&_li_.button]:p-1.75 [&_li_.button]:text-left [&_li_.button]:whitespace-normal [&_li_.button]:wrap-anywhere [&_li_.button]:text-[length:inherit] [&_li_.button]:leading-normal"
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
            <span className="shrink-0 whitespace-nowrap">Waiting on you · {groups.length}</span>
            <span className="waiting-decision-summary min-w-0 flex-1 truncate max-w-[58%] text-muted">{groups[0].card.title}</span>
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
            {groups.map(group => (
              <li key={group.card.id} className="waiting-question-group p-1.5">
                <Disclosure title={<span className="text-gold">{group.card.title} · {group.decisions.length}</span>}>
                  <ul aria-label={`Questions for ${group.card.title}`}>
                    {group.decisions.map(decision => {
                      const task = state.cards[decision.card.id]
                      const ask = task?.asks?.find(ask => ask.id === decision.id)
                      const context = ask && askWording({ ask }).context

                      return (
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
                          {context && <div className="text-meta text-muted px-1.75 pb-2"><RichText text={context} /></div>}
                        </li>
                      )
                    })}
                  </ul>
                  <QuestionGroupAnswers
                    group={group}
                    command={command}
                    notify={notify}
                    disabled={loading}
                  />
                </Disclosure>
              </li>
            ))}
          </ul>
        )}
      </Popover>
    </section>
  )
}
