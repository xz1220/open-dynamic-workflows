import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";

import {
  CronError,
  LAUNCHD_MAX_INTERVALS,
  launchdIntervals,
  nextFire,
  parseCron,
  schtasksSchedule,
  systemdCalendars,
} from "../src/schedule/cron.js";

/** July's UTC offset (getTimezoneOffset) of each zone the tests use. */
const JULY_OFFSET: Record<string, number> = { UTC: 0, "America/New_York": 240 };

/** Run `fn` with the process in `zone`; the test is skipped where the runtime ignores a TZ change. */
function inZone(t: TestContext, zone: string, fn: () => void): void {
  const saved = process.env.TZ;
  process.env.TZ = zone;
  try {
    if (new Date("2026-07-01T12:00:00Z").getTimezoneOffset() !== JULY_OFFSET[zone]) {
      t.skip(`this runtime ignores TZ=${zone}`);
      return;
    }
    fn();
  } finally {
    if (saved === undefined) delete process.env.TZ;
    else process.env.TZ = saved;
  }
}

/** The fire times after `from`, one after another, as UTC ISO strings. */
function fires(expr: string, from: string, count: number): string[] {
  const spec = parseCron(expr);
  const out: string[] = [];
  let at = new Date(from);
  for (let i = 0; i < count; i++) {
    const next = nextFire(spec, at);
    assert.ok(next, `${expr} fires after ${at.toISOString()}`);
    out.push(next.toISOString());
    at = next;
  }
  return out;
}

test("parseCron reads numbers, *, lists, ranges, steps and names", () => {
  const spec = parseCron("  */15  9-17/4 1,15,31 jan-mar,DEC mon-fri ");
  assert.equal(spec.expr, "*/15 9-17/4 1,15,31 jan-mar,DEC mon-fri");
  assert.deepEqual(spec.minutes, [0, 15, 30, 45]);
  assert.deepEqual(spec.hours, [9, 13, 17]);
  assert.deepEqual(spec.days, [1, 15, 31]);
  assert.deepEqual(spec.months, [1, 2, 3, 12]);
  assert.deepEqual(spec.weekdays, [1, 2, 3, 4, 5]);
  assert.equal(spec.daysStar, false);
  assert.equal(spec.weekdaysStar, false);

  const all = parseCron("* * * * *");
  assert.equal(all.minutes.length, 60);
  assert.equal(all.hours.length, 24);
  assert.equal(all.days.length, 31);
  assert.equal(all.months.length, 12);
  assert.deepEqual(all.weekdays, [0, 1, 2, 3, 4, 5, 6], "0-7 folds Sunday's 7 into 0");
  assert.equal(all.daysStar && all.weekdaysStar, true);
});

test("day-of-week 7 is Sunday, like 0 and sun", () => {
  for (const dow of ["0", "7", "sun", "SUN", "0,7"]) assert.deepEqual(parseCron(`0 9 * * ${dow}`).weekdays, [0], dow);
  assert.deepEqual(parseCron("0 9 * * 5-7").weekdays, [0, 5, 6]);
  assert.deepEqual(parseCron("0 9 * * */2").weekdays, [0, 2, 4, 6]);
});

test("parseCron refuses anything else with a precise message", () => {
  const cases: Array<[string, string]> = [
    ["", "the cron expression is empty"],
    ["@daily", `invalid cron expression "@daily": @daily is not supported — write the five fields instead: "0 0 * * *"`],
    ["@hourly", `invalid cron expression "@hourly": @hourly is not supported — write the five fields instead: "0 * * * *"`],
    ["@reboot", `invalid cron expression "@reboot": @reboot is not a time of day, so odw schedule cannot use it`],
    ["* * * *", `invalid cron expression "* * * *": expected 5 fields (minute hour day-of-month month day-of-week), got 4`],
    [
      "0 * * * * *",
      `invalid cron expression "0 * * * * *": expected 5 fields (minute hour day-of-month month day-of-week), got 6 — seconds and years are not supported`,
    ],
    ["60 * * * *", `invalid cron expression "60 * * * *": minute "60": 60 is out of range 0-59`],
    ["0 24 * * *", `invalid cron expression "0 24 * * *": hour "24": 24 is out of range 0-23`],
    ["0 0 0 * *", `invalid cron expression "0 0 0 * *": day-of-month "0": 0 is out of range 1-31`],
    ["0 0 * 13 *", `invalid cron expression "0 0 * 13 *": month "13": 13 is out of range 1-12`],
    ["0 0 * * 8", `invalid cron expression "0 0 * * 8": day-of-week "8": 8 is out of range 0-7`],
    ["0 0 * foo *", `invalid cron expression "0 0 * foo *": month "foo": "foo" is not a number or a month name (jan-dec)`],
    ["0 0 * * funday", `invalid cron expression "0 0 * * funday": day-of-week "funday": "funday" is not a number or a day name (sun-sat)`],
    ["0 mon * * *", `invalid cron expression "0 mon * * *": hour "mon": "mon" is not a number`],
    ["5/15 * * * *", `invalid cron expression "5/15 * * * *": minute "5/15": a step needs "*" or a range before it — write "5-59/15"`],
    ["/5 * * * *", `invalid cron expression "/5 * * * *": minute "/5": a step needs "*" or a range before the "/"`],
    ["*/0 * * * *", `invalid cron expression "*/0 * * * *": minute "*/0": the step must be at least 1`],
    ["*/x * * * *", `invalid cron expression "*/x * * * *": minute "*/x": the step "x" is not a number`],
    ["*/5/2 * * * *", `invalid cron expression "*/5/2 * * * *": minute "*/5/2": only one "/" is allowed`],
    ["1-2-3 * * * *", `invalid cron expression "1-2-3 * * * *": minute "1-2-3": a range has one "-" (a-b)`],
    ["-5 * * * *", `invalid cron expression "-5 * * * *": minute "-5": a range needs a value on both sides of "-"`],
    ["0 17-9 * * *", `invalid cron expression "0 17-9 * * *": hour "17-9": the range runs backwards`],
    ["0 0 * * fri-sun", `invalid cron expression "0 0 * * fri-sun": day-of-week "fri-sun": the range runs backwards — write "5-7" to end on Sunday`],
    ["1,,2 * * * *", `invalid cron expression "1,,2 * * * *": minute "1,,2" has an empty list item`],
    ["0 0 L * *", `invalid cron expression "0 0 L * *": day-of-month "L": "L" (last) is Quartz syntax, which cron does not support`],
    ["0 0 15W * *", `invalid cron expression "0 0 15W * *": day-of-month "15W": "W" (nearest weekday) is Quartz syntax, which cron does not support`],
    ["0 0 * * 5#2", `invalid cron expression "0 0 * * 5#2": day-of-week "5#2": "#" (nth weekday) is Quartz syntax, which cron does not support`],
    ["0 0 ? * *", `invalid cron expression "0 0 ? * *": day-of-month "?": "?" (no specific value) is Quartz syntax, which cron does not support`],
    ["0 0 30 2 *", `invalid cron expression "0 0 30 2 *": it never fires: Feb has no day 30`],
    ["0 0 31 apr,jun *", `invalid cron expression "0 0 31 apr,jun *": it never fires: Apr/Jun have no day 31`],
  ];
  for (const [expr, message] of cases) {
    assert.throws(() => parseCron(expr), (err: unknown) => err instanceof CronError && err.message === message, expr);
  }
});

test("an impossible day-of-month is fine when a restricted day-of-week can match on its own", () => {
  // Both fields restricted: cron fires on either, so the Mondays of February still come.
  assert.doesNotThrow(() => parseCron("0 0 30 2 mon"));
});

test("nextFire is the first matching minute strictly after the given time", (t) => {
  inZone(t, "UTC", () => {
    assert.deepEqual(fires("0 8 * * *", "2026-10-17T07:59:59Z", 2), ["2026-10-17T08:00:00.000Z", "2026-10-18T08:00:00.000Z"]);
    assert.deepEqual(fires("0 8 * * *", "2026-10-17T08:00:00Z", 1), ["2026-10-18T08:00:00.000Z"], "not the minute it is in");
    assert.deepEqual(fires("*/15 * * * *", "2026-10-17T12:07:30Z", 3), [
      "2026-10-17T12:15:00.000Z",
      "2026-10-17T12:30:00.000Z",
      "2026-10-17T12:45:00.000Z",
    ]);
    assert.deepEqual(fires("59 23 31 12 *", "2026-10-17T00:00:00Z", 2), ["2026-12-31T23:59:00.000Z", "2027-12-31T23:59:00.000Z"]);
  });
});

test("nextFire finds 29 February, years ahead", (t) => {
  inZone(t, "UTC", () => {
    assert.deepEqual(fires("0 0 29 2 *", "2026-10-17T00:00:00Z", 3), [
      "2028-02-29T00:00:00.000Z",
      "2032-02-29T00:00:00.000Z",
      "2036-02-29T00:00:00.000Z",
    ]);
    // Across a century that is not a leap year: 2096, then 2104.
    assert.deepEqual(fires("0 0 29 2 *", "2096-03-01T00:00:00Z", 1), ["2104-02-29T00:00:00.000Z"]);
  });
});

test("nextFire treats day-of-week 0 and 7 as Sunday, and combines day fields as cron does", (t) => {
  inZone(t, "UTC", () => {
    // 2026-10-17 is a Saturday.
    for (const dow of ["0", "7", "sun"]) assert.deepEqual(fires(`0 9 * * ${dow}`, "2026-10-17T12:00:00Z", 2), ["2026-10-18T09:00:00.000Z", "2026-10-25T09:00:00.000Z"]);
    assert.deepEqual(fires("0 9 * * 5-7", "2026-10-15T12:00:00Z", 3), [
      "2026-10-16T09:00:00.000Z",
      "2026-10-17T09:00:00.000Z",
      "2026-10-18T09:00:00.000Z",
    ]);
    // Both restricted: the 1st of the month OR a Monday.
    assert.deepEqual(fires("0 0 1 * mon", "2026-10-25T12:00:00Z", 3), [
      "2026-10-26T00:00:00.000Z",
      "2026-11-01T00:00:00.000Z",
      "2026-11-02T00:00:00.000Z",
    ]);
    // A field starting with * makes it AND: odd days that are Mondays (Oct 26 and Nov 2 are even).
    assert.deepEqual(fires("0 0 */2 * mon", "2026-10-17T00:00:00Z", 2), ["2026-10-19T00:00:00.000Z", "2026-11-09T00:00:00.000Z"]);
  });
});

test("nextFire walks local time, so daylight saving changes are no special case", (t) => {
  inZone(t, "America/New_York", () => {
    // Spring forward on 2026-03-08 (02:00 EST → 03:00 EDT): 08:00 stays 08:00 local on both sides.
    assert.deepEqual(fires("0 8 * * *", "2026-03-07T00:00:00Z", 3), [
      "2026-03-07T13:00:00.000Z", // 08:00 EST
      "2026-03-08T12:00:00.000Z", // 08:00 EDT
      "2026-03-09T12:00:00.000Z",
    ]);
    // 02:30 does not exist on the 8th: that day is skipped.
    assert.deepEqual(fires("30 2 * * *", "2026-03-07T12:00:00Z", 1), ["2026-03-09T06:30:00.000Z"]);
    // Hourly across the gap: 01:00 EST, then 03:00 EDT.
    assert.deepEqual(fires("0 * * * *", "2026-03-08T05:30:00Z", 2), ["2026-03-08T06:00:00.000Z", "2026-03-08T07:00:00.000Z"]);
    // Fall back on 2026-11-01 (02:00 EDT → 01:00 EST): 08:00 local again, now in EST.
    assert.deepEqual(fires("0 8 * * *", "2026-10-31T00:00:00Z", 2), ["2026-10-31T12:00:00.000Z", "2026-11-01T13:00:00.000Z"]);
    // Each local time fires once: the hour a fall-back repeats counts on its first pass only (as systemd computes it).
    assert.deepEqual(fires("*/30 1 * * *", "2026-11-01T04:00:00Z", 4), [
      "2026-11-01T05:00:00.000Z", // 01:00 EDT
      "2026-11-01T05:30:00.000Z", // 01:30 EDT
      "2026-11-02T06:00:00.000Z", // 01:00 EST, the next day
      "2026-11-02T06:30:00.000Z",
    ]);
    assert.deepEqual(fires("0 * * * *", "2026-11-01T03:30:00Z", 3), [
      "2026-11-01T04:00:00.000Z", // 00:00 EDT
      "2026-11-01T05:00:00.000Z", // 01:00 EDT
      "2026-11-01T07:00:00.000Z", // 02:00 EST: the second 01:00 does not count again
    ]);
    // From inside the second pass the walk goes on, never back to the first.
    assert.deepEqual(fires("45 1 * * *", "2026-11-01T06:10:00Z", 1), ["2026-11-02T06:45:00.000Z"]);
  });
});

test("launchdIntervals spells restricted fields out and keeps cron's day rule", () => {
  assert.deepEqual(launchdIntervals(parseCron("0 8 * * *")), [{ Hour: 8, Minute: 0 }]);
  assert.deepEqual(launchdIntervals(parseCron("* * * * *")), [{}]);
  assert.deepEqual(launchdIntervals(parseCron("0 8 * * 1-5")), [1, 2, 3, 4, 5].map((w) => ({ Weekday: w, Hour: 8, Minute: 0 })));
  assert.deepEqual(launchdIntervals(parseCron("0 9 * * 0,7")), [{ Weekday: 0, Hour: 9, Minute: 0 }], "Sunday once");
  // Both day fields restricted: separate Day and Weekday entries (launchd fires on any).
  assert.deepEqual(launchdIntervals(parseCron("30 6 1,15 * mon")), [
    { Day: 1, Hour: 6, Minute: 30 },
    { Day: 15, Hour: 6, Minute: 30 },
    { Weekday: 1, Hour: 6, Minute: 30 },
  ]);
  // A starred field: one entry must match both.
  assert.deepEqual(launchdIntervals(parseCron("0 0 */15 jun mon")), [1, 16, 31].map((d) => ({ Month: 6, Day: d, Weekday: 1, Hour: 0, Minute: 0 })));
  assert.equal(launchdIntervals(parseCron("*/5 * * * *")).length, 12);
  assert.equal(launchdIntervals(parseCron("0 */6 1 1,7 *")).length, 8);
});

test(`launchdIntervals refuses an expression that needs more than ${LAUNCHD_MAX_INTERVALS} entries`, () => {
  assert.equal(launchdIntervals(parseCron("0-59 0 * * *")).length, 1, "every minute of hour 0: Minute left out");
  assert.equal(launchdIntervals(parseCron("0-58 0 * * *")).length, 59);
  assert.throws(
    () => launchdIntervals(parseCron("*/2 9-17 * * 1-5")),
    (err: unknown) =>
      err instanceof CronError &&
      err.message ===
        `launchd needs 1350 StartCalendarInterval entries for "*/2 9-17 * * 1-5" (odw writes at most 64) — ` +
          `use --backend cron (macOS runs cron too) or --backend systemd on Linux, or a simpler expression`,
  );
});

test("systemdCalendars translates to OnCalendar= values, two for cron's either-day rule", () => {
  assert.deepEqual(systemdCalendars(parseCron("0 8 * * *")), ["*-*-* 08:00:00"]);
  assert.deepEqual(systemdCalendars(parseCron("*/15 * * * *")), ["*-*-* *:00,15,30,45:00"]);
  assert.deepEqual(systemdCalendars(parseCron("0 8 * * 1-5")), ["Mon,Tue,Wed,Thu,Fri *-*-* 08:00:00"]);
  assert.deepEqual(systemdCalendars(parseCron("0 9 * * 7")), ["Sun *-*-* 09:00:00"]);
  assert.deepEqual(systemdCalendars(parseCron("30 6 1,15 * mon")), ["*-*-01,15 06:30:00", "Mon *-*-* 06:30:00"]);
  assert.deepEqual(systemdCalendars(parseCron("0 0 */15 jun mon")), ["Mon *-06-01,16,31 00:00:00"]);
  assert.deepEqual(systemdCalendars(parseCron("5 4 29 2 *")), ["*-02-29 04:05:00"]);
});

test("schtasksSchedule picks the closest /SC schedule and says when it is not exact", () => {
  const cases: Array<[string, string[], boolean]> = [
    ["*/15 * * * *", ["/SC", "MINUTE", "/MO", "15", "/ST", "00:00"], true],
    ["5-59/30 * * * *", ["/SC", "MINUTE", "/MO", "30", "/ST", "00:05"], true],
    ["30 * * * *", ["/SC", "HOURLY", "/MO", "1", "/ST", "00:30"], true],
    ["0 */2 * * *", ["/SC", "HOURLY", "/MO", "2", "/ST", "00:00"], true],
    ["0 8 * * *", ["/SC", "DAILY", "/ST", "08:00"], true],
    ["0 8 * * 1-5", ["/SC", "WEEKLY", "/D", "MON,TUE,WED,THU,FRI", "/ST", "08:00"], true],
    ["0 8 1,15 * *", ["/SC", "MONTHLY", "/D", "1,15", "/ST", "08:00"], true],
    ["*/7 * * * *", ["/SC", "DAILY", "/ST", "00:00"], false],
    ["0 8 1 * mon", ["/SC", "DAILY", "/ST", "08:00"], false],
  ];
  for (const [expr, args, exact] of cases) assert.deepEqual(schtasksSchedule(parseCron(expr)), { args, exact }, expr);
});
