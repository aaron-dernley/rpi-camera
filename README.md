# @aaronge/rpi-camera

Enumerates Raspberry Pi CSI camera modules via `rpicam-hello
--list-cameras`, as a typed, versioned Swamp model. Zero privileges: the
command doesn't need root. Read-only — this model never captures an image
or starts a preview.

**Zero cameras is a valid, fully-verified result** (`"No cameras
available!"`) — this machine has no camera module attached, and that
state is exactly what the roadmap for this extension family calls out as
"valid, not an error." A **populated** result could not be observed while
building this model, for the same reason. See "How it works" for what
that means for the per-camera schema.

## Installation

```sh
swamp extension pull @aaronge/rpi-camera
```

## Usage

```sh
swamp model create @aaronge/rpi-camera rpi-local

swamp model method run rpi-local readCameras
```

The method writes one resource: `cameras`. Every field is described — run
`swamp model type describe @aaronge/rpi-camera` to see the full schema.

Reference the latest snapshot from a workflow assert step or another model:

```yaml
expr: >-
  data.latest("rpi-local", "cameras").attributes.outputRecognized == true
```

## Global arguments

| Arg                | Default             | Notes                        |
| --------------------- | ---------------------- | -------------------------------- |
| `rpicamHelloPath`    | `"rpicam-hello"`      | Override for odd installs.       |

## How it works

- **`cameras`** — the zero-camera case (`"No cameras available!"`) is
  parsed exactly and verified against real hardware. A populated result is
  recognized by unindented `N : <description>` header lines; each
  camera's `index` and `headerLine` come from that line, but the detailed
  mode/resolution/format lines beneath it are kept verbatim in `rawBlock`
  rather than structurally parsed — that nested shape could not be
  verified without a real camera attached, and guessing it wrong would be
  worse than not parsing it at all. `rawOutput` always stores the full
  command output.

  `outputRecognized` is the field this model is actually confident in:
  `true` when the output matched either the verified zero-camera message
  or the header-line pattern, `false` when it matched neither — meaning
  `cameras`/`cameraCount` shouldn't be trusted and `rawOutput` needs a
  human look. This is deliberately what the bundled workflow asserts on,
  not `cameraCount > 0` (which would be wrong on this and most machines).

Refuses to run on non-Pi hardware — checking `/proc/device-tree/model`
names a Raspberry Pi — before writing anything.

## Workflow

The extension ships an `rpi-camera` workflow: a `collect` job runs
`readCameras`, an `assert` job checks `outputRecognized == true` (catches
a future `rpicam-apps` update changing the output format in a way this
parser doesn't recognize — the real failure mode, since a plain
`cameraCount > 0` check would be wrong on any Pi without a camera
attached), and a `report` job prints a one-screen summary regardless of
whether the assert job passed. Camera presence changes rarely, so this
runs once a day (`51 6 * * *`) rather than every 5 minutes like the
telemetry-focused extensions in this family.

## License

MIT — see LICENSE for details.
