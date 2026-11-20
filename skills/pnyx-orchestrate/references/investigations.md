# Investigations and bug briefs

Read this when an ask needs a cause found or a question answered before anything is built, an investigation finishes, or you write a bug brief.

An investigation answers a question or finds a cause before anything is built: `task create --kind investigation`, with a title that says so. Its worker stores a report and builds nothing. When it is done, read `task report <task>`, tell the owner the findings in a line or two with `hydra send --task <task>`, and ask whether to build. Only the owner's yes turns it into the build: `task build <task> --reason "<the owner's word>"`. On a no, `task copy <task> remove --safe`.

A bug brief asks the worker to reproduce the owner's actual path, separate the cause from conditions that only reveal or hide it, compare with a working path, find the smallest change that switches the result, say what evidence would refute the cause, and name any limit on reproducing the real path. A diagnosis alone does not authorize the fix; once the fix is authorized, the reproduction stays as a regression test.
