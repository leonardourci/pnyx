import type { UpgradeStatus } from '#upgrade/model.ts'
import { clock } from '#web-hydra/chat.ts'
import { Button } from '#web-shared/ui/controls.tsx'
import { Disclosure } from '#web-shared/ui/disclosure.tsx'
import { IdentityCredits } from '#web-shared/ui/icons/identity-credits.tsx'
import { checkedDay } from '#web-upgrade/upgrade-hint.tsx'

function Version({
  upgrade,
  startUpgrade,
}: {
  upgrade?: UpgradeStatus
  startUpgrade(): void
}) {
  const build = document.querySelector<HTMLMetaElement>('meta[name=pnyx-build]')?.content
  const checked = upgrade && `checked ${checkedDay({ at: upgrade.checkedAt })} at ${clock({ at: upgrade.checkedAt })}`
  const status = !upgrade ? 'Not checked for upgrades yet.'
    : upgrade.available ? `A newer Pnyx is available, ${checked}.` : `Up to date, ${checked}.`

  return (
    <div className="about-version">
      <p>Build <code>{build || 'unknown'}</code>. {status}</p>
      {upgrade?.available && <Button variant="primary" onClick={startUpgrade}>Upgrade</Button>}
    </div>
  )
}

export function About({
  upgrade,
  startUpgrade,
}: {
  upgrade?: UpgradeStatus
  startUpgrade(): void
}) {
  return (
    <section className="about" aria-label="About Pnyx">
      <p>Pnyx brings your agents and their work into a Hydra.</p>
      <Version upgrade={upgrade} startUpgrade={startUpgrade} />
      <Disclosure title="License notices">
        <IdentityCredits />
        <p>GFS Neohellenic by the Greek Font Society is distributed under the <a href="/fonts/gfs-neohellenic/OFL.txt" target="_blank" rel="noreferrer">SIL Open Font License 1.1</a>.</p>
        <p>Inter by Rasmus Andersson is distributed under the <a href="/fonts/inter/OFL.txt" target="_blank" rel="noreferrer">SIL Open Font License 1.1</a>.</p>
        <p>JetBrains Mono is distributed under the <a href="/fonts/jetbrains-mono/OFL.txt" target="_blank" rel="noreferrer">SIL Open Font License 1.1</a>.</p>
        <p>Tabler interface icons are distributed under the <a href="/licenses/tabler-icons.txt" target="_blank" rel="noreferrer">MIT License</a>.</p>
        <p>Claude Code and Codex marks identify Anthropic and OpenAI. The marks are from Simple Icons, distributed under <a href="https://creativecommons.org/publicdomain/zero/1.0/" target="_blank" rel="noreferrer">CC0 1.0</a>. Trademarks belong to their respective owners.</p>
      </Disclosure>
    </section>
  )
}
