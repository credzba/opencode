import { afterEach, describe, expect, mock, spyOn, test } from "bun:test"
import { Effect } from "effect"
import fs from "fs/promises"
import path from "path"
import yargs from "yargs"
import { tmpdir } from "../../fixture/fixture"
import { TuiThreadCommand, resolveThreadDirectory } from "../../../src/cli/cmd/tui"
import { cliIt } from "../../lib/cli-process"
import * as Network from "../../../src/cli/network"
import * as TuiLayer from "../../../src/cli/tui/layer"
import * as TuiRuntime from "../../../src/plugin/tui/runtime"
import * as Rpc from "../../../src/util/rpc"
import * as TerminalWin32 from "@opencode-ai/tui/terminal-win32"
import * as Timeout from "../../../src/util/timeout"
import * as TuiConfig from "../../../src/config/tui"
import * as ValidateSession from "../../../src/cli/tui/validate-session"

describe("tui thread", () => {
  afterEach(() => {
    mock.restore()
  })

  test("loads the TUI integration lazily", async () => {
    const source = await Bun.file(new URL("../../../src/cli/cmd/tui.ts", import.meta.url)).text()

    expect(source).toContain('await import("../tui/layer")')
    expect(source).toMatch(/await import\(["']@\/plugin\/tui\/runtime["']\)/)
    expect(source).not.toContain('import("./app")')
  })

  async function check(project?: string) {
    await using tmp = await tmpdir({ git: true })
    const link = path.join(path.dirname(tmp.path), path.basename(tmp.path) + "-link")
    const type = process.platform === "win32" ? "junction" : "dir"

    try {
      await fs.symlink(tmp.path, link, type)
      expect(resolveThreadDirectory(project, link, tmp.path)).toBe(tmp.path)
    } finally {
      await fs.rm(link, { recursive: true, force: true }).catch(() => undefined)
    }
  }

  test("uses the real cwd when PWD points at a symlink", async () => {
    await check()
  })

  test("uses the real cwd after resolving a relative project from PWD", async () => {
    await check(".")
  })

  test("resolves a relative mini project from PWD when cwd differs", async () => {
    await using pwd = await tmpdir({ git: true })
    await using cwd = await tmpdir({ git: true })

    expect(resolveThreadDirectory(".", pwd.path, cwd.path)).toBe(pwd.path)
    expect(resolveThreadDirectory(undefined, pwd.path, cwd.path)).toBe(cwd.path)
  })

  test("parses supported --no-replay forms", async () => {
    for (const option of ["--no-replay", "--no-replay=true", "--noReplay"]) {
      const args = await yargs([])
        .command({ ...TuiThreadCommand, handler: () => {} })
        .exitProcess(false)
        .parse(["--mini", option, "--replay-limit", "10"])

      expect(args.replay === false || args.noReplay === true).toBe(true)
      expect(args.replayLimit).toBe(10)
    }
  })

  test("preserves boolean negation for existing options", async () => {
    const args = await yargs([])
      .command({ ...TuiThreadCommand, handler: () => {} })
      .exitProcess(false)
      .parse(["--mdns", "--no-mdns"])

    expect(args.mdns).toBe(false)
  })

  cliIt.live("rejects mini-only options without --mini", ({ opencode }) =>
    Effect.gen(function* () {
      const result = yield* opencode.spawn(["--replay-limit", "10"])

      opencode.expectExit(result, 1)
      expect(result.stderr).toContain("--replay-limit requires --mini")
    }),
  )

  cliIt.live("routes attached sessions to mini mode", ({ opencode }) =>
    Effect.gen(function* () {
      const result = yield* opencode.spawn(["attach", "http://127.0.0.1:1", "--mini"])

      opencode.expectExit(result, 1)
      expect(result.stderr).toContain("--mini requires a TTY stdout")
    }),
  )

  cliIt.live("rejects network options in mini mode", ({ opencode }) =>
    Effect.gen(function* () {
      const result = yield* opencode.spawn(["--mini", "--port", "4096"])

      opencode.expectExit(result, 1)
      expect(result.stderr).toContain("--port cannot be used with --mini")
    }),
  )

  test("does not force process.exit after tui exits cleanly", async () => {
    const exit = spyOn(process, "exit").mockImplementation((() => undefined) as typeof process.exit)
    const worker = globalThis.Worker
    const tty = Object.getOwnPropertyDescriptor(process.stdin, "isTTY")
    const cwd = process.cwd()
    const sigusr2 = process.listeners("SIGUSR2")

    spyOn(TerminalWin32, "win32InstallCtrlCGuard").mockReturnValue(undefined)
    spyOn(Rpc, "client").mockImplementation(
      () =>
        ({
          call: async () => ({ url: "http://127.0.0.1" }),
          on: () => () => {},
        }) as never,
    )
    spyOn(Timeout, "withTimeout").mockImplementation((input) => input as never)
    spyOn(Network, "resolveNetworkOptionsNoConfig").mockReturnValue({
      mdns: false,
      port: 0,
      hostname: "127.0.0.1",
      mdnsDomain: "opencode.local",
      cors: [],
    })
    spyOn(TuiConfig.TuiConfig, "get").mockResolvedValue({} as never)
    spyOn(TuiLayer, "run").mockImplementation(() => Effect.void as never)
    spyOn(TuiRuntime, "createLegacyTuiPluginHost").mockReturnValue(undefined as never)
    spyOn(ValidateSession, "validateSession").mockResolvedValue(undefined)

    Object.defineProperty(process.stdin, "isTTY", {
      configurable: true,
      value: true,
    })
    globalThis.Worker = class extends EventTarget {
      onerror = null
      onmessage = null
      onmessageerror = null
      postMessage() {}
      terminate() {}
    } as unknown as typeof Worker

    const args: Parameters<NonNullable<typeof TuiThreadCommand.handler>>[0] = {
      _: [],
      $0: "opencode",
      project: undefined,
      prompt: "hi",
      model: undefined,
      agent: undefined,
      session: undefined,
      continue: false,
      fork: false,
      auto: false,
      yolo: false,
      "dangerously-skip-permissions": false,
      dangerouslySkipPermissions: false,
      mini: false,
      replay: undefined,
      "no-replay": undefined,
      noReplay: undefined,
      "replay-limit": undefined,
      replayLimit: undefined,
      demo: undefined,
      port: 0,
      hostname: "127.0.0.1",
      mdns: false,
      "mdns-domain": "opencode.local",
      mdnsDomain: "opencode.local",
      cors: [],
    }

    try {
      await TuiThreadCommand.handler(args)
      if (process.platform === "win32") {
        // On Windows, process.exit(0) is required because awaiting the
        // worker shutdown destroys the console window.
        expect(exit).toHaveBeenCalledWith(0)
      } else {
        expect(exit).not.toHaveBeenCalled()
      }
    } finally {
      if (tty) Object.defineProperty(process.stdin, "isTTY", tty)
      else delete (process.stdin as { isTTY?: boolean }).isTTY
      globalThis.Worker = worker
      process.chdir(cwd)
      process.removeAllListeners("SIGUSR2")
      for (const listener of sigusr2) {
        process.on("SIGUSR2", listener)
      }
      mock.restore()
    }
  })
})
