/* global document, ClipboardItem */
/* eslint pnyx/object-params: "off" -- Playwright owns page and element callback signatures. */
/* eslint @typescript-eslint/no-unused-expressions: "off" -- The CLI reads this function as its script. */
(async page => {
  await page.context().grantPermissions([
    'clipboard-read',
    'clipboard-write',
  ])
  const cdp = await page.context().newCDPSession(page)
  const question = page.locator('.hydra-chat .chat-decision')
  const answer = question.getByRole(
    'textbox',
    {
      name: 'Your answer',
      exact: true,
    },
  )
  await answer.waitFor()

  const valueIs = async ({
    field,
    expected,
  }) => {
    const actual = await field.inputValue()

    if (actual !== expected) {
      throw new Error(`Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
    }
  }

  // Chromium's editing command keeps the real clipboard event and default insertion.
  const paste = async () => {
    await cdp.send(
      'Input.dispatchKeyEvent',
      {
        type: 'keyDown',
        key: 'Unidentified',
        commands: ['paste'],
      },
    )
    await cdp.send(
      'Input.dispatchKeyEvent',
      {
        type: 'keyUp',
        key: 'Unidentified',
      },
    )
  }

  await page.getByRole(
    'button',
    {
      name: 'Review synthetic change',
      exact: true,
    },
  ).focus()
  await page.keyboard.press('F2')
  const brief = page.getByRole(
    'textbox',
    {
      name: 'Brief',
      exact: true,
    },
  )
  await brief.focus()
  await page.evaluate(() => navigator.clipboard.writeText('Task note\nPasted second line'))
  await paste()
  await valueIs({
    field: brief,
    expected: 'Task note\nPasted second line',
  })
  await page.getByRole(
    'button',
    {
      name: 'Save',
      exact: true,
    },
  ).click()
  await brief.waitFor({ state: 'detached' })

  const cardAnswer = page.getByRole(
    'tabpanel',
    {
      name: 'Context',
      exact: true,
    },
  )
    .getByRole(
      'textbox',
      {
        name: 'Your answer',
        exact: true,
      },
    )
  await cardAnswer.focus()
  await page.evaluate(() => navigator.clipboard.writeText('Task question note'))
  await paste()
  await valueIs({
    field: cardAnswer,
    expected: 'Task question note',
  })

  await page.evaluate(() => {
    document.addEventListener(
      'paste',
      event => {
        document.documentElement.dataset.pasteTrusted = String(event.isTrusted)
        document.documentElement.dataset.pastePrevented = String(event.defaultPrevented)
      },
    )
  })
  await page.evaluate(() => navigator.clipboard.writeText('Copied first line\nSecond line'))
  await answer.focus()
  await paste()
  await valueIs({
    field: answer,
    expected: 'Copied first line\nSecond line',
  })
  const nativePaste = await page.evaluate(() => ({
    trusted: document.documentElement.dataset.pasteTrusted,
    prevented: document.documentElement.dataset.pastePrevented,
  }))

  if (nativePaste.trusted !== 'true' || nativePaste.prevented !== 'false') {
    throw new Error(`The answer must receive a native, uncancelled paste: ${JSON.stringify(nativePaste)}`)
  }

  await answer.evaluate(field => field.setSelectionRange(
    0,
    6,
  ))
  await page.keyboard.press('Backspace')
  await page.keyboard.type('Edited')
  await valueIs({
    field: answer,
    expected: 'Edited first line\nSecond line',
  })
  await cdp.send(
    'Input.insertText',
    { text: ' dictated' },
  )
  await valueIs({
    field: answer,
    expected: 'Edited dictated first line\nSecond line',
  })
  await cdp.send(
    'Input.imeSetComposition',
    {
      text: ' composition',
      selectionStart: 12,
      selectionEnd: 12,
    },
  )
  await cdp.send(
    'Input.insertText',
    { text: ' composition' },
  )
  await valueIs({
    field: answer,
    expected: 'Edited dictated composition first line\nSecond line',
  })

  await answer.evaluate(field => field.select())
  await cdp.send(
    'Input.dispatchKeyEvent',
    {
      type: 'keyDown',
      key: 'Unidentified',
      commands: ['copy'],
    },
  )
  await cdp.send(
    'Input.dispatchKeyEvent',
    {
      type: 'keyUp',
      key: 'Unidentified',
    },
  )
  const copied = await page.evaluate(() => navigator.clipboard.readText())

  if (copied !== 'Edited dictated composition first line\nSecond line') {
    throw new Error(`Copy changed the selected answer: ${JSON.stringify(copied)}`)
  }

  await answer.fill('')
  await page.evaluate(async () => {
    const canvas = document.createElement('canvas')
    canvas.width = 2
    canvas.height = 2
    const png = await new Promise(resolve => canvas.toBlob(
      resolve,
      'image/png',
    ))
    await navigator.clipboard.write([
      new ClipboardItem({
        'text/plain': new Blob(
          ['Text wins'],
          { type: 'text/plain' },
        ),
        'image/png': png,
      }),
    ])
  })
  await answer.focus()
  await paste()
  await valueIs({
    field: answer,
    expected: 'Text wins',
  })

  await answer.fill('')
  await page.evaluate(async () => {
    const canvas = document.createElement('canvas')
    canvas.width = 2
    canvas.height = 2
    const png = await new Promise(resolve => canvas.toBlob(
      resolve,
      'image/png',
    ))
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })])
  })
  await answer.focus()
  await paste()
  const field = answer.locator('xpath=ancestor::div[contains(@class,"composer-field")]')
  await field.locator('.draft-card[data-kind=image]:not([data-loading]) img').waitFor()
  await field.getByRole(
    'button',
    {
      name: 'Remove Image 1',
      exact: true,
      includeHidden: true,
    },
  ).click()

  await answer.focus()
  await page.evaluate(() => navigator.clipboard.writeText('Copied first line\nSecond line'))
  await paste()
  await valueIs({
    field: answer,
    expected: 'Copied first line\nSecond line',
  })
  await question.getByRole(
    'button',
    {
      name: 'Send answer',
      exact: true,
    },
  ).click()
  await answer.waitFor({ state: 'detached' })
  await cdp.detach()

  return 'paste-regression-passed'
})
