import assert from 'node:assert/strict'
import { test } from 'node:test'
import { arrowFocus, bufferedScroll, controlKind, enterPreview, INPUT, moveFocus, PASS, recoverFocus, type ControlKind, type FocusMove } from './focus.ts'

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

interface Control {
  name: string
  kind: ControlKind
}

// A preview's controls in Tab order, and where ↑ ↓ ← → from each one lead.
const arrows = ({
  controls,
  from,
  key,
}: {
  controls: Control[]
  from: string
  key: string
}) => arrowFocus({
  controls: controls.map(control => control.name),
  from,
  key,
  kind: controls.find(control => control.name === from)!.kind,
})

const button = ({ name }: { name: string }): Control => ({
  name,
  kind: 'other',
})

test(
  'only sliders, text fields and radio groups keep ← and → for themselves, and only an open popup keeps every arrow',
  () => {
    const kinds = [
      [
        {
          tag: 'INPUT',
          type: 'range',
        },
        'slider',
      ],
      [
        {
          tag: 'INPUT',
          type: 'text',
        },
        'text',
      ],
      [
        {
          tag: 'INPUT',
          type: 'number',
        },
        'text',
      ],
      [
        { tag: 'TEXTAREA' },
        'text',
      ],
      [
        {
          tag: 'INPUT',
          type: 'checkbox',
        },
        'other',
      ],
      [
        {
          tag: 'INPUT',
          type: 'radio',
        },
        'radio',
      ],
      [
        {
          tag: 'BUTTON',
          role: 'radio',
        },
        'radio',
      ],
      [
        {
          tag: 'BUTTON',
          role: 'switch',
        },
        'other',
      ],
      [
        {
          tag: 'BUTTON',
          role: 'combobox',
        },
        'other',
      ],
      [
        {
          tag: 'BUTTON',
          role: 'combobox',
          expanded: true,
        },
        'popup',
      ],
      [
        {
          tag: 'BUTTON',
          expanded: true,
          popup: true,
        },
        'popup',
      ],
      [
        {
          tag: 'BUTTON',
          expanded: true,
        },
        'other',
      ],
      [
        { tag: 'A' },
        'other',
      ],
    ] as const

    for (const [
      element,
      kind,
    ] of kinds) {
      assert.equal(
        controlKind(element),
        kind,
        JSON.stringify(element),
      )
    }
  },
)

test(
  'a slider takes ← → for its value, while ↑ ↓ move off it and ↑ on the first control goes back to the field',
  () => {
    const controls: Control[] = [
      {
        name: 'Interface text size',
        kind: 'slider',
      },
      {
        name: 'Interface text size value',
        kind: 'text',
      },
      button({ name: 'Open in Settings' }),
    ]

    for (const key of [
      'ArrowLeft',
      'ArrowRight',
    ]) {
      assert.equal(
        arrows({
          controls,
          from: 'Interface text size',
          key,
        }),
        PASS,
      )
    }

    assert.equal(
      arrows({
        controls,
        from: 'Interface text size',
        key: 'ArrowDown',
      }),
      'Interface text size value',
    )
    assert.equal(
      arrows({
        controls,
        from: 'Interface text size',
        key: 'ArrowUp',
      }),
      INPUT,
    )
  },
)

test(
  'a text field keeps ← → for its caret, and ↑ ↓ still move between controls',
  () => {
    const controls: Control[] = [
      button({ name: 'How work lands' }),
      {
        name: 'Start command name',
        kind: 'text',
      },
      {
        name: 'Command',
        kind: 'text',
      },
      button({ name: 'Save start command' }),
    ]

    for (const key of [
      'ArrowLeft',
      'ArrowRight',
    ]) {
      assert.equal(
        arrows({
          controls,
          from: 'Command',
          key,
        }),
        PASS,
      )
    }

    assert.equal(
      arrows({
        controls,
        from: 'Command',
        key: 'ArrowUp',
      }),
      'Start command name',
    )
    assert.equal(
      arrows({
        controls,
        from: 'Command',
        key: 'ArrowDown',
      }),
      'Save start command',
    )
  },
)

test(
  'an open popup keeps every arrow until it closes',
  () => {
    const controls: Control[] = [
      {
        name: 'How work lands',
        kind: 'popup',
      },
      button({ name: 'Show fewer' }),
      button({ name: 'Open task' }),
    ]

    for (const key of [
      'ArrowUp',
      'ArrowDown',
      'ArrowLeft',
      'ArrowRight',
    ]) {
      assert.equal(
        arrows({
          controls,
          from: 'How work lands',
          key,
        }),
        PASS,
      )
    }

    assert.equal(
      arrows({
        controls,
        from: 'Show fewer',
        key: 'ArrowDown',
      }),
      'Open task',
      'an expanded disclosure is no popup, so ↓ still moves on',
    )
  },
)

// One case per preview type, since each mixes different kinds of control.
const ARROW_PREVIEWS: Record<string, {
  controls: Control[]
  entry?: string
  own?: string[]
}> = {
  task: { controls: [button({ name: 'Open task' })] },
  conversation: { controls: [button({ name: 'Open chat' })] },
  project: { controls: [button({ name: 'Show project' })] },
  'setting, switch': {
    controls: [
      button({ name: 'Focus mode' }),
      button({ name: 'Open in Settings' }),
    ],
    own: ['Focus mode'],
  },
  'setting, choice': {
    controls: [
      {
        name: 'Theme: Dark',
        kind: 'radio',
      },
      button({ name: 'Dark tile' }),
      button({ name: 'Open in Settings' }),
    ],
    own: ['Theme: Dark'],
  },
  'setting, number changed from its default': {
    controls: [
      button({ name: 'Reset to default' }),
      {
        name: 'Interface text size',
        kind: 'slider',
      },
      {
        name: 'Interface text size value',
        kind: 'text',
      },
      button({ name: 'Open in Settings' }),
    ],
    own: [
      'Interface text size',
      'Interface text size value',
    ],
    entry: 'Interface text size',
  },
  'Projects panel': {
    controls: [
      button({ name: 'How work lands' }),
      button({ name: 'Who merges' }),
      {
        name: 'Start command name',
        kind: 'text',
      },
      {
        name: 'Start command',
        kind: 'text',
      },
      button({ name: 'Brings its own folder' }),
      button({ name: 'Save start command' }),
      button({ name: 'Detach' }),
      button({ name: 'Add a folder' }),
      button({ name: 'Clone a repo' }),
      button({ name: 'Edit here' }),
    ],
  },
  'agents and dispatch panel': { controls: [button({ name: 'Edit here' })] },
  action: { controls: [button({ name: 'Run' })] },
  filter: { controls: [] },
  Ask: { controls: [] },
}

for (const [
  preview,
  {
    controls,
    entry,
    own = [],
  },
] of Object.entries(ARROW_PREVIEWS)) {
  test(
    `the ${preview} preview: → enters it, ↑ ↓ step through its controls, and ↑ or ← leave it`,
    () => {
      const names = controls.map(control => control.name)
      const entered = enterPreview({
        controls: names,
        own,
      })

      assert.equal(
        entered,
        entry ?? names[0],
        'with no control, → from the field does nothing',
      )

      const last = names.at(-1)
      let at = entered

      for (const name of names.slice(names.indexOf(entered!) + 1)) {
        at = arrows({
          controls,
          from: at!,
          key: 'ArrowDown',
        }) as string
        assert.equal(
          at,
          name,
        )
      }

      if (last) {
        assert.equal(
          arrows({
            controls,
            from: last,
            key: 'ArrowDown',
          }),
          last,
          '↓ on the last control stays there',
        )
        assert.equal(
          arrows({
            controls,
            from: names[0]!,
            key: 'ArrowUp',
          }),
          INPUT,
        )
      }

      for (const control of controls) {
        assert.equal(
          arrows({
            controls,
            from: control.name,
            key: 'ArrowLeft',
          }),
          control.kind === 'other' ? INPUT : PASS,
        )
      }
    },
  )
}

const rows = ({
  count,
  height = 30,
}: {
  count: number
  height?: number
}) => Array.from(
  { length: count },
  (
    _,
    index,
  ) => ({
    top: 24 + index * height,
    height,
  }),
)

test(
  'in the middle of a long list the scroll keeps two rows above and below the focused one, moving only when it must',
  () => {
    const list = rows({ count: 20 })

    assert.equal(
      bufferedScroll({
        scrollTop: 0,
        viewport: 150,
        rows: list,
        index: 10,
      }),
      list[12]!.top + 30 - 150,
      'moving down, the second row below the focus becomes the last one in view',
    )
    assert.equal(
      bufferedScroll({
        scrollTop: 400,
        viewport: 150,
        rows: list,
        index: 10,
      }),
      list[8]!.top,
      'moving up, the second row above the focus becomes the first one in view',
    )
    assert.equal(
      bufferedScroll({
        scrollTop: 240,
        viewport: 200,
        rows: list,
        index: 10,
      }),
      240,
      'already buffered, the list stays still',
    )
  },
)

test(
  'near the top the buffer shrinks and the list shows its own top; near the bottom it ends at the last row',
  () => {
    const list = rows({ count: 20 })

    assert.equal(
      bufferedScroll({
        scrollTop: 200,
        viewport: 150,
        rows: list,
        index: 1,
      }),
      0,
    )
    assert.equal(
      bufferedScroll({
        scrollTop: 0,
        viewport: 150,
        rows: list,
        index: 19,
      }),
      list[19]!.top + 30 - 150,
    )
  },
)

test(
  'a short list never scrolls, and a pane too small for the full buffer keeps as many neighbours as fit',
  () => {
    assert.equal(
      bufferedScroll({
        scrollTop: 0,
        viewport: 150,
        rows: rows({ count: 3 }),
        index: 2,
      }),
      0,
    )

    const list = rows({ count: 20 })

    assert.equal(
      bufferedScroll({
        scrollTop: 0,
        viewport: 100,
        rows: list,
        index: 10,
      }),
      list[11]!.top + 30 - 100,
      'one row each side fits in 100 px, two do not',
    )
  },
)

test(
  'a lone control far down the pane, such as Open chat under long matches, comes into view instead of the pane jumping to its top',
  () => {
    const lone = [
      {
        top: 900,
        height: 30,
      },
    ]

    assert.equal(
      bufferedScroll({
        scrollTop: 0,
        viewport: 400,
        rows: lone,
        index: 0,
      }),
      530,
    )
    assert.equal(
      bufferedScroll({
        scrollTop: 530,
        viewport: 400,
        rows: lone,
        index: 0,
      }),
      530,
    )
  },
)
