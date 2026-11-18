/* eslint-disable pnyx/object-params -- Playwright owns evaluation callback signatures. */
import { expect, test } from 'vitest'
import { MOTION_CSS_EASING, MOTION_DURATIONS, motionDuration } from '../../web/src/shared/motion.ts'
import { openHydra } from '../setup/browser.ts'
import { startPnyx, until } from '../setup/pnyx.ts'

test(
  'the global off switch and OS reduced motion make CSS and TypeScript motion instant',
  async () => {
    const pnyx = await startPnyx({ zeroCache: true })
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
