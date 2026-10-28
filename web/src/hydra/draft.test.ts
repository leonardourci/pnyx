import assert from 'node:assert/strict'
import { test } from 'node:test'
import { taskMention } from '../../../src/hydra/mentions.ts'
import { draftView, editDraft, CHIP_SPACE, CHIP_JOIN, WORD_JOINER, ICON_SPACE, placeImages, replaceDisplay } from './draft.ts'

const task = taskMention({
  id: 'task-1',
  title: 'Fix [login]',
})
const image = '[image: /home/hydras/default/attachments/a.png]'
const other = '[image: /home/hydras/default/attachments/b.png]'
// A task chip shows as its card and state icons, then its title.
const label = `${CHIP_SPACE}${ICON_SPACE}${WORD_JOINER}${ICON_SPACE}${CHIP_JOIN}Fix [login]${CHIP_SPACE}`

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
    assert.equal(
      place({
        text: 'In, the attachment is too large',
        at: 'In',
      }).text,
      `In ${image}, the attachment is too large`,
    )
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
    assert.equal(
      place({
        text: 'First line\nsecond',
        at: 'First line\n',
      }).text,
      `First line\n${image} second`,
    )
    assert.equal(
      place({
        text: 'café 𝒜𝒷𝒸 done',
        at: 'café 𝒜𝒷',
      }).text,
      `café 𝒜𝒷𝒸 ${image} done`,
    )
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
    const japanese = place({
      text: 'これは画像です。',
      at: 'これは画',
    }).text
    assert.ok(japanese.startsWith('これは画像'))
    assert.ok(!japanese.endsWith(`${image} 。`))
    assert.equal(
      place({
        text: 'ok 👍👍 go',
        at: 'ok 👍',
      }).text,
      `ok 👍 ${image} 👍 go`,
    )
  },
)
