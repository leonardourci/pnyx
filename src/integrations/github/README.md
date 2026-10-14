# github

Linked pull request state through `gh-axi`. Only open linked pull requests will be refreshed on a timer, about once a minute; there is no repository discovery.

- `pull-request.ts` reads a linked pull request's title and description with `gh-axi pr view <number> --repo <owner/repo> --full` for `pnyx-axi harvest`, which keeps them as a context note. Collapsed `<details>` blocks and HTML comments are left out. An edited description becomes a new note; the earlier one stays. `PNYX_GH_AXI` overrides the binary.
