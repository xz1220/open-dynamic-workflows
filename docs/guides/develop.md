# Developing ODW

English · [简体中文](../zh-CN/guides/develop.md)

Working on ODW itself.

## Develop

```bash
npm ci                # install the locked build dependencies
npm run build         # tsc → dist/
npm test              # node:test suite, driven by a mock adapter (no real accounts)
npm run typecheck     # tsc --noEmit
npx tsx src/cli.ts conformance   # the dialect conformance suite (conformance/); also part of npm test
npm run build:binary  # bundle + Node SEA + postject → a single self-contained ./build/odw
```

Working on the dashboard? Seed a simulated fleet that keeps moving, point a server
at it, and run the dev server — it rebuilds `web/src` on every page load and proxies
`/api` (SSE included) to that server:

```bash
node web/demo-fixtures.mjs /tmp/odw-demo/runs /tmp/odw-demo/project --live &
echo '{"runsRoot":"/tmp/odw-demo/runs"}' > /tmp/odw-demo/odw.config.json
(cd /tmp/odw-demo/project && npx tsx "$OLDPWD/src/cli.ts" serve --config /tmp/odw-demo/odw.config.json --port 4317) &
node web/dev.mjs --api http://127.0.0.1:4317     # → http://127.0.0.1:5173
```

To update a local source installation, build the updated checkout and run
`npm install -g .`, then copy its `skills/open-dynamic-workflows/` directory into
your agent's skills directory. Existing npm-linked checkouts use the rebuilt
`dist/` immediately.

`package.json` is the version source. Source builds identify themselves as
`0.5.0-dev+g<revision>` (`.dirty` marks uncommitted changes); source archives use
`0.5.0-dev+source`. Build scripts generate the embedded version before compiling
or testing. Release builds set `ODW_RELEASE_TAG=v0.5.0` and require a clean
checkout at that tag, matching package and lockfile versions, passing tests and
type checks, and a binary that reports the expected version. The release workflow
publishes only after all platform builds succeed.

To cut a release, `node scripts/prepare-release.mjs <version> [--date YYYY-MM-DD]
[--dry-run]` sets the package and lockfile version, turns `CHANGELOG.md`'s
`## Unreleased` into `## <version> — <date>` under a new empty `## Unreleased`, and
points the docs' `action@v…` pins at the new tag; it then prints the `git` commands
that commit, tag and push — it runs none of them. The tag's workflow publishes that
changelog section as the release notes, and fails when the section is missing.

`build:binary` follows the standard single-executable recipe: [esbuild](https://esbuild.github.io/)
bundles `dist/` (zero-dep ESM) into one CommonJS file, `node --experimental-sea-config`
turns it into a [SEA](https://nodejs.org/api/single-executable-applications.html)
blob, and [postject](https://github.com/nodejs/postject) grafts that blob into a
copy of the `node` binary (ad-hoc code-signed on macOS). esbuild and postject are
**build-only devDependencies** — the binary and the npm package stay zero
*runtime* dependencies. Cross-platform binaries are built per-OS in CI
([`.github/workflows/release.yml`](../../.github/workflows/release.yml)); SEA injects
into the host's `node`, so each target is built on its own runner.

> Once published, `npm i -g odw` (or `npx odw …`) puts the `odw` command on your PATH.
