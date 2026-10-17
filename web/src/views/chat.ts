/**
 * Chat Host view.
 *
 * The data comes from the local `/api/chat/*` backend. A hosted turn can attach
 * a real ODW run; the tool card is hydrated from the same run stream as Jobs.
 */
import { pill } from "../components/glyph";
import { icons } from "../icons";
import { t, tn } from "../i18n";
import type { ChatMessage, ChatSession, ChatSessionState, ChatSessionSummary, ChatToolStatus } from "../types";
import { esc, fmtClock } from "../util";
import { emptyArt } from "./activity";

interface ChatRenderState {
  creating: boolean;
  sending: boolean;
  error: string;
  missingId: string | null;
  writable: boolean;
}

const SYSTEM_MESSAGES = {
  "chat.ready":
    "This local Chat Host session is ready. Mention ODW or workflow to attach a real ODW run to the turn.",
  "chat.linked":
    "I linked this turn to a local ODW run. The tool card will update from the run stream as it settles.",
  "chat.recorded":
    "I recorded this turn in the local Chat Host. Mention ODW or workflow when you want this conversation to attach a run.",
} as const;

const LEGACY_MESSAGE_KIND = new Map<string, keyof typeof SYSTEM_MESSAGES>(
  Object.entries(SYSTEM_MESSAGES).map(([kind, text]) => [text, kind as keyof typeof SYSTEM_MESSAGES]),
);

const EVENT_LABELS: Record<string, string> = {
  run_started: "Run started",
  run_finished: "Run finished",
  run_failed: "Run failed",
  run_stopped: "Run stopped",
  phase_started: "Phase started",
  agent_started: "Agent started",
  agent_finished: "Agent finished",
  agent_failed: "Agent failed",
  log: "Log",
};

function stateBadge(state: ChatSessionState | ChatToolStatus): string {
  return pill(state === "idle" ? "idle" : state, t(state));
}

function messageText(m: ChatMessage): string {
  const rawKind = m.kind ?? LEGACY_MESSAGE_KIND.get(m.text);
  const kind = rawKind && rawKind in SYSTEM_MESSAGES ? (rawKind as keyof typeof SYSTEM_MESSAGES) : undefined;
  return kind ? t(SYSTEM_MESSAGES[kind]) : m.text;
}

function errorBanner(error: string): string {
  return error ? `<div class="chat-error" role="alert">${esc(t(error))}</div>` : "";
}

function sessionRow(s: ChatSessionSummary, activeId: string | null): string {
  const on = s.id === activeId ? " on" : "";
  const lastKind = LEGACY_MESSAGE_KIND.get(s.lastMessage);
  const last = lastKind ? t(SYSTEM_MESSAGES[lastKind]) : s.lastMessage || t("No messages yet.");
  return (
    `<button class="chat-session${on}" data-chat-session="${esc(s.id)}" data-key="cs-${esc(s.id)}">` +
    `<span class="chat-session-top"><b>${esc(s.title)}</b>${stateBadge(s.state)}</span>` +
    `<span class="chat-session-msg">${esc(last)}</span>` +
    `<span class="chat-session-meta">${esc(s.source)} · ${fmtClock(s.updatedAt)}${s.linkedRuns ? ` · ${tn(s.linkedRuns, "{n} linked run", "{n} linked runs")}` : ""}</span>` +
    `</button>`
  );
}

function messageHtml(m: ChatMessage): string {
  if (m.role === "tool" && m.tool) return toolCard(m);
  const who = m.role === "user" ? t("You") : "Codex";
  const streaming = m.status === "streaming";
  const failed = m.status === "failed";
  const state = streaming ? " streaming" : failed ? " failed" : "";
  return (
    `<div class="chat-msg ${m.role}${state}" data-key="m-${esc(m.id)}">` +
    `<div class="chat-avatar">${m.role === "user" ? "u" : "c"}</div>` +
    `<div class="chat-bubble"><div class="chat-msg-head"><b>${who}</b><span>${fmtClock(m.ts)}</span></div>` +
    `<div class="chat-text">${esc(messageText(m))}${streaming ? `<span class="chat-caret"></span>` : ""}</div></div>` +
    `</div>`
  );
}

function toolCard(m: ChatMessage): string {
  const tool = m.tool!;
  const eventRows = tool.events
    .map(
      (e, i) =>
        `<div class="tool-event" data-key="te-${i}"><span>${fmtClock(e.ts)}</span><b>${esc(t(EVENT_LABELS[e.type] ?? e.type))}</b><em>${esc(e.label === "run requested" ? t("run requested") : e.label)}</em></div>`,
    )
    .join("");
  const result = tool.result ? `<div class="tool-result">${esc(tool.result)}</div>` : "";
  const pct = Math.round(tool.progress * 100);
  return (
    `<div class="chat-msg tool" data-key="m-${esc(m.id)}">` +
    `<div class="chat-avatar">o</div>` +
    `<div class="tool-card s-${esc(tool.status)}">` +
    `<div class="tool-head"><span class="tool-name">${esc(tool.name)}</span>${stateBadge(tool.status)}</div>` +
    `<div class="tool-title">${esc(tool.workflow)}</div>` +
    `<div class="tool-sub"><span class="mono" data-run="${esc(tool.runId)}">${esc(tool.runId)} ↗</span><span>${t("phase")}: ${esc(tool.phase)}</span><span>${pct}%</span></div>` +
    `<div class="tool-progress prog thin"><i class="${tool.status === "running" ? "p-run" : tool.status === "failed" ? "p-fail" : "p-done"}" style="width:${pct}%"></i></div>` +
    `<div class="tool-events">${eventRows || `<div class="tool-event"><em>${t("Waiting for events...")}</em></div>`}</div>` +
    result +
    `</div></div>`
  );
}

function linkedRuns(session: ChatSession): string {
  if (session.linkedRuns.length === 0) return `<div class="chat-empty-side">${t("No linked ODW runs yet.")}</div>`;
  return session.linkedRuns
    .map(
      (r) =>
        `<div class="linked-run" data-run="${esc(r.runId)}" data-key="lr-${esc(r.runId)}">` +
        `<div class="top"><b>${esc(r.workflow)}</b>${pill(r.state)}</div>` +
        `<span class="rid">${esc(r.runId)}</span>` +
        `<div class="prog thin"><i class="${r.state === "running" ? "p-run" : r.state === "failed" ? "p-fail" : "p-done"}" style="width:${Math.round(r.progress * 100)}%"></i></div>` +
        `</div>`,
    )
    .join("");
}

function timeline(session: ChatSession | null): string {
  const linked = session?.linkedRuns.length ?? 0;
  const running = session?.linkedRuns.some((r) => r.state === "running" || r.state === "pending" || r.state === "stale");
  const done = session?.linkedRuns.some((r) => r.state === "done");
  const rows: Array<[string, string, boolean]> = [
    [t("User message"), session ? t("stored by local server") : t("waiting"), Boolean(session)],
    [t("Host turn"), running ? t("watching ODW run") : session ? t("idle") : t("waiting"), Boolean(running)],
    [t("ODW bridge"), linked ? tn(linked, "{n} linked run", "{n} linked runs") : t("waiting"), linked > 0],
    [t("Tool result"), done ? t("available") : t("pending"), Boolean(done)],
  ];
  return rows
    .map(([title, sub, on]) => `<div class="host-step${on ? " on" : ""}"><b>${esc(title)}</b><span>${esc(sub)}</span></div>`)
    .join("");
}

function disabledComposer(draft: string, hint: string, error: string): string {
  return (
    `<footer class="chat-composer">` +
    errorBanner(error) +
    `<textarea id="chat-input" rows="3" placeholder="${esc(t("Create a session first."))}" disabled>${esc(draft)}</textarea>` +
    `<div class="chat-compose-actions"><span>${esc(t(hint))}</span>` +
    `<button class="btn primary disabled" disabled aria-disabled="true">${icons.send}${t("Send")}</button></div>` +
    `</footer>`
  );
}

function emptyThread(draft: string, status: ChatRenderState): string {
  const newAttrs = status.creating || !status.writable ? ` disabled aria-disabled="true"` : "";
  return (
    `<section class="chat-thread">` +
    emptyArt(
      t("No chat sessions yet"),
      t("Create a hosted turn to start."),
      `<div class="chat-empty-actions"><button class="btn primary" data-chat-new="1"${newAttrs}>${icons.plus}${status.creating ? t("Creating...") : t("New session")}</button></div>`,
    ) +
    disabledComposer(draft, "The local backend will store messages and linked runs.", status.error) +
    `</section>`
  );
}

function missingThread(draft: string, missingId: string, sessions: ChatSessionSummary[] | null, status: ChatRenderState): string {
  const first = sessions?.[0]?.id ?? null;
  const newAttrs = status.creating || !status.writable ? ` disabled aria-disabled="true"` : "";
  const openFirst = first
    ? `<button class="btn" data-chat-session="${esc(first)}">${t("Open latest session")}</button>`
    : "";
  return (
    `<section class="chat-thread">` +
    emptyArt(
      t("Chat session not found"),
      `<span class="mono">${esc(missingId)}</span>`,
      `<div class="chat-empty-actions">${openFirst}<button class="btn primary" data-chat-new="1"${newAttrs}>${icons.plus}${status.creating ? t("Creating...") : t("New session")}</button></div>`,
    ) +
    disabledComposer(draft, "Choose an existing session or create a new one.", status.error) +
    `</section>`
  );
}

export function renderChat(
  sessions: ChatSessionSummary[] | null,
  session: ChatSession | null,
  draft: string,
  activeId: string | null,
  status: ChatRenderState,
): string {
  const list = sessions ?? [];
  const rows =
    sessions === null
      ? `<div class="chat-empty-side">${t("Loading chat sessions...")}</div>`
      : list.length
        ? list.map((s) => sessionRow(s, activeId)).join("")
        : `<div class="chat-empty-side">${t("No chat sessions yet.")}</div>`;
  const codexStreaming = Boolean(session?.messages.some((m) => m.role === "assistant" && m.status === "streaming"));
  const composerLocked = status.sending || codexStreaming || !status.writable;
  const canSend = Boolean(session && draft.trim() && !composerLocked);
  const sendAttrs = canSend ? "" : ` disabled aria-disabled="true"`;
  const sendClass = canSend ? "" : " disabled";
  const mod = /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘" : "Ctrl";
  const thread = status.missingId
    ? missingThread(draft, status.missingId, sessions, status)
    : session
      ? `<section class="chat-thread">` +
        `<header class="chat-thread-head">` +
        `<div style="min-width:0"><h1>${esc(session.title)}</h1><p>${esc(session.source)}</p></div>` +
        `<div class="chat-head-actions"><div class="chat-head-tags"><span>${t("Codex host")}</span><span>${t("ODW bridge")}</span></div>` +
        `<button class="btn ghost sm" data-chat-delete="${esc(session.id)}">${icons.trash}${t("Delete")}</button></div>` +
        `</header>` +
        `<div class="chat-messages" data-chat-id="${esc(session.id)}">${session.messages.map(messageHtml).join("")}</div>` +
        `<footer class="chat-composer">` +
        errorBanner(status.error) +
        `<textarea id="chat-input" rows="3" placeholder="${esc(t("Ask Codex. Mention ODW or workflow to attach a local run."))}"${composerLocked ? " disabled" : ""}>${esc(draft)}</textarea>` +
        `<div class="chat-compose-actions"><span>${t("Messages are stored by the local backend.")} <kbd>${mod} ↵</kbd></span>` +
        `<button class="btn primary${sendClass}" data-chat-send="1"${sendAttrs}>${icons.send}${status.sending ? t("Sending...") : t("Send")}</button></div>` +
        `</footer>` +
        `</section>`
      : emptyThread(draft, status);
  const newAttrs = status.creating || !status.writable ? ` disabled aria-disabled="true"` : "";
  return (
    `<div class="chat-page">` +
    `<aside class="chat-list">` +
    `<div class="chat-list-head"><div><div class="eyebrow">${t("local backend")}</div><h2>${t("Chat Host")}</h2></div>` +
    `<button class="btn sm" data-chat-new="1"${newAttrs}>${icons.plus}${status.creating ? t("Creating...") : t("New")}</button></div>` +
    `<div class="chat-sessions">${rows}</div>` +
    `</aside>` +
    thread +
    `<aside class="chat-side">` +
    `<section><h3>${t("Host activity")}</h3>${timeline(session)}</section>` +
    `<section><h3>${t("Linked ODW runs")}</h3>${session ? linkedRuns(session) : `<div class="chat-empty-side">${t("No linked ODW runs yet.")}</div>`}</section>` +
    `<section><h3>${t("Tool contract")}</h3>` +
    `<pre>{\n  "tool": "odw.run",\n  "workflow": "chat-host-bridge",\n  "args": { ... }\n}</pre></section>` +
    `</aside>` +
    `</div>`
  );
}
