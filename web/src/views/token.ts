/**
 * The "needs a token" screen (ODW extension): `odw serve --token` answers
 * every API read with 401 until this browser gives the token. The URL it
 * printed carries it as `#token=…`, which the app trades for the server's
 * cookie on load; this screen is for a link without it.
 */
import { icons } from "../icons";
import { t } from "../i18n";

/** A padlock in hairlines whose shackle closes, with the signal dot as its keyhole. */
const LOCK =
  `<svg class="tk-lock" viewBox="0 0 96 96" aria-hidden="true">` +
  `<path class="shackle" pathLength="1" d="M30 44V32a18 18 0 0 1 36 0v12"/>` +
  `<rect class="body" x="20" y="44" width="56" height="40" rx="9"/>` +
  `<circle class="hole" cx="48" cy="61" r="4.5"/><path class="hole-line" d="M48 65v8"/></svg>`;

export function renderTokenScreen(error: "wrong" | "locked" | null): string {
  const why =
    error === "locked"
      ? t("Too many wrong tokens from here. Wait a minute, then try again.")
      : error === "wrong"
        ? t("That token was refused.")
        : "";
  return (
    `<div class="token-screen">` +
    `<div class="tk-card">` +
    LOCK +
    `<div class="eyebrow">${t("Remote dashboard")}</div>` +
    `<h1 class="display">${t("This dashboard needs a token.")}</h1>` +
    `<p class="lede">${t("Its owner started it with {cmd}. Open the URL it printed (it ends in {hash}), or paste the token here. It stays read-only either way.", { cmd: "<code>odw serve --token</code>", hash: "<code>#token=…</code>" })}</p>` +
    `<form class="tk-form${why ? " bad" : ""}" data-token-form>` +
    `<input class="mono" type="password" name="token" autocomplete="off" spellcheck="false" placeholder="${t("token")}" aria-label="${t("token")}" required>` +
    `<button class="btn primary" type="submit">${icons.arrow}${t("Open")}</button>` +
    `</form>` +
    (why ? `<p class="tk-why" role="alert">${why}</p>` : "") +
    `</div></div>`
  );
}
