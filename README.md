# pi-pprof-tools

Pi package for Go `pprof` capture, analysis, comparison, and top-N Markdown tables.

## Features

- Capture pprof profiles from `http://localhost:6060`.
- Analyze existing `pprof-data/pprof-*` directories.
- Run `go tool pprof -top` for supported sample indexes (CPU samples/time, heap/alloc object+space, block/mutex delay+contentions, goroutine/threadcreate counts).
- Render normal Markdown tables and return structured data for the LLM.
- Compare two runs by cumulative percentage delta.

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
```

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
