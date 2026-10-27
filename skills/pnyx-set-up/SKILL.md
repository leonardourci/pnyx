---
name: pnyx-set-up
description: Use when you are Hydra and your digest shows "Setup needed", or the owner asks what Pnyx still needs to be set up.
user-invocable: false
metadata:
  internal: true
---

# Pnyx setup

Pnyx checks its setup each time a Hydra session opens, in its own code, and lists only what is missing under "Setup needed" in your digest. A complete setup prints nothing. `pnyx-axi setup check --hydra <hydra>` prints the same list again (exit 1 while anything is missing).

Each row names who fixes it. Do the `you` rows yourself, without asking. For `owner` rows that name a `pnyx-axi` command, run that command with `--hydra <hydra>` as usual, except `setup service`, which serves every Hydra and refuses `--hydra`. Pnyx turns owner actions into a question card in your chat, and only the owner's Confirm runs them; when your session is set to Bypass permissions or Codex's `never`, they run at once instead, so report the result rather than a pending confirmation. For `owner` rows without a command, ask the owner in one short line. Greet a first setup with one line ("A few things to set up") before the cards; that line is the turn's reply, so never add `NO_REPLY` after it. When the owner dismisses one, note it in owner memory (`preferences`) and do not raise it again.

After a fix, run `setup check` again and report only what is still missing.

Setup of hooks, skills and the login service changes user-wide configuration. If a command returns `CUSTOM_HOME_SETUP`, keep the selected `PNYX_HOME` and ask whether the owner wants those changes for that home. Only then add `--allow-custom-home`; do not unset `PNYX_HOME` to get around the refusal. Use `--preview --allow-custom-home` after that choice to inspect the targets. A custom home's service also needs an unused `--port` that no installed Pnyx service reserves.

## Rows

- `config`: no local dispatch rules or account registry. Run `pnyx-axi rule init --shared --hydra <hydra> --reason "first-run setup"` yourself; it only creates missing files. It registers starter accounts; any whose login folder is missing show up as `account:<name>` rows next time.
- `account:<name>`: a registered account's login folder does not exist. Ask the owner whether they use that account. If they do, they sign in with that folder; if not, run the `pnyx-axi account remove` command the row names so the owner confirms its removal.
- `login:claude`, `login:codex`: the rules name a harness with no login. Ask the owner to sign in to it; Pnyx only stores login folders. When accounts are registered, the row also names an `account set` command: run it with the folder the owner signed in to, so the owner confirms it. If they do not use that harness, propose rules without it (`rule propose set`).
- `hooks`: the reporting hooks are not installed for this Pnyx home. Run `pnyx-axi setup hooks --hydra <hydra>`; the owner confirms it. Codex then asks the owner to trust the new hooks once with `/hooks`.
- `skills`: the global skill links are missing. Run `pnyx-axi setup skills --hydra <hydra>`; the owner confirms it. A `conflict` row means another skill sits at that path: raise no card, since `setup skills` refuses to replace it; ask the owner to move it aside, then raise the card.
- `quota-axi`: not on PATH, so dispatch cannot rank accounts by quota. Ask the owner to install [quota-axi](https://github.com/kunchenguid/quota-axi); quota stays unknown without it, and a start with several unknown candidates can require an explicit harness or rule.
- `service`: no macOS login service, so Hydras stop when this server stops. Run `pnyx-axi setup service` without `--hydra`; the owner confirms it, and the service takes over once a manually started server stops. This row only applies on macOS; a foreground server works without the service.
- `profile:<project>`: an attached project has no profile. Write it yourself as your contract's Project memory section describes.
