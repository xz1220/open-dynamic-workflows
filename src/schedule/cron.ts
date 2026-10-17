/**
 * Cron expressions for `odw schedule` (an ODW extension): parse and validate
 * the classic five fields, find the next time an expression fires in local
 * time, and expand it into what launchd, systemd timers and schtasks take.
 *
 *   minute  hour  day-of-month  month  day-of-week
 *   0-59    0-23  1-31          1-12   0-7 (0 and 7 are both Sunday)
 *
 * A field is a comma-separated list of `*`, `N`, `N-M`, `*\/S` and `N-M/S`;
 * month and day-of-week also take English names (jan-dec, sun-sat, any case).
 * That is the dialect Vixie cron — and so cronie, macOS and the BSDs — reads,
 * and the cron backend writes an expression into the crontab as it is, so
 * anything else (`@daily`, `L`, `W`, `#`, `?`, `5/15`, a sixth field) is
 * refused with a message that says why.
 *
 * Day-of-month and day-of-week combine as cron combines them: when both are
 * restricted, a day matches either one; when either field starts with `*`, a
 * day must match both (so `*\/2` counts as `*` there, as it does in cron).
 */

import { DynamicWorkflowError } from "../errors.js";

/** A cron expression odw cannot use, with the reason. */
export class CronError extends DynamicWorkflowError {}

/** A parsed cron expression: each field's values, ascending and distinct. */
export interface CronSpec {
  /** The expression, its fields joined by single spaces. */
  expr: string;
  minutes: number[];
  hours: number[];
  /** Days of the month, 1-31. */
  days: number[];
  /** Months, 1-12. */
  months: number[];
  /** Days of the week, 0-6 from Sunday (a 7 is folded into 0). */
  weekdays: number[];
  /** The day-of-month field starts with `*` (see the module comment). */
  daysStar: boolean;
  /** The day-of-week field starts with `*`. */
  weekdaysStar: boolean;
}

const MONTH_NAMES = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const DAY_NAMES = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

interface FieldRule {
  name: string;
  min: number;
  max: number;
  /** Names the field also takes, and the value of the first one. */
  names?: { list: string[]; first: number; kind: string };
}

const FIELDS: readonly FieldRule[] = [
  { name: "minute", min: 0, max: 59 },
  { name: "hour", min: 0, max: 23 },
  { name: "day-of-month", min: 1, max: 31 },
  { name: "month", min: 1, max: 12, names: { list: MONTH_NAMES, first: 1, kind: "month" } },
  { name: "day-of-week", min: 0, max: 7, names: { list: DAY_NAMES, first: 0, kind: "day" } },
];

/** What the `@` shorthands some crons take stand for: the error names the five fields to write instead. */
const MACROS: Record<string, string> = {
  "@yearly": "0 0 1 1 *",
  "@annually": "0 0 1 1 *",
  "@monthly": "0 0 1 * *",
  "@weekly": "0 0 * * 0",
  "@daily": "0 0 * * *",
  "@midnight": "0 0 * * *",
  "@hourly": "0 * * * *",
};

/** Quartz-style values some schedulers take and cron does not: L, 5L, L-3, 15W, LW, 5#2, ?. */
const QUARTZ_RE = /^(?:\?|L(?:-\d+)?|LW|\d+[LW]|(?:\d+|[a-z]{3})#\d+|[a-z]{3}L)$/i;
const QUARTZ: Array<[string, string]> = [
  ["#", "nth weekday"],
  ["?", "no specific value"],
  ["W", "nearest weekday"],
  ["L", "last"],
];

/** The most days each month can have (February: in a leap year). */
const MAX_DAYS = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

/** Parse and validate a five-field cron expression; throws a {@link CronError} saying what is wrong. */
export function parseCron(input: string): CronSpec {
  const text = input.trim();
  const fail = (why: string): never => {
    throw new CronError(`invalid cron expression ${JSON.stringify(text)}: ${why}`);
  };
  if (!text) throw new CronError("the cron expression is empty");
  if (text.startsWith("@")) {
    const macro = MACROS[text.toLowerCase()];
    if (macro) fail(`${text} is not supported — write the five fields instead: "${macro}"`);
    fail(
      text.toLowerCase() === "@reboot"
        ? "@reboot is not a time of day, so odw schedule cannot use it"
        : `${text} is not supported — write the five fields (minute hour day-of-month month day-of-week)`,
    );
  }
  const fields = text.split(/\s+/);
  if (fields.length !== 5) {
    fail(
      `expected 5 fields (minute hour day-of-month month day-of-week), got ${fields.length}` +
        (fields.length > 5 ? " — seconds and years are not supported" : ""),
    );
  }
  const [minutes, hours, days, months, weekdays] = fields.map((field, i) => parseField(field, FIELDS[i]!, fail));
  const spec: CronSpec = {
    expr: fields.join(" "),
    minutes: minutes!,
    hours: hours!,
    days: days!,
    months: months!,
    weekdays: [...new Set(weekdays!.map((day) => day % 7))].sort((a, b) => a - b),
    daysStar: fields[2]!.startsWith("*"),
    weekdaysStar: fields[4]!.startsWith("*"),
  };
  // A day-of-month a starred day-of-week must agree with, in months that never
  // have it, never comes: cron would accept the line and stay silent forever.
  if (spec.weekdaysStar && !spec.daysStar && !spec.months.some((m) => spec.days.some((d) => d <= MAX_DAYS[m - 1]!))) {
    const monthText = spec.months.map((m) => capitalize(MONTH_NAMES[m - 1]!)).join("/");
    fail(`it never fires: ${monthText} ${spec.months.length === 1 ? "has" : "have"} no day ${spec.days.join("/")}`);
  }
  return spec;
}

/** One field's values, ascending and distinct. */
function parseField(field: string, rule: FieldRule, fail: (why: string) => never): number[] {
  const values = new Set<number>();
  for (const item of field.split(",")) {
    const problem = (why: string) => fail(`${rule.name} ${JSON.stringify(item)}: ${why}`);
    if (item === "") fail(`${rule.name} ${JSON.stringify(field)} has an empty list item`);
    const [base, step, extra] = item.split("/");
    if (extra !== undefined) problem(`only one "/" is allowed`);
    if (base === "" && step !== undefined) problem(`a step needs "*" or a range before the "/"`);
    let lo = rule.min;
    let hi = rule.max;
    if (base !== "*") {
      const bounds = base!.split("-");
      if (bounds.length > 2) problem(`a range has one "-" (a-b)`);
      lo = fieldValue(bounds[0]!, rule, problem);
      hi = bounds.length === 2 ? fieldValue(bounds[1]!, rule, problem) : lo;
      if (bounds.length === 1 && step !== undefined) {
        problem(`a step needs "*" or a range before it — write "${base}-${rule.max}/${step}"`);
      }
      if (hi < lo) {
        problem(
          `the range runs backwards` + (rule.name === "day-of-week" && hi === 0 ? ` — write "${lo}-7" to end on Sunday` : ""),
        );
      }
    }
    let by = 1;
    if (step !== undefined) {
      if (!/^\d+$/.test(step)) problem(`the step ${JSON.stringify(step)} is not a number`);
      by = Number(step);
      if (by < 1) problem("the step must be at least 1");
    }
    for (let v = lo; v <= hi; v += by) values.add(v);
  }
  return [...values].sort((a, b) => a - b);
}

/** One number or name of a field, range-checked. */
function fieldValue(token: string, rule: FieldRule, problem: (why: string) => never): number {
  if (/^\d+$/.test(token)) {
    const value = Number(token);
    if (value < rule.min || value > rule.max) problem(`${value} is out of range ${rule.min}-${rule.max}`);
    return value;
  }
  const named = rule.names?.list.indexOf(token.toLowerCase()) ?? -1;
  if (named !== -1) return named + rule.names!.first;
  if (QUARTZ_RE.test(token)) {
    const [char, meaning] = QUARTZ.find(([c]) => token.toUpperCase().includes(c))!;
    problem(`"${char}" (${meaning}) is Quartz syntax, which cron does not support`);
  }
  if (token === "") problem(`a range needs a value on both sides of "-"`);
  const names = rule.names ? ` or a ${rule.names.kind} name (${rule.names.list[0]}-${rule.names.list.at(-1)})` : "";
  return problem(`${JSON.stringify(token)} is not a number${names}`);
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// --- when it fires -----------------------------------------------------------

/** One full Gregorian cycle (400 years): every date falls on every weekday within it. */
const HORIZON_MS = 146_097 * 86_400_000;

/**
 * The first time strictly after `after` the expression fires, in the local
 * time zone; null when it never does (parseCron refuses those already).
 *
 * The walk is over real instants, not wall-clock arithmetic, so daylight
 * saving time needs no special case: "0 8 * * *" stays at 08:00 local on both
 * sides of a change, and a time a spring-forward skips is skipped (03:00
 * follows 01:59). Each local time fires once: in an hour a fall-back repeats,
 * only its first pass counts — what systemd computes for the same schedule,
 * and what cron does for a fixed time (cron also reruns a wildcard one there).
 * Months, days and hours that cannot match are stepped over whole, so even a
 * 29 February is found in a few hundred steps.
 */
export function nextFire(spec: CronSpec, after: Date): Date | null {
  const minute = mask(spec.minutes, 60);
  const hour = mask(spec.hours, 24);
  const day = mask(spec.days, 32);
  const month = mask(spec.months, 13);
  const weekday = mask(spec.weekdays, 7);
  const both = spec.daysStar || spec.weekdaysStar;
  const dayMatches = (t: Date): boolean =>
    both ? day[t.getDate()]! && weekday[t.getDay()]! : day[t.getDate()]! || weekday[t.getDay()]!;

  // The next whole minute, cut in UTC: a local setSeconds() inside an hour a
  // fall-back repeats would resolve to that hour's first pass, back in time.
  let t = new Date(Math.floor(after.getTime() / 60_000) * 60_000 + 60_000);
  const horizon = after.getTime() + HORIZON_MS;
  while (t.getTime() <= horizon) {
    let next: Date;
    if (!month[t.getMonth() + 1]) next = new Date(t.getFullYear(), t.getMonth() + 1, 1);
    else if (!dayMatches(t)) next = new Date(t.getFullYear(), t.getMonth(), t.getDate() + 1);
    else if (!hour[t.getHours()]) next = new Date(t.getFullYear(), t.getMonth(), t.getDate(), t.getHours() + 1);
    else if (!minute[t.getMinutes()] || !firstPass(t)) next = new Date(t.getTime() + 60_000);
    else return t;
    // A wall-clock jump a DST change resolves to an instant not after `t` (a
    // repeated midnight): step one real minute instead, so the walk always advances.
    t = next.getTime() > t.getTime() ? next : new Date(t.getTime() + 60_000);
  }
  return null;
}

/** Whether `t` is the first instant showing its local time: Date resolves a repeated local time to its first pass. */
function firstPass(t: Date): boolean {
  return new Date(t.getFullYear(), t.getMonth(), t.getDate(), t.getHours(), t.getMinutes()).getTime() === t.getTime();
}

function mask(values: number[], size: number): boolean[] {
  const out = new Array<boolean>(size).fill(false);
  for (const v of values) out[v] = true;
  return out;
}

/** Every day matches: no day-of-month or day-of-week restriction is in force. */
function everyDay(spec: CronSpec): boolean {
  const allDays = spec.days.length === 31;
  const allWeekdays = spec.weekdays.length === 7;
  return spec.daysStar || spec.weekdaysStar ? allDays && allWeekdays : allDays || allWeekdays;
}

// --- launchd -----------------------------------------------------------------

/** One launchd StartCalendarInterval dictionary; a key it leaves out matches anything. */
export type CalendarInterval = Partial<Record<"Month" | "Day" | "Weekday" | "Hour" | "Minute", number>>;

/** The most StartCalendarInterval entries odw writes; an expression that needs more takes another backend. */
export const LAUNCHD_MAX_INTERVALS = 64;

/**
 * The StartCalendarInterval entries for an expression. launchd matches a
 * dictionary when all its keys match and fires when any dictionary does, so
 * each restricted field is spelled out value by value, and cron's "either
 * day-of-month or day-of-week" becomes separate Day and Weekday entries.
 * Refuses (a {@link CronError}) an expression that needs more than
 * {@link LAUNCHD_MAX_INTERVALS} of them.
 */
export function launchdIntervals(spec: CronSpec): CalendarInterval[] {
  const each = (values: number[], size: number): Array<number | undefined> =>
    values.length === size ? [undefined] : values;
  let dayParts: CalendarInterval[];
  if (everyDay(spec)) {
    dayParts = [{}];
  } else if (spec.daysStar || spec.weekdaysStar) {
    dayParts = [];
    for (const d of each(spec.days, 31)) {
      for (const w of each(spec.weekdays, 7)) dayParts.push(defined({ Day: d, Weekday: w }));
    }
  } else {
    dayParts = [...spec.days.map((d) => ({ Day: d })), ...spec.weekdays.map((w) => ({ Weekday: w }))];
  }
  const months = each(spec.months, 12);
  const hours = each(spec.hours, 24);
  const minutes = each(spec.minutes, 60);
  const count = months.length * dayParts.length * hours.length * minutes.length;
  if (count > LAUNCHD_MAX_INTERVALS) {
    throw new CronError(
      `launchd needs ${count} StartCalendarInterval entries for "${spec.expr}" (odw writes at most ` +
        `${LAUNCHD_MAX_INTERVALS}) — use --backend cron (macOS runs cron too) or --backend systemd on Linux, ` +
        `or a simpler expression`,
    );
  }
  const out: CalendarInterval[] = [];
  for (const m of months) {
    for (const part of dayParts) {
      for (const h of hours) {
        for (const min of minutes) out.push(defined({ Month: m, ...part, Hour: h, Minute: min }));
      }
    }
  }
  return out;
}

/** The entry without its undefined keys (key order kept: Month, Day, Weekday, Hour, Minute). */
function defined(interval: CalendarInterval): CalendarInterval {
  return Object.fromEntries(Object.entries(interval).filter(([, v]) => v !== undefined)) as CalendarInterval;
}

// --- systemd -----------------------------------------------------------------

const SYSTEMD_DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/**
 * The OnCalendar= values of a systemd timer for an expression, in local time:
 * one, or two when day-of-month and day-of-week are both restricted — a timer
 * fires at any of its OnCalendar= values, which is cron's "either". Values
 * are spelled out as lists, which every systemd version reads.
 */
export function systemdCalendars(spec: CronSpec): string[] {
  const list = (values: number[], size: number) => (values.length === size ? "*" : values.map(two).join(","));
  const time = `${list(spec.hours, 24)}:${list(spec.minutes, 60)}:00`;
  const date = (days: string) => `*-${list(spec.months, 12)}-${days}`;
  const weekdays = spec.weekdays.map((w) => SYSTEMD_DAYS[w]).join(",");
  if (everyDay(spec)) return [`${date("*")} ${time}`];
  if (spec.daysStar || spec.weekdaysStar) {
    const dow = spec.weekdays.length === 7 ? "" : `${weekdays} `;
    return [`${dow}${date(list(spec.days, 31))} ${time}`];
  }
  return [`${date(list(spec.days, 31))} ${time}`, `${weekdays} ${date("*")} ${time}`];
}

function two(n: number): string {
  return String(n).padStart(2, "0");
}

// --- schtasks ----------------------------------------------------------------

/**
 * The closest schtasks.exe schedule (`/SC …` arguments) for an expression, for
 * the line odw prints on Windows: exact for the common shapes — every N
 * minutes, every N hours, daily, weekly on some days, monthly on some dates —
 * and otherwise a daily run at the first time of day, flagged as approximate.
 */
export function schtasksSchedule(spec: CronSpec): { args: string[]; exact: boolean } {
  const start = (hour: number, minute: number) => ["/ST", `${two(hour)}:${two(minute)}`];
  const firstTime = start(spec.hours[0]!, spec.minutes[0]!);
  if (spec.months.length === 12 && everyDay(spec)) {
    const minuteStep = evenStep(spec.minutes, 60);
    if (spec.minutes.length > 1 && spec.hours.length === 24 && minuteStep) {
      return { args: ["/SC", "MINUTE", "/MO", String(minuteStep), ...start(0, spec.minutes[0]!)], exact: true };
    }
    const hourStep = evenStep(spec.hours, 24);
    if (spec.minutes.length === 1 && hourStep) {
      const every = hourStep === 24 ? ["/SC", "DAILY"] : ["/SC", "HOURLY", "/MO", String(hourStep)];
      return { args: [...every, ...firstTime], exact: true };
    }
  }
  const oneTime = spec.minutes.length === 1 && spec.hours.length === 1;
  if (spec.months.length === 12 && oneTime && (spec.daysStar || spec.weekdaysStar)) {
    if (spec.days.length === 31) {
      const days = spec.weekdays.map((w) => SYSTEMD_DAYS[w]!.toUpperCase()).join(",");
      return { args: ["/SC", "WEEKLY", "/D", days, ...firstTime], exact: true };
    }
    if (spec.weekdays.length === 7) {
      return { args: ["/SC", "MONTHLY", "/D", spec.days.join(","), ...firstTime], exact: true };
    }
  }
  return { args: ["/SC", "DAILY", ...firstTime], exact: false };
}

/** The step of values that split a cycle evenly (0,15,30,45 of 60 → 15; one value → the cycle), else null. */
function evenStep(values: number[], cycle: number): number | null {
  const step = values.length > 1 ? values[1]! - values[0]! : cycle;
  const even = cycle % step === 0 && values.length === cycle / step && values.every((v, i) => v === values[0]! + i * step);
  return even ? step : null;
}
