# `@odw/desktop` — read-only Tauri shell

A thin macOS shell around the ODW observatory. It owns **no run state**: it
spawns `odw serve` as a sidecar, waits for the local HTTP server, then points a
single webview at it — the same SPA a browser loads from `odw serve`. There is
one renderer and zero "native vs web" fork. The Rust layer only adds presentation
glue: a tray item, a Dock badge fed by the web layer, native notifications on run
transitions, and "close hides, stays resident".

> **Read-only invariant.** Nothing in this process starts, controls, or mutates a
> run. The capability allow-list (`src-tauri/capabilities/default.json`) only
> permits spawning `binaries/odw serve --port <digits>` — there is no surface to
> POST `/api/runs/:id/control`.

## ⚠️ Build status: authored, not compiled here

The Rust shell was written and reviewed but **has not been compiled in this
environment** — there is no `cargo`/`rustc`/`@tauri-apps/cli` toolchain available
where it was authored. Treat `src-tauri/` as code that is correct by inspection
and against the Tauri 2 API, but that still needs a first real `tauri build` on a
machine with the toolchain installed. The web SPA it loads **is** built and
verified (`npm run build:web` at the repo root, served by `odw serve`).

## Prerequisites

- **Rust** (stable) + Cargo — <https://rustup.rs>
- **Xcode Command Line Tools** (`xcode-select --install`) — for the macOS bundler
- **Node** ≥ 18 and the workspace deps: `npm install` at the repo root
- The Tauri CLI is a dev dependency of this package (`@tauri-apps/cli ^2`); it is
  invoked through the `tauri` script, so no global install is required.

## How the sidecar binary is produced

Tauri embeds the `odw` runtime as an `externalBin` sidecar. It must be named with
the Rust host target triple (e.g. `odw-aarch64-apple-darwin`). Two steps:

```bash
# 1) Build the single-file runtime binary from the repo root.
#    (esbuild + Node SEA + postject — see scripts/build-binary.mjs)
npm run build:binary          # → ./odw

# 2) Stage it as a sidecar under the expected triple-suffixed name.
cd apps/desktop
npm run bundle:sidecar        # ./odw → src-tauri/binaries/odw-<triple>
```

`bundle:sidecar` (→ `scripts/bundle-sidecar.mjs`) resolves the triple via
`rustc -Vv`, finds the binary at `./odw` (or `dist/odw`, `build/odw`, or a path
you pass), and copies it into `src-tauri/binaries/`. It runs automatically as the
`predev`/`prebuild` hook, so the commands below stage the sidecar for you.

## Build & run

```bash
cd apps/desktop

# Dev: hot-reloads the Rust shell; the webview still loads the *built* SPA via
# odw serve, so run `npm run build:web` at the repo root first (or after SPA edits).
npm run dev

# Release: produces a signed/notarizable .app + .dmg under
# src-tauri/target/release/bundle/ (signing config is left to CI — see below).
npm run build
```

## Icons (placeholder)

`tauri.conf.json` references `icons/` (app icon set + `icons/tray.png` as a
template image) which are **not yet committed**. Generate them once you have an
app glyph:

```bash
cd apps/desktop
npx @tauri-apps/cli icon path/to/odw-logo.png   # fills src-tauri/icons/
```

The tray icon should be a monochrome template PNG (`iconAsTemplate: true`) so it
adapts to light/dark menu bars.

## What the shell does (and deliberately does not)

| Concern | Where | Note |
|---|---|---|
| Spawn `odw serve` sidecar | `src/lib.rs · spawn_sidecar` | fixed loopback port `4317` for v1 |
| Wait-for-ready, then navigate once | `probe` + `navigate_once` | TCP connect probe; no extra deps |
| Tray (Show / Quit) | `build_tray` | |
| Native notifications on terminal runs | `listen_for_notifications` | driven by a `run:transition` event the **web** layer emits (`web/src/native.ts`) |
| Dock badge = active run count | emitted from `web/src/native.ts` | shell holds no run state |
| Close hides; app stays resident | `on_window_event` / `ExitRequested` | the detached worker keeps running |

**Rust red line:** the shell never parses `events.jsonl`, computes run state, or
starts/controls a run. Everything it shows comes from the localhost API.

## Release wiring (TODO)

`.github/workflows/release.yml` already emits a per-OS `odw` binary. To ship the
`.app`, add a step after that binary exists: `bundle:sidecar` → `tauri build`
with Developer ID signing + notarization. The web build ships for free with the
binary (`odw serve`).
