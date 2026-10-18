/**
 * The "needs a token" screen (ODW extension): `odw serve --token` answers
 * every API read with 401 until this browser gives the token. The URL it
 * printed carries it as `#token=…`, which the app trades for the server's
 * cookie on load; this screen is for a link without it.
 */
import { icons } from "../icons";
import { t } from "../i18n";

export function renderTokenScreen(error: "wrong" | "locked" | null): string {
  const why =
    error === "locked"
      ? t("Too many wrong tokens from here. Wait a minute, then try again.")
      : error === "wrong"
        ? t("That token was refused.")
        : "";
  return (
    `<div class="page token-screen">` +
    `<header class="page-head"><div><div class="eyebrow">${t("Remote dashboard")}</div>` +
    `<h1 class="display">${t("This dashboard needs a token.")}</h1>` +
    `<p class="lede" style="margin-top:12px">${t("Its owner started it with {cmd}. Open the URL it printed (it ends in {hash}), or paste the token here. It stays read-only either way.", { cmd: "<code>odw serve --token</code>", hash: "<code>#token=…</code>" })}</p></div></header>` +
    `<form class="card setcard" data-token-form style="max-width:520px;padding:16px;display:flex;gap:10px;align-items:center">` +
    `<input class="input mono" type="password" name="token" autocomplete="off" spellcheck="false" placeholder="${t("token")}" aria-label="${t("token")}" style="flex:1" required>` +
    `<button class="btn" type="submit">${icons.terminal}${t("Open")}</button>` +
    `</form>` +
    (why ? `<p class="dim" role="alert" style="margin-top:10px">${why}</p>` : "") +
    `</div>`
  );
}
