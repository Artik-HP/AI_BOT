const test = require("node:test");
const assert = require("node:assert/strict");
const { formatTime, formatUtc, isValidTimeZone, localParts, nextDailyMoment } = require("../../src/utils/time");

test("nextDailyMoment: следующий раз «ЧЧ:ММ» по UTC и по поясу, зимой, летом и в день перехода на летнее время", () => {
  const iso = (moment) => new Date(moment).toISOString();

  assert.equal(iso(nextDailyMoment("09:00", "", Date.UTC(2026, 0, 15, 8, 0))), "2026-01-15T09:00:00.000Z", "сегодня ещё не наступило");
  assert.equal(iso(nextDailyMoment("09:00", "", Date.UTC(2026, 0, 15, 9, 0))), "2026-01-16T09:00:00.000Z", "ровно сейчас — уже завтра");
  assert.equal(iso(nextDailyMoment("09:00", "Europe/Kyiv", Date.UTC(2026, 0, 15, 6, 0))), "2026-01-15T07:00:00.000Z", "зимой UTC+2");
  assert.equal(iso(nextDailyMoment("09:00", "Europe/Kyiv", Date.UTC(2026, 6, 15, 6, 30))), "2026-07-16T06:00:00.000Z", "летом UTC+3, сегодня уже прошло");
  assert.equal(iso(nextDailyMoment("09:00", "Europe/Kyiv", Date.UTC(2026, 2, 28, 12, 0))), "2026-03-29T06:00:00.000Z", "29 марта — уже летнее время");
  assert.equal(iso(nextDailyMoment("00:15", "Europe/Kyiv", Date.UTC(2026, 0, 15, 21, 0))), "2026-01-15T22:15:00.000Z", "полночь по Киеву — ещё 15-е по UTC");
});

const WINTER = Date.UTC(2026, 0, 15, 10, 0, 30);
const SUMMER = Date.UTC(2026, 6, 15, 10, 0);

test("formatUtc и formatTime без пояса — прежний вид «ГГГГ-ММ-ДД ЧЧ:ММ UTC»", () => {
  assert.equal(formatUtc(Date.UTC(2026, 9, 29, 19, 5)), "2026-10-29 19:05 UTC");
  assert.equal(formatTime(Date.UTC(2026, 9, 29, 19, 5)), "2026-10-29 19:05 UTC");
  assert.equal(formatTime(Date.UTC(2026, 9, 29, 19, 5), ""), "2026-10-29 19:05 UTC");
});

test("formatTime с поясом: местное время и название пояса; летнее время считает Intl, а не зашитое смещение", () => {
  assert.equal(formatTime(WINTER, "Europe/Kyiv"), "2026-01-15 12:00 Europe/Kyiv");
  assert.equal(formatTime(SUMMER, "Europe/Kyiv"), "2026-07-15 13:00 Europe/Kyiv");
  assert.equal(formatTime(new Date(SUMMER).toISOString(), "Europe/Kyiv"), "2026-07-15 13:00 Europe/Kyiv", "строка ISO тоже принимается");
  assert.equal(formatTime(Date.UTC(2026, 0, 15, 23, 30), "Europe/Kyiv"), "2026-01-16 01:30 Europe/Kyiv", "после полуночи — уже следующий день");
});

test("localParts: дата, время, день недели по местному календарю и смещение, в том числе дробное и отрицательное", () => {
  assert.deepEqual(localParts(WINTER, "Europe/Kyiv"), { date: "2026-01-15", time: "12:00", weekday: 4, offset: "UTC+02:00" });
  assert.equal(localParts(SUMMER, "Europe/Kyiv").offset, "UTC+03:00");
  assert.equal(localParts(WINTER, "Asia/Kolkata").offset, "UTC+05:30");
  assert.deepEqual(localParts(Date.UTC(2026, 0, 15, 2, 0), "America/New_York"), { date: "2026-01-14", time: "21:00", weekday: 3, offset: "UTC-05:00" });
  assert.equal(localParts(WINTER, "UTC").offset, "UTC+00:00");
});

test("isValidTimeZone: имена IANA да, мусор и пустое — нет", () => {
  assert.equal(isValidTimeZone("Europe/Kyiv"), true);
  assert.equal(isValidTimeZone("UTC"), true);

  for (const bad of ["Mars/Olympus", "", "+03:00 Kyiv", null, undefined]) {
    assert.equal(isValidTimeZone(bad), false, String(bad));
  }
});
