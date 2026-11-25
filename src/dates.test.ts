import { describe, expect, test } from "bun:test";
import { dueWords } from "./dates.ts";

const tz = "Asia/Shanghai";
// Tuesday 2026-11-24 10:00 in Shanghai.
const tue = new Date("2026-11-24T02:00:00Z");
const say = (due: string, now = tue, zone = tz, lang = "zh") => dueWords(due, now, zone, lang);

describe("dueWords", () => {
  test("today, tomorrow and the day after are words; the day after carries its weekday", () => {
    expect(say("2026-11-24")).toBe("今天");
    expect(say("2026-11-25")).toBe("明天");
    expect(say("2026-11-26")).toBe("后天 周四");
  });

  test("a time follows the day; no time is the day alone", () => {
    expect(say("2026-11-24T08:00")).toBe("今天 08:00");
    expect(say("2026-11-25T15:30")).toBe("明天 15:30");
    expect(say("2026-11-26T08:00")).toBe("后天 周四 08:00");
    expect(say("2026-11-27T09:05")).toBe("周五 11-27 09:05");
    expect(say("2026-11-30T18:00")).toBe("下周一 11-30 18:00");
  });

  test("later this week is weekday and month-day", () => {
    expect(say("2026-11-27")).toBe("周五 11-27");
    expect(say("2026-11-29")).toBe("周日 11-29");
  });

  test("next calendar week (Monday first) says 下; the week after does not", () => {
    expect(say("2026-11-30")).toBe("下周一 11-30");
    expect(say("2026-12-06")).toBe("下周日 12-06");
    expect(say("2026-12-07")).toBe("周一 12-07");
    expect(say("2027-02-15")).toBe("周一 2027-02-15");
  });

  test("past dates, yesterday included, are weekday and month-day", () => {
    expect(say("2026-11-23")).toBe("周一 11-23");
    expect(say("2026-11-23T20:00")).toBe("周一 11-23 20:00");
    expect(say("2026-11-10")).toBe("周二 11-10");
  });

  test("another year adds the year", () => {
    expect(say("2027-01-04")).toBe("周一 2027-01-04");
    expect(say("2025-12-31T09:00")).toBe("周三 2025-12-31 09:00");
  });

  test("today turns at midnight in the app zone, not in UTC", () => {
    const beforeMidnight = new Date("2026-11-24T15:59:00Z"); // 23:59 on the 24th in Shanghai
    const afterMidnight = new Date("2026-11-24T16:00:00Z"); // 00:00 on the 25th in Shanghai
    expect(say("2026-11-25", beforeMidnight)).toBe("明天");
    expect(say("2026-11-25", afterMidnight)).toBe("今天");
    expect(say("2026-11-24", afterMidnight)).toBe("周二 11-24");
    // The same instant in UTC is still the 24th.
    expect(say("2026-11-25", afterMidnight, "UTC")).toBe("明天");
  });

  test("around a week boundary: the relative words win over 下, the week turns on Monday", () => {
    const sat = new Date("2026-11-28T02:00:00Z");
    expect(say("2026-11-30", sat)).toBe("后天 周一");
    expect(say("2026-12-01", sat)).toBe("下周二 12-01");
    const sun = new Date("2026-11-29T02:00:00Z");
    expect(say("2026-11-30", sun)).toBe("明天");
    expect(say("2026-12-01", sun)).toBe("后天 周二");
    expect(say("2026-12-02", sun)).toBe("下周三 12-02");
    expect(say("2026-12-07", sun)).toBe("周一 12-07");
    const mon = new Date("2026-11-30T02:00:00Z");
    expect(say("2026-12-06", mon)).toBe("周日 12-06");
    expect(say("2026-12-07", mon)).toBe("下周一 12-07");
  });

  test("across the new year: the relative words need no year, other dates add it", () => {
    const wed = new Date("2026-12-30T02:00:00Z");
    expect(say("2027-01-01", wed)).toBe("后天 周五");
    expect(say("2027-01-04", wed)).toBe("下周一 2027-01-04");
  });

  test("English", () => {
    expect(say("2026-11-24T08:00", tue, tz, "en")).toBe("Today 08:00");
    expect(say("2026-11-25", tue, tz, "en")).toBe("Tomorrow");
    expect(say("2026-11-26", tue, tz, "en")).toBe("Thu 11-26");
    expect(say("2026-11-30", tue, tz, "en")).toBe("Next Mon 11-30");
    expect(say("2027-01-04", tue, tz, "en")).toBe("Mon 2027-01-04");
  });
});
