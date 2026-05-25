# pi-pprof-tools

Pi package for Go `pprof` workflows in performance-test runs.

## Features

- Capture pprof profiles from `http://localhost:6060`.
- Analyze existing `benchmark-results/pprof-*` directories.
- Run `go tool pprof -top` for useful sample indexes.
- Show top rows in a Pi widget.
- Compare two runs by cumulative percentage delta.

## Tools

- `pprof_capture`
- `pprof_analyze`
- `pprof_compare`

## Commands

```text
/pprof-capture [name]
/pprof-analyze <dir>
/pprof-analyze off
/pprof-widget off
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
