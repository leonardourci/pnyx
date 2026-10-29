import assert from 'node:assert/strict'
import { test } from 'node:test'
import { INPUT, moveFocus, recoverFocus, type FocusMove } from './focus.ts'

// The stops a run of keys visits, starting from the input.
const walk = ({
  controls,
  moves,
}: {
  controls: string[]
  moves: FocusMove[]
}) => {
  let at: string = INPUT

  return moves.map(move => {
    at = moveFocus({
      controls,
      from: at,
      move,
    })

    return at
  })
}

const tabs = ({ count }: { count: number }): FocusMove[] => Array.from(
  { length: count },
  () => 'next',
)
const backTabs = ({ count }: { count: number }): FocusMove[] => Array.from(
  { length: count },
  () => 'previous',
)

test(
  'Tab walks the input, then every control in document order, then wraps to the input; ⇧Tab walks back and wraps too',
  () => {
    const controls = [
      'slider',
      'number box',
      'Open in Settings',
    ]

    assert.deepEqual(
      walk({
        controls,
        moves: tabs({ count: 4 }),
      }),
      [
        'slider',
        'number box',
        'Open in Settings',
        INPUT,
      ],
    )
    assert.deepEqual(
      walk({
        controls,
        moves: backTabs({ count: 4 }),
      }),
      [
        'Open in Settings',
        'number box',
        'slider',
        INPUT,
      ],
    )
  },
)

test(
  'Escape returns to the input from any control, and focus outside the order rejoins it as the input',
  () => {
    assert.equal(
      moveFocus({
        controls: [
          'slider',
          'number box',
        ],
        from: 'number box',
        move: 'escape',
      }),
      INPUT,
    )
    assert.equal(
      moveFocus({
        controls: ['Open task'],
        from: 'a badge’s remove button',
        move: 'next',
      }),
      'Open task',
    )
  },
)

test(
  'an empty preview keeps Tab and ⇧Tab on the input',
  () => {
    for (const move of [
      'next',
      'previous',
      'escape',
    ] as const) {
      assert.equal(
        moveFocus({
          controls: [],
          from: INPUT,
          move,
        }),
        INPUT,
      )
    }
  },
)

test(
  'a control that disappears hands focus to the next control after it, or to the input when it was the last',
  () => {
    const before = [
      'Reset to default',
      'slider',
      'number box',
      'Open in Settings',
    ]
    const controls = [
      'slider',
      'number box',
      'Open in Settings',
    ]

    assert.equal(
      recoverFocus({
        before,
        controls,
        lost: 'Reset to default',
      }),
      'slider',
      'resetting a text size removes Reset to default, and focus moves on to the slider',
    )
    assert.equal(
      recoverFocus({
        before: [
          'slider',
          'Open in Settings',
        ],
        controls: ['slider'],
        lost: 'Open in Settings',
      }),
      INPUT,
    )
    assert.equal(
      recoverFocus({
        before: ['Run'],
        controls: [],
        lost: 'Run',
      }),
      INPUT,
    )
  },
)

test(
  'a control that becomes disabled leaves the order, and focus skips any later control that went with it',
  () => {
    assert.equal(
      recoverFocus({
        before: [
          'Decrease',
          'number box',
          'Increase',
          'Open in Settings',
        ],
        controls: [
          'Decrease',
          'number box',
          'Open in Settings',
        ],
        lost: 'Increase',
      }),
      'Open in Settings',
      'Increase is disabled at the maximum',
    )
    assert.equal(
      recoverFocus({
        before: [
          'Save start command',
          'Detach',
          'Add a folder',
        ],
        controls: ['Add a folder'],
        lost: 'Save start command',
      }),
      'Add a folder',
    )
  },
)

// One typical control list per preview: Tab from the input reaches the first control, and the last one wraps back to the input.
const PREVIEWS: Record<string, string[]> = {
  task: [
    'PR #31 link',
    '+2 links',
    'Open task',
  ],
  conversation: ['Open chat'],
  project: ['Show project'],
  'setting, switch': [
    'Focus mode switch',
    'Open in Settings',
  ],
  'setting, choice': [
    'Theme: System radio',
    'System tile',
    'Light tile',
    'Dark tile',
    'Open in Settings',
  ],
  'setting, number changed from its default': [
    'Reset to default',
    'Interface text size slider',
    'Interface text size value',
    'Open in Settings',
  ],
  'Projects panel': [
    'How work lands',
    'Merged by',
    'Start command name',
    'Command',
    'Brings its own folder',
    'Save start command',
    'Detach',
    'Add a folder',
    'Clone a repo',
    'Edit here',
  ],
  'agents and dispatch panel': ['Edit here'],
  action: ['Run'],
  filter: [],
  Ask: [],
}

for (const [
  preview,
  controls,
] of Object.entries(PREVIEWS)) {
  test(
    `the ${preview} preview: Tab and ⇧Tab cycle its controls through the input`,
    () => {
      const forward = walk({
        controls,
        moves: tabs({ count: controls.length + 1 }),
      })
      const backward = walk({
        controls,
        moves: backTabs({ count: controls.length + 1 }),
      })

      assert.deepEqual(
        forward,
        [
          ...controls,
          INPUT,
        ],
      )
      assert.deepEqual(
        backward,
        [
          ...controls.toReversed(),
          INPUT,
        ],
      )
    },
  )
}
