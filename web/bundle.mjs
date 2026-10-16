/**
 * Shared bundler for the client SPA — used by build.mjs (production) and
 * dev.mjs (live development).
 *
 * esbuild (a build-only devDependency of the root package, resolved up the tree)
 * bundles the vanilla-TS app to one IIFE and the stylesheet tree to one CSS
 * file; both are inlined into the HTML shell together with the display face, so
 * the output is a single zero-dependency document the embed pipeline can serve
 * from `odw serve` and the SEA binary — no CDN, no network on load.
 */
import { build } from "esbuild";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const webRoot = fileURLToPath(new URL(".", import.meta.url));

/** The display face, inlined as data: URLs (latin subset, ~43KB of woff2). */
function fontFaces() {
  const face = (style, file) => {
    const b64 = readFileSync(`${webRoot}src/fonts/${file}`).toString("base64");
    return (
      `@font-face{font-family:"Instrument Serif";font-style:${style};font-weight:400;` +
      `font-display:swap;src:url(data:font/woff2;base64,${b64}) format("woff2");}`
    );
  };
  return (
    "/* Instrument Serif © The Instrument Serif Project Authors — SIL Open Font License 1.1 (see web/src/fonts/OFL.txt) */\n" +
    face("normal", "instrument-serif-latin-400-normal.woff2") +
    face("italic", "instrument-serif-latin-400-italic.woff2")
  );
}

/**
 * Build the self-contained index.html. `minify: false` keeps the output
 * readable for development; production minifies both JS and CSS.
 */
export async function bundleHtml({ minify = true } = {}) {
  const common = {
    bundle: true,
    minify,
    // Keep CJK (the zh i18n strings) as raw UTF-8 rather than \uXXXX escapes —
    // the HTML shell is UTF-8, so this is smaller and readable in the bundle.
    charset: "utf8",
    legalComments: "none",
    write: false,
    logLevel: "silent",
  };
  const [js, css] = await Promise.all([
    build({
      ...common,
      entryPoints: [`${webRoot}src/main.ts`],
      format: "iife",
      platform: "browser",
      target: ["es2020"],
    }),
    build({
      ...common,
      entryPoints: [`${webRoot}src/styles/index.css`],
      target: ["chrome110", "safari16", "firefox115"],
    }),
  ]);
  // An inline <script> ends at the first `</script`, wherever it appears.
  const script = js.outputFiles[0].text.replace(/<\/script/gi, "<\\/script");
  const style = fontFaces() + "\n" + css.outputFiles[0].text;
  const tmpl = readFileSync(`${webRoot}index.html`, "utf8");
  // Function replacers so `$` sequences in the css/js are inserted verbatim.
  return tmpl.replace("/*INLINE_CSS*/", () => style).replace("/*INLINE_JS*/", () => script);
}
