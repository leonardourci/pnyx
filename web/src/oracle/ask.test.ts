import assert from 'node:assert/strict'
import { test } from 'node:test'
import { askKey, askStart, askTargets, settledSend } from './ask.ts'

const zeus = {
  id: 'lab',
  name: 'Zeus',
  icon: 'zeus',
}
const artemis = {
  id: 'default',
  name: 'Artemis',
  icon: 'artemis',
}
const hydras = [
  artemis,
  zeus,
]

const press = ({
  key,
  mod = false,
  composing = false,
  picking = false,
  targeted = false,
  request = 'make the font bigger',
}: {
  key: string
  mod?: boolean
  composing?: boolean
  picking?: boolean
  targeted?: boolean
  request?: string
}) => askKey({
  key,
  mod,
  composing,
  picking,
  targeted,
  request,
})

test(
  '"ask" and a space start a request, and "ask:<name>" names its Hydra by display name in any case',
  () => {
    assert.deepEqual(
      askStart({
        query: 'ask why is deploy slow',
        hydras,
      }),
      { request: 'why is deploy slow' },
    )
    assert.deepEqual(
      askStart({
        query: 'Ask:artemis ',
        hydras,
      }),
      {
        target: artemis,
        request: '',
      },
    )
    assert.equal(
      askStart({
        query: 'ask:hera hello',
        hydras,
      }),
      null,
      'an unknown name stays plain text',
    )
    assert.equal(
      askStart({
        query: 'ask',
        hydras,
      }),
      null,
    )
    assert.equal(
      askStart({
        query: 'asking about deploys',
        hydras,
      }),
      null,
    )
    assert.equal(
      askStart({
        query: 'deploy ask ',
        hydras,
      }),
      null,
      'only the start of the field starts a request',
    )
  },
)

test(
  'the picker lists the current Hydra first',
  () => {
    assert.deepEqual(
      askTargets({
        hydras,
        current: zeus,
      }).map(hydra => hydra.name),
      [
        'Zeus',
        'Artemis',
      ],
    )
    assert.deepEqual(
      askTargets({
        hydras: [],
        current: zeus,
      }),
      [zeus],
      'the current Hydra is a target before the Hydra list arrives',
    )
  },
)

test(
  'Enter without a Hydra opens the picker, Enter with one sends, and Mod+Enter sends and opens the chat',
  () => {
    assert.equal(
      press({ key: 'Enter' }),
      'pick',
    )
    assert.equal(
      press({
        key: 'Enter',
        targeted: true,
      }),
      'send',
    )
    assert.equal(
      press({
        key: 'Enter',
        mod: true,
        targeted: true,
      }),
      'send-open',
    )
    assert.equal(
      press({
        key: 'Enter',
        picking: true,
      }),
      'send',
    )
    assert.equal(
      press({
        key: 'Enter',
        mod: true,
        picking: true,
      }),
      'send-open',
    )
    assert.equal(
      press({
        key: 'Enter',
        targeted: true,
        request: '  ',
      }),
      null,
      'an empty request sends nothing',
    )
  },
)

test(
  'the arrows move only in the picker, Escape steps back from it and otherwise leaves Ask mode, and nothing acts while composing',
  () => {
    assert.equal(
      press({
        key: 'ArrowDown',
        picking: true,
      }),
      'down',
    )
    assert.equal(
      press({
        key: 'ArrowUp',
        picking: true,
      }),
      'up',
    )
    assert.equal(
      press({ key: 'ArrowDown' }),
      null,
    )
    assert.equal(
      press({
        key: 'Escape',
        picking: true,
      }),
      'back',
    )
    assert.equal(
      press({ key: 'Escape' }),
      'leave',
    )

    for (const key of [
      'Enter',
      'Escape',
      'ArrowDown',
    ]) {
      assert.equal(
        press({
          key,
          composing: true,
          picking: true,
          targeted: true,
        }),
        null,
      )
    }
  },
)

test(
  'a send the owner left by closing the palette or leaving Ask mode only notifies; otherwise a refusal stays and a delivered request closes or opens the chat',
  () => {
    assert.equal(
      settledSend({
        current: false,
        sent: true,
        opening: true,
      }),
      'notify',
      'delivered after the palette closed: no focus taken back and no chat opened',
    )
    assert.equal(
      settledSend({
        current: false,
        sent: false,
        opening: false,
      }),
      'notify',
      'refused after leaving Ask mode: the new search keeps its text',
    )
    assert.equal(
      settledSend({
        current: true,
        sent: false,
        opening: false,
      }),
      'show-error',
    )
    assert.equal(
      settledSend({
        current: true,
        sent: true,
        opening: false,
      }),
      'close',
    )
    assert.equal(
      settledSend({
        current: true,
        sent: true,
        opening: true,
      }),
      'open-chat',
    )
  },
)
