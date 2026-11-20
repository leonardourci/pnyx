import { ICON_SIZE } from '#web-shared/icons.tsx'
import type { RefObject } from 'react'
import type { OpenDecision } from '#tasks/decisions.ts'
import { ownerQuestionGroups } from '#tasks/question-groups.ts'
import { Disclosure } from '#web-shared/ui/disclosure.tsx'
import { RichText } from '#web-shared/ui/rich-text.tsx'
import { askWording } from '#tasks/ask-state.ts'
import type { Command } from '#web-app/connection.ts'
import { QuestionGroupAnswers, GroupAnswerRetries, useGroupAnswers } from './question-group.tsx'
import type { HydraState } from '#app/model.ts'
import { Button } from '#web-shared/ui/controls.tsx'
import { conversationMessages, latestAgentMessage, placeMessageCaret } from '#web-hydra/caret.ts'
import { Popover } from '#web-shared/ui/popover.tsx'
import { markdownText } from '#web-hydra/markdown-text.ts'

export function WaitingDecisions({
  state,
  hydraId,
  open,
  loading,
  triggerRef,
  command,
  notify,
}: {
  state: HydraState
  hydraId: string
  command: Command
  notify({ text }: { text: string }): void
  open({ decision }: { decision: OpenDecision }): Promise<void>
  loading: boolean
  triggerRef: RefObject<HTMLButtonElement | null>
}) {
  const groups = ownerQuestionGroups({ state })
  const answers = useGroupAnswers({
    hydraId,
    command,
    notify,
  })
  const retries = <GroupAnswerRetries answers={answers} />

  if (!groups.length) {
    return retries
  }

  return (
    <>
      {retries}
      <section
        className="waiting-decisions flex-none py-1.5 text-meta text-muted [&_.popover-panel]:max-h-waiting-menu [&_.popover-panel]:p-1.25 [&_li_.button]:flex [&_li_.button]:min-h-0 [&_li_.button]:w-full [&_li_.button]:flex-col [&_li_.button]:items-start [&_li_.button]:p-1.75 [&_li_.button]:text-left [&_li_.button]:text-inherit-size [&_li_.button]:leading-normal [&_li_.button]:wrap-anywhere [&_li_.button]:whitespace-normal [&_ul]:m-0 [&_ul]:list-none [&_ul]:p-0 [&>.popover]:max-w-full [&>.popover>.button]:flex [&>.popover>.button]:min-h-0 [&>.popover>.button]:w-full [&>.popover>.button]:justify-between [&>.popover>.button]:gap-2 [&>.popover>.button]:border-t [&>.popover>.button]:border-t-line [&>.popover>.button]:px-0 [&>.popover>.button]:py-1.5 [&>.popover>.button]:text-inherit-size [&>.popover>.button]:text-gold"
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
              <span className="waiting-decision-summary max-w-decision-summary min-w-0 flex-1 truncate text-muted">{groups[0].card.title}</span>
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
                const focusable = [...event.currentTarget.querySelectorAll<HTMLElement>('summary, button:not(:disabled), a[href]')]
                  .filter(element => element.getClientRects().length > 0)
                const index = focusable.findIndex(element => element === document.activeElement)
                const next = index + (event.key === 'ArrowDown' ? 1 : -1)

                if (next < 0) {
                  close()
                } else if (next >= focusable.length) {
                  close()
                  event.currentTarget.closest('.hydra-chat')?.querySelector<HTMLTextAreaElement>('.composer textarea')
                    ?.focus()
                } else {
                  focusable[next].focus()
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
                                close()
                                await open({ decision })
                              }}
                            >
                              <span className="waiting-decision-task text-muted">{decision.card.title}</span>
                              <span className="waiting-decision-question text-gold">{markdownText({ text: decision.text })}</span>
                            </Button>
                            {context && <div className="px-1.75 pb-2 text-meta text-muted"><RichText text={context} /></div>}
                          </li>
                        )
                      })}
                    </ul>
                    <QuestionGroupAnswers
                      group={group}
                      answers={answers}
                      disabled={loading}
                    />
                  </Disclosure>
                </li>
              ))}
            </ul>
          )}
        </Popover>
      </section>
    </>
  )
}
