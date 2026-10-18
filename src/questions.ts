/**
 * Agent questions (an ODW extension): what happens when an agent stops to ask
 * the user something in a headless run.
 *
 * A CLI run headless has nobody to answer its clarifying tool — Claude Code's
 * `AskUserQuestion` returns at once with an empty answer, or waits out a
 * timeout, and the model goes on guessing (anthropics/claude-code#50728,
 * #73125, #61337). ODW reads the call from the CLI's stream (the adapter's
 * `output.questions` rules; the built-in claude declares AskUserQuestion's),
 * kills the CLI at once — an agent never goes on with an empty answer — and
 * then does what `questions` says, the agent()'s own, else its adapter's,
 * else the run's:
 *
 *   - `"checkpoint"` (the default): the question becomes a checkpoint — the
 *     same `odw approve|reject`, dashboard card, `notify` "waiting" hook and
 *     one-time approve links as a checkpoint() — and the person's answer
 *     (`--note`, or an edited payload's `answer`) is added to the prompt as
 *     "earlier you asked X, the user answered Y" for a new run of the same
 *     call, in the same worktree; a rejection fails it with `needs_input`.
 *   - `"fail"`: the agent fails at once with reason `needs_input`, its
 *     questions on the failure.
 *   - `"deny"`: the CLI runs without its question tool (the adapter's
 *     `questionArgs`; the built-in claude's `--disallowedTools
 *     AskUserQuestion`), and the prompt tells the agent to assume and say so.
 *     A question asked anyway fails it with `needs_input`.
 *
 * No question is guessed from a reply's text (one that ends in "?", say):
 * only the CLI's own tool call counts. No CLI session is resumed either —
 * each CLI's session semantics differ — the call runs again, told the answer.
 */

/** What an agent's question does (see the module notes). */
export type QuestionPolicy = "fail" | "checkpoint" | "deny";

export const QUESTION_POLICIES: readonly QuestionPolicy[] = ["fail", "checkpoint", "deny"];

export function isQuestionPolicy(value: unknown): value is QuestionPolicy {
  return (QUESTION_POLICIES as readonly unknown[]).includes(value);
}

/** One question an agent asked, as its CLI's tool call put it. */
export interface AgentQuestion {
  /** The question itself. */
  question: string;
  /** Its short heading, when the tool gave one. */
  header?: string;
  /** The answers it offered, when it offered any. */
  options?: string[];
  /** More than one of the options may be chosen. */
  multiSelect?: boolean;
}

/** Times one agent() call may ask and be answered before a further question fails it with `needs_input`. */
export const MAX_QUESTION_ROUNDS = 3;

/** Questions one tool call keeps, options one question keeps, and the characters of each. */
export const MAX_QUESTIONS = 10;
export const MAX_OPTIONS = 20;
export const QUESTION_CHARS = 1000;
export const OPTION_CHARS = 200;

/** One question, in one line: "Which database? (options: Postgres / SQLite)". */
export function questionLine(q: AgentQuestion): string {
  const options = q.options && q.options.length > 0 ? ` (${q.multiSelect ? "choose any of" : "options"}: ${q.options.join(" / ")})` : "";
  return `${q.question}${options}`;
}

/** The title of the checkpoint a question becomes: "<label> asks: <the first question>" (and how many more). */
export function questionTitle(label: string, questions: readonly AgentQuestion[]): string {
  const first = questions[0]?.question ?? "a question";
  const more = questions.length > 1 ? ` (+${questions.length - 1} more)` : "";
  return `${label} asks: ${first}${more}`;
}

/** One round of questions, and what the person answered (null: approved with no answer). */
export interface AnsweredRound {
  questions: AgentQuestion[];
  answer: string | null;
}

/**
 * What a call that asked is told when it runs again: each question it asked,
 * and the answer — appended to its prompt, so any CLI can take it.
 */
export function answeredBrief(rounds: readonly AnsweredRound[]): string {
  const parts = rounds.map(({ questions, answer }) => {
    const asked = questions.map((q) => `- ${questionLine(q)}`).join("\n");
    const said =
      answer === null
        ? "The user gave no specific answer: use your best judgement, and say in your reply what you assumed."
        : `The user answered: ${answer}`;
    return `Earlier in this task you stopped to ask the user:\n${asked}\n${said}`;
  });
  return (
    `${parts.join("\n\n")}\n\n` +
    "Go on with the task with this answer. Do not ask again about what was answered here; if something else is " +
    "unclear, make a reasonable assumption and say so in your reply."
  );
}

/** What a `"deny"` call's prompt says: nobody can answer, so assume and say so. */
export const DENY_PROMPT =
  "No one can answer questions while you work on this task. Where something is unclear, make a reasonable " +
  "assumption, carry on, and state the assumptions you made in your reply.";

/**
 * The answer in a person's approval of a question's checkpoint: the note,
 * else the `answer` of an edited payload — null when there is neither.
 */
export function answerOf(result: { note: string | null; edited: boolean; payload: unknown }): string | null {
  const note = result.note?.trim();
  if (note) return note;
  if (result.edited && result.payload !== null && typeof result.payload === "object" && !Array.isArray(result.payload)) {
    const answer = (result.payload as { answer?: unknown }).answer;
    if (typeof answer === "string" && answer.trim()) return answer.trim();
  }
  return null;
}

/** At most `max` characters, ending in an ellipsis when cut. */
export function clipText(text: string, max: number): string {
  const chars = Array.from(text.replace(/\s+/g, " ").trim());
  return chars.length <= max ? chars.join("") : chars.slice(0, max - 1).join("") + "…";
}
