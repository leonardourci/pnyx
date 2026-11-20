import { Button, InlineButton } from '#web-shared/ui/controls.tsx'
import { ICON_SIZE, Icon } from '#web-shared/icons.tsx'
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import type { ChatScroll } from './chat-scroll.ts'

const SCREEN_AND_A_HALF_ABOVE = '150% 0px 0px 0px'

export const CHAT_FRAME = 'chat-frame [--chat-max:var(--spacing-chat-max)] [--chat-pad:var(--spacing-chat-pad)] [--chat-gap:var(--spacing-chat-gap)] [--chat-inset:max(calc(var(--chat-pad)_+_var(--chat-scrollbar,0px)),calc((100%_-_var(--chat-max))/2))] [&>:is(.composer,.agent-change-choice,.compaction-queue,.save-checking,.waiting-decisions)]:mx-(--chat-inset) [&>.waiting-decisions]:px-0 [&>.composer]:mb-3 [&_.composer-bar]:h-auto'

export interface OlderRows {
  cursor?: string
  load({ cursor }: { cursor: string }): Promise<void>
}

function OlderSentinel({
  scroll,
  older,
  loadingEarlier,
}: {
  scroll: ChatScroll
  older?: OlderRows
  loadingEarlier: boolean
}) {
  const marker = useRef<HTMLDivElement>(null)
  const [
    loading,
    setLoading,
  ] = useState(false)
  const [
    failure,
    setFailure,
  ] = useState<{
    cursor: string
    text: string
  }>()
  const latestOlder = useRef(older)
  const explicitRead = useRef(loadingEarlier)
  useLayoutEffect(() => {
    latestOlder.current = older
    explicitRead.current = loadingEarlier
  })
  const cursor = older?.cursor
  const offline = !older

  useEffect(
    () => {
      const element = marker.current
      const root = scroll.scroller.current

      if (offline) {
        setFailure(undefined)
      }

      const idle = !cursor || loading || loadingEarlier || failure?.cursor === cursor

      if (!element || !root || idle) {
        return
      }

      const observer = new IntersectionObserver(
        async reached => {
          if (!reached.some(entry => entry.isIntersecting) || explicitRead.current) {
            return
          }

          observer.disconnect()
          setLoading(true)

          try {
            await latestOlder.current?.load({ cursor })
          } catch (error) {
            setFailure({
              cursor,
              text: (error as Error).message,
            })
          } finally {
            setLoading(false)
          }
        },
        {
          root,
          rootMargin: SCREEN_AND_A_HALF_ABOVE,
        },
      )
      observer.observe(element)

      return () => observer.disconnect()
    },
    [
      cursor,
      loading,
      loadingEarlier,
      offline,
      failure,
    ],
  )

  const failedHere = failure !== undefined && failure.cursor === cursor

  return (
    <div ref={marker} className="chat-older min-h-7">
      {failedHere && (
        <p className="chat-older-failed flex h-full flex-wrap items-center justify-center gap-x-2 text-meta text-muted" role="alert">
          Earlier messages did not load: {failure.text}
          <InlineButton className="text-gold cursor-pointer" onClick={() => setFailure(undefined)}>Retry</InlineButton>
        </p>
      )}
      {(loading || loadingEarlier) && (
        <div className="chat-loading h-full flex items-center justify-center pointer-events-none" role="status" aria-label="Loading earlier messages">
          <span className="chat-spinner size-4 border-2 border-line border-t-muted rounded-full animate-hydra-spin motion-reduce:animate-hydra-spin-reduced" aria-hidden="true" />
        </div>
      )}
    </div>
  )
}

export function ChatError({ text }: { text?: string }) {
  return (
    <p className="chat-error flex items-start gap-2 border border-red/35 rounded-card bg-red/8 text-red text-ui wrap-anywhere max-w-full mt-4.5 py-2.5 px-3 [&>svg]:mt-0.5" role="alert">
      <Icon name="error" size={ICON_SIZE.control} />
      {text}
    </p>
  )
}

function JumpToLatest({ scroll }: { scroll: ChatScroll }) {
  return (
    <>
      <div className="chat-fade absolute inset-x-0 bottom-0 z-2 h-(--chat-end) pointer-events-none bg-linear-to-b/srgb from-transparent to-surface animate-chat-fade motion-reduce:animate-none" aria-hidden="true" />
      <Button
        className="jump absolute bottom-2.5 left-[calc(50%-var(--spacing-jump)/2)] z-3 size-jump p-0 justify-center border border-line rounded-full bg-surface text-ink shadow-jump animate-chat-fade enabled:hover:bg-raised motion-reduce:animate-none"
        aria-label="Jump to latest"
        title="Jump to latest"
        onClick={scroll.toEnd}
      >
        <Icon name="chevron_down" size={ICON_SIZE.toolbar} />
      </Button>
    </>
  )
}

export function Chat({
  title,
  scroll,
  older,
  loadingEarlier,
  error,
  status,
  children,
}: {
  title: string
  scroll: ChatScroll
  older?: OlderRows
  loadingEarlier: boolean
  error?: string
  status?: ReactNode
  children: ReactNode
}) {
  return (
    <div className="chat-body relative flex-1 min-h-0 flex flex-col">
      <div className="chat-viewport relative flex min-h-0 flex-1 flex-col">
        <div
          className="chat-messages thread flex-1 min-w-0 min-h-0 overflow-auto pt-2.5 px-(--chat-pad) pb-(--chat-end) block [scrollbar-gutter:stable_both-edges] focus-visible:-outline-offset-3"
          ref={scroll.scroller}
          data-key-scope="thread"
          role="region"
          aria-label={`${title} conversation`}
          data-away={scroll.reading || undefined}
          tabIndex={0}
          {...scroll.handlers}
        >
          <div className="chat-stream max-w-(--chat-max) mx-auto" ref={scroll.content}>
            <OlderSentinel
              scroll={scroll}
              older={older}
              loadingEarlier={loadingEarlier}
            />
            {children}
            {error && <ChatError text={error} />}
          </div>
        </div>
        {scroll.reading && <JumpToLatest scroll={scroll} />}
      </div>
      {status}
    </div>
  )
}
