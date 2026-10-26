import assert from 'node:assert/strict'
import { test } from 'node:test'
import { knownCommands } from '../web/src/hydra/chat-tokens.ts'

const suggestions = [
  {
    command: '/compact',
    description: 'Compact the conversation',
    source: 'Agent commands',
    kind: 'command' as const,
  },
  {
    command: '$inscribe',
    description: 'Save memory',
    source: 'Pnyx Hydra',
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
    const text = 'Please /compact then $inscribe, /unknown /compact-extra /folder/compact $deploy'
    assert.deepEqual(
      knownCommands({
        text,
        suggestions,
      }).map(match => text.slice(
        match.start,
        match.end,
      )),
      ['$inscribe'],
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
    assert.equal(
      knownCommands({
        text: '/compact',
        suggestions,
        leading: false,
      }).length,
      0,
    )
  },
)

test(
  'Codex scans names throughout a message including punctuation and code text',
  () => {
    const text = 'Use ($inscribe), `x$inscribe` and $inscribe.md, then $unknown'
    assert.deepEqual(
      knownCommands({
        text,
        suggestions,
      }).map(match => text.slice(
        match.start,
        match.end,
      )),
      [
        '$inscribe',
        '$inscribe',
        '$inscribe',
      ],
    )
    assert.equal(
      knownCommands({
        text: '$inscribe',
        suggestions: [
          ...suggestions,
          suggestions[1]!,
        ],
      }).length,
      0,
    )
  },
)
