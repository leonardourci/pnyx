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
    await page.type({ text: '/ins' })
    await page.shows({
      what: 'Hydra’s own skill among the grouped suggestions',
      check: () => [...document.querySelectorAll('.slash-menu [role=option]')]
        .find(o => o.querySelector('strong')?.textContent === '/inscribe'
          && document.querySelector('.slash-menu .picker-group')?.textContent === 'Pnyx Hydra'),
    })
    await page.press({ key: 'ArrowDown' })
    await page.press({ key: 'Enter' })
    await page.shows({
      what: 'the skill badge in the draft',
      check: () => document.querySelector('.hydra-chat .draft-skill')?.textContent?.includes('/inscribe')
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

        return mine?.querySelector('.draft-skill')?.textContent?.includes('/inscribe') && mine.textContent?.includes('what we chose for') && mine.textContent.includes('Ship the layout')
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
      /\n\n\/inscribe what we chose for /,
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

for (const harness of [
  'claude',
  'codex',
]) {
  test(
    `sent ${harness} skill mentions follow native boundaries and survive a reload`,
    async () => {
      const s = await pnyx.scenario()
      await s.owner({
        args: [
          'rule',
          'set',
          'hydra',
          '--harness',
          harness,
        ],
      })
      const text = harness === 'codex'
        ? 'Please ($inscribe), then `$inscribe` and\n\n```text\n$inscribe\n```\n\n$not-a-known-skill stays literal.\n\n[Skill documentation](https://example.com/$inscribe)\n\n[$inscribe]\n\n[$inscribe]: https://example.com/guide'
        : '/inscribe first, then /inscribe safely. /inscribe, and /not-a-known-skill stay literal.\n\n**prefix**/inscribe and **/inscribe** safely. [link](/inscribe) [**/inscribe**](https://example.com). `/inscribe` and\n\n```text\n/inscribe\n```'
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

      for (let load = 0; load < 2; load++) {
        const page = await openHydra({ s })
        await page.shows({
          what: 'known skill badges and literal unknown names',
          arg: { harness },
          check: ({ harness }) => {
            const mine = document.querySelector('.message.mine')

            return mine?.querySelectorAll('.draft-skill').length === (harness === 'codex' ? 4 : 2)
            && mine.textContent?.includes('not-a-known-skill')
            && !mine.querySelector('.skill-remove')
            && (harness !== 'codex' || mine.querySelector('code .draft-skill'))
            && (harness !== 'claude' || !mine.querySelector('strong .draft-skill, a .draft-skill, code .draft-skill'))
          },
        })

        if (harness === 'codex') {
          const href = await page.shows({
            what: 'the skill documentation link destination',
            check: () => document.querySelector<HTMLAnchorElement>('.message.mine a')?.href,
          })
          assert.equal(
            href,
            'https://example.com/$inscribe',
          )
          await page.shows({
            what: 'the reference-style skill link',
            check: () => document.querySelector('.message.mine a[href="https://example.com/guide"] .draft-skill'),
          })
        }

        await page.close()
      }
    },
  )
}

test(
  'sent Codex skill mentions remain readable in literal HTML',
  async () => {
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
    const text = 'Use $inscribe here <!-- $inscribe -->.\n\n<div>$inscribe</div>'
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

for (const harness of [
  'claude',
  'codex',
]) {
  test(
    `a ${harness} project skill keeps its saved label color after sending and reloading`,
    async () => {
      const s = await pnyx.scenario()
      await s.owner({
        args: [
          'rule',
          'set',
          'hydra',
          '--harness',
          harness,
        ],
      })
      const project = await s.project({ name: 'Release tools' })
      const skill = join(
        project,
        '.agents/skills/deploy',
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
        '---\nname: deploy\ndescription: Deploy the release\n---\nDeploy safely.\n',
      )
      await s.owner({
        args: [
          'task',
          'create',
          '--title',
          'Release',
          '--project',
          project,
        ],
      })
      const savedColor = s.state().labelColors?.find(entry => entry.label === project)?.color
      assert.ok(
        savedColor,
        'the project has a persisted label color',
      )
      let page = await openHydra({ s })
      await page.click({ selector: '.hydra-chat textarea' })
      await page.type({ text: '/deploy' })
      await page.shows({
        what: 'the project skill suggestion',
        check: () => [...document.querySelectorAll('.slash-menu [role=option]')].find(option => option.textContent?.includes('Deploy the release')),
      })
      await page.press({ key: 'ArrowDown' })
      await page.press({ key: 'Enter' })
      const draft = await page.shows({
        what: 'the project label in the draft',
        check: () => {
          const label = document.querySelector('.composer .draft-skill .project-label')

          return label && {
            text: label.textContent,
            color: label.getAttribute('data-label-color'),
            ink: getComputedStyle(label).color,
          }
        },
      })
      assert.equal(
        draft.color,
        savedColor,
      )
      assert.match(
        draft.text?.replaceAll(
          '\u2060',
          '',
        ) ?? '',
        /Release tools/,
      )
      await page.type({ text: 'safely' })
      await page.press({ key: 'Enter' })
      await hydraFinished({
        s,
        turns: 1,
      })

      for (let load = 0; load < 2; load++) {
        const sent = await page.shows({
          what: 'the saved project label in the sent message',
          check: () => {
            const label = document.querySelector('.message.mine .draft-skill .project-label')

            return label && {
              text: label.textContent,
              color: label.getAttribute('data-label-color'),
              ink: getComputedStyle(label).color,
            }
          },
        })
        assert.deepEqual(
          sent,
          draft,
        )
        await page.close()

        if (load === 0) {
          page = await openHydra({ s })
        }
      }
    },
  )
}

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
      await page.click({ selector: '.hydra-chat .chat-decision .ask-option-pick' })
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
        // What the owner sees in each row: a closed fold shows only its summary.
        const shown = [...document.querySelectorAll<HTMLElement>('.task-updates > ol > li')].map(row => row.innerText)

        return shown[0]?.includes('Styling the header') && shown
      },
    })
    await page.click({ selector: '.updates-order' })
    await page.shows({
      what: 'the same Updates oldest first',
      arg: { newest },
      check: ({ newest }) => {
        const shown = [...document.querySelectorAll<HTMLElement>('.task-updates > ol > li')].map(row => row.innerText)

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

test(
  'card Markdown stays compact, expands on demand and keeps option links independent of selection',
  async () => {
    const s = await pnyx.scenario()
    const { worker } = await startedTask({ s })
    await s.owner({
      args: [
        'task',
        'create',
        '--title',
        'Reference task',
        '--key',
        'reference',
      ],
    })
    const reference = s.task({ key: 'reference' })
    const task = s.task({ key: 'ship' })
    const card = `.card[data-task="${task.id}"]`
    const markdown = `**Ready for review**

- First item
- Second item

\`\`\`sh
pnpm run lint
\`\`\`

| Check | Result |
| --- | --- |
| Layout | Ready |

[Reference task](pnyx-task:${reference.id})

End of the long update.`
    await s.owner({
      args: [
        'task',
        'brief',
        'ship',
        '--brief',
        markdown,
      ],
    })
    await worker.run({
      args: [
        'task',
        'status',
        'ship',
        'working',
        '--note',
        markdown,
      ],
    })
    const page = await openHydra({ s })
    await page.click({ selector: '.card-open[aria-label="Open task Ship the layout"]' })
    await page.shows({
      what: 'formatted update clamped to three compact lines',
      arg: { card },
      check: ({ card }) => {
        const row = [...document.querySelectorAll(`${card} .update-line`)]
          .find(row => row.querySelector('strong')?.textContent === 'Ready for review')
        const preview = row?.querySelector<HTMLElement>('.text-preview')

        return preview && preview.scrollHeight > preview.clientHeight
          && getComputedStyle(preview.querySelector('.markdown')!).fontSize === '12px'
          && row?.querySelector('.show-more')?.getAttribute('aria-expanded') === 'false'
      },
    })
    await page.click({ selector: `${card} .update-line .show-more` })
    await page.shows({
      what: 'the full Markdown update after Show more',
      arg: { card },
      check: ({ card }) => {
        const expanded = document.querySelector(`${card} .update-line .show-more[aria-expanded=true]`)?.parentElement

        return expanded?.querySelector('li')?.textContent === 'First item'
          && expanded.querySelector('pre code')?.textContent?.includes('pnpm run lint')
          && expanded.querySelector('td')?.textContent === 'Layout'
          && expanded.querySelector('[role=button].task-reference')?.textContent?.includes('Reference task')
          && !expanded.querySelector('.text-preview')
      },
    })
    await page.click({ selector: `${card} .update-line .show-more` })
    await page.shows({
      what: 'Show less restores the preview',
      arg: { card },
      check: ({ card }) => document.querySelector(`${card} .update-line .text-preview`)
        && document.querySelector(`${card} .update-line .show-more`)?.getAttribute('aria-expanded') === 'false',
    })
    await page.click({
      selector: `${card} .disclosure > summary`,
      text: "Hydra's build instructions",
    })
    await page.shows({
      what: 'the build instructions formatted as Markdown',
      arg: { card },
      check: ({ card }) => document.querySelector(`${card} .disclosure[open] .markdown strong`)?.textContent === 'Ready for review',
    })
    const asked = await worker.run({
      args: [
        'task',
        'ask',
        'ship',
        '--question',
        '**Keep** this approach?',
        '--context',
        markdown,
        '--choice',
        '**Keep**: Preserve the existing layout',
        '--choice',
        `Review: [Reference task](pnyx-task:${reference.id})`,
        '--recommend',
        '1',
      ],
    })
    const question = /^ask: (\S+)$/m.exec(asked)?.[1]
    assert.ok(
      question,
      asked,
    )
    await s.as({ agent: await s.agent({ hydra: true }) }).run({
      args: [
        'task',
        'escalate',
        'ship',
        question,
        '--reason',
        'Owner decision',
      ],
    })
    await page.shows({
      what: 'formatted question and option with its accessible description',
      arg: { card },
      check: ({ card }) => {
        const option = document.querySelector(`${card} .ask-option`)
        const pick = option?.querySelector('.ask-option-pick')
        const description = document.getElementById(pick?.getAttribute('aria-describedby') ?? '')

        return document.querySelector(`${card} .ask-headline strong`)?.textContent === 'Keep'
          && option?.querySelector('.ask-label strong')?.textContent === 'Keep'
          && description?.textContent?.includes('Recommended') && description.textContent.includes('Preserve the existing layout')
          && !document.querySelector('button button, button a')
      },
    })
    await page.click({
      selector: `${card} .ask-option`,
      text: 'Keep',
    })
    await page.shows({
      what: 'clicking the option row selects it',
      arg: { card },
      check: ({ card }) => document.querySelector(`${card} .ask-option-pick`)?.getAttribute('aria-pressed') === 'true',
    })
    await page.press({ key: 'Enter' })
    await page.shows({
      what: 'keyboard activation toggles the focused option',
      arg: { card },
      check: ({ card }) => document.querySelector(`${card} .ask-option-pick`)?.getAttribute('aria-pressed') === 'false',
    })
    await page.click({ selector: `${card} .ask-option .task-reference` })
    await page.shows({
      what: 'the option reference opens its task',
      check: () => document.querySelector('.card-open[aria-label="Open task Reference task"]')?.getAttribute('aria-expanded') === 'true',
    })
    await page.shows({
      what: 'following the reference did not select the option',
      arg: { card },
      check: ({ card }) => document.querySelector(`${card} .ask-option-pick`)?.getAttribute('aria-pressed') === 'false',
    })
    await page.click({ selector: `${card} .ask-option-pick[aria-label="Choose Keep"]` })
    await page.click({ selector: `${card} .ask textarea` })
    await page.type({ text: '**Approved** with `coverage`' })
    await page.click({
      selector: `${card} .ask button`,
      text: 'Send answer',
    })
    await page.shows({
      what: 'the recorded decision renders the Markdown answer',
      arg: { card },
      check: ({ card }) => [...document.querySelectorAll(`${card} .decision-answer-text strong`)]
        .some(element => element.textContent === 'Approved'),
    })
    await page.close()
  },
)

test(
  'Waiting on you lists each owner item, opens permissions, and removes only the item answered',
  async () => {
    const s = await pnyx.scenario()
    const {
      folder,
      worker,
    } = await startedTask({ s })
    const hydra = s.as({ agent: await s.chat({ text: 'Review the layout choices' }) })

    for (const question of [
      'Keep the compact layout?',
      'Ship the new theme?',
    ]) {
      await hydra.run({
        args: [
          'task',
          'ask',
          'ship',
          '--to',
          'owner',
          '--question',
          question,
        ],
      })
    }

    await worker.run({
      args: [
        'task',
        'ask',
        'ship',
        '--to',
        'hydra',
        '--question',
        'Which file should I edit?',
      ],
    })
    await s.owner({
      args: [
        'task',
        'create',
        '--key',
        'palette',
        '--title',
        'Polish the palette',
      ],
    })
    const palette = s.task({ key: 'palette' }).id
    await s.owner({
      args: [
        'push',
        '--key',
        'palette',
        '--file',
        '-',
      ],
      input: JSON.stringify({
        attention: [
          {
            key: 'fixture:question',
            kind: 'question',
            blocking: true,
            text: 'Which preview should stay?',
          },
        ],
      }),
    })
    const agent = await s.agent({ cwd: folder })
    assert.ok(agent.useTool)
    const permission = agent.useTool({
      tool: 'Bash',
      input: { command: 'echo preview' },
    })
    await until({
      what: 'the pending permission',
      check: () => s.task({ key: 'ship' }).permissions?.find(item => item.status === 'pending'),
    })
    const page = await openHydra({ s })
    await page.click({ selector: '.waiting-decisions > .popover > button' })
    await page.shows({
      what: 'one row per owner question, permission and prompt above the composer',
      check: () => {
        const strip = document.querySelector('.waiting-decisions')
        const rows = [...strip?.querySelectorAll('li') ?? []].map(row => row.textContent)
        const composer = document.querySelector('.hydra-chat .composer')

        return rows.length === 4 && rows[0]?.includes('Keep the compact layout?')
          && rows[1]?.includes('Ship the new theme?') && rows[2]?.includes('Allow Bash?')
          && rows[3]?.includes('Which preview should stay?')
          && strip?.textContent?.includes('Waiting on you')
          && composer
          && strip.getBoundingClientRect().bottom <= composer.getBoundingClientRect().top
      },
    })
    await page.click({
      selector: '.waiting-decisions button',
      text: 'Allow Bash?',
    })
    await page.shows({
      what: 'the permission on its open task',
      check: () => document.querySelector('.card .ask[aria-label="Tool permission"]'),
    })
    await page.click({
      selector: '.card .ask button',
      text: 'Allow',
    })
    await permission
    await page.click({ selector: '.waiting-decisions > .popover > button' })
    await page.shows({
      what: 'only the permission removed from the strip',
      check: () => {
        const rows = [...document.querySelectorAll('.waiting-decisions li')]

        return rows.length === 3 && rows.every(row => !row.textContent?.includes('Allow Bash?'))
      },
    })
    await page.click({
      selector: '.waiting-decisions button',
      text: 'Which preview should stay?',
    })
    await page.shows({
      what: 'the second task opens with its own prompt',
      arg: { palette },
      check: ({ palette }) => {
        const card = document.querySelector(`[data-task="${palette}"].selected`)

        return card?.textContent?.includes('Polish the palette')
          && card.textContent.includes('Which preview should stay?')
      },
    })
    await s.owner({
      args: [
        'push',
        '--key',
        'palette',
        '--file',
        '-',
      ],
      input: JSON.stringify({ attention: [] }),
    })
    const questions = s.task({ key: 'ship' }).asks!.filter(ask => ask.audience === 'owner')

    await page.shows({
      what: 'only the two owner questions remain after clearing the prompt',
      check: () => document.querySelector('.waiting-decisions button')?.textContent?.includes('Waiting on you · 2'),
    })
    await page.click({ selector: '.waiting-decisions > .popover > button' })
    await page.shows({
      what: 'both owner questions visible before answering either',
      check: () => document.querySelectorAll('.waiting-decisions li').length === 2,
    })

    for (const ask of questions) {
      await s.owner({
        args: [
          'task',
          'answer',
          'ship',
          ask.id,
          '--text',
          'Yes',
        ],
      })

      if (ask.id === questions[0].id) {
        await page.shows({
          what: 'answering one owner question leaves the other listed',
          check: () => {
            const rows = [...document.querySelectorAll('.waiting-decisions li')]

            return rows.length === 1 && rows[0].textContent?.includes('Ship the new theme?')
              && !rows[0].textContent?.includes('Keep the compact layout?')
          },
        })
      }
    }

    await page.shows({
      what: 'no strip remains when only Hydra’s question is open',
      check: () => !document.querySelector('.waiting-decisions'),
    })
    await page.close()
  },
)

test(
  'Waiting on you supports the composer, chat caret, picker and every question control',
  async () => {
    const s = await pnyx.scenario()
    await startedTask({ s })
    const hydra = s.as({ agent: await s.chat({ text: 'Review the release' }) })
    await hydra.run({
      args: [
        'task',
        'ask',
        'ship',
        '--to',
        'owner',
        '--question',
        'Keep the compact layout?',
        '--context',
        'Choose the spacing for the release.',
        '--details',
        'The compact layout fits narrow screens.',
        '--choice',
        'Keep compact',
        '--choice',
        'Use roomy',
      ],
    })
    await hydra.run({
      args: [
        'task',
        'ask',
        'ship',
        '--to',
        'owner',
        '--question',
        'Publish the theme?',
      ],
    })
    const page = await openHydra({ s })
    await page.shows({
      what: 'both questions available in the waiting row',
      check: () => document.querySelector('.waiting-decisions button')?.textContent?.includes('Waiting on you · 2'),
    })
    await page.click({ selector: '.hydra-chat .composer textarea' })
    await page.press({ key: 'ArrowUp' })
    await page.shows({
      what: 'the row focused without opening its picker',
      check: () => document.activeElement?.matches('.waiting-decisions > .popover > button')
      && document.activeElement.getAttribute('aria-expanded') === 'false',
    })
    await page.press({ key: 'ArrowUp' })
    await page.shows({
      what: 'a second Up enters the chat caret without opening a picker',
      check: () => document.activeElement?.matches('.hydra-chat .messages')
      && !document.querySelector('.waiting-decisions [popover]') && !!window.getSelection()?.focusNode,
    })
    await page.click({ selector: '.hydra-chat .composer textarea' })
    await page.press({ key: 'ArrowUp' })
    await page.press({ key: 'Tab' })
    await page.shows({
      what: 'Tab opens an anchored picker and focuses its first question',
      check: () => document.activeElement?.matches('.waiting-decisions li button')
      && document.activeElement.textContent?.includes('Keep the compact layout?')
      && document.querySelector('.waiting-decisions [popover]:popover-open'),
    })
    await page.press({ key: 'ArrowDown' })
    await page.shows({
      what: 'Down reaches the next question',
      check: () => document.activeElement?.textContent?.includes('Publish the theme?'),
    })
    await page.press({ key: 'ArrowDown' })
    await page.shows({
      what: 'Down past the picker returns to the composer',
      check: () => document.activeElement?.matches('.hydra-chat .composer textarea'),
    })
    await page.press({ key: 'ArrowUp' })
    await page.press({ key: 'Enter' })
    await page.press({ key: 'Enter' })
    await page.shows({
      what: 'Enter on the first question reaches its first answer option',
      check: () => document.activeElement?.matches('.hydra-chat .ask-option-pick')
      && document.activeElement.getAttribute('aria-label')?.includes('Keep compact'),
    })
    await page.press({ key: 'ArrowUp' })
    await page.shows({
      what: 'Up leaves the choice for the question context caret',
      check: () => document.activeElement?.matches('.hydra-chat .messages')
      && window.getSelection()?.focusNode?.textContent?.includes('Choose the spacing'),
    })
    await page.press({ key: 'ArrowUp' })
    await page.shows({
      what: 'the caret moves freely through the question headline',
      check: () => window.getSelection()?.focusNode?.textContent?.includes('Keep the compact layout?'),
    })
    await page.press({ key: 'ArrowDown' })
    await page.press({ key: 'ArrowDown' })
    await page.shows({
      what: 'Down returns from question text to the first choice',
      check: () => document.activeElement?.matches('.hydra-chat .ask-option-pick')
      && document.activeElement.getAttribute('aria-label')?.includes('Keep compact'),
    })
    await page.press({ key: 'ArrowDown' })
    await page.shows({
      what: 'Down enters the first choice label as text',
      check: () => document.activeElement?.matches('.hydra-chat .messages')
        && window.getSelection()?.focusNode?.textContent?.includes('Keep compact'),
    })
    await page.press({ key: 'ArrowDown' })
    await page.shows({
      what: 'Down reaches the adjacent second choice',
      check: () => document.activeElement?.matches('.hydra-chat .ask-option-pick')
        && document.activeElement.getAttribute('aria-label')?.includes('Use roomy'),
    })
    await page.press({ key: 'Enter' })
    await page.press({ key: 'ArrowDown' })
    await page.shows({
      what: 'Down enters the selected choice label as text',
      check: () => document.activeElement?.matches('.hydra-chat .messages')
        && window.getSelection()?.focusNode?.textContent?.includes('Use roomy'),
    })
    await page.press({ key: 'ArrowDown' })
    await page.shows({
      what: 'Down enters the optional note',
      check: () => document.activeElement?.matches('.hydra-chat .ask textarea'),
    })
    await page.type({ text: 'Keep this layout\nwith a note' })
    await page.press({ key: 'ArrowUp' })
    await page.shows({
      what: 'Up within a multiline note keeps editing the note',
      check: () => document.activeElement?.matches('.hydra-chat .ask textarea')
      && (document.activeElement as HTMLTextAreaElement).selectionStart < 'Keep this layout\n'.length,
    })
    await page.press({ key: 'ArrowUp' })
    await page.shows({
      what: 'Up past the note reaches the selected choice label',
      check: () => document.activeElement?.matches('.hydra-chat .messages')
        && window.getSelection()?.focusNode?.textContent?.includes('Use roomy'),
    })
    await page.press({ key: 'ArrowUp' })
    await page.shows({
      what: 'Up from the label returns to the selected option',
      check: () => document.activeElement?.matches('.hydra-chat .ask-option-pick[aria-pressed=true]'),
    })
    await page.press({ key: 'ArrowDown' })
    await page.press({ key: 'ArrowDown' })
    await page.shows({
      what: 'the note retains the draft and can be left from its last line',
      check: () => {
        const input = document.activeElement as HTMLTextAreaElement

        if (!input.matches('.hydra-chat .ask textarea')) {
          return false
        }

        input.setSelectionRange(
          input.value.length,
          input.value.length,
        )

        return input.value === 'Keep this layout\nwith a note'
      },
    })
    await page.press({ key: 'ArrowDown' })
    await page.shows({
      what: 'Down reaches the details disclosure',
      check: () => document.activeElement?.matches('.hydra-chat .decision-details summary'),
    })
    await page.press({ key: 'Enter' })
    await page.shows({
      what: 'Enter opens the details disclosure',
      check: () => document.activeElement?.closest('details')?.open,
    })
    await page.press({ key: 'ArrowDown' })
    await page.shows({
      what: 'Down enters the expanded details as text',
      check: () => document.activeElement?.matches('.hydra-chat .messages')
      && window.getSelection()?.focusNode?.textContent?.includes('fits narrow screens'),
    })
    await page.press({ key: 'ArrowUp' })
    await page.shows({
      what: 'Up leaves the details for their disclosure control',
      check: () => document.activeElement?.matches('.hydra-chat .decision-details summary'),
    })
    await page.press({ key: 'Enter' })
    await page.press({ key: 'ArrowDown' })
    await page.press({ key: 'ArrowDown' })
    await page.shows({
      what: 'Down passes closed details and reaches Send answer',
      check: () => document.activeElement?.matches('.hydra-chat .pending-decision-actions button'),
    })
    await page.press({ key: 'Escape' })
    await page.shows({
      what: 'Escape leaves an open question without submitting its draft',
      check: () => document.activeElement?.matches('.hydra-chat .composer textarea')
      && document.querySelector('.hydra-chat .ask-option-pick[aria-pressed=true]'),
    })
    await page.close()
  },
)
