/**
 * Local wall-clock dates on the server side: `now` in the app zone, and a due date the way a person says it.
 * Pure: no database, no fetch. Due dates are stored as wall-clock strings with no zone (`YYYY-MM-DD` or
 * `YYYY-MM-DDTHH:MM`); "today" is the day of `now` in the zone the caller passes (the app zone, `appZone()`).
 */

/** One formatter per zone: building an Intl.DateTimeFormat costs far more than using one (the trend reads one per event). */
const clocks = new Map<string, Intl.DateTimeFormat>();

/** `now` as a local wall-clock string `YYYY-MM-DDTHH:MM` in `timezone`, the shape `due` is stored in. */
export function localClock(now: Date, timezone: string): string {
  let fmt = clocks.get(timezone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
    clocks.set(timezone, fmt);
  }
  const parts = Object.fromEntries(fmt.formatToParts(now).map((p) => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
}

/** `YYYY-MM-DD` shifted by `n` calendar days. */
export function addDays(day: string, n: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Day of the week of `YYYY-MM-DD`, Monday 0 to Sunday 6. */
const weekday = (day: string): number => (new Date(`${day}T00:00:00Z`).getUTCDay() + 6) % 7;

const WEEKDAYS: Record<"zh" | "en", string[]> = {
  zh: ["周一", "周二", "周三", "周四", "周五", "周六", "周日"],
  en: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"],
};

/**
 * A due date as words, against the day of `now` in `timezone`:
 * today `今天`, tomorrow `明天`, the day after `后天 周四`; a day of next calendar week (Monday first)
 * `下周一 11-30`; any other day, past or future, `周五 11-27`, with the year when it is not this year
 * (`周一 2027-01-04`). A time follows when the todo has one: `后天 周四 08:00`.
 * English: `Today`, `Tomorrow`, `Thu 11-26`, `Next Mon 11-30`, `Fri 11-27`.
 */
export function dueWords(due: string, now: Date, timezone: string, lang = "zh"): string {
  const l = lang === "en" ? "en" : "zh";
  const today = localClock(now, timezone).slice(0, 10);
  const day = due.slice(0, 10);
  const time = due.length > 10 ? ` ${due.slice(11, 16)}` : "";
  const wd = WEEKDAYS[l][weekday(day)]!;
  const md = day.slice(0, 4) === today.slice(0, 4) ? day.slice(5) : day;
  const monday = addDays(today, -weekday(today));
  const nextWeek = day >= addDays(monday, 7) && day <= addDays(monday, 13);
  let words: string;
  if (day === today) words = l === "zh" ? "今天" : "Today";
  else if (day === addDays(today, 1)) words = l === "zh" ? "明天" : "Tomorrow";
  else if (day === addDays(today, 2)) words = l === "zh" ? `后天 ${wd}` : `${wd} ${md}`;
  else if (nextWeek) words = l === "zh" ? `下${wd} ${md}` : `Next ${wd} ${md}`;
  else words = `${wd} ${md}`;
  return words + time;
}
