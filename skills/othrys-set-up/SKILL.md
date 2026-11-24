---
name: othrys-set-up
description: Use when Othrys reports missing setup or the owner asks how to configure it.
user-invocable: true
metadata:
  internal: true
---

# Othrys setup

`othrys setup check --titan <id>` lists missing setup and exits nonzero while anything is missing. Use the UI for Titan, project and dispatch configuration. Ask the owner to sign in when a harness or account needs login.

`othrys setup --preview` inspects the login service. `othrys setup hooks --preview` and `othrys setup skills --preview` inspect hook and skill installation. Setup writes user-wide configuration, even under a custom `OTHRYS_HOME`; keep the selected home and follow the owner's authority before applying it.

A foreground `othrys serve` runs the app without installing a service. Use Ctrl+C to stop it. For trials, select a temporary home and a unique portless name, or use `--port 0`.
