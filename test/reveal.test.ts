import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { Marked, type Token, type Tokens } from 'marked'
import {
  revealStep,
  safeEnd,
  splitBlocks,
  type Block,
} from '../web/src/components/ui/reveal.ts'

const md = new Marked({ gfm: true })
const lex = ({ text }: { text: string }) => md.lexer(text)
const FRAME = 1000 / 60
const replies = JSON.parse(readFileSync(
  new URL(
    'fixtures/streamed-replies.json',
    import.meta.url,
  ),
  'utf8',
)) as Record<string, {
  text: string
  pushes: {
    t: number
    len: number
    final?: boolean
  }[]
}>

// The text a reader sees, from a token walk (Markdown's own markdownText needs a DOM).
const plain = ({ tokens }: { tokens: Token[] }): string => tokens.map(token => {
  if (token.type === 'space') {
    return ''
  }

  if (token.type === 'code' || token.type === 'codespan') {
    return token.text
  }

  if (token.type === 'list') {
    return plain({ tokens: (token as Tokens.List).items })
  }

  if (token.type === 'table') {
    const table = token as Tokens.Table

    return [
      ...table.header,
      ...table.rows.flat(),
    ].map(cell => plain({ tokens: cell.tokens })).join('')
  }

  if ('tokens' in token && token.tokens) {
    return plain({ tokens: token.tokens })
  }

  return 'text' in token ? String(token.text) : token.raw
}).join('')

type Reader = {
  boundary: number
  done: Block[]
  fenced: boolean
  seen: string
}

// Splits what the DOM holds as MessageText does, and checks that what it shows only grows.
const show = ({
  reader,
  text,
  shown,
}: {
  reader: Reader
  text: string
  shown: number
}) => {
  const split = splitBlocks({
    text: text.slice(
      0,
      shown,
    ),
    boundary: reader.boundary,
    done: reader.done,
    lex,
  })
  reader.boundary = split.boundary
  reader.fenced = split.fenced
  const seen = plain({
    tokens: lex({
      text: text.slice(
        0,
        shown,
      ),
    }),
  })
  assert.ok(
    seen.startsWith(reader.seen),
    `text on screen was rewritten:\n${JSON.stringify(reader.seen.slice(-60))}\n→ ${JSON.stringify(seen.slice(-60))}`,
  )
  reader.seen = seen

  return split
}

const reader = (): Reader => ({
  boundary: 0,
  done: [],
  fenced: false,
  seen: '',
})

test(
  'the tail check holds half-written Markdown until it can show it whole',
  () => {
    const at = ({
      text,
      end = text.length,
      final = false,
    }: {
      text: string
      end?: number
      final?: boolean
    }) => safeEnd({
      text,
      end,
      final,
      fenced: false,
    })

    assert.equal(
      at({ text: 'Some **bol' }),
      5,
      'an opener waits for its closer',
    )
    assert.equal(
      at({
        text: 'Some **bold** rest',
        end: 8,
      }),
      13,
      'a received closer shows the span whole',
    )
    assert.equal(
      at({
        text: 'Some **bo\n\nnext',
        end: 9,
      }),
      9,
      'a blank line gives up',
    )
    assert.equal(
      at({
        text: 'Some **bol',
        final: true,
      }),
      10,
      'an ended stream shows the text as it is',
    )
    assert.equal(
      at({ text: 'Done.\n\n- ' }),
      7,
      'a marker-only line waits',
    )
    assert.equal(
      at({ text: 'Done.\n\n```ts' }),
      7,
      'an unfinished fence line waits',
    )
    assert.equal(
      at({
        text: 'Done.\n\n```ts\nx',
        end: 8,
      }),
      12,
      'a finished fence line shows whole',
    )
    assert.equal(
      at({ text: 'Done.\n\n| a | b |\n| --' }),
      7,
      'a table header waits for its delimiter row',
    )
    assert.equal(
      at({ text: 'See [the docs]' }),
      4,
      'a ] at the end of the text cannot be judged yet',
    )
    assert.equal(
      at({
        text: 'Some **bold** rest',
        end: 12,
      }),
      13,
      'never stop inside a closing run',
    )
    assert.equal(
      at({ text: 'See [the docs](https://exa' }),
      4,
      'a link waits for its )',
    )
    assert.equal(
      at({ text: 'Some **bold\nmo' }),
      5,
      'an opener on an earlier line of the paragraph waits',
    )
    assert.equal(
      at({
        text: 'Done.\n\n- item',
        end: 8,
      }),
      9,
      'a list marker shows with its space',
    )
    assert.equal(
      at({ text: 'Done.\n\n| a | b |\n| - | - |\n| 1 | 2' }),
      27,
      'a half-arrived body row waits',
    )

    for (const text of [
      'Edit snake_case now',
      'Open ~/.pnyx now',
      'a \\*b now',
    ]) {
      assert.equal(
        at({ text }),
        text.length,
        `${text} opens nothing`,
      )
    }

    assert.equal(
      safeEnd({
        text: '```py\nf(**kw',
        end: 12,
        final: false,
        fenced: true,
      }),
      12,
      'nothing is held inside a fence',
    )
  },
)

test(
  'blocks start at the index Markdown gives them, which comments store',
  () => {
    const text = 'Intro.\n\n---\n\nAfter the rule.\n\n- one\n- two\n  - nested\n\n> quoted\n\nEnd.'
    const done: Block[] = []
    const { live } = splitBlocks({
      text,
      boundary: 0,
      done,
      lex,
    })
    assert.deepEqual(
      [
        ...done,
        live,
      ].filter(block => block.tokens[0]!.type !== 'space')
        .map(block => [
          block.tokens[0]!.type,
          block.index,
        ]),
      [
        [
          'paragraph',
          0,
        ],
        [
          'hr',
          1,
        ],
        [
          'paragraph',
          1,
        ],
        [
          'list',
          2,
        ],
        [
          'blockquote',
          5,
        ],
        [
          'paragraph',
          6,
        ],
      ],
    )
  },
)

test(
  'text arriving one char at a time never shows half-written Markdown',
  () => {
    for (const { text } of Object.values(replies)) {
      const state = reader()
      let cursor = 0, shown = 0

      for (let len = 1; len <= text.length; len++) {
        const step = revealStep({
          text: text.slice(
            0,
            len,
          ),
          cursor,
          shown,
          speed: Infinity,
          elapsed: FRAME,
          final: len === text.length,
          fenced: state.fenced,
        })
        cursor = step.cursor

        if (step.shown !== shown) {
          shown = step.shown
          show({
            reader: state,
            text: text.slice(
              0,
              len,
            ),
            shown,
          })
        }
      }
    }
  },
)

test(
  'a step across a closing fence stops there, so bold after a code block never shows **',
  () => {
    const text = 'Intro.\n\n```ts\nconst ready = true\n```\n\n**Bold words here** after the fence, and more words.'
    const state = reader()
    let shown = text.indexOf('ready'), cursor = shown
    show({
      reader: state,
      text,
      shown,
    })
    assert.ok(state.fenced)
    // One frame would land inside the bold span.
    const speed = (text.indexOf('words') + 2 - cursor) / FRAME

    for (let frame = 0; frame < 10; frame++) {
      const step = revealStep({
        text,
        cursor,
        shown,
        speed,
        elapsed: FRAME,
        final: false,
        fenced: state.fenced,
      })
      cursor = step.cursor
      shown = step.shown
      show({
        reader: state,
        text,
        shown,
      })
      assert.ok(
        !state.seen.includes('**'),
        `showed ${JSON.stringify(state.seen)}`,
      )
    }

    assert.equal(
      shown,
      text.lastIndexOf(' ') + 1,
      'the last word may still grow',
    )
  },
)
