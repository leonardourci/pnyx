import { memo, useContext, useMemo } from 'react'
import { shownImageNames } from '#hydra/images.ts'
import { InlinePictures } from '#web-hydra/attached-image.tsx'
import { ChatTokensContext } from '#web-hydra/chat-token-text.tsx'
import { prepareChatTokens } from '#web-hydra/chat-tokens.ts'
import { markdown, renderBlocks, type BlockWrap, type TaskLink } from '#web-hydra/markdown.tsx'

// Every agent- or owner-written text Pnyx shows: Markdown with task, column and skill chips, and its images in place.
export const RichText = memo(function RichText({
  text,
  images = true,
  block,
  openTask,
  columnLook,
}: {
  text: string
  // Pictures show in place of their chips; a compact preview keeps the chips.
  images?: boolean
  block?: BlockWrap
} & Omit<TaskLink, 'images'>) {
  const context = useContext(ChatTokensContext)
  const prepared = useMemo(
    () => prepareChatTokens({
      text,
      suggestions: context.suggestions ?? [],
    }),
    [
      text,
      context.suggestions,
    ],
  )
  const tokens = useMemo(
    () => {
      const tokens = markdown.lexer(prepared.text)
      markdown.walkTokens(
        tokens,
        // eslint-disable-next-line pnyx/object-params -- Marked owns this callback signature.
        token => {
          token.raw = prepared.restore({ text: token.raw })

          if ('href' in token) {
            token.href = prepared.restore({ text: token.href })
          }

          if (token.type === 'code' && token.lang) {
            token.lang = prepared.restore({ text: token.lang })
          }
        },
      )

      return tokens
    },
    [prepared],
  )
  const names = useMemo(
    () => shownImageNames({ text }),
    [text],
  )

  return (
    <ChatTokensContext.Provider
      value={{
        ...context,
        tokens: prepared,
      }}
    >
      <InlinePictures.Provider value={images}>
        <div className="markdown">{renderBlocks({
          text,
          tokens,
          block: block ? ({
            quote,
            ...props
          }) => block({
            ...props,
            quote: prepared.restore({ text: quote }),
          }) : undefined,
          openTask,
          columnLook,
          images: names,
        })}
        </div>
      </InlinePictures.Provider>
    </ChatTokensContext.Provider>
  )
})
