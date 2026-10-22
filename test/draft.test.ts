import assert from 'node:assert/strict'
import { test } from 'node:test'
import { reference, taskMention } from '../src/mentions/mentions.ts'
import { fileBlock } from '../src/attachments/files.ts'
import { draftView, editDraft, ICON_SPACE, placeBlock, replaceDisplay, snapCaret } from '../web/src/hydra/draft.ts'

const task = taskMention({
  id: 'task-1',
  title: 'Fix [login]',
})
const image = '[image: /home/hydras/default/attachments/a.png]'
// A task chip shows as its card and state icons, then its title.
const label = `${ICON_SPACE}${ICON_SPACE}Fix [login]`

test(
  'the draft shows references and attachments as chips over the Markdown',
  () => {
    const text = `Look at ${task} and\n\n${image}\n\n${fileBlock({
      name: 'notes.txt',
      // A reference inside an attached file stays part of the file chip.
      text: `one \`\`\` two ${task}\n`,
    })}\n\nin ${reference({
      kind: 'project',
      value: '/work/app (main)',
      label: 'app',
    })}`
    const view = draftView({ text })
    assert.equal(
      view.display,
      `Look at ${label} and\n\n${ICON_SPACE}${ICON_SPACE}Image 1\n\nnotes.txt\n\nin @app`,
    )
    assert.deepEqual(
      view.chips.map(chip => [
        chip.kind,
        chip.attached,
        chip.value,
      ]),
      [
        [
          'task',
          false,
          'task-1',
        ],
        [
          'image',
          true,
          '/home/hydras/default/attachments/a.png',
        ],
        [
          'file',
          true,
          'notes.txt',
        ],
        [
          'project',
          false,
          '/work/app (main)',
        ],
      ],
    )
    assert.match(
      text,
      /File: notes.txt\n\n````\none ``` two .*\n````/,
    )
    assert.deepEqual(
      draftView({
        text: `Move it to ${reference({
          kind: 'column',
          value: 'custom:1',
          label: 'Needs you',
        })}`,
      }).chips.map(chip => [
        chip.kind,
        chip.value,
        chip.label,
      ]),
      [
        [
          'column',
          'custom:1',
          `${ICON_SPACE}Needs you`,
        ],
      ],
    )
  },
)

test(
  'typing next to a chip keeps it and an edit that touches it removes it whole',
  () => {
    const text = `Hi ${task} there`
    const typed = editDraft({
      text,
      next: `Hi ${label}! there`,
      caret: `Hi ${label}!`.length,
    })
    assert.deepEqual(
      typed,
      {
        text: `Hi ${task}! there`,
        caret: `Hi ${label}!`.length,
      },
    )
    const erased = editDraft({
      text,
      next: `Hi ${label.slice(
        0,
        -1,
      )} there`,
      caret: `Hi ${label}`.length - 1,
    })
    assert.deepEqual(
      erased,
      {
        text: 'Hi  there',
        caret: 3,
      },
    )
    assert.deepEqual(
      replaceDisplay({
        text,
        from: 5,
        to: 5,
        insert: 'x',
      }),
      {
        text: 'Hi x there',
        caret: 4,
      },
    )
  },
)

test(
  'a character typed next to the same character keeps the caret right after it',
  () => {
    // A space typed before an existing space must not move the caret past both.
    assert.deepEqual(
      editDraft({
        text: 'a b',
        next: 'a  b',
        caret: 2,
      }),
      {
        text: 'a  b',
        caret: 2,
      },
    )
    const text = `I think ${image} the end`
    const at = draftView({ text }).chips[0]!.to
    const typed = draftView({ text }).display
    assert.equal(
      editDraft({
        text,
        next: `${typed.slice(
          0,
          at,
        )} ${typed.slice(at)}`,
        caret: at + 1,
      }).caret,
      at + 1,
    )
  },
)

test(
  'pasted reference Markdown becomes a chip and the caret skips over chips',
  () => {
    const pasted = editDraft({
      text: 'See ',
      next: `See ${task}`,
      caret: 4 + task.length,
    })
    assert.deepEqual(
      pasted,
      {
        text: `See ${task}`,
        caret: `See ${label}`.length,
      },
    )
    const view = draftView({ text: pasted.text })
    assert.equal(
      snapCaret({
        view,
        offset: 6,
        backward: false,
      }),
      `See ${label}`.length,
    )
    assert.equal(
      snapCaret({
        view,
        offset: 6,
        backward: true,
      }),
      'See '.length,
    )
  },
)

test(
  'an attachment goes after the caret line without splitting its words',
  () => {
    const text = 'Intro\n\nI think it could\nhave a preview'
    const caret = 'Intro\n\nI thin'.length
    const placed = placeBlock({
      text,
      caret,
      block: image,
    })
    assert.deepEqual(
      placed,
      {
        text: `Intro\n\nI think it could\n\n${image}\n\nhave a preview`,
        caret,
      },
    )
    const end = placeBlock({
      text: 'Look',
      caret: 4,
      block: `${image}\n\n${image}`,
    })
    assert.equal(
      end.text,
      `Look\n\n${image}\n\n${image}\n\n`,
    )
    assert.equal(
      end.caret,
      draftView({ text: end.text }).display.length,
    )
    assert.equal(
      placeBlock({
        text: 'One\n\n\n\nTwo',
        caret: 5,
        block: image,
      }).text,
      `One\n\n${image}\n\nTwo`,
    )
  },
)
