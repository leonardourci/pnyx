/* eslint-disable pnyx/object-params -- Playwright owns evaluation callback signatures. */
import { beforeAll, expect, test } from 'vitest'
import { MOTION_CSS_EASING, MOTION_DURATIONS, motionDuration } from '../../web/src/shared/motion.ts'
import { openHydra } from '../setup/browser.ts'
import { startPnyx, until, type Pnyx } from '../setup/pnyx.ts'

const SAMPLE_FRAMES = 60
let pnyx: Pnyx
beforeAll(async () => {
  pnyx = await startPnyx({ zeroCache: true })
})

test(
  'the global off switch and OS reduced motion make CSS and TypeScript motion instant',
  async () => {
    const hydra = await pnyx.hydra()
    pnyx.claude.plan({
      hydra: hydra.id,
      text: 'Check motion',
      reply: 'Motion checked.',
    })
    const session = await hydra.chat({ text: 'Check motion' })
    await until({
      what: 'motion reply',
      check: () => session.answered === 1,
    })
    const page = await openHydra({
      port: pnyx.port(),
      hydraId: hydra.id,
    })
    const label = page.locator(`[data-hydra-workspace="${hydra.id}"] .message`).first()
    const messageDuration = () => label.evaluate(
      element => getComputedStyle(element).animationDuration,
    )
    expect(parseFloat(await messageDuration())).toBeGreaterThan(0)
    await page.getByRole(
      'button',
      {
        name: 'Settings',
        exact: true,
      },
    ).click()
    const knob = page.locator('.settings-page:not([hidden]) .switch-track > span').first()
    await knob.waitFor()
    const timing = () => knob.evaluate(element => ({
      duration: getComputedStyle(element).transitionDuration,
      easing: getComputedStyle(element).transitionTimingFunction,
    }))
    await page.evaluate(() => {
      document.documentElement.dataset.motion = 'off'
    })
    expect((await timing()).duration).toBe('0s')
    expect(motionDuration({ mode: 'off' })).toBe(0)
    await page.getByRole(
      'button',
      {
        name: 'Close Settings',
        exact: true,
      },
    ).click()
    expect(await messageDuration()).toBe('0s')
    await page.evaluate(() => {
      document.documentElement.dataset.motion = 'normal'
    })
    expect(parseFloat(await messageDuration())).toBeGreaterThan(0)
    await page.getByRole(
      'button',
      {
        name: 'Settings',
        exact: true,
      },
    ).click()
    await knob.waitFor()
    expect(await timing()).toEqual({
      duration: `${MOTION_DURATIONS.base / 1000}s`,
      easing: MOTION_CSS_EASING,
    })

    for (const [
      speed,
      milliseconds,
    ] of Object.entries(MOTION_DURATIONS)) {
      const value = await page.evaluate(
        name => getComputedStyle(document.documentElement).getPropertyValue(`--transition-duration-${name}`)
          .trim(),
        speed,
      )
      expect(parseFloat(value) * (value.endsWith('ms') ? 1 : 1000)).toBe(milliseconds)
    }

    await page.emulateMedia({ reducedMotion: 'reduce' })
    expect((await timing()).duration).toBe('0s')
    await page.getByRole(
      'button',
      {
        name: 'Close Settings',
        exact: true,
      },
    ).click()
    expect(await messageDuration()).toBe('0s')
    expect(motionDuration({ reducedMotion: true })).toBe(0)
  },
)

test(
  'opening a visible card keeps its scroll anchor and contains every painted frame',
  async () => {
    const hydra = await pnyx.hydra()
    await hydra.owner({
      args: [
        'task',
        'create',
        '--key',
        'first',
        '--title',
        'Keep the first task visible',
      ],
    })
    await hydra.owner({
      args: [
        'task',
        'create',
        '--key',
        'second',
        '--title',
        'Keep a longer task title visible before the family opens',
      ],
    })
    await hydra.owner({
      args: [
        'task',
        'create',
        '--key',
        'open',
        '--title',
        'Open without a flash',
        '--brief',
        'Keep the opening surface calm.',
      ],
    })
    await hydra.owner({
      args: [
        'task',
        'create',
        '--key',
        'next',
        '--title',
        'Keep the next task visible',
      ],
    })
    await hydra.owner({
      args: [
        'task',
        'create',
        '--key',
        'child',
        '--title',
        'Keep the compact child',
        '--parent',
        'open',
      ],
    })
    await hydra.owner({
      args: [
        'view',
        'set',
        '--json',
        JSON.stringify({ workspace: { projectWidths: { ideas: 280 } } }),
      ],
    })

    for (const theme of [
      'light',
      'dark',
    ]) {
      const page = await openHydra({
        port: pnyx.port(),
        hydraId: hydra.id,
      })

      try {
        await page.evaluate(
          async theme => {
            document.documentElement.dataset.theme = theme
            await document.fonts.ready
          },
          theme,
        )
        const title = page.getByRole(
          'button',
          {
            name: 'Open without a flash',
            exact: true,
          },
        )
        await title.hover()
        const frames = title.evaluate(
          async (
            trigger,
            frameCount,
          ) => {
            const card = trigger.closest<HTMLElement>('.card')!
            const scroll = card.closest<HTMLElement>('.column-cards')!
            const start = scroll.scrollTop
            await new Promise<void>(resolve => trigger.addEventListener(
              'click',
              () => resolve(),
              { once: true },
            ))
            let scrollDelta = 0, escaped = false, replaced = false

            for (let frame = 0; frame < frameCount; frame++) {
              await new Promise(requestAnimationFrame)
              replaced ||= !card.isConnected
              scrollDelta = Math.max(
                scrollDelta,
                Math.abs(scroll.scrollTop - start),
              )
              const bounds = card.getBoundingClientRect()

              for (const fraction of [
                0.25,
                0.75,
              ]) {
                for (const y of [
                  bounds.bottom + 12,
                  card.querySelector('.card-content')!.getBoundingClientRect().bottom - 4,
                ]) {
                  if (y <= bounds.bottom) {
                    continue
                  }

                  const hit = document.elementFromPoint(
                    bounds.left + bounds.width * fraction,
                    y,
                  )
                  escaped ||= !!hit && card.contains(hit) && !hit.closest('[popover], .resize')
                }
              }
            }

            return {
              scrollDelta,
              escaped,
              replaced,
            }
          },
          SAMPLE_FRAMES,
        )
        await title.click()
        const result = await frames
        expect(result.scrollDelta).toBeLessThan(0.5)
        expect({
          escaped: result.escaped,
          replaced: result.replaced,
        }).toEqual({
          escaped: false,
          replaced: false,
        })
      } finally {
        await page.context().close()
      }
    }
  },
)

test(
  'resizing the task modal keeps its close action anchored and its icons undistorted',
  async () => {
    const hydra = await pnyx.hydra()
    const title = 'Keep a long task title readable while resizing its conversation and instructions'
    await hydra.owner({
      args: [
        'task',
        'create',
        '--key',
        'resize-modal',
        '--title',
        title,
      ],
    })

    for (const theme of [
      'light',
      'dark',
    ]) {
      const page = await openHydra({
        port: pnyx.port(),
        hydraId: hydra.id,
      })

      try {
        await page.evaluate(
          async theme => {
            document.documentElement.dataset.theme = theme
            await document.fonts.ready
          },
          theme,
        )
        await page.getByRole(
          'button',
          {
            name: title,
            exact: true,
          },
        ).hover()
        await page.getByRole(
          'button',
          {
            name: 'Open modal',
            exact: true,
          },
        ).click()
        const modal = page.getByRole(
          'dialog',
          {
            name: title,
            exact: true,
          },
        )
        await until({
          what: 'the modal finishes opening before resizing',
          check: async () => {
            const bounds = await modal.boundingBox()
            const settled = await modal.evaluate(element => getComputedStyle(element).transform === 'none')

            return settled && !!bounds
              && Math.abs(bounds.width - 1008) < 1
              && Math.abs(bounds.height - 720) < 1
          },
        })

        for (const [
          axis,
          delta,
        ] of [
            [
              'width',
              -500,
            ],
            [
              'height',
              -500,
            ],
            [
              'width',
              300,
            ],
            [
              'height',
              200,
            ],
          ] as const) {
          const grip = modal.getByRole(
            'separator',
            {
              name: `Resize task modal ${axis}`,
              exact: true,
            },
          )
          await grip.hover()
          const bounds = (await grip.boundingBox())!
          const sampling = modal.evaluate(
            async (
              dialog,
              frameCount,
            ) => {
              const close = dialog.querySelector<HTMLElement>(
                '.dialog-head [aria-label="Close"]',
              )!

              const anchor = () => {
                const surface = dialog.getBoundingClientRect()
                const button = close.getBoundingClientRect()

                return {
                  right: surface.right - button.right,
                  top: button.top - surface.top,
                }
              }

              const initial = anchor()
              let anchorDrift = 0, iconDistortion = 0

              for (let frame = 0; frame < frameCount; frame++) {
                await new Promise(requestAnimationFrame)
                const current = anchor()
                anchorDrift = Math.max(
                  anchorDrift,
                  Math.abs(current.right - initial.right),
                  Math.abs(current.top - initial.top),
                )

                for (const icon of dialog.querySelectorAll<SVGElement>('.dialog-head svg, [data-card-header] svg')) {
                  const bounds = icon.getBoundingClientRect(), style = getComputedStyle(icon)
                  iconDistortion = Math.max(
                    iconDistortion,
                    Math.abs(bounds.width - parseFloat(style.width)),
                    Math.abs(bounds.height - parseFloat(style.height)),
                  )
                }
              }

              return {
                anchorDrift,
                iconDistortion,
              }
            },
            SAMPLE_FRAMES,
          )
          await page.mouse.move(
            bounds.x + bounds.width / 2,
            bounds.y + bounds.height / 2,
          )
          await page.mouse.down()
          await page.mouse.move(
            bounds.x + bounds.width / 2 + (axis === 'width' ? delta : 0),
            bounds.y + bounds.height / 2 + (axis === 'height' ? delta : 0),
            { steps: 20 },
          )
          await page.mouse.up()
          const result = await sampling
          expect.soft(result.anchorDrift).toBeLessThan(0.5)
          expect.soft(result.iconDistortion).toBeLessThan(0.5)
        }
      } finally {
        await page.context().close()
      }
    }
  },
)
