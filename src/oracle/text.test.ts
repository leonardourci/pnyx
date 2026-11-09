import assert from 'node:assert/strict'
import { test } from 'node:test'
import { visibleText } from './text.ts'

test(
  'injected wakes hide their reminders while owner text before a wake remains visible',
  () => {
    const context = '<pnyx-context>A routine update.</pnyx-context>'
    const wake = '<pnyx-wake>Check work.</pnyx-wake>'
    assert.equal(
      visibleText({ text: wake }),
      '',
    )
    assert.equal(
      visibleText({ text: `  \n${wake}\nTrailing reminder.` }),
      '',
    )
    assert.equal(
      visibleText({ text: `${context}\n${wake}\nTrailing reminder.` }),
      '',
    )
    assert.equal(
      visibleText({ text: `Owner text\n${wake}` }),
      'Owner text',
    )
    assert.equal(
      visibleText({ text: `${context}\nOwner text\n${wake}` }),
      'Owner text',
    )
    assert.equal(
      visibleText({ text: `${context}\nOwner text` }),
      'Owner text',
    )
    assert.equal(
      visibleText({ text: context }),
      '',
    )
    assert.equal(
      visibleText({ text: 'Plain owner text.' }),
      'Plain owner text.',
    )
  },
)
