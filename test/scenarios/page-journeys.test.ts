import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { HYDRA_CARD } from '../../src/core/hydra.ts'
import { browserGroup } from './browser.ts'
import { scenarioGroup, until } from './harness.ts'

// The owner's own journeys on the built page, in one headless Chrome against one Pnyx.
const pnyx = scenarioGroup({ incorporateSteering: true })
const chrome = browserGroup()
type Scenario = Awaited<ReturnType<typeof pnyx.scenario>>

function installFixtureSkill() {
  for (const folder of [
    process.env.CLAUDE_CONFIG_DIR!,
    process.env.CODEX_HOME!,
  ]) {
    const skill = join(
      folder,
      'skills',
      'fixture-cli',
    )
    mkdirSync(
      skill,
      { recursive: true },
    )
    writeFileSync(
      join(
        skill,
        'SKILL.md',
      ),
      '---\nname: fixture-cli\ndescription: Fixture command\n---\n',
    )
  }
}

const openHydra = ({ s }: { s: Scenario }) => chrome.open({ url: `http://127.0.0.1:${pnyx.port()}/hydra/${s.hydraId}/` })

const hydraFinished = async ({
  s,
  turns,
}: {
  s: Scenario
  turns: number
}) => {
  const agent = await s.agent({ hydra: true })
  await until({
    what: `Hydra to finish turn ${turns}`,
    check: () => s.received({ cwd: agent.cwd }).length === turns
      && s.state().cards[HYDRA_CARD]?.sessionActivity === 'finished',
  })

  return agent
}

test(
  'a message sent from the composer streams Hydra’s reply as it is written, settles once, and stays through a restart',
  async () => {
    const s = await pnyx.scenario()
    const page = await openHydra({ s })
    const held = pnyx.claude.plan({
      text: 'Plan the release',
      reply: 'Release plan: **ship** it on Friday.',
      hold: true,
    })

    try {
      await page.click({ selector: '.hydra-chat textarea' })
      await page.type({ text: 'Plan the release' })
      await page.press({ key: 'Enter' })
      // Markdown renders as it streams, and the last word waits until the turn says the reply is whole.
      await page.shows({
        what: 'the streamed reply while the turn runs',
        check: () => {
          const messages = document.querySelector('.hydra-chat .messages')
          const text = messages?.textContent ?? ''

          return text.includes('Release plan: ship it on') && !text.includes('Friday') && !text.includes('**')
            && messages?.querySelector('strong')?.textContent === 'ship'
            && (document.querySelector('.hydra-chat textarea') as HTMLTextAreaElement | null)?.value === ''
            && document.querySelector('.composer-stop')
            && !document.querySelector('.hydra-chat .turn-foot')
        },
      })
      const agent = await s.agent({ hydra: true })
      assert.ok(agent.received.at(-1)?.endsWith('\n\nPlan the release'))
      const late = await openHydra({ s })
      await late.shows({
        what: 'the reply so far on a page opened mid-turn',
        check: () => document.querySelector('.hydra-chat .messages')?.textContent?.includes('Release plan: ship it on'),
      })
      await late.close()
    } finally {
      held.release()
    }

    const settled = ({ replies }: { replies: string[] }) => page.shows({
      what: `${replies.join(' and ')} settled once each`,
      arg: { replies },
      check: ({ replies }) => {
        const messages = [...document.querySelectorAll('.hydra-chat .message')].map(m => m.textContent ?? '')
        const once = ({ text }: { text: string }) => messages.filter(m => m.includes(text))
          .length === 1

        return replies.every(text => once({ text })) && once({ text: 'Plan the release' })
          && document.querySelectorAll('.hydra-chat .turn-foot').length === replies.length
          && !document.querySelector('.composer-stop')
      },
    })
    await settled({ replies: ['Release plan: ship it on Friday.'] })

    await pnyx.restart()
    // A change made while the page reconnects proves it follows the new server.
    await s.owner({
      args: [
        'task',
        'create',
        '--title',
        'Write the notes',
      ],
    })
    await page.shows({
      what: 'the task created after the restart',
      check: () => document.querySelector('.kanban')?.textContent?.includes('Write the notes'),
    })
    pnyx.claude.plan({
      text: 'And the notes?',
      reply: 'Notes are drafted.',
    })
    await page.click({ selector: '.hydra-chat textarea' })
    await page.type({ text: 'And the notes?' })
    await page.press({ key: 'Enter' })
    await settled({
      replies: [
        'Release plan: ship it on Friday.',
        'Notes are drafted.',
      ],
    })
    await page.close()
  },
)

test(
  'the composer completes a session command, turns a mention and attachments into cards, and Hydra gets them in one message',
  async () => {
    installFixtureSkill()
    const s = await pnyx.scenario()
    await s.owner({
      args: [
        'task',
        'create',
        '--title',
        'Ship the layout',
        '--key',
        'ship',
      ],
    })
    await s.owner({
      args: [
        'hydra',
        'send',
        '--text',
        'Hello',
        '--event-id',
        'hello',
      ],
    })
    await hydraFinished({
      s,
      turns: 1,
    })
    const page = await openHydra({ s })
    await page.click({ selector: '.hydra-chat textarea' })
    await page.type({ text: '/fixture-c' })
    await page.shows({
      what: 'the fixture skill among the grouped suggestions',
      check: () => [...document.querySelectorAll('.slash-menu [role=option]')]
        .find(o => o.querySelector('strong')?.textContent === '/fixture-cli'
          && document.querySelector('.slash-menu .picker-group')?.textContent === 'Global · .claude'),
    })
    await page.press({ key: 'ArrowDown' })
    await page.press({ key: 'Enter' })
    await page.shows({
      what: 'the skill badge in the draft',
      check: () => document.querySelector('.hydra-chat .draft-skill')?.textContent?.includes('/fixture-cli')
        && !document.querySelector('.slash-menu'),
    })

    await page.type({ text: 'what we chose for @layo' })
    await page.shows({
      what: 'the task in the mention menu',
      check: () => [...document.querySelectorAll('.mention-menu [role=option]')].map(o => o.textContent).join()
        .includes('Ship the layout'),
    })
    await page.press({ key: 'Enter' })
    await page.shows({
      what: 'the mention as a task chip',
      check: () => document.querySelector('.hydra-chat .draft-chip[data-kind=task]')?.textContent?.includes('Ship the layout')
        && !document.querySelector('.mention-menu'),
    })
    const tokenLooks = await page.shows({
      what: 'the composer token styles',
      check: () => [...document.querySelectorAll('.composer .draft-chip')].map(token => {
        const style = getComputedStyle(token)

        return {
          color: style.color,
          background: style.backgroundColor,
          shadow: style.boxShadow,
          padding: style.padding,
          font: style.fontFamily,
          size: style.fontSize,
          icons: [...token.querySelectorAll('.chip-icon svg')].map(icon => icon.innerHTML),
        }
      }),
    })

    await page.type({ text: 'and keep this. ' })
    const note = join(
      s.folder({ name: 'files' }),
      'note.txt',
    )
    writeFileSync(
      note,
      'Remember the grid.\n',
    )
    await page.upload({
      selector: '.hydra-chat input[type=file]',
      files: [
        join(
          import.meta.dirname,
          '../../web/public/favicon-16.png',
        ),
        note,
      ],
    })
    await page.shows({
      what: 'the file and the uploaded image as cards in the draft',
      check: () => {
        const cards = [...document.querySelectorAll('.hydra-chat .draft-card')]
        const thumb = document.querySelector<HTMLImageElement>('.hydra-chat .draft-card img')

        return cards.map(c => `${c.getAttribute('data-kind')} ${c.querySelector('.attachment-card')?.textContent}`).join() === 'file note.txt,image Image 1'
          && thumb?.complete && thumb.naturalWidth === 16
      },
    })
    await page.press({ key: 'Enter' })
    await page.shows({
      what: 'the sent message, with the draft emptied',
      check: () => {
        const mine = [...document.querySelectorAll('.hydra-chat .message.mine')].at(-1)

        return mine?.querySelector('.draft-skill')?.textContent?.includes('/fixture-cli') && mine.textContent?.includes('what we chose for') && mine.textContent.includes('Ship the layout')
          && mine.textContent.includes('Remember the grid.') && mine.querySelector('img')
          && !document.querySelector('.composer .draft-chip')
      },
    })
    const sentLooks = await page.shows({
      what: 'the same skill and task tokens in the sent message',
      check: () => {
        const mine = [...document.querySelectorAll('.message.mine')].at(-1)
        const tokens = [...(mine?.querySelectorAll('.draft-chip') ?? [])]

        return tokens.length === 2 && !mine?.querySelector('.skill-remove') && tokens.map(token => {
          const style = getComputedStyle(token)

          return {
            color: style.color,
            background: style.backgroundColor,
            shadow: style.boxShadow,
            padding: style.padding,
            font: style.fontFamily,
            size: style.fontSize,
            icons: [...token.querySelectorAll('.chip-icon svg')].map(icon => icon.innerHTML),
          }
        })
      },
    })
    assert.deepEqual(
      sentLooks,
      tokenLooks,
    )
    await page.shows({
      what: 'a wrapped task mention flows into the following words',
      check: () => {
        const mine = [...document.querySelectorAll('.message.mine')].at(-1)
        const task = mine?.querySelector('.draft-chip[data-kind=task]')
        const paragraph = task?.closest('p')

        if (!paragraph || !task) {
          return false
        }

        paragraph.style.width = '120px'
        const walker = document.createTreeWalker(
          paragraph,
          NodeFilter.SHOW_TEXT,
        )
        let after: Text | undefined

        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
          if (node.textContent?.includes('and keep this.')) {
            after = node as Text
          }
        }

        if (!after) {
          return false
        }

        const range = document.createRange()
        const start = after.data.indexOf('and')
        range.setStart(
          after,
          start,
        )
        range.setEnd(
          after,
          start + 3,
        )
        const rects = task.getClientRects()
        const last = rects[rects.length - 1]
        const afterTop = range.getBoundingClientRect().top
        const flows = rects.length > 1 && last && Math.abs(last.top - afterTop) < 4
        paragraph.style.removeProperty('width')

        return flows
      },
    })

    const agent = await hydraFinished({
      s,
      turns: 2,
    })

    for (const key of [
      'Enter',
      'Space',
    ] as const) {
      await page.click({ selector: '.hydra-head' })
      let reached = false
      const visited: string[] = []

      for (let tab = 0; tab < 20; tab++) {
        await page.press({ key: 'Tab' })
        const active = await page.shows({
          what: 'the keyboard navigation position',
          check: () => ({
            reached: document.activeElement?.matches('.message.mine .task-reference'),
            target: document.activeElement?.getAttribute('aria-label') ?? document.activeElement?.className,
          }),
        })

        visited.push(active.target ?? 'none')

        if (active.reached) {
          reached = true
          break
        }
      }

      assert.ok(
        reached,
        `Tab reaches the sent task mention: ${visited.join(' -> ')}`,
      )
      await page.press({ key })
      await page.shows({
        what: `${key} opens the sent task mention after ${visited.at(-1)}`,
        check: () => document.querySelector('.card-open[aria-label="Open task Ship the layout"]')?.getAttribute('aria-expanded') === 'true',
      })
      await page.click({ selector: '.card-open[aria-label="Open task Ship the layout"]' })
    }

    const sent = s.received({ cwd: agent.cwd }).at(-1)
    assert.ok(sent)
    assert.match(
      sent,
      /\n\n\/fixture-cli what we chose for /,
    )
    assert.ok(sent.includes('Ship the layout'))
    assert.ok(sent.includes('Remember the grid.'))
    assert.deepEqual(
      pnyx.claude.sessions.filter(session => session.cwd === agent.cwd)
        .flatMap(session => session.images),
      ['image/png'],
    )
    await page.close()
  },
)

test(
  'sent Codex skill mentions remain readable in literal HTML',
  async () => {
    installFixtureSkill()
    const s = await pnyx.scenario()
    await s.owner({
      args: [
        'rule',
        'set',
        'hydra',
        '--harness',
        'codex',
      ],
    })
    const text = 'Use $fixture-cli here <!-- $fixture-cli -->.\n\n<div>$fixture-cli</div>'
    await s.owner({
      args: [
        'hydra',
        'send',
        '--text',
        text,
      ],
    })
    await hydraFinished({
      s,
      turns: 1,
    })
    const page = await openHydra({ s })

    try {
      const rendered = await page.shows({
        what: 'the sent Codex message with its skill catalog loaded',
        check: () => {
          const mine = document.querySelector('.message.mine')

          return mine?.querySelector('.draft-skill') && {
            text: mine.textContent,
            badges: mine.querySelectorAll('.draft-skill').length,
            quotes: [...mine.querySelectorAll('.message-block')].map(block => block.getAttribute('data-quote')),
          }
        },
      })
      assert.doesNotMatch(
        rendered.text ?? '',
        /[\uE000\uE001]/,
      )
      assert.equal(
        rendered.badges,
        3,
      )
      assert.ok(rendered.text?.includes('<!--'))
      assert.ok(rendered.text?.includes('<div>'))
      assert.deepEqual(
        rendered.quotes,
        text.split('\n\n'),
      )
    } finally {
      await page.close()
    }
  },
)

const startedTask = async ({ s }: { s: Scenario }) => {
  const folder = s.folder({ name: 'web-app' })
  await s.owner({
    args: [
      'task',
      'create',
      '--title',
      'Ship the layout',
      '--key',
      'ship',
      '--folder',
      folder,
    ],
  })
  await s.owner({
    args: [
      'task',
      'start',
      'ship',
    ],
  })
  const worker = s.as({ agent: await s.agent({ cwd: folder }) })
  await until({
    what: 'the worker to finish its opening turn',
    check: () => s.task({ key: 'ship' }).sessionActivity === 'finished',
  })

  return {
    folder,
    worker,
  }
}

test(
  'task mentions in a question support arrow navigation and Escape to the composer',
  async () => {
    const s = await pnyx.scenario()
    await startedTask({ s })
    const task = s.task({ key: 'ship' })
    const hydra = s.as({ agent: await s.chat({ text: 'Review the layout' }) })
    await hydraFinished({
      s,
      turns: 1,
    })
    await hydra.run({
      args: [
        'task',
        'ask',
        'ship',
        '--to',
        'owner',
        '--question',
        'Keep the layout?',
        '--context',
        `[Ship the layout](pnyx-task:${task.id}) [Unavailable](pnyx-task:task-missing)`,
        '--choice',
        'Keep it',
      ],
    })
    const page = await openHydra({ s })

    try {
      await page.shows({
        what: 'the completed reply and question have settled in the chat',
        check: () => {
          const stream = document.querySelector('.hydra-chat .hydra-messages')
          const reply = document.querySelector('.hydra-chat .message[aria-label="Hydra"]')

          return reply?.textContent?.includes('Recorded reply.') && !reply.hasAttribute('data-streaming')
            && stream && stream.scrollHeight - stream.clientHeight - stream.scrollTop < 1
        },
      })
      await page.click({ selector: '.hydra-chat .chat-decision .ask-option-pick' })
      await page.shows({
        what: 'the chosen answer owns focus before question navigation',
        check: () => document.activeElement?.matches('.hydra-chat .ask-option-pick[aria-pressed=true]'),
      })
      await page.press({ key: 'ArrowUp' })
      await page.shows({
        what: 'Up reaches the available task mention and skips the unavailable one',
        arg: { id: task.id },
        check: ({ id }) => document.activeElement?.matches(`.hydra-chat .ask .task-reference[data-task-ref="${id}"]`),
      })
      await page.press({ key: 'ArrowDown' })
      await page.shows({
        what: 'Down returns from the task mention to the answer choice',
        check: () => document.activeElement?.matches('.hydra-chat .ask-option-pick'),
      })
      await page.press({ key: 'ArrowUp' })
      await page.press({ key: 'Escape' })
      await page.shows({
        what: 'Escape from the task mention returns to the composer without sending the answer',
        check: () => document.activeElement?.matches('.hydra-chat .composer textarea')
          && document.querySelector('.hydra-chat .ask-option-pick[aria-pressed=true]'),
      })
      await page.type({ text: 'draft' })
      await page.press({ key: 'ArrowUp' })
      await page.shows({
        what: 'Up within a draft stays in the composer and reaches its start',
        check: () => {
          const input = document.activeElement

          return input instanceof HTMLTextAreaElement && input.matches('.hydra-chat .composer textarea')
            && input.value === 'draft' && input.selectionStart === 0
        },
      })
      await page.press({ key: 'ArrowUp' })
      await page.shows({
        what: 'Up at the draft start reaches the waiting row without changing the answer',
        check: () => document.activeElement?.matches('.waiting-decisions > .popover > button')
          && document.querySelector('.hydra-chat .ask-option-pick[aria-pressed=true]'),
      })
      await page.press({ key: 'ArrowDown' })
      await page.shows({
        what: 'Down returns from the waiting row to the unchanged draft',
        check: () => {
          const input = document.activeElement

          return input instanceof HTMLTextAreaElement && input.matches('.hydra-chat .composer textarea')
            && input.value === 'draft'
        },
      })
    } finally {
      await page.close()
    }
  },
)

test(
  'opening a card shows its Updates in place and they follow the worker live, newest first, until it closes',
  async () => {
    const s = await pnyx.scenario()
    const { worker } = await startedTask({ s })
    const page = await openHydra({ s })
    const card = '.card-open[aria-label="Open task Ship the layout"]'
    const closed = await page.shows({
      what: 'the closed card',
      arg: { card },
      check: ({ card }) => {
        const title = document.querySelector(card)
        const box = title?.closest('.card')?.getBoundingClientRect()

        return title?.getAttribute('aria-expanded') === 'false' && !document.querySelector('.task-updates') && box && { top: box.top }
      },
    })
    await page.click({ selector: card })
    // Once no double-click rename follows, the keyboard lands in the Updates.
    await page.shows({
      what: 'the card open on its focused Updates',
      arg: { card },
      check: ({ card }) => {
        const expanded = document.querySelector(card)?.getAttribute('aria-expanded') === 'true'
        const updates = document.querySelector<HTMLElement>('.task-updates')
        const rows = updates?.innerText ?? ''

        return expanded && rows.includes('Moved to In progress') && rows.includes('Worker started') && document.activeElement === updates
      },
    })

    await worker.run({
      args: [
        'hydra',
        'send',
        '--task',
        'ship',
        '--text',
        'The grid is done; the header is next.',
      ],
    })
    // By now the opened card has long finished aligning, so its place is settled.
    const settled = await page.shows({
      what: 'the report on top, folded',
      arg: { card },
      check: ({ card }) => {
        const fold = document.querySelector<HTMLDetailsElement>('.task-updates > ol > li:first-child details.report-fold')
        const box = document.querySelector(card)?.closest('.card')
          ?.getBoundingClientRect()
        const folded = fold && !fold.open && fold.innerText.includes('Reported to Hydra') && !fold.innerText.includes('the header is next')

        return folded && box && { top: box.top }
      },
    })
    assert.deepEqual(
      settled,
      closed,
      'the card opened where it was',
    )
    await page.click({ selector: '.task-updates details.report-fold > summary' })
    await page.shows({
      what: 'the report opened',
      check: () => document.querySelector<HTMLElement>('.task-updates details.report-fold')?.innerText.includes('The grid is done; the header is next.'),
    })

    await worker.run({
      args: [
        'task',
        'status',
        'ship',
        'working',
        '--note',
        'Styling the header',
      ],
    })
    const newest = await page.shows({
      what: 'the new declaration on top',
      check: () => {
        const groups = new Map<string, string[]>()

        for (const row of document.querySelectorAll<HTMLElement>('.task-updates > ol > li:not([hidden])')) {
          const key = row.dataset.updateGroup!
          groups.set(
            key,
            [
              ...(groups.get(key) ?? []),
              row.innerText,
            ],
          )
        }

        const shown = [...groups.values()].map(parts => parts.join('\n'))

        return shown[0]?.includes('Styling the header') && shown
      },
    })
    await page.click({ selector: '.updates-order' })
    await page.shows({
      what: 'the same Updates oldest first',
      arg: { newest },
      check: ({ newest }) => {
        const groups = new Map<string, string[]>()

        for (const row of document.querySelectorAll<HTMLElement>('.task-updates > ol > li:not([hidden])')) {
          const key = row.dataset.updateGroup!
          groups.set(
            key,
            [
              ...(groups.get(key) ?? []),
              row.innerText,
            ],
          )
        }

        const shown = [...groups.values()].map(parts => parts.join('\n'))

        return document.querySelector('.updates-order')?.textContent?.startsWith('Oldest first')
          && JSON.stringify(shown) === JSON.stringify([...newest].reverse())
      },
    })

    await page.click({ selector: card })
    await page.shows({
      what: 'the card closed again',
      arg: { card },
      check: ({ card }) => document.querySelector(card)?.getAttribute('aria-expanded') === 'false'
        && !document.querySelector('.task-updates'),
    })
    await page.close()
  },
)

test(
  'the owner answers an escalated question from its card; the worker gets the answer once and it stays answered after a restart',
  async () => {
    const s = await pnyx.scenario()
    const {
      folder,
      worker,
    } = await startedTask({ s })
    const taskId = s.task({ key: 'ship' }).id
    const asked = await worker.run({
      args: [
        'task',
        'ask',
        'ship',
        '--question',
        'Delete the legacy theme?',
        '--choice',
        'Delete',
        '--choice',
        'Keep',
      ],
    })
    const id = /^ask: (\S+)$/m.exec(asked)?.[1]
    assert.ok(
      id,
      asked,
    )
    await s.as({ agent: await s.agent({ hydra: true }) }).run({
      args: [
        'task',
        'escalate',
        'ship',
        id,
        '--question',
        'Can the legacy theme go?',
        '--reason',
        'it is user-visible',
      ],
    })
    const page = await openHydra({ s })
    await page.shows({
      what: 'the question on its card in Needs you, and waiting in the chat',
      check: () => {
        const card = document.querySelector('.column-needs_you .card-question')?.textContent ?? ''

        return card.includes('Can the legacy theme go?') && document.querySelector('.waiting-decisions')
      },
    })
    // A long later reply scrolls the question out of the chat; the waiting line brings it back.
    pnyx.claude.plan({
      text: 'What else is open?',
      reply: Array.from(
        { length: 40 },
        (
          _,
          n,
        ) => `- Open item ${n + 1}`,
      ).join('\n'),
    })
    await s.owner({
      args: [
        'hydra',
        'send',
        '--text',
        'What else is open?',
        '--event-id',
        'open-items',
      ],
    })
    const question = `[data-entry-id="ask:${taskId}:${id}"] .ask`
    await page.shows({
      what: 'the question scrolled away under the long reply',
      arg: { question },
      check: ({ question }) => {
        const asked = document.querySelector(question)?.getBoundingClientRect()
        const view = document.querySelector('.hydra-messages')?.getBoundingClientRect()
        const replied = document.querySelector('.hydra-chat .messages')?.textContent?.includes('Open item 40')

        return replied && asked && view && asked.bottom < view.top
      },
    })
    await page.click({ selector: '.waiting-decisions button' })
    await page.click({ selector: '[aria-label="Items waiting on you"] button' })
    await page.shows({
      what: 'the question back in view in the chat',
      arg: { question },
      check: ({ question }) => {
        const asked = document.querySelector(question)?.getBoundingClientRect()
        const view = document.querySelector('.hydra-messages')?.getBoundingClientRect()

        return asked && view && asked.top >= view.top && asked.bottom <= view.bottom
      },
    })
    await page.click({
      selector: '.card-question button',
      text: 'Answer',
    })
    await page.shows({
      what: 'the card open with its question focused',
      check: () => document.activeElement?.closest('.card .ask'),
    })
    await page.click({
      selector: '.card .ask-option button[aria-label="Choose Keep"]',
    })
    await page.click({ selector: '.card .ask textarea' })
    await page.type({ text: 'Keep it for one more release' })
    await page.click({
      selector: '.card .ask button',
      text: 'Send answer',
    })
    const answered = ({ tab }: { tab: typeof page }) => tab.shows({
      what: 'the question answered everywhere on the page',
      check: () => {
        const decided = document.querySelector('.hydra-chat .chat-decision .decided')?.textContent ?? ''
        const waiting = document.querySelector('.card-question, .waiting-decisions, .column-needs_you .card')

        return !waiting && decided.includes('Can the legacy theme go?')
      },
    })
    await answered({ tab: page })
    const answers = () => s.received({ cwd: folder }).filter(text => text.includes('Keep it for one more release'))
    await until({
      what: 'the worker to get the answer',
      check: () => answers().length === 1,
    })
    assert.equal(
      answers()[0],
      `Answer from the owner to your question ${id}: Delete the legacy theme?\nChoice: Keep\nKeep it for one more release`,
    )

    await pnyx.restart()
    await answered({ tab: page })
    await page.close()
    const reopened = await openHydra({ s })
    await answered({ tab: reopened })
    await reopened.close()
    // A later message reaching the worker shows nothing was sent again before it.
    await s.owner({
      args: [
        'reply',
        'ship',
        '--text',
        'Carry on with the header',
      ],
    })
    await until({
      what: 'the worker to get the later message',
      check: () => s.received({ cwd: folder }).some(text => text.includes('Carry on with the header')),
    })
    assert.equal(
      answers().length,
      1,
    )
  },
)
