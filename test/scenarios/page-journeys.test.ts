import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { HYDRA_CARD } from '../../src/core/hydra.ts'
import { browserGroup } from './browser.ts'
import { scenarioGroup, until } from './harness.ts'

// The owner's own journeys on the built page, in one headless Chrome against one Pnyx.
const pnyx = scenarioGroup()
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
    // The catalog lists the skills in Hydra's own folder once its session has one.
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
      what: 'Hydra’s own skill among the matching session commands',
      check: () => [...document.querySelectorAll('.slash-menu [role=option]')]
        .find(o => o.querySelector('strong')?.textContent === '/inscribe' && o.querySelector('small')?.textContent === 'Project skill'),
    })
    await page.press({ key: 'ArrowDown' })
    await page.press({ key: 'Enter' })
    await page.shows({
      what: 'the command in the draft',
      check: () => (document.querySelector('.hydra-chat textarea') as HTMLTextAreaElement | null)?.value === '/inscribe '
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

        return mine?.textContent?.includes('/inscribe what we chose for') && mine.textContent.includes('Ship the layout')
          && mine.textContent.includes('Remember the grid.') && mine.querySelector('img')
          && !document.querySelector('.hydra-chat .draft-chip')
      },
    })
    const agent = await hydraFinished({
      s,
      turns: 2,
    })
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
          && expanded.querySelector('button.task-reference')?.textContent?.includes('Reference task')
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
