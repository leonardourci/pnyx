---
name: pnyx-set-up
description: Use when Pnyx reports missing setup or the owner asks how to configure it.
user-invocable: true
metadata:
  internal: true
---

# Pnyx setup

`pnyx setup check --hydra <id>` lists missing setup and exits nonzero while anything is missing. Use the UI for Hydra, project and dispatch configuration. Ask the owner to sign in when a harness or account needs login.

`pnyx setup --preview` inspects the login service. `pnyx setup hooks --preview` and `pnyx setup skills --preview` inspect hook and skill installation. Setup writes user-wide configuration, even under a custom `PNYX_HOME`; keep the selected home and follow the owner's authority before applying it.

A foreground `pnyx serve` runs the app without installing a service. Use Ctrl+C to stop it. For trials, select a temporary home and a unique portless name, or use `--port 0`.
