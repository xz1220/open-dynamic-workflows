# 参与开发 ODW

[English](../../guides/develop.md) · 简体中文

开发 ODW 本身。

## 开发

```bash
npm ci                # 安装锁定版本的构建依赖
npm run build         # tsc → dist/
npm test              # node:test 测试套件,由 mock 适配器驱动(无需真实账号)
npm run typecheck     # tsc --noEmit
npx tsx src/cli.ts conformance   # 方言一致性测试套件(conformance/);npm test 也会运行
npm run build:binary  # 打包 + Node SEA + postject → 单个自包含的 ./build/odw
```

要开发看板:先生成一组持续推进的模拟运行,让一个 server 指向它,再启动开发服务器——它会在每次
刷新页面时重新构建 `web/src`,并把 `/api`(含 SSE)代理到那个 server:

```bash
node web/demo-fixtures.mjs /tmp/odw-demo/runs /tmp/odw-demo/project --live &
echo '{"runsRoot":"/tmp/odw-demo/runs"}' > /tmp/odw-demo/odw.config.json
(cd /tmp/odw-demo/project && npx tsx "$OLDPWD/src/cli.ts" serve --config /tmp/odw-demo/odw.config.json --port 4317) &
node web/dev.mjs --api http://127.0.0.1:4317     # → http://127.0.0.1:5173
```

更新本地源码安装时,先构建更新后的目录,再运行 `npm install -g .`,并将同目录的
`skills/open-dynamic-workflows/` 复制到 agent 的技能目录。已经通过 npm 链接到源码的安装,
会直接使用重新构建的 `dist/`。

版本以 `package.json` 为准。源码构建显示 `0.5.0-dev+g<修订号>`,有未保存修改时附加
`.dirty`;不含 Git 记录的源码包显示 `0.5.0-dev+source`。构建或测试前会生成内嵌版本信息。
正式构建设置 `ODW_RELEASE_TAG=v0.5.0`,要求当前源码正好对应该版本、没有未保存修改,
包版本与锁文件一致,测试和类型检查通过,且二进制报告预期版本。所有平台构建成功后才发布。

发版时运行 `node scripts/prepare-release.mjs <version> [--date YYYY-MM-DD] [--dry-run]`:它修改
package 与锁文件的版本,把 `CHANGELOG.md` 的 `## Unreleased` 改名为 `## <version> — <日期>`
并在其上新开一个空的 `## Unreleased`,把文档里的 `action@v…` 固定版本改成新 tag,然后打印提交、
打 tag、推送所需的 `git` 命令——它自己一条都不执行。tag 触发的发布流程以这一节 changelog 作为
Release 正文,找不到这一节则发布失败。

`build:binary` 走的是标准的单二进制配方:[esbuild](https://esbuild.github.io/) 把
`dist/`(零依赖 ESM)打包成一个 CommonJS 文件,`node --experimental-sea-config` 生成
[SEA](https://nodejs.org/api/single-executable-applications.html) blob,再由
[postject](https://github.com/nodejs/postject) 把 blob 注入到一份 `node` 二进制的拷贝里
(macOS 下做 ad-hoc 签名)。esbuild 和 postject 都是**仅构建用的 devDependency**——
二进制和 npm 包仍保持零**运行时**依赖。跨平台二进制在 CI 里按操作系统分别构建
([`.github/workflows/release.yml`](../../../.github/workflows/release.yml)):SEA 注入的是宿主
机的 `node`,所以每个目标平台都要在各自的 runner 上构建。

> 发布后,`npm i -g odw`(或 `npx odw …`)会把 `odw` 命令装到你的 PATH 上。
