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

interface Control {
  name: string
  kind: ControlKind
  lines?: {
    value: string
    start: number
    end: number
  }
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
}) => {
  const control = controls.find(item => item.name === from)!

  return arrowFocus({
    controls: controls.map(item => item.name),
    from,
    key,
    kind: control.kind,
    lines: control.lines,
  })
}

const entered = ({
  controls,
  own = [],
}: {
  controls: Control[]
  own?: string[]
}) => enterPreview({
  controls: controls.map(control => control.name),
  own,
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

test(
  'a one-button preview (a task without links, a conversation, a project, an action, the agents panel): → and ↓ land on its button, and ↑ or ← go back',
  () => {
    const controls = [button({ name: 'Open chat' })]

    assert.equal(
      entered({ controls }),
      'Open chat',
    )
    assert.equal(
      arrows({
        controls,
        from: 'Open chat',
        key: 'ArrowDown',
      }),
      'Open chat',
    )
    assert.equal(
      arrows({
        controls,
        from: 'Open chat',
        key: 'ArrowUp',
      }),
      INPUT,
    )
    assert.equal(
      arrows({
        controls,
        from: 'Open chat',
        key: 'ArrowLeft',
      }),
      INPUT,
    )
  },
)

test(
  'a filter or Ask preview has no control, so → from the field enters nothing',
  () => {
    assert.equal(
      entered({ controls: [] }),
      undefined,
    )
  },
)

test(
  'a task with links: → lands on its first link, ↓ walks the links, the +1 disclosure and Open task, and ↑ or ← go back',
  () => {
    const controls = [
      button({ name: 'PR #31' }),
      button({ name: '+1' }),
      button({ name: 'Open task' }),
    ]

    assert.equal(
      entered({ controls }),
      'PR #31',
    )
    assert.equal(
      arrows({
        controls,
        from: 'PR #31',
        key: 'ArrowDown',
      }),
      '+1',
    )
    assert.equal(
      arrows({
        controls,
        from: '+1',
        key: 'ArrowDown',
      }),
      'Open task',
    )
    assert.equal(
      arrows({
        controls,
        from: 'Open task',
        key: 'ArrowDown',
      }),
      'Open task',
      '↓ on the last control stays there',
    )
    assert.equal(
      arrows({
        controls,
        from: 'PR #31',
        key: 'ArrowUp',
      }),
      INPUT,
    )
    assert.equal(
      arrows({
        controls,
        from: '+1',
        key: 'ArrowLeft',
      }),
      INPUT,
    )
  },
)

test(
  'a switch setting such as Focus mode: → lands on its switch, ↓ moves to Open in Settings, and ↑ or ← go back',
  () => {
    const controls = [
      button({ name: 'Focus mode' }),
      button({ name: 'Open in Settings' }),
    ]

    assert.equal(
      entered({
        controls,
        own: ['Focus mode'],
      }),
      'Focus mode',
    )
    assert.equal(
      arrows({
        controls,
        from: 'Focus mode',
        key: 'ArrowDown',
      }),
      'Open in Settings',
    )
    assert.equal(
      arrows({
        controls,
        from: 'Open in Settings',
        key: 'ArrowDown',
      }),
      'Open in Settings',
    )
    assert.equal(
      arrows({
        controls,
        from: 'Focus mode',
        key: 'ArrowUp',
      }),
      INPUT,
    )
    assert.equal(
      arrows({
        controls,
        from: 'Focus mode',
        key: 'ArrowLeft',
      }),
      INPUT,
    )
    assert.equal(
      arrows({
        controls,
        from: 'Open in Settings',
        key: 'ArrowLeft',
      }),
      INPUT,
    )
  },
)

test(
  'a choice setting such as Theme: → lands on its chosen option, which keeps ← →, and ↓ walks the preview tiles to Open in Settings',
  () => {
    const controls: Control[] = [
      {
        name: 'Theme: System',
        kind: 'radio',
      },
      button({ name: 'System tile' }),
      button({ name: 'Light tile' }),
      button({ name: 'Dark tile' }),
      button({ name: 'Open in Settings' }),
    ]

    assert.equal(
      entered({
        controls,
        own: ['Theme: System'],
      }),
      'Theme: System',
    )
    assert.equal(
      arrows({
        controls,
        from: 'Theme: System',
        key: 'ArrowDown',
      }),
      'System tile',
    )
    assert.equal(
      arrows({
        controls,
        from: 'System tile',
        key: 'ArrowDown',
      }),
      'Light tile',
    )
    assert.equal(
      arrows({
        controls,
        from: 'Light tile',
        key: 'ArrowDown',
      }),
      'Dark tile',
    )
    assert.equal(
      arrows({
        controls,
        from: 'Dark tile',
        key: 'ArrowDown',
      }),
      'Open in Settings',
    )
    assert.equal(
      arrows({
        controls,
        from: 'Open in Settings',
        key: 'ArrowDown',
      }),
      'Open in Settings',
    )
    assert.equal(
      arrows({
        controls,
        from: 'Theme: System',
        key: 'ArrowUp',
      }),
      INPUT,
    )
    assert.equal(
      arrows({
        controls,
        from: 'Theme: System',
        key: 'ArrowLeft',
      }),
      PASS,
    )
    assert.equal(
      arrows({
        controls,
        from: 'Light tile',
        key: 'ArrowLeft',
      }),
      INPUT,
    )
  },
)

test(
  'a number setting changed from its default: → skips Reset to default for the slider, ↓ walks to Open in Settings, and ↑ from the slider reaches Reset',
  () => {
    const controls: Control[] = [
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
    ]

    assert.equal(
      entered({
        controls,
        own: [
          'Interface text size',
          'Interface text size value',
        ],
      }),
      'Interface text size',
    )
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
        from: 'Interface text size value',
        key: 'ArrowDown',
      }),
      'Open in Settings',
    )
    assert.equal(
      arrows({
        controls,
        from: 'Open in Settings',
        key: 'ArrowDown',
      }),
      'Open in Settings',
    )
    assert.equal(
      arrows({
        controls,
        from: 'Interface text size',
        key: 'ArrowUp',
      }),
      'Reset to default',
    )
    assert.equal(
      arrows({
        controls,
        from: 'Reset to default',
        key: 'ArrowUp',
      }),
      INPUT,
    )
    assert.equal(
      arrows({
        controls,
        from: 'Reset to default',
        key: 'ArrowLeft',
      }),
      INPUT,
    )
    assert.equal(
      arrows({
        controls,
        from: 'Interface text size',
        key: 'ArrowLeft',
      }),
      PASS,
    )
    assert.equal(
      arrows({
        controls,
        from: 'Interface text size value',
        key: 'ArrowLeft',
      }),
      PASS,
    )
    assert.equal(
      arrows({
        controls,
        from: 'Open in Settings',
        key: 'ArrowLeft',
      }),
      INPUT,
    )
  },
)

test(
  'the Projects panel: → lands on How work lands, ↓ walks every control to Edit here, including off the end of a start command, and ← keeps to the text fields',
  () => {
    const controls: Control[] = [
      button({ name: 'How work lands for pnyx' }),
      button({ name: 'Who merges pull requests for pnyx' }),
      {
        name: 'Start command name for pnyx',
        kind: 'text',
      },
      {
        name: 'Start command for pnyx',
        kind: 'text',
        lines: {
          value: 'pnpm dev',
          start: 8,
          end: 8,
        },
      },
      button({ name: 'Brings its own folder' }),
      button({ name: 'Save start command' }),
      button({ name: 'Detach pnyx' }),
      button({ name: 'Add a folder' }),
      button({ name: 'Clone a repo' }),
      button({ name: 'Edit here' }),
    ]

    assert.equal(
      entered({ controls }),
      'How work lands for pnyx',
    )
    assert.equal(
      arrows({
        controls,
        from: 'How work lands for pnyx',
        key: 'ArrowDown',
      }),
      'Who merges pull requests for pnyx',
    )
    assert.equal(
      arrows({
        controls,
        from: 'Who merges pull requests for pnyx',
        key: 'ArrowDown',
      }),
      'Start command name for pnyx',
    )
    assert.equal(
      arrows({
        controls,
        from: 'Start command name for pnyx',
        key: 'ArrowDown',
      }),
      'Start command for pnyx',
    )
    assert.equal(
      arrows({
        controls,
        from: 'Start command for pnyx',
        key: 'ArrowDown',
      }),
      'Brings its own folder',
    )
    assert.equal(
      arrows({
        controls,
        from: 'Brings its own folder',
        key: 'ArrowDown',
      }),
      'Save start command',
    )
    assert.equal(
      arrows({
        controls,
        from: 'Save start command',
        key: 'ArrowDown',
      }),
      'Detach pnyx',
    )
    assert.equal(
      arrows({
        controls,
        from: 'Detach pnyx',
        key: 'ArrowDown',
      }),
      'Add a folder',
    )
    assert.equal(
      arrows({
        controls,
        from: 'Add a folder',
        key: 'ArrowDown',
      }),
      'Clone a repo',
    )
    assert.equal(
      arrows({
        controls,
        from: 'Clone a repo',
        key: 'ArrowDown',
      }),
      'Edit here',
    )
    assert.equal(
      arrows({
        controls,
        from: 'Edit here',
        key: 'ArrowDown',
      }),
      'Edit here',
    )
    assert.equal(
      arrows({
        controls,
        from: 'How work lands for pnyx',
        key: 'ArrowUp',
      }),
      INPUT,
    )
    assert.equal(
      arrows({
        controls,
        from: 'Who merges pull requests for pnyx',
        key: 'ArrowLeft',
      }),
      INPUT,
    )
    assert.equal(
      arrows({
        controls,
        from: 'Start command name for pnyx',
        key: 'ArrowLeft',
      }),
      PASS,
    )
    assert.equal(
      arrows({
        controls,
        from: 'Start command for pnyx',
        key: 'ArrowLeft',
      }),
      PASS,
    )
    assert.equal(
      arrows({
        controls,
        from: 'Detach pnyx',
        key: 'ArrowLeft',
      }),
      INPUT,
    )
  },
)

test(
  'in a multi-line field ↑ and ↓ move its caret between lines, and move focus only from its first or last line',
  () => {
    const press = ({
      key,
      at,
    }: {
      key: string
      at: number
    }) => arrowFocus({
      controls: [
        'Start command name',
        'Start command',
        'Brings its own folder',
      ],
      from: 'Start command',
      key,
      kind: 'text',
      lines: {
        value: 'pnpm i\npnpm build\npnpm dev',
        start: at,
        end: at,
      },
    })

    assert.equal(
      press({
        key: 'ArrowUp',
        at: 6,
      }),
      'Start command name',
      'the end of the first line',
    )
    assert.equal(
      press({
        key: 'ArrowDown',
        at: 6,
      }),
      PASS,
    )
    assert.equal(
      press({
        key: 'ArrowUp',
        at: 10,
      }),
      PASS,
      'the middle line',
    )
    assert.equal(
      press({
        key: 'ArrowDown',
        at: 10,
      }),
      PASS,
    )
    assert.equal(
      press({
        key: 'ArrowDown',
        at: 18,
      }),
      'Brings its own folder',
      'the start of the last line',
    )
    assert.equal(
      press({
        key: 'ArrowUp',
        at: 26,
      }),
      PASS,
    )
  },
)

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
      264,
      'moving down, the second row below the focus becomes the last one in view',
    )
    assert.equal(
      bufferedScroll({
        scrollTop: 400,
        viewport: 150,
        rows: list,
        index: 10,
      }),
      264,
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
      474,
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
      284,
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
