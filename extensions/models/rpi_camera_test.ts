// Run with `deno test -A`. -A is needed because catFile shells out to `cat`
// for /proc reads — see the sibling extensions' test files for why Deno's
// permission checker requires it even for world-readable files.
import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import {
  createModelTestContext,
  withMockedCommand,
} from "jsr:@swamp-club/swamp-testing@0.20260824.32";
import {
  assertRaspberryPiHardware,
  model,
  parseCameraList,
} from "./rpi_camera.ts";

// createModelTestContext() returns a MethodContext typed with a default
// Record<string, unknown> globalArgs — narrower than each execute()'s own
// inline context type. This cast bridges that gap; the contextual type at
// each call site (inferred from execute()'s own parameter type) fills in T.
function asContext<T>(context: unknown): T {
  return context as T;
}

const DEFAULT_GLOBAL_ARGS = { rpicamHelloPath: "rpicam-hello" };

// --- parseCameraList -----------------------------------------------------

// Captured live from `rpicam-hello --list-cameras` on this Pi 5 — no
// camera module attached.
const REAL_NO_CAMERAS_OUTPUT = "No cameras available!\n";

Deno.test("parseCameraList recognizes the verified zero-camera message", () => {
  const result = parseCameraList(REAL_NO_CAMERAS_OUTPUT);
  assertEquals(result.cameras, []);
  assertEquals(result.outputRecognized, true);
});

// Inferred shape, NOT observed on real hardware — this machine has no
// camera module attached. Based on publicly documented rpicam-apps
// --list-cameras output shape. Should be revisited against real output
// once a camera is attached; only the "N : ..." header line is actually
// load-bearing to this parser, so the exact mode-line formatting below is
// illustrative, not asserted on beyond being preserved verbatim.
const INFERRED_ONE_CAMERA_OUTPUT = `Available cameras
-----------------
0 : imx708 [4608x2592 10-bit RGGB] (/base/soc/i2c0mux/i2c@1/imx708@1a)
    Modes: 'SRGGB10_CSI2P' : 1536x864 [120.13 fps]
                              2304x1296 [56.03 fps]
`;

Deno.test("parseCameraList parses an inferred single-camera output, keeping mode detail verbatim in rawBlock", () => {
  const result = parseCameraList(INFERRED_ONE_CAMERA_OUTPUT);
  assertEquals(result.outputRecognized, true);
  assertEquals(result.cameras.length, 1);
  assertEquals(result.cameras[0].index, 0);
  assert(result.cameras[0].headerLine.startsWith("0 : imx708"));
  assert(result.cameras[0].rawBlock.includes("Modes:"));
  assert(result.cameras[0].rawBlock.includes("2304x1296"));
});

const INFERRED_TWO_CAMERA_OUTPUT = `Available cameras
-----------------
0 : imx708 [4608x2592 10-bit RGGB] (/base/soc/i2c0mux/i2c@1/imx708@1a)
    Modes: 'SRGGB10_CSI2P' : 4608x2592 [14.35 fps]
1 : imx219 [3280x2464 10-bit RGGB] (/base/soc/i2c0mux/i2c@0/imx219@10)
    Modes: 'SRGGB10_CSI2P' : 3280x2464 [21.19 fps]
`;

Deno.test("parseCameraList splits multiple cameras at each unindented header line", () => {
  const result = parseCameraList(INFERRED_TWO_CAMERA_OUTPUT);
  assertEquals(result.cameras.length, 2);
  assertEquals(result.cameras[0].index, 0);
  assertEquals(result.cameras[1].index, 1);
  assert(result.cameras[0].rawBlock.includes("imx708"));
  assert(!result.cameras[0].rawBlock.includes("imx219"));
  assert(result.cameras[1].rawBlock.includes("imx219"));
});

Deno.test("parseCameraList reports outputRecognized=false for a genuinely unrecognized format, rather than guessing zero cameras", () => {
  const result = parseCameraList(
    "Some future rpicam-apps output we've never seen\n",
  );
  assertEquals(result.cameras, []);
  assertEquals(result.outputRecognized, false);
});

// --- readCameras: real hardware + mocked populated/not-found scenarios ---
//
// This model refuses to run at all off Pi hardware, so — like the sibling
// extensions' method-level tests — the primary test exercises the real
// rpicam-hello on whatever host runs the suite. This machine has no
// camera attached, which is itself the primary case the roadmap calls out
// as valid to verify.

Deno.test("readCameras writes a cameras resource from real rpicam-hello output (zero cameras on this machine)", async () => {
  const { context, getWrittenResources } = createModelTestContext({
    globalArgs: DEFAULT_GLOBAL_ARGS,
    methodName: "readCameras",
  });

  await model.methods.readCameras.execute({}, asContext(context));

  const written = getWrittenResources();
  assertEquals(written.length, 1);
  assertEquals(written[0].specName, "cameras");
  const data = written[0].data as {
    cameras: unknown[];
    cameraCount: number;
    outputRecognized: boolean;
    rawOutput: string;
  };
  assertEquals(data.cameras, []);
  assertEquals(data.cameraCount, 0);
  assertEquals(data.outputRecognized, true);
  assert(data.rawOutput.includes("No cameras available"));
});

Deno.test("readCameras parses a mocked populated scenario end to end", async () => {
  const { context, getWrittenResources } = createModelTestContext({
    globalArgs: DEFAULT_GLOBAL_ARGS,
    methodName: "readCameras",
  });

  await withMockedCommand((command, args) => {
    if (command === "cat" && args[0] === "/proc/device-tree/model") {
      return { stdout: "Raspberry Pi 5 Model B Rev 1.1\0", code: 0 };
    }
    if (command === "rpicam-hello" && args.includes("--list-cameras")) {
      return { stdout: INFERRED_ONE_CAMERA_OUTPUT, code: 0 };
    }
    throw new Error(`unexpected command in test: ${command} ${args.join(" ")}`);
  }, () => model.methods.readCameras.execute({}, asContext(context)));

  const data = getWrittenResources()[0].data as {
    cameraCount: number;
    outputRecognized: boolean;
  };
  assertEquals(data.cameraCount, 1);
  assertEquals(data.outputRecognized, true);
});

Deno.test("readCameras surfaces a clean not-found error when rpicam-hello is not on PATH", async () => {
  const { context } = createModelTestContext({
    globalArgs: { rpicamHelloPath: "/nonexistent/rpicam-hello" },
    methodName: "readCameras",
  });

  await assertRejects(
    () => model.methods.readCameras.execute({}, asContext(context)),
    Error,
    "not found on PATH",
  );
});

Deno.test("assertRaspberryPiHardware strips the trailing NUL from /proc/device-tree/model on this real Pi 5", async () => {
  const hardware = await assertRaspberryPiHardware();
  assert(!hardware.model.includes("\0"));
  assertEquals(hardware.model, hardware.model.trim());
  assert(hardware.model.includes("Raspberry Pi"));
});
