# pi-pprof-tools

Pi package for Go `pprof` capture, analysis, comparison, and top-N Markdown tables.

## Features

- Capture pprof profiles from `http://localhost:6060`.
- Analyze existing `pprof-data/pprof-*` directories.
- Run `go tool pprof -top` for supported sample indexes (CPU samples/time, heap/alloc object+space, block/mutex delay+contentions, goroutine/threadcreate counts).
- Render normal Markdown tables and return structured data for the LLM.
- Compare two runs by cumulative percentage delta.
- Create git worktree task workspaces under `~/Developer`.
- Prepare `/do` planning sessions with ignored checkbox plans in `docs/plans/`.
- Commit with optional trailers and ship/push the current branch, creating a draft PR when `gh` is available.

## Tools

- `pprof_capture`
- `pprof_analyze`
- `pprof_compare`

## Commands

```text
/pprof-capture [name]
/pprof-analyze <dir>
/pprof-analyze off   # clear any legacy widget
/pprof-widget off    # clear any legacy widget

/workspace [task-name]        # create/activate ~/Developer/<task-name> from upstream
/workspace-current            # show active routed workspace
/do [task-name]               # create workspace, ignore docs/plans/<task>.md, ask Pi to plan
/commit [subject]             # commit with optional Reason/Ticket/Test-Plan trailers
/ship                         # push current branch and optionally create a draft PR
```

After `/workspace` or `/do`, relative tool paths and bash calls are routed to the active worktree in the same Pi session.

## Install

Local project install:

```bash
pi install -l ./pi-pprof-tools
```

Git install after publishing:

```bash
pi install git:github.com/flaticols/pi-pprof-tools@v0.1.0
```

## Requirements

- Go toolchain available as `go`.
- For capture: pprof port-forward available at `localhost:6060`.
- For git commands: Git repository with an upstream such as `origin/main` or `origin/HEAD`.
- Optional: `gitmd` is used by `/commit` when available to reinforce trailers; `semtag` is detected during `/ship`.
