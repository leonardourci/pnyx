import { TaskReference } from '#web-tasks/task-reference.tsx'
import { decodeValue, mentionId } from '#hydra/mentions.ts'
import { Fragment, memo, useContext, useMemo, type ReactNode } from 'react'
import { Marked, type Token, type Tokens } from 'marked'
import { IMAGE, imageNames } from '#hydra/images.ts'
import { ImageChip } from './attached-image.tsx'
import { ColumnChip } from '#web-tasks/column-chip.tsx'
import { ChatTokensContext, ChatTokenText, SkillToken } from './chat-token-text.tsx'
import { prepareChatTokens } from './chat-tokens.ts'
import { readSkillReference } from '#hydra/transcripts-skill-reference.ts'

export const markdown = new Marked({ gfm: true })
const decodeEntities = ({ text }: { text: string }) => text.replace(
  /&(?:#x[\da-f]+|#\d+|[a-z][a-z\d]+);/gi,
  entity => {
  // Only a single character reference enters this inert decoder, never markup.
    const decoder = document.createElement('textarea')
    decoder.innerHTML = entity

    return decoder.value
  },
)

const inlineText = ({ tokens }: { tokens: Token[] }): string => tokens.map(token => {
  if (token.type === 'codespan') {
    return token.text
  }

  if (token.type === 'br') {
    return ''
  }

  if ('tokens' in token && token.tokens) {
    return inlineText({ tokens: token.tokens })
  }

  return 'text' in token ? decodeEntities({ text: String(token.text) }) : token.raw
}).join('')

export const markdownText = ({ text }: { text: string }) => markdown.lexer(text).filter(token => token.type !== 'space')
  .map(token => {
    if (token.type === 'code') {
      return token.text
    }

    if ('tokens' in token && token.tokens) {
      return inlineText({ tokens: token.tokens })
    }

    return token.raw.trim()
  })
  .join('\n\n')

// Tokens become React elements, never HTML. Raw HTML remains visible text;
// images remain links so transcripts cannot trigger remote tracking requests.
export function markdownHref({ href }: { href: string }): string | undefined {
  try {
    const url = new URL(decodeEntities({ text: href }))

    return [
      'https:',
      'http:',
      'mailto:',
    ].includes(url.protocol) ? url.href : undefined
  } catch {
    return undefined
  }
}

type TaskLink = {
  openTask?({ id }: { id: string }): void
  columnLook?({ id }: { id: string }): {
    icon: string
    tone: string
  }
  images?: Map<string, string>
}

const withImages = ({
  text,
  images,
}: {
  text: string
  images?: Map<string, string>
}): ReactNode => text.split(IMAGE).map((
  part,
  n,
) => n % 2 ? (
  <ImageChip
    key={n}
    path={part}
    label={images?.get(part) ?? 'Image'}
  />
) : <ChatTokenText key={n} text={part} />)

const inline = ({
  tokens,
  openTask,
  columnLook,
  images,
}: { tokens: Token[] } & TaskLink): ReactNode =>
  tokens.map((
    token,
    i,
  ) => {
    const children = 'tokens' in token && token.tokens ? inline({
      tokens: token.tokens,
      openTask,
      columnLook,
      images,
    })
      : 'text' in token ? decodeEntities({ text: String(token.text) }) : token.raw

    switch (token.type) {
      case 'strong': return <strong key={i}>{children}</strong>
      case 'em': return <em key={i}>{children}</em>
      case 'del': return <del key={i}>{children}</del>
      case 'codespan': return <code key={i}><ChatTokenText text={token.text} code /></code>
      case 'html': return <ChatTokenText key={i} text={token.text} />
      case 'br': return <br key={i} />
      case 'link': case 'image': {
        const task = token.type === 'link' ? mentionId({ href: token.href }) : undefined
        const skillPointer = token.type === 'link' ? /^pnyx-skill:([\w%~.-]+)$/.exec(token.href) : null
        const skillValue = skillPointer ? decodeValue({ value: skillPointer[1]! }) : undefined
        const skill = skillValue ? readSkillReference({ value: skillValue }) : undefined

        if (skill) {
          return <SkillToken key={i} skill={skill} />
        }

        const pointer = token.type === 'link' ? /^pnyx-(project|column|image|file):([\w%~.-]+)$/.exec(token.href) : null
        const value = pointer ? decodeValue({ value: pointer[2]! }) : undefined
        const label = inlineText({ tokens: token.tokens ?? [] }).replace(
          /^@/,
          '',
        )

        if (pointer?.[1] === 'image' && value !== undefined) {
          return (
            <ImageChip
              key={i}
              path={value}
              label={label}
              reference
            />
          )
        }

        if (pointer?.[1] === 'column' && value !== undefined) {
          const look = columnLook?.({ id: value }) ?? {
            icon: 'custom',
            tone: '',
          }

          return (
            <ColumnChip
              key={i}
              {...look}
              label={label}
            />
          )
        }

        if (pointer) {
          return <span key={i} className="chip reference-chip" contentEditable={false}>{children}</span>
        }

        if (task) {
          return (
            <TaskReference
              key={i}
              id={task}
              openTask={openTask}
            >{children}
            </TaskReference>
          )
        }

        const href = markdownHref({ href: token.href })

        return href ? (
          <a
            key={i}
            href={href}
            contentEditable={false}
            target="_blank"
            rel="noreferrer noopener"
          >
            {children}
          </a>
        ) : <Fragment key={i}>{children}</Fragment>
      }
      case 'text': return (
        <Fragment key={i}>{typeof children === 'string' ? withImages({
          text: children,
          images,
        }) : children}
        </Fragment>
      )
      default: return <Fragment key={i}>{children}</Fragment>
    }
  })

function Code({
  text,
  language,
}: {
  text: string
  language?: string
}) {
  const lang = language?.split(/\s/)[0]?.toLowerCase() ?? ''

  return (
    <div className="code-block">
      {lang && <span className="code-language">{lang}</span>}
      <pre>
        <code><ChatTokenText text={text} code /></code>
      </pre>
    </div>
  )
}

function Table({
  token,
  openTask,
  columnLook,
  images,
}: { token: Tokens.Table } & TaskLink) {
  const align = token.align.map(a => ({ textAlign: a ?? undefined }))
  const cells = ({
    row,
    Cell,
  }: {
    row: Tokens.TableCell[]
    Cell: 'th' | 'td'
  }) => row.map((
    cell,
    n,
  ) => (
    <Cell key={n} style={align[n]}>{inline({
      tokens: cell.tokens,
      openTask,
      columnLook,
      images,
    })}
    </Cell>
  ))

  return (
    <div className="markdown-table">
      <table>
        <thead>
          <tr>
            {cells({
              row: token.header,
              Cell: 'th',
            })}
          </tr>
        </thead>
        <tbody>{token.rows.map((
          row,
          n,
        ) => (
          <tr key={n}>{cells({
            row,
            Cell: 'td',
          })}
          </tr>
        ))}
        </tbody>
      </table>
    </div>
  )
}

export interface MarkdownBlock {
  index: number
  offset: number
  quote: string
}
type Render = {
  tokens: Token[]
  inItem?: boolean
  base?: number
}

type BlockWrap = ({
  index,
  offset,
  quote,
  children,
}: MarkdownBlock & { children: ReactNode }) => ReactNode

type Blocks = {
  text: string
  tokens: Token[]
  // Where `text` starts in the message, and the index of its first block.
  offset?: number
  index?: number
  block?: BlockWrap
} & TaskLink

// blockCount in reveal.ts mirrors every `block` call made here.
const renderBlocks = ({
  text,
  tokens,
  offset: start = 0,
  index: first = 0,
  block,
  openTask,
  columnLook,
  images,
}: Blocks): ReactNode => {
  let index = first

  const wrap = ({
    offset,
    quote,
    children,
  }: Omit<MarkdownBlock, 'index'> & { children: ReactNode }) =>
    block ? block({
      index: index++,
      offset: start + offset,
      quote: quote.trim(),
      children,
    }) : children

  const render = ({
    tokens,
    inItem = false,
    base = 0,
  }: Render): ReactNode => {
    let cursor = base

    return tokens.map((
      token,
      i,
    ) => {
      const found = text.indexOf(
        token.raw,
        cursor,
      )
      const offset = found < 0 ? cursor : found
      cursor = offset + token.raw.length
      let node: ReactNode

      switch (token.type) {
        case 'space': case 'checkbox': return null
        case 'hr': return <hr key={i} />
        case 'blockquote':
          return (
            <blockquote key={i}>{render({
              tokens: token.tokens ?? [],
              base: offset,
            })}
            </blockquote>
          )
        case 'list': return (
          <Fragment key={i}>{list({
            token: token as Tokens.List,
            offset,
          })}
          </Fragment>
        )
        case 'heading': {
          const Heading = `h${Math.min(
            6,
            token.depth,
          )}` as 'h1'
          node = (
            <Heading>{inline({
              tokens: token.tokens ?? [],
              openTask,
              columnLook,
              images,
            })}
            </Heading>
          ); break
        }
        case 'paragraph': case 'text': {
          const content = token.tokens ? inline({
            tokens: token.tokens,
            openTask,
            columnLook,
            images,
          }) : withImages({
            text: token.text,
            images,
          })
          const paragraph = <p>{content}</p>

          if (inItem) {
            return <Fragment key={i}>{paragraph}</Fragment>
          }

          node = paragraph; break
        }
        case 'code': node = <Code text={token.text} language={token.lang} />; break
        case 'html': node = <p><ChatTokenText text={token.text} /></p>; break
        case 'table': node = (
          <Table
            token={token as Tokens.Table}
            openTask={openTask}
            columnLook={columnLook}
            images={images}
          />
        ); break
        default: node = <p>{token.raw}</p>
      }

      const quote = token.type !== 'table' && 'text' in token ? String(token.text) : token.raw

      return (
        <Fragment key={i}>{wrap({
          offset,
          quote,
          children: node,
        })}
        </Fragment>
      )
    })
  }

  // A plain function, not a component: a component defined here would remount
  // on every render and drop focus from comments inside list items.
  const list = ({
    token,
    offset,
  }: {
    token: Tokens.List
    offset: number
  }) => {
    const Tag = token.ordered ? 'ol' : 'ul'
    let cursor = offset

    return (
      <Tag start={token.ordered ? Number(token.start) : undefined}>
        {token.items.map((
          item,
          n,
        ) => {
          const found = text.indexOf(
            item.raw,
            cursor,
          )
          const itemOffset = found < 0 ? cursor : found
          cursor = itemOffset + item.raw.length
          const marker = item.task && (
            <span
              role="img"
              aria-label={item.checked ? 'Completed' : 'Not completed'}
              className="task-marker"
            >
              {item.checked ? '☑' : '☐'}
            </span>
          )
          const content = render({
            tokens: item.tokens,
            inItem: true,
            base: itemOffset,
          })
          const body = <>{marker}{content}</>

          return (
            <li key={n}>{wrap({
              offset: itemOffset,
              quote: item.text,
              children: body,
            })}
            </li>
          )
        })}
      </Tag>
    )
  }

  return render({ tokens })
}

// Memoized, so a streamed reply's completed blocks skip the typing frames between pushes.
export const MarkdownBlocks = memo(renderBlocks)

export const Markdown = memo(function Markdown({
  text,
  block,
  openTask,
  columnLook,
}: {
  text: string
  block?: BlockWrap
} & TaskLink) {
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
  const images = useMemo(
    () => imageNames({ text }),
    [text],
  )

  return (
    <ChatTokensContext.Provider
      value={{
        ...context,
        tokens: prepared,
      }}
    >
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
        images,
      })}
      </div>
    </ChatTokensContext.Provider>
  )
})
