import assert from 'node:assert/strict'
import { test } from 'node:test'
import { reference } from '#hydra/mentions.ts'
import { draftView } from './draft.ts'
import { GOAL_SLOT, requestPaths, sendableRequest, withProjectRequest } from './project-request.ts'

const billing = reference({
  kind: 'project',
  value: '/code/billing',
  label: 'billing',
})

test(
  'Add project goes under the draft with the caret right after its @',
  () => {
    const draft = `Check ${billing} first`
    const request = withProjectRequest({ text: draft })
    const shown = draftView({ text: request.text }).display

    assert.ok(request.text.startsWith(`${draft}\nAdd @ to this Hydra and ${GOAL_SLOT}.`))
    assert.equal(
      shown.slice(
        request.caret - 'Add @'.length,
        request.caret,
      ),
      'Add @',
    )
  },
)

test(
  'an unfilled goal leaves the message, and an unpicked project keeps it from going out',
  () => {
    assert.deepEqual(
      sendableRequest({ text: `Add ${billing} to this Hydra and ${GOAL_SLOT}.` }),
      {
        text: `Add ${billing} to this Hydra.`,
        unpicked: false,
      },
    )
    assert.equal(
      sendableRequest({ text: `Add ${billing} to this Hydra and fix the tests.` }).text,
      `Add ${billing} to this Hydra and fix the tests.`,
    )
    assert.ok(sendableRequest({ text: `Hello\nAdd @ to this Hydra and ${GOAL_SLOT}.` }).unpicked)
  },
)

test(
  'a plain path in a request is found whole, spaces included, and an unpicked @ is not',
  () => {
    const display = 'Hello\nAdd /Users/ana/My Project to this Hydra and fix it.\nAdd @ to this Hydra.'
    const [found] = requestPaths({ display })

    assert.equal(
      requestPaths({ display }).length,
      1,
    )
    assert.equal(
      display.slice(
        found!.from,
        found!.to,
      ),
      '/Users/ana/My Project',
    )
  },
)
