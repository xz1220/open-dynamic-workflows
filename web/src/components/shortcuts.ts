/**
 * The keyboard cheat sheet (press "?"): every shortcut the dashboard answers to,
 * in one overlay that shares the command palette's card style.
 */
import { t } from "../i18n";
import { esc } from "../util";

let el: HTMLElement | null = null;

export function shortcutsOpen(): boolean {
  return Boolean(el?.classList.contains("open"));
}

function keys(...ks: string[]): string {
  return ks.map((k) => `<kbd>${esc(k)}</kbd>`).join(" ");
}

function build(): string {
  const mod = /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘" : "Ctrl";
  const groups: Array<[string, Array<[string, string]>]> = [
    [
      t("Anywhere"),
      [
        [`${keys(mod, "K")} ${t("or")} ${keys("/")}`, t("Search runs, workflows and commands…")],
        [`${keys("g")} ${keys("a")}`, t("Activity")],
        [`${keys("g")} ${keys("j")}`, t("Jobs")],
        [`${keys("g")} ${keys("w")}`, t("Workspace")],
        [`${keys("g")} ${keys("e")}`, t("Evals")],
        [`${keys("g")} ${keys("c")}`, t("Chat Host")],
        [`${keys("g")} ${keys("s")}`, t("Settings")],
        [keys("?"), t("Keyboard shortcuts")],
      ],
    ],
    [
      t("A run"),
      [
        [keys("1", "2", "3", "4", "5"), `${t("Graph")} · ${t("Timeline")} · ${t("Logs")} · ${t("Result")} · ${t("Changes")}`],
        [keys("j", "k"), t("Next / previous agent with changes")],
        [keys("$"), t("Where this run spent")],
        [keys("+", "-"), `${t("Zoom in")} / ${t("Zoom out")}`],
        [keys("0"), t("Fit to screen")],
        [keys("Esc"), t("Close")],
        [`${keys("Enter")}`, t("Open the focused node or row")],
      ],
    ],
    [t("Chat Host"), [[keys(mod, "Enter"), t("Send")]]],
  ];
  return (
    `<div class="pal keys-card" role="document">` +
    `<div class="pal-in"><span class="keys-title">${esc(t("Keyboard shortcuts"))}</span><kbd>esc</kbd></div>` +
    `<div class="pal-list">` +
    groups
      .map(
        ([title, rows]) =>
          `<div class="pal-group">${esc(title)}</div>` +
          rows.map(([k, label]) => `<div class="keys-row"><span>${esc(label)}</span><span>${k}</span></div>`).join(""),
      )
      .join("") +
    `</div></div>`
  );
}

export function toggleShortcuts(): void {
  if (shortcutsOpen()) return closeShortcuts();
  if (!el) {
    el = document.createElement("div");
    el.id = "keys";
    el.setAttribute("role", "dialog");
    el.setAttribute("aria-modal", "true");
    el.addEventListener("mousedown", (e) => {
      if (e.target === el) closeShortcuts();
    });
    document.body.appendChild(el);
  }
  el.innerHTML = build();
  el.classList.add("open");
}

export function closeShortcuts(): void {
  el?.classList.remove("open");
}
