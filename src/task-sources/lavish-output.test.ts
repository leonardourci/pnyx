import assert from 'node:assert/strict'
import { test } from 'node:test'
import { lavishSession } from './lavish-output.ts'

test(
  'only leading Lavish session fields classify a final round; all payload stays outside the classifier',
  () => {
    assert.deepEqual(
      lavishSession({ stdout: 'session:\n  status: ended\n' }),
      {
        status: 'ended',
        ended: true,
      },
    )
    assert.deepEqual(
      lavishSession({ stdout: 'session:\n  status: feedback\n  session_ended: true\nprompts[1]{tag,text}:\n  message,"final comment"\n' }),
      {
        status: 'feedback',
        ended: true,
      },
    )
    assert.deepEqual(
      lavishSession({ stdout: 'session:\n  status: feedback\nprompts[1]:\n  - text: session_ended: true\n    status: ended\n' }),
      {
        status: 'feedback',
        ended: false,
      },
    )
    assert.deepEqual(
      lavishSession({ stdout: 'error: broken\nsession:\n  status: ended\n' }),
      {
        status: 'unknown',
        ended: false,
      },
    )
    assert.deepEqual(
      lavishSession({ stdout: 'session:\n  status: feedback\n  status: ended\n' }),
      {
        status: 'unknown',
        ended: false,
      },
    )
    assert.deepEqual(
      lavishSession({ stdout: 'session:\n  status: feedback\n  session_ended: "true"\n' }),
      {
        status: 'unknown',
        ended: false,
      },
    )
    assert.deepEqual(
      lavishSession({ stdout: 'session:\n  status: feedback\n  session_ended: yes\n' }),
      {
        status: 'unknown',
        ended: false,
      },
    )
  },
)
