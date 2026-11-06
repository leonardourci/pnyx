import type { Receipt } from '#web-app/connection.ts'
import { composing } from '#web-shared/ime.ts'
import { type Dispatch,type KeyboardEvent,type RefObject,type SetStateAction } from 'react'
import { askAttempt,askKey,askStart,settledSend,type AskAttempt,type AskKey,type AskTarget } from './ask.ts'
import { movedId } from './keys.ts'

export const ASK_BADGE = 'ask'

export interface Asking {
  // The Hydra named with ask:<name>; without one, Enter shows the picker.
  target?: string
  picking: boolean
  picked?: string
  sending: boolean
  // The send went out but its receipt has not come back yet.
  checking?: boolean
  error?: string
}

export function useAskMode({
  ask,
  setAsk,
  attempt,
  query,
  setQuery,
  targets,
  stepped,
  send,
  notify,
  close,
  openChat,
}: {
  ask: Asking | null
  setAsk: Dispatch<SetStateAction<Asking | null>>
  attempt: RefObject<AskAttempt | null>
  query: string
  setQuery: Dispatch<SetStateAction<string>>
  targets: AskTarget[]
  stepped: RefObject<boolean>
  send({
    id,
    text,
    event,
    onChecking,
  }: {
    id: string
    text: string
    event: string
    onChecking(): void
  }): Promise<Receipt>
  notify({ text }: { text: string }): void
  close({ restore }: { restore: boolean }): void
  openChat({ id }: { id: string }): void
}) {
  const targetIds = targets.map(target => target.id)
  const askTarget = targets.find(target => target.id === ask?.target)
  const pickedId = targetIds.find(id => id === ask?.picked) ?? targetIds[0]
  const pickedTarget = targets.find(target => target.id === pickedId)

  const leaveAsk = () => {
    attempt.current = null
    setAsk(null)
  }

  const sendAsk = async ({
    to,
    opening,
  }: {
    to?: AskTarget
    opening: boolean
  }) => {
    const text = query.trim()

    if (!ask || !to || ask.sending || !text) {
      return
    }

    const sending = askAttempt({
      kept: attempt.current,
      text,
      to: to.id,
    })
    attempt.current = sending
    setAsk({
      ...ask,
      sending: true,
      checking: false,
      error: undefined,
    })

    let problem: string | undefined

    try {
      const receipt = await send({
        id: to.id,
        text,
        event: sending.id,
        onChecking: () => {
          if (attempt.current === sending) {
            // eslint-disable-next-line pnyx/object-params -- React state setter callback contract.
            setAsk(value => value && {
              ...value,
              checking: true,
            })
          }
        },
      })

      if (receipt.state !== 'queued') {
        problem = typeof receipt.detail === 'string' ? receipt.detail : `${to.name} did not take the request.`
      }
    } catch (error) {
      problem = error instanceof Error ? error.message : String(error)
    }

    const sent = problem === undefined
    const outcome = settledSend({
      current: attempt.current === sending,
      sent,
      opening,
    })

    switch (outcome) {
      case 'notify':
        notify({ text: sent ? `Sent to ${to.name}` : `Ask ${to.name}: ${problem}` })
        break
      case 'show-error':
        // eslint-disable-next-line pnyx/object-params -- React state setter callback contract.
        setAsk(value => value && {
          ...value,
          sending: false,
          checking: false,
          error: problem,
        })
        break
      case 'close':
      case 'open-chat':
        setAsk(null); setQuery('')
        close({ restore: outcome === 'close' })
        notify({ text: `Sent to ${to.name}` })

        if (outcome === 'open-chat') {
          openChat({ id: to.id })
        }
    }
  }

  const askAct = ({ key }: { key: AskKey }) => {
    if (!ask) {
      return
    }

    switch (key) {
      case 'leave':
        leaveAsk()
        break
      case 'back':
        setAsk({
          ...ask,
          picking: false,
        })
        break
      case 'pick':
        setAsk({
          ...ask,
          picking: true,
          picked: undefined,
        })
        break
      case 'up':
      case 'down':
        stepped.current = true
        setAsk({
          ...ask,
          picked: movedId({
            ids: targetIds,
            current: pickedId,
            step: key === 'down' ? 1 : -1,
          }),
        })
        break
      case 'send':
      case 'send-open':
        sendAsk({
          to: ask.picking ? pickedTarget : askTarget,
          opening: key === 'send-open',
        })
    }
  }

  const askInput = ({ event }: { event: KeyboardEvent<HTMLInputElement> }) => {
    const key = askKey({
      key: event.key,
      mod: event.metaKey || event.ctrlKey,
      composing: composing({ event: event.nativeEvent }),
      picking: ask?.picking === true,
      targeted: !!askTarget,
      request: query,
    })

    if (!key) {
      return
    }

    event.preventDefault(); event.stopPropagation()
    askAct({ key })
  }

  const type = ({ typed }: { typed: string }) => {
    // The request is on its way, so its text stays as sent.
    if (ask?.sending) {
      return
    }

    const start = ask ? null : askStart({
      query: typed,
      hydras: targets,
    })

    if (start) {
      setAsk({
        target: start.target?.id,
        picking: false,
        sending: false,
      })
      setQuery(start.request)

      return
    }

    if (ask?.error) {
      setAsk({
        ...ask,
        error: undefined,
      })
    }

    setQuery(typed)
  }

  return {
    leaveAsk,
    sendAsk,
    askAct,
    askInput,
    type,
  }
}
