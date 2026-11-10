import { TaskReference } from '#web-tasks/task-reference.tsx'
import { decodeValue, mentionId } from '#hydra/mentions.ts'
import { Fragment, memo, useContext, useMemo, type ComponentProps, type ReactNode } from 'react'
import type { Token, Tokens } from 'marked'
import { decodeEntities, inlineText, markdown } from './markdown-text.ts'
import { SHOWN_IMAGE, shownImageLabel, shownImageNames, shownImagePath } from '#hydra/images.ts'
import { attachmentSource, ImageChip, MessageImage } from './attached-image.tsx'
import { ColumnChip } from '#web-tasks/column-chip.tsx'
import { ChatTokensContext, ChatTokenText, SkillToken } from './chat-token-text.tsx'
import { prepareChatTokens } from './chat-tokens.ts'
import { readSkillReference } from '#hydra/transcripts-skill-reference.ts'
import { CHIP_SOURCE } from './message-selection.ts'

// Tokens become React elements, never executable HTML.
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

function htmlImages({ text }: { text: string }) {
  return [...text.matchAll(/<img\b(?:[^"'<>]|"[^"]*"|'[^']*')*>/gi)].flatMap(match => {
    const template = document.createElement('template')
    template.innerHTML = match[0]
    const image = template.content.firstElementChild

    if (image?.tagName !== 'IMG') {
      return []
    }

    const dimension = ({ name }: { name: string }) => {
      const value = image.getAttribute(name) ?? ''

      return /^\d+$/.test(value) && Number(value) > 0 && Number.isFinite(Number(value)) ? Number(value) : undefined
    }

    return [
      {
        index: match.index,
        raw: match[0],
        props: {
          src: image.getAttribute('src') ?? '',
          alt: image.getAttribute('alt') ?? undefined,
          title: image.getAttribute('title') ?? undefined,
          width: dimension({ name: 'width' }),
          height: dimension({ name: 'height' }),
        },
      },
    ]
  })
}

// First offsets keep deduplication stable when streamed blocks render independently.
export function messageImagePositions({
  text,
  tokens,
}: {
  text: string
  tokens?: Token[]
}) {
  const positions = new Map<string, number>()
  const hasImages = text.includes('![') || /<img\b/i.test(text) || !text.matchAll(SHOWN_IMAGE).next().done

  if (!hasImages) {
    return positions
  }

  const add = ({
    path,
    offset,
  }: {
    path: string
    offset: number
  }) => {
    if (!positions.has(path)) {
      positions.set(
        path,
        offset,
      )
    }
  }

  const visit = ({
    tokens,
    source,
    offset,
  }: {
    tokens: Token[]
    source: string
    offset: number
  }) => {
    let cursor = 0

    for (const token of tokens) {
      const found = source.indexOf(
        token.raw,
        cursor,
      )

      if (found < 0) {
        continue
      }

      cursor = found + token.raw.length
      const at = offset + found

      if (token.type === 'image') {
        add({
          path: decodeEntities({ text: token.href }),
          offset: at,
        })
      } else if (token.type === 'html') {
        for (const image of htmlImages({ text: token.raw })) {
          add({
            path: image.props.src,
            offset: at + image.index,
          })
        }
      } else if (token.type === 'text' && !token.tokens) {
        for (const match of token.raw.matchAll(SHOWN_IMAGE)) {
          add({
            path: shownImagePath({ match }).path,
            offset: at + match.index,
          })
        }
      } else if (token.type === 'list') {
        visit({
          tokens: (token as Tokens.List).items,
          source: token.raw,
          offset: at,
        })
      } else if (token.type === 'table') {
        const table = token as Tokens.Table
        const cells = [
          ...table.header,
          ...table.rows.flat(),
        ]
        visit({
          tokens: cells.flatMap(cell => cell.tokens),
          source: token.raw,
          offset: at,
        })
      } else if ('tokens' in token && token.tokens && token.type !== 'codespan') {
        visit({
          tokens: token.tokens,
          source: token.raw,
          offset: at,
        })
      }
    }
  }

  visit({
    tokens: tokens ?? markdown.lexer(text),
    source: text,
    offset: 0,
  })

  return positions
}

function messageImage({
  props,
  inlineImages,
}: {
  props: ComponentProps<typeof MessageImage>
  inlineImages?: Set<string>
}) {
  const first = inlineImages?.delete(props.src)

  return first
    ? <MessageImage {...props} />
    : <ImageChip path={props.src} label={props.alt || 'Image'} />
}

function messageHtml({
  text,
  inlineImages,
}: {
  text: string
  inlineImages?: Set<string>
}): ReactNode {
  const parts: ReactNode[] = []
  let end = 0

  for (const image of htmlImages({ text })) {
    parts.push(
      <ChatTokenText
        key={end}
        text={text.slice(
          end,
          image.index,
        )}
      />,
      <Sourced key={`${image.index}:html-image`} markdown={image.raw}>
        {messageImage({
          props: image.props,
          inlineImages,
        })}
      </Sourced>,
    )
    end = image.index + image.raw.length
  }

  parts.push(<ChatTokenText key={end} text={text.slice(end)} />)

  return parts
}

type TaskLink = {
  openTask?({ id }: { id: string }): void
  columnLook?({ id }: { id: string }): {
    icon: string
    tone: string
  }
  images?: Map<string, string>
  inlineImages?: Set<string>
  imagePositions?: Map<string, number>
}

function Sourced({
  markdown,
  children,
}: {
  markdown: string
  children: ReactNode
}) {
  return <span {...{ [CHIP_SOURCE]: markdown }}>{children}</span>
}

const withImages = ({
  text,
  images,
  inlineImages,
}: {
  text: string
  images?: Map<string, string>
  inlineImages?: Set<string>
}): ReactNode => {
  const parts: ReactNode[] = []
  let end = 0

  for (const match of text.matchAll(SHOWN_IMAGE)) {
    const [source] = match
    const { path } = shownImagePath({ match })
    const label = shownImageLabel({
      match,
      names: images,
    })
    const first = inlineImages?.delete(path)
    const sourceUrl = attachmentSource({ path })
    parts.push(
      <ChatTokenText
        key={end}
        text={text.slice(
          end,
          match.index,
        )}
      />,
      <Sourced key={`${match.index}:image`} markdown={source}>
        {first && sourceUrl
          ? <MessageImage src={path} alt={label} />
          : <ImageChip path={path} label={label} />}
      </Sourced>,
    )
    end = match.index + source.length
  }

  return [
    ...parts,
    <ChatTokenText key={end} text={text.slice(end)} />,
  ]
}

const inline = ({
  tokens,
  openTask,
  columnLook,
  images,
  inlineImages,
}: { tokens: Token[] } & TaskLink): ReactNode =>
  tokens.map((
    token,
    i,
  ) => {
    if (token.type === 'image') {
      return (
        <Sourced key={i} markdown={token.raw}>{messageImage({
          props: {
            src: decodeEntities({ text: token.href }),
            alt: decodeEntities({ text: token.text }),
            title: token.title ?? undefined,
          },
          inlineImages,
        })}
        </Sourced>
      )
    }

    const children = 'tokens' in token && token.tokens ? inline({
      tokens: token.tokens,
      openTask,
      columnLook,
      images,
      inlineImages,
    })
      : 'text' in token ? decodeEntities({ text: String(token.text) }) : token.raw

    switch (token.type) {
      case 'strong': return <strong key={i}>{children}</strong>
      case 'em': return <em key={i}>{children}</em>
      case 'del': return <del key={i}>{children}</del>
      case 'codespan': return <code key={i}><ChatTokenText text={token.text} code /></code>
      case 'html': return (
        <Fragment key={i}>{messageHtml({
          text: token.text,
          inlineImages,
        })}
        </Fragment>
      )
      case 'br': return <br key={i} />
      case 'link': {
        const task = mentionId({ href: token.href })
        const skillPointer = /^pnyx-skill:([\w%~.-]+)$/.exec(token.href)
        const skillValue = skillPointer ? decodeValue({ value: skillPointer[1]! }) : undefined
        const skill = skillValue ? readSkillReference({ value: skillValue }) : undefined

        if (skill) {
          return <Sourced key={i} markdown={token.raw}><SkillToken skill={skill} /></Sourced>
        }

        const pointer = /^pnyx-(project|column|image|file):([\w%~.-]+)$/.exec(token.href)
        const value = pointer ? decodeValue({ value: pointer[2]! }) : undefined
        const label = inlineText({ tokens: token.tokens ?? [] }).replace(
          /^@/,
          '',
        )

        if (pointer?.[1] === 'image' && value !== undefined) {
          return (
            <Sourced key={i} markdown={token.raw}>
              <ImageChip
                path={value}
                label={label}
                reference
              />
            </Sourced>
          )
        }

        if (pointer?.[1] === 'column' && value !== undefined) {
          const look = columnLook?.({ id: value }) ?? {
            icon: 'custom',
            tone: '',
          }

          return (
            <Sourced key={i} markdown={token.raw}>
              <ColumnChip
                {...look}
                label={label}
              />
            </Sourced>
          )
        }

        if (pointer) {
          return (
            <Sourced key={i} markdown={token.raw}>
              <span className="chip reference-chip" contentEditable={false}>{children}</span>
            </Sourced>
          )
        }

        if (task) {
          return (
            <Sourced key={i} markdown={token.raw}>
              <TaskReference
                id={task}
                openTask={openTask}
                savedLabel={label}
              >{children}
              </TaskReference>
            </Sourced>
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
          inlineImages,
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

function table({
  token,
  openTask,
  columnLook,
  images,
  inlineImages,
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
      inlineImages,
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
  imagePositions = messageImagePositions({ text }),
}: Blocks): ReactNode => {
  let index = first
  const inlineImages = new Set([...imagePositions].filter(([
    , offset,
  ]) => offset >= start && offset < start + text.length).map(([path]) => path))

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
              inlineImages,
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
            inlineImages,
          }) : withImages({
            text: token.text,
            images,
            inlineImages,
          })
          const paragraph = <p>{content}</p>

          if (inItem) {
            return <Fragment key={i}>{paragraph}</Fragment>
          }

          node = paragraph; break
        }
        case 'code': node = <Code text={token.text} language={token.lang} />; break
        case 'html': node = (
          <p>{messageHtml({
            text: token.text,
            inlineImages,
          })}
          </p>
        ); break
        case 'table': node = table({
          token: token as Tokens.Table,
          openTask,
          columnLook,
          images,
          inlineImages,
        }); break
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
    () => shownImageNames({ text }),
    [text],
  )

  const imagePositions = useMemo(
    () => messageImagePositions({
      text,
      tokens,
    }),
    [
      text,
      tokens,
    ],
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
        imagePositions,
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
