import assert from 'node:assert/strict'
import { test } from 'node:test'
import { reference, taskMention } from '../src/mentions/mentions.ts'
import { fileBlock } from '../src/attachments/files.ts'
import { cardChip, cardLabel, draftView, editDraft, ICON_SPACE, placeBlock, placeImages, removeChip, replaceDisplay, snapCaret } from '../web/src/hydra/draft.ts'

const task = taskMention({
  id: 'task-1',
  title: 'Fix [login]',
})
const image = '[image: /home/hydras/default/attachments/a.png]'
const other = '[image: /home/hydras/default/attachments/b.png]'
const card = ({ name }: { name: string }) => cardLabel({ name })
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
      `Look at ${label} and\n\n${card({ name: 'Image 1' })}\n\n${card({ name: 'notes.txt' })}\n\nin @app`,
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
  'a text file goes after the caret line as its own paragraph, without splitting a word',
  () => {
    const file = fileBlock({
      name: 'build.log',
      text: 'ok\n',
    })
    const text = 'Intro\n\nI think it could\nhave a preview'
    const caret = 'Intro\n\nI thin'.length
    assert.deepEqual(
      placeBlock({
        text,
        caret,
        block: file,
      }),
      {
        text: `Intro\n\nI think it could\n\n${file}\n\nhave a preview`,
        caret,
      },
    )
  },
)

test(
  'an image lands at the caret inside the sentence, never inside a word, and its card comes out whole',
  () => {
    const shown = ({ text }: { text: string }) => draftView({ text }).display
    const place = ({
      text,
      at,
      lines = [image],
    }: {
      text: string
      at: string
      lines?: string[]
    }) => placeImages({
      text,
      caret: text.indexOf(at) + at.length,
      lines,
    })
    // The owner's report: a caret mid-word once split "think" around the image.
    const midWord = place({
      text: 'I think it could have a preview',
      at: 'I thi',
    })
    assert.equal(
      midWord.text,
      `I think ${image} it could have a preview`,
    )
    assert.equal(
      shown({ text: midWord.text }).slice(midWord.caret),
      ' it could have a preview',
    )
    // Between a word and punctuation, the card sits before the comma with no space after it.
    assert.equal(
      place({
        text: 'In, the attachment is too large',
        at: 'In',
      }).text,
      `In ${image}, the attachment is too large`,
    )
    // At the end, a space after the cards gives the caret somewhere to go; several images are one space apart.
    const end = place({
      text: 'Keep it small like',
      at: 'like',
      lines: [
        image,
        other,
      ],
    })
    assert.equal(
      end.text,
      `Keep it small like ${image} ${other} `,
    )
    assert.equal(
      end.caret,
      shown({ text: end.text }).length,
    )
    // Line breaks stay, and a card before a word keeps a space from it.
    assert.equal(
      place({
        text: 'First line\nsecond',
        at: 'First line\n',
      }).text,
      `First line\n${image} second`,
    )
    // A word in letters outside the Basic Multilingual Plane is never cut inside a surrogate pair.
    assert.equal(
      place({
        text: 'café 𝒜𝒷𝒸 done',
        at: 'café 𝒜𝒷',
      }).text,
      `café 𝒜𝒷𝒸 ${image} done`,
    )
    // Words that hold an apostrophe, an underscore or a decimal point stay whole.
    assert.equal(
      place({
        text: "I don't use snake_case or 3.14 here",
        at: 'I do',
      }).text,
      `I don't ${image} use snake_case or 3.14 here`,
    )
    assert.equal(
      place({
        text: 'snake_case and 3.14',
        at: 'sna',
      }).text,
      `snake_case ${image} and 3.14`,
    )
    assert.equal(
      place({
        text: 'pi is 3.14 today',
        at: 'pi is 3.',
      }).text,
      `pi is 3.14 ${image} today`,
    )
    // Text without spaces between words moves only to the end of the word the caret is in.
    const japanese = place({
      text: 'これは画像です。',
      at: 'これは画',
    }).text
    assert.ok(japanese.startsWith('これは画像'))
    assert.ok(!japanese.endsWith(`${image} 。`))
    // An emoji is not part of a word, so the card goes at the caret with a space on both sides.
    assert.equal(
      place({
        text: 'ok 👍👍 go',
        at: 'ok 👍',
      }).text,
      `ok 👍 ${image} 👍 go`,
    )
  },
)

test(
  'removing a card takes one space beside it, so the sentence reads as it did before',
  () => {
    const text = `I think ${image} it could, and ${other}, too`
    const chips = draftView({ text }).chips
    const first = removeChip({
      text,
      chip: chips[0]!,
    })
    assert.equal(
      first.text,
      `I think it could, and ${other}, too`,
    )
    assert.equal(
      draftView({ text: first.text }).display.slice(
        0,
        first.caret,
      ),
      'I think ',
    )
    assert.equal(
      removeChip({
        text,
        chip: chips[1]!,
      }).text,
      `I think ${image} it could, and, too`,
    )
    // Backspace on a card takes it out as × does.
    const plain = `I think ${image} it could`
    const view = draftView({ text: plain })
    const at = view.chips[0]!.to
    assert.equal(
      editDraft({
        text: plain,
        next: view.display.slice(
          0,
          at - 1,
        ) + view.display.slice(at),
        caret: at - 1,
      }).text,
      'I think it could',
    )
    // Text typed straight after a card keeps the space before it, so the words never run together.
    const glued = `I think ${image}here the attachment`
    assert.equal(
      removeChip({
        text: glued,
        chip: draftView({ text: glued }).chips[0]!,
      }).text,
      'I think here the attachment',
    )
  },
)

test(
  'a card shows its name, cut short when long, and only images and attached files are drawn as cards',
  () => {
    const long = 'a-very-long-release-notes-file-name.md'
    const text = `${fileBlock({
      name: long,
      text: 'x\n',
    })}\n\nSee ${image} and ${reference({
      kind: 'image',
      value: '/home/hydras/default/attachments/a.png',
      label: 'Image 1',
    })} and ${reference({
      kind: 'file',
      value: 'notes.txt',
      label: 'notes.txt',
    })}`
    const chips = draftView({ text }).chips
    assert.deepEqual(
      chips.map(chip => [
        chip.kind,
        chip.attached,
        chip.name,
        cardChip({ chip }),
      ]),
      [
        [
          'file',
          true,
          long,
          true,
        ],
        [
          'image',
          true,
          'Image 1',
          true,
        ],
        [
          'image',
          false,
          'Image 1',
          true,
        ],
        [
          'file',
          false,
          'notes.txt',
          false,
        ],
      ],
    )
    assert.ok(chips[0]!.label.replaceAll(
      '\u2060',
      '',
    ).includes('a-very-long-release…'))
    assert.equal(
      chips[2]!.label,
      cardLabel({ name: 'Image 1' }),
    )
    assert.equal(
      chips[3]!.label,
      '@notes.txt',
    )
  },
)
