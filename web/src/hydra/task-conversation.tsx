import { useEffect, useRef, useState, type ComponentProps } from 'react'
import type { ThreadPage } from '../../../src/thread/read.ts'
import { taskConversation } from '../../../src/thread/task.ts'
import { Button } from '../components/ui/controls.tsx'
import { Working } from '../components/ui/streaming.tsx'
import { Composer } from './composer.tsx'
import { Messages } from './messages.tsx'
import { joinMessageParts, quoteInto } from './chat.ts'
import type { Card } from '../../../src/core/model.ts'

export function TaskConversation({
  card,
  liveThread,
  ...composer
}: Omit<ComponentProps<typeof Composer>, 'card' | 'thread' | 'settings'> & {
  card: Card
  liveThread: ThreadPage | null
}) {
  const [
    page,
    setPage,
  ] = useState<ThreadPage | null>(null)
  const [
    error,
    setError,
  ] = useState('')
  const scroller = useRef<HTMLDivElement>(null), follow = useRef(true)
  const {
    command,
    connected,
  } = composer

  useEffect(
    () => {
      if (!connected) {
        return
      }

      let active = true
      void command({
        name: 'thread',
        args: [card.id],
      }).then(
        result => {
          if (active) {
            setPage(result.thread as ThreadPage); setError('')
          }
        },
        (error: Error) => {
          if (active) {
            setError(error.message)
          }
        },
      )

      return () => {
        active = false
        void command({
          name: 'thread',
          args: [],
        }).catch(() => {})
      }
    },
    [
      command,
      connected,
      card.id,
      card.agent?.sessionId,
    ],
  )

  useEffect(
    () => {
      if (liveThread?.card === card.id) {
        setPage(liveThread)
      }
    },
    [
      liveThread,
      card.id,
    ],
  )

  useEffect(
    () => {
      if (follow.current && scroller.current) {
        scroller.current.scrollTop = scroller.current.scrollHeight
      }
    },
    [page],
  )

  const entries = taskConversation({
    card,
    entries: joinMessageParts({ entries: page?.entries ?? [] }),
  })
  const working = (card.sessionActivity ?? card.activity) === 'working'

  return (
    <section className="task-conversation" aria-label="Task conversation">
      <h3 className="eyebrow">Conversation</h3>
      <div
        className="thread task-messages"
        data-key-scope="thread"
        ref={scroller}
        tabIndex={0}
        onScroll={event => {
          const el = event.currentTarget
          follow.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40
        }}
      >
        {page?.older && (
          <Button
            onClick={() => {
              void command({
                name: 'thread',
                args: [
                  card.id,
                  page.older!,
                ],
              }).then(result => {
                const older = result.thread as ThreadPage
                setPage(current => current ? {
                  ...current,
                  older: older.older,
                  entries: [
                    ...older.entries,
                    ...current.entries.filter(e =>
                      !older.entries.some(o => o.id === e.id)),
                  ],
                } : older)
              })
                .catch((error: Error) => setError(error.message))
            }}
          >Older messages
          </Button>
        )}
        <Messages
          entries={entries}
          working={working}
          comments={composer.comments}
          setComments={composer.setComments}
          quote={({ text }) => composer.setDraft({
            text: quoteInto({
              draft: composer.draft,
              text,
            }),
          })}
          openTask={composer.openTask}
          notify={composer.notify}
        />
        {working && <Working />}
        {page?.unavailable && <p className="muted">{page.unavailable}</p>}
        {error && <p role="alert">{error}</p>}
      </div>
      <Composer {...composer} card={card.id} thread={page} />
    </section>
  )
}
