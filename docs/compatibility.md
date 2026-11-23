# Upgrading from Pnyx

Othrys calls its coordinators Titans. Existing names such as Poseidon, Hades and custom names stay unchanged. Existing icons remain available; the random default pool also includes Cronus, Rhea, Hyperion and Mnemosyne alongside Atlas, Prometheus, Themis and the Greek god names.

## Home selection

`OTHRYS_HOME` takes precedence over the legacy `PNYX_HOME`. An explicit home is used as supplied and never automatically moved or merged. New installations use `~/.othrys`.

When only `~/.pnyx` exists, Othrys creates `~/.othrys` as a directory symlink to it. No data is copied, renamed or rewritten. The old path stays valid for captured transcript paths, worker logs, accounts, projects, copies and sessions. Repeated starts reuse the alias. When both paths exist, Othrys uses `~/.othrys` and leaves both homes intact. It never combines two installations. A broken symlink, non-directory target or inaccessible default home produces an error instead of replacing it. Correct the target or select a home explicitly.

The alias is a compatibility measure, not a backup. Both names address the same data. To return to the previous application, stop Othrys and use the original home; do not run two servers against the same home.

## Intentional legacy names

The public executable and package are `othrys`; public coordinator commands use `titan` and `--titan`. Legacy command aliases and executable entry paths remain accepted. Environment variables use `OTHRYS_`; legacy `PNYX_` variables remain fallback inputs, with the new spelling taking precedence.

Durable `hydras/` folders, `hydra.log`, serialized Hydra field and event names, actor/host/route identifiers such as `hydra` and `pnyx`, browser draft and preference storage keys, existing icon identifiers and historical transcript markers retain their original spelling for compatibility. Recorded fixtures and user-written content are not rebranded. These identifiers belong to the storage protocol rather than the displayed product vocabulary. This includes the saved preference keys `defaultHydraWidth` and `hiddenHydras`, and the interrupted-upgrade marker `pnyx-upgrade-from`.

Repository links are prepared for `leonardourci/othrys`. This change does not rename the hosted repository, publish a release, reinstall services or migrate a running installation. Setup remains an explicit action.
