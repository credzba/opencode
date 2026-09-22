# Local Upstream Sync & Build Notes

This repository is a fork (`credzba/opencode`) of the upstream project (`anomalyco/opencode`).
Work happens on `dev`. Upstream's default branch is also `dev`; there is no `main` branch.

Keep this file up to date whenever the local workflow changes.

## Remotes

- `origin` -> `git@github.com:credzba/opencode.git` (the fork)
- upstream is fetched on demand from `https://github.com/anomalyco/opencode.git`

## Syncing latest upstream changes

```powershell
# Optional safety net before touching history
git branch backup/dev-before-sync HEAD

# 1. Catch up with the fork remote first (fast-forwards your own merged work)
git fetch origin
git merge --ff-only origin/dev

# 2. Fetch and merge upstream dev
git fetch https://github.com/anomalyco/opencode.git dev:refs/remotes/upstream/dev
git merge upstream/dev --no-edit

# 3. Refresh deps and verify
bun install
bun typecheck   # run from the package dirs (e.g. packages/opencode, packages/tui)
```

`git merge --ff-only origin/dev` is safe because local `dev` is normally an ancestor of
`origin/dev`. If it is not, stop and inspect before merging.

### Conflicts to expect and how to resolve them

- `packages/opencode/src/cli/cmd/tui.ts` - the fork pins `if (process.platform === "win32") process.exit(0)`
  to keep a Windows exit fix. Upstream may instead call `process.exit()`. Keep the fork's conditional.
- `packages/tui/src/config/index.tsx` - the fork adds a `linux_clipboard_selection` setting; upstream may
  add unrelated settings such as `cursor`. Keep both: include both in the `Resolved` `Omit` list, both
  fields, and both `resolve(...)` entries.

More generally, when a conflict is "fork feature vs upstream feature", keep both sides.

## Version shown by local builds

`packages/script/src/index.ts` computes the build version. For preview (non-`latest`) channels the
version now comes from `packages/opencode/package.json`, so a local build reports the current synced
version (for example `1.18.32`) instead of the old `0.0.0-dev-<timestamp>` placeholder.

It updates automatically every time upstream is merged - no manual step.

## Building the executable (Windows x64)

Run from `packages/opencode`:

```powershell
bun run script/build.ts --single --skip-embed-web-ui
```

- `--single` builds only the current platform (the default builds all 12 OS/arch targets).
- `--skip-embed-web-ui` skips the app/Vite bundle. The full build currently panics in a native
  dependency during `vite build` (`napi-sys` "Node-API symbol has not been loaded"); embedded web UI is
  not used, so skipping it is fine. The server's dynamic import falls back to `null`.
- The build wipes `dist` first and finishes with a smoke test that prints the version.

Output: `packages/opencode/dist/opencode-windows-x64/bin/opencode.exe`

## Installing to `~/bin`

`C:\Users\Credzba\bin` is on `PATH`.

```powershell
Copy-Item -LiteralPath "packages\opencode\dist\opencode-windows-x64\bin\opencode.exe" `
  -Destination "$HOME\bin\opencode.exe" -Force
```

Verify:

```powershell
& "$HOME\bin\opencode.exe" --version
```

Windows locks a running `.exe`, so stop any running `opencode` before copying (otherwise the
`-Force` copy fails). A common workaround is to copy to `opencode.exe.working`, stop the running
instance, then swap.
