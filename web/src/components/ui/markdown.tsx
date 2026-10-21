import { Button } from './controls.tsx'
import { mentionId } from '../../../../src/mentions/mentions.ts'
import { Fragment, useMemo, type ReactNode } from 'react'
import { Marked, type Token, type Tokens } from 'marked'
import { imageLine, imagePaths } from '../../../../src/attachments/images.ts'
import { AttachedImage } from './attached-image.tsx'

const markdown = new Marked({ gfm: true })
const decodeEntities = ({ text }: { text: string }) => text.replace(
  /&(?:#x[\da-f]+|#\d+|[a-z][a-z\d]+);/gi,
  entity => {
  // Only a single character reference enters this inert decoder, never markup.
    const decoder = document.createElement('textarea')
    decoder.innerHTML = entity

    return decoder.value
  },
)

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

type TaskLink = { openTask?({ id }: { id: string }): void }

const inline = ({
  tokens,
  openTask,
}: { tokens: Token[] } & TaskLink): ReactNode =>
  tokens.map((
    token,
    i,
  ) => {
    const children = 'tokens' in token && token.tokens ? inline({
      tokens: token.tokens,
      openTask,
    })
      : 'text' in token ? decodeEntities({ text: String(token.text) }) : token.raw

    switch (token.type) {
      case 'strong': return <strong key={i}>{children}</strong>
      case 'em': return <em key={i}>{children}</em>
      case 'del': return <del key={i}>{children}</del>
      case 'codespan': return <code key={i}>{token.text}</code>
      case 'br': return <br key={i} />
      case 'link': case 'image': {
        const task = token.type === 'link' ? mentionId({ href: token.href }) : undefined

        if (task && openTask) {
          return (
            <Button
              key={i}
              className="task-mention"
              contentEditable={false}
              onClick={() => openTask({ id: task })}
              title="Open referenced task"
            >{children}
            </Button>
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
        <code>{text}</code>
      </pre>
    </div>
  )
}

function Table({
  token,
  openTask,
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

export function Markdown({
  text,
  block,
  openTask,
}: {
  text: string
  block?({
    index,
    offset,
    quote,
    children,
  }: MarkdownBlock & { children: ReactNode }): ReactNode
} & TaskLink) {
  const tokens = useMemo(
    () => markdown.lexer(text),
    [text],
  )
  let index = 0

  const wrap = ({
    offset,
    quote,
    children,
  }: Omit<MarkdownBlock, 'index'> & { children: ReactNode }) =>
    block ? block({
      index: index++,
      offset,
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
            })}
            </Heading>
          ); break
        }
        case 'paragraph': case 'text': {
          const image = imagePaths({ text: token.text.trim() })[0]
          const content = image !== undefined && imageLine({ path: image }) === token.text.trim()
            ? <AttachedImage path={image} />
            : token.tokens ? inline({
              tokens: token.tokens,
              openTask,
            }) : token.text
          const paragraph = <p>{content}</p>

          if (inItem) {
            return <Fragment key={i}>{paragraph}</Fragment>
          }

          node = paragraph; break
        }
        case 'code': node = <Code text={token.text} language={token.lang} />; break
        case 'table': node = <Table token={token as Tokens.Table} openTask={openTask} />; break
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

  return <div className="markdown">{render({ tokens })}</div>
}
