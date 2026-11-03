// How the bot writes a moment for people. Without a time zone it is "2026-11-03 09:00 UTC", as before; with
// BOT_TIMEZONE (an IANA name such as Europe/Kyiv) it is the local wall clock with the zone's name. Daylight saving is
// computed by Intl from the zone's rules; no offset is written in by hand. Sits below config: the zone is passed in.

const formatters = new Map();

function formatUtc(timestamp) {
  return `${new Date(timestamp).toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

function isValidTimeZone(name) {
  if (typeof name !== "string" || !name.trim()) {
    return false;
  }

  try {
    new Intl.DateTimeFormat("en-US", { timeZone: name.trim() });
    return true;
  } catch {
    return false;
  }
}

function formatterFor(timeZone) {
  if (!formatters.has(timeZone)) {
    formatters.set(timeZone, new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23"
    }));
  }

  return formatters.get(timeZone);
}

function formatOffset(minutes) {
  const sign = minutes < 0 ? "-" : "+";
  const size = Math.abs(minutes);

  return `UTC${sign}${String(Math.floor(size / 60)).padStart(2, "0")}:${String(size % 60).padStart(2, "0")}`;
}

// The wall clock of `timeZone` at `timestamp`: date, time, weekday (0 is Sunday) and the offset from UTC, which is the
// difference between that wall clock read as UTC and the moment itself.
function localParts(timestamp, timeZone) {
  const moment = new Date(timestamp).getTime();
  const parts = Object.fromEntries(formatterFor(timeZone).formatToParts(new Date(moment)).map(({ type, value }) => [type, value]));
  const wall = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute));

  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    time: `${parts.hour}:${parts.minute}`,
    weekday: new Date(wall).getUTCDay(),
    offset: formatOffset(Math.round((wall - Math.floor(moment / 60000) * 60000) / 60000))
  };
}

function offsetMinutes(timestamp, timeZone) {
  const [, sign, hours, minutes] = localParts(timestamp, timeZone).offset.match(/^UTC([+-])(\d{2}):(\d{2})$/);

  return (sign === "-" ? -1 : 1) * (Number(hours) * 60 + Number(minutes));
}

// The moment a wall clock of `timeZone` shows this date and time. The offset is read at the guess and read again,
// which settles across a daylight saving switch.
function zonedMoment(year, month, day, hours, minutes, timeZone) {
  const wall = Date.UTC(year, month - 1, day, hours, minutes);
  let moment = wall;

  for (let pass = 0; pass < 2; pass += 1) {
    moment = wall - offsetMinutes(moment, timeZone) * 60000;
  }

  return moment;
}

// The next moment after `after` when it is "HH:MM" in `timeZone` (empty means UTC): for a daily message.
function nextDailyMoment(time, timeZone, after) {
  const [hours, minutes] = time.split(":").map(Number);
  const zone = timeZone || "UTC";
  const [year, month, day] = localParts(after, zone).date.split("-").map(Number);

  for (let ahead = 0; ahead < 3; ahead += 1) {
    const moment = zonedMoment(year, month, day + ahead, hours, minutes, zone);

    if (moment > after) {
      return moment;
    }
  }

  throw new Error("DAILY_TIME_UNREACHABLE");
}

function formatTime(timestamp, timeZone = "") {
  if (!timeZone) {
    return formatUtc(new Date(timestamp).getTime());
  }

  const { date, time } = localParts(timestamp, timeZone);

  return `${date} ${time} ${timeZone}`;
}

module.exports = {
  formatUtc,
  formatTime,
  isValidTimeZone,
  localParts,
  nextDailyMoment
};
