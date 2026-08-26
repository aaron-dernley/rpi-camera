/**
 * Raspberry Pi CSI camera enumeration via `rpicam-hello --list-cameras`.
 * Zero-privilege — the command doesn't need root to enumerate. Read-only:
 * this model never captures an image or starts a preview.
 *
 * Zero cameras is a valid, fully-verified result on this hardware ("No
 * cameras available!") — not an error. A populated result (one or more
 * cameras with their supported modes) could **not** be observed while
 * building this model, since this machine has no camera module attached.
 * Rather than hardcode an unverified guess at the detailed mode/
 * resolution/format structure `rpicam-hello` prints per camera, each
 * detected camera's raw text block is preserved verbatim in `rawBlock`
 * (and the full command output in `rawOutput`), with only the header line
 * — `N : <description>` — parsed out. `outputRecognized` is false when the
 * output matches neither the verified zero-camera message nor the header
 * pattern at all, so a genuinely unrecognized format doesn't silently
 * masquerade as "zero cameras."
 *
 * @module
 */
import { z } from "npm:zod@4";

/** Minimal logger shape methods depend on — matches `context.logger`. */
export interface MinimalLogger {
  /** Log a user-visible progress or state-transition message. */
  info(msg: string, props?: Record<string, unknown>): void;
  /** Log a recoverable issue or degraded-behavior message. */
  warn(msg: string, props?: Record<string, unknown>): void;
}

/**
 * Read a text file via `cat` rather than `Deno.readTextFile`. Deno's
 * permission checker demands the literal `--allow-all` flag for `/proc`
 * reads — no scoped `--allow-read` satisfies it, even though the file is
 * world-readable either way. Same workaround the rest of this family uses.
 */
async function catFile(path: string): Promise<string> {
  const cmd = new Deno.Command("cat", {
    args: [path],
    stdout: "piped",
    stderr: "piped",
  });
  const output = await cmd.output();
  if (!output.success) {
    throw new Error(
      `cat ${path} failed: ${new TextDecoder().decode(output.stderr).trim()}`,
    );
  }
  return new TextDecoder().decode(output.stdout).trim();
}

/** Result of the hardware guard every method runs before doing real work. */
export interface PiHardwareInfo {
  /** `/proc/device-tree/model`, NUL byte stripped. */
  model: string;
}

/** Hardware guard every method calls before writing any resource. Refuses to run on non-Pi hardware. */
export async function assertRaspberryPiHardware(): Promise<PiHardwareInfo> {
  let rawModel: string;
  try {
    rawModel = await catFile("/proc/device-tree/model");
  } catch (error) {
    throw new Error(
      `This model requires Raspberry Pi hardware: /proc/device-tree/model ` +
        `is missing or unreadable (${
          error instanceof Error ? error.message : String(error)
        }).`,
    );
  }
  // The kernel reports this value NUL-terminated, not newline-terminated.
  const model = rawModel.replace(/\0+$/, "").trim();
  if (!model.includes("Raspberry Pi")) {
    throw new Error(
      `This model requires Raspberry Pi hardware: /proc/device-tree/model ` +
        `reports "${model}", which does not contain "Raspberry Pi".`,
    );
  }
  return { model };
}

/** One detected camera, minimally parsed. */
export interface ParsedCamera {
  index: number;
  headerLine: string;
  rawBlock: string;
}

/** Parsed `rpicam-hello --list-cameras` output. */
export interface ParsedCameraList {
  cameras: ParsedCamera[];
  outputRecognized: boolean;
}

// Matches a camera header line, e.g. "0 : imx708 [4608x2592 10-bit RGGB]
// (/base/soc/i2c0mux/i2c@1/imx708@1a)" — deliberately only the leading
// "N :" is load-bearing; the rest of the line and any indented lines below
// it are kept verbatim in rawBlock rather than parsed further, since that
// detailed shape couldn't be verified against real hardware.
const CAMERA_HEADER_RE = /^(\d+)\s*:\s*(.+)$/;

/**
 * Parse `rpicam-hello --list-cameras` output. The exact zero-camera
 * message ("No cameras available!") is verified against real hardware; a
 * populated result is recognized by unindented "N : ..." header lines,
 * each followed by its indented detail lines (kept verbatim, not
 * structurally parsed — see the module doc for why).
 */
export function parseCameraList(output: string): ParsedCameraList {
  const trimmed = output.trim();
  if (trimmed === "No cameras available!") {
    return { cameras: [], outputRecognized: true };
  }

  const lines = output.split("\n");
  const cameras: ParsedCamera[] = [];
  let current: { index: number; headerLine: string; lines: string[] } | null =
    null;

  for (const line of lines) {
    if (line.trim().length === 0) continue;
    const isIndented = /^\s/.test(line);
    if (!isIndented) {
      const headerMatch = CAMERA_HEADER_RE.exec(line.trim());
      if (headerMatch) {
        if (current) {
          cameras.push({
            index: current.index,
            headerLine: current.headerLine,
            rawBlock: current.lines.join("\n"),
          });
        }
        current = {
          index: Number(headerMatch[1]),
          headerLine: line.trim(),
          lines: [line],
        };
        continue;
      }
      // An unindented, non-header line (e.g. "Available cameras" /
      // "-----------------" banner text some rpicam-apps versions print)
      // — not part of any camera block, just skip it.
      continue;
    }
    if (current) current.lines.push(line);
  }
  if (current) {
    cameras.push({
      index: current.index,
      headerLine: current.headerLine,
      rawBlock: current.lines.join("\n"),
    });
  }

  return { cameras, outputRecognized: cameras.length > 0 };
}

const GlobalArgsSchema = z.object({
  rpicamHelloPath: z.string().default("rpicam-hello").describe(
    "Path to the rpicam-hello binary. Override for odd installs.",
  ),
});

type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

const CameraSchema = z.object({
  index: z.number().describe(
    'Camera index, from the "N :" prefix of its header line.',
  ),
  headerLine: z.string().describe(
    "The camera's full header line verbatim, e.g. a model/resolution/" +
      "bus-path summary. Not further parsed — see the module doc.",
  ),
  rawBlock: z.string().describe(
    "This camera's full text block verbatim, header line plus any " +
      "indented mode/format lines beneath it. Not structurally parsed " +
      "into resolutions/formats/fps — that detailed shape couldn't be " +
      "verified without real camera hardware.",
  ),
});

const CamerasSchema = z.object({
  cameras: z.array(CameraSchema).describe(
    "One entry per detected camera. Empty array is a valid, fully-" +
      "verified result — zero cameras attached is normal, not an error.",
  ),
  cameraCount: z.number().describe(
    "cameras.length, hoisted for a quick check.",
  ),
  outputRecognized: z.boolean().describe(
    "False when rpicam-hello's output matched neither the verified " +
      '"No cameras available!" message nor the header-line pattern at ' +
      "all — meaning cameras/cameraCount should not be trusted and " +
      "rawOutput needs a human look, rather than silently reporting 0.",
  ),
  rawOutput: z.string().describe(
    "Verbatim rpicam-hello --list-cameras output, always stored — the " +
      "source of truth when outputRecognized is false or when the " +
      "detailed per-camera format matters.",
  ),
  capturedAt: z.string().describe(
    "ISO-8601 timestamp when this snapshot was captured.",
  ),
});

/** Model definition for `@aaronge/rpi-camera` — Pi CSI camera enumeration. */
export const model = {
  type: "@aaronge/rpi-camera",
  version: "2026.08.26.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    cameras: {
      description:
        "Detected CSI cameras from rpicam-hello --list-cameras. Zero " +
        "cameras is a valid result, not an error.",
      schema: CamerasSchema,
      lifetime: "infinite" as const,
      garbageCollection: 200,
    },
  },
  methods: {
    readCameras: {
      description: "Run rpicam-hello --list-cameras, parse it, and write the " +
        "cameras resource.",
      arguments: z.object({}),
      execute: async (
        _args: Record<string, never>,
        context: {
          globalArgs: GlobalArgs;
          logger: MinimalLogger;
          writeResource: (
            specName: string,
            name: string,
            data: Record<string, unknown>,
          ) => Promise<{ name: string }>;
        },
      ) => {
        await assertRaspberryPiHardware();
        const capturedAt = new Date().toISOString();
        const rpicamHelloPath = context.globalArgs.rpicamHelloPath;

        context.logger.info(
          "Enumerating cameras via {rpicamHelloPath} --list-cameras",
          { rpicamHelloPath },
        );
        let rawOutput: string;
        try {
          const cmd = new Deno.Command(rpicamHelloPath, {
            args: ["--list-cameras"],
            stdout: "piped",
            stderr: "piped",
          });
          const output = await cmd.output();
          rawOutput = new TextDecoder().decode(output.stdout);
          if (!output.success && rawOutput.trim().length === 0) {
            throw new Error(
              `rpicam-hello --list-cameras failed: ${
                new TextDecoder().decode(output.stderr).trim()
              }`,
            );
          }
        } catch (error) {
          if (error instanceof Deno.errors.NotFound) {
            throw new Error(
              `rpicam-hello not found on PATH (looked for "${rpicamHelloPath}"). ` +
                `It ships in rpicam-apps. Set the rpicamHelloPath global ` +
                `argument if it lives somewhere nonstandard.`,
            );
          }
          throw error;
        }

        const { cameras, outputRecognized } = parseCameraList(rawOutput);
        if (!outputRecognized) {
          context.logger.warn(
            "rpicam-hello output matched neither the known zero-camera " +
              "message nor the header-line pattern; cameraCount may be " +
              "wrong — check rawOutput: {rawOutput}",
            { rawOutput: rawOutput.trim() },
          );
        }

        context.logger.info(
          "Captured {cameraCount} camera(s), outputRecognized={outputRecognized}",
          { cameraCount: cameras.length, outputRecognized },
        );

        const handle = await context.writeResource("cameras", "cameras", {
          cameras,
          cameraCount: cameras.length,
          outputRecognized,
          rawOutput,
          capturedAt,
        });
        return { dataHandles: [handle] };
      },
    },
  },
};
