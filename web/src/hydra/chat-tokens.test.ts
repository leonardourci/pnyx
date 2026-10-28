import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Marked } from 'marked'
import { knownCommands, prepareChatTokens } from './chat-tokens.ts'

const suggestions = [
  {
    command: '/compact',
    description: 'Compact the conversation',
    source: 'Agent commands',
    kind: 'command' as const,
  },
  {
    command: '$fixture-cli',
    description: 'Save memory',
    source: 'Session skills',
    kind: 'skill' as const,
  },
  {
    command: '$deploy',
    description: 'Another project',
    source: 'Project',
    file: '/demo/.agents/skills/deploy/SKILL.md',
  },
]

test(
  'native tokens keep their surrounding text and require an exact catalog name',
  () => {
    const text = 'Please /compact then $fixture-cli, /unknown /compact-extra /folder/compact $deploy'
    assert.deepEqual(
      knownCommands({
        text,
        suggestions,
      }).map(match => text.slice(
        match.start,
        match.end,
      )),
      ['$fixture-cli'],
    )
  },
)

test(
  'Claude built-ins require the start while inline skills authorize invocation',
  () => {
    const catalog = [
      ...suggestions,
      {
        command: '/review',
        description: 'Review',
        source: 'Session skills',
        kind: 'skill' as const,
      },
    ]
    const text = '/compact focus here then /review and /compact'
    assert.deepEqual(
      knownCommands({
        text,
        suggestions: catalog,
      }).map(match => match.item.command),
      [
        '/compact',
        '/review',
      ],
    )
    assert.deepEqual(
      knownCommands({
        text: 'please /review, then /review safely',
        suggestions: catalog,
      }).map(match => match.item.command),
      ['/review'],
    )
  },
)

test(
  'Codex scans names throughout a message including punctuation and code text',
  () => {
    const text = 'Use ($fixture-cli), `x$fixture-cli` and $fixture-cli.md, then $unknown'
    assert.deepEqual(
      knownCommands({
        text,
        suggestions,
      }).map(match => text.slice(
        match.start,
        match.end,
      )),
      [
        '$fixture-cli',
        '$fixture-cli',
        '$fixture-cli',
      ],
    )
    assert.equal(
      knownCommands({
        text: '$fixture-cli',
        suggestions: [
          ...suggestions,
          suggestions[1]!,
        ],
      }).length,
      0,
    )
  },
)

for (const text of [
  '**prefix**/review',
  '**/review** safely',
  '[**/review**](https://example.com)',
  '[/review](https://example.com)',
  '`/review`',
  '```text\n/review\n```',
  'Please /review safely',
  '**prefix** $fixture-cli',
  '\\$fixture-cli',
  '`\\$fixture-cli`',
  '\uE0000\uE001 $fixture-cli',
  '[$fixture-cli](https://example.com/$fixture-cli)',
  '`$fixture-cli`',
  '```text\n$fixture-cli\n```',
]) {
  test(
    `Markdown preserves raw invocation boundaries: ${text}`,
    () => {
      const catalog = [
        ...suggestions,
        {
          command: '/review',
          description: 'Review',
          source: 'Session skills',
        },
      ]
      const prepared = prepareChatTokens({
        text,
        suggestions: catalog,
      })
      const parser = new Marked({ gfm: true })
      const tokens = parser.lexer(prepared.text)
      const visible: string[] = []
      parser.walkTokens(
        tokens,
        // eslint-disable-next-line pnyx/object-params -- Marked owns this callback signature.
        token => {
          if ((token.type === 'text' && !token.tokens) || token.type === 'codespan' || token.type === 'code') {
            visible.push(...prepared.split({
              text: token.text,
              code: token.type !== 'text',
            }).flatMap(part => 'item' in part && part.item ? [part.item.command] : []))
          }
        },
      )
      const expected = knownCommands({
        text,
        suggestions: catalog,
      }).filter(command => !text.slice(
        0,
        command.start,
      ).endsWith('https://example.com/') && (command.item.command.startsWith('$') || !text.startsWith('```')))
      assert.deepEqual(
        visible,
        expected.map(command => command.item.command),
      )
      assert.equal(
        prepared.restore({ text: prepared.text }),
        text,
      )
    },
  )
}

test(
  'literal marker characters and entities cannot become a skill badge',
  () => {
    const prepared = prepareChatTokens({
      text: '&#57344;0&#57345; $fixture-cli',
      suggestions,
    })
    assert.deepEqual(
      prepared.split({ text: '\uE0000\uE001' }),
      [{ text: '\uE0000\uE001' }],
    )
  },
)

test(
  'repeated skill names preserve Markdown reference links',
  () => {
    const prepared = prepareChatTokens({
      text: '[$fixture-cli]\n\n[$fixture-cli]: https://example.com/guide',
      suggestions,
    })
    const parser = new Marked({ gfm: true })
    const links: string[] = []
    parser.walkTokens(
      parser.lexer(prepared.text),
      // eslint-disable-next-line pnyx/object-params -- Marked owns this callback signature.
      token => {
        if (token.type === 'link') {
          links.push(token.href)
        }
      },
    )
    assert.deepEqual(
      links,
      ['https://example.com/guide'],
    )
  },
)
