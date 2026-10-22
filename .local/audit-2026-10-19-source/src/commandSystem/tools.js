const crypto = require("node:crypto");
const QRCode = require("qrcode");
const axios = require("axios");
function fail(text) {
  const error = new Error(text);
  error.userError = true;
  throw error;
}
function integer(value, min, max) {
  const n = Number(value);
  if (!String(value).trim() || !Number.isSafeInteger(n) || n < min || n > max)
    fail(`Ожидается целое число от ${min} до ${max}.`);
  return n;
}
// Recursive descent over a bounded arithmetic grammar. No JS, variables or function calls.
function calculate(source) {
  if (!source || source.length > 500 || /[^\d\s.+\-*/%^()eE]/.test(source))
    fail("Допустимы числа, скобки и + − * / % ^.");
  const tokens =
    source.match(/(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?|[()+\-*/%^]/g) || [];
  if (tokens.length > 200)
    fail("Слишком длинное выражение: максимум 200 чисел и операторов.");
  if (tokens.join("") !== source.replace(/\s/g, ""))
    fail("Некорректное выражение.");
  let i = 0,
    depth = 0;
  const finite = (n) =>
    Number.isFinite(n)
      ? n
      : fail(
          "Результат не является конечным числом (деление на ноль или переполнение).",
        );
  function atom() {
    if (++depth > 40) fail("Слишком много вложенных скобок.");
    let n;
    if (tokens[i] === "(") {
      i++;
      n = expression();
      if (tokens[i++] !== ")") fail("Не закрыта скобка.");
    } else {
      const t = tokens[i++];
      if (!t || !/^(?:\d|\.)/.test(t)) fail("Ожидается число.");
      n = finite(Number(t));
    }
    depth--;
    return n;
  }
  function power() {
    const n = atom();
    return tokens[i] === "^" ? (i++, finite(n ** unary())) : n;
  }
  function unary() {
    if (tokens[i] === "+" || tokens[i] === "-") {
      const sign = tokens[i++];
      return (sign === "-" ? -1 : 1) * unary();
    }
    return power();
  }
  function product() {
    let n = unary();
    while (["*", "/", "%"].includes(tokens[i])) {
      const op = tokens[i++],
        b = unary();
      n = finite(op === "*" ? n * b : op === "/" ? n / b : n % b);
    }
    return n;
  }
  function expression() {
    let n = product();
    while (["+", "-"].includes(tokens[i])) {
      const op = tokens[i++],
        b = product();
      n = finite(op === "+" ? n + b : n - b);
    }
    return n;
  }
  const n = expression();
  if (i !== tokens.length) fail("Лишние символы или отсутствует оператор.");
  return n;
}
const units = {
  mm: ["length", 0.001],
  cm: ["length", 0.01],
  m: ["length", 1],
  km: ["length", 1000],
  in: ["length", 0.0254],
  ft: ["length", 0.3048],
  mi: ["length", 1609.344],
  g: ["mass", 0.001],
  kg: ["mass", 1],
  lb: ["mass", 0.45359237],
  s: ["duration", 1],
  min: ["duration", 60],
  h: ["duration", 3600],
  d: ["duration", 86400],
  ml: ["volume", 0.001],
  l: ["volume", 1],
  c: ["temperature", 1],
  f: ["temperature", 1],
  k: ["temperature", 1],
};
function convert(args) {
  const match = args.match(
    /^(-?(?:\d+(?:\.\d*)?|\.\d+))\s+([a-z]+)\s+(?:to\s+)?([a-z]+)$/i,
  );
  if (!match)
    fail("Пример: 10 km m; 32 f c. Единицы: " + Object.keys(units).join(", "));
  const [, raw, a0, b0] = match,
    a = a0.toLowerCase(),
    b = b0.toLowerCase(),
    n = Number(raw);
  if (!units[a] || !units[b] || units[a][0] !== units[b][0])
    fail("Неизвестные или несовместимые единицы.");
  let result;
  if (units[a][0] === "temperature") {
    const c = a === "f" ? ((n - 32) * 5) / 9 : a === "k" ? n - 273.15 : n;
    if (c < -273.15) fail("Температура ниже абсолютного нуля.");
    result = b === "f" ? (c * 9) / 5 + 32 : b === "k" ? c + 273.15 : c;
  } else result = (n * units[a][1]) / units[b][1];
  if (!Number.isFinite(result)) fail("Число слишком большое.");
  return `${n} ${a} = ${Number(result.toPrecision(12))} ${b}`;
}
function password(args) {
  const n = integer(args || "20", 8, 128),
    groups = [
      "ABCDEFGHJKLMNPQRSTUVWXYZ",
      "abcdefghijkmnopqrstuvwxyz",
      "23456789",
      "!@#$%&*+-_=",
    ];
  const all = groups.join(""),
    chars = groups.map((g) => g[crypto.randomInt(g.length)]);
  while (chars.length < n) chars.push(all[crypto.randomInt(all.length)]);
  for (let i = chars.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join("");
}
function base64(args) {
  const match = args.match(/^(encode|decode)\s+([\s\S]+)$/);
  if (!match) fail("Используй encode текст или decode SGVsbG8=.");
  if (match[1] === "encode")
    return Buffer.from(match[2], "utf8").toString("base64");
  if (
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      match[2],
    )
  )
    fail("Некорректный Base64.");
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(
      Buffer.from(match[2], "base64"),
    );
  } catch {
    fail("Данные не являются текстом UTF-8.");
  }
}
function timestamp(args) {
  if (!args)
    return `Unix (секунды): ${Math.floor(Date.now() / 1000)}\nUTC: ${new Date().toISOString()}`;
  const date = /^-?\d+$/.test(args)
    ? new Date(Number(args) * 1000)
    : /^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(args)
      ? new Date(args)
      : null;
  if (!/^-?\d+$/.test(args)) {
    const parts = args.match(
      /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/,
    );
    if (
      !parts ||
      Number(parts[2]) < 1 ||
      Number(parts[2]) > 12 ||
      Number(parts[3]) < 1 ||
      Number(parts[3]) >
        new Date(
          Date.UTC(Number(parts[1]), Number(parts[2]), 0),
        ).getUTCDate() ||
      Number(parts[4]) > 23 ||
      Number(parts[5]) > 59 ||
      Number(parts[6]) > 59
    )
      fail(
        "Некорректная календарная дата. Используй ISO 8601 с секундами и часовым поясом.",
      );
  }
  if (!date || !Number.isFinite(date.getTime()))
    fail(
      "Используй Unix в секундах или ISO 8601 с часовым поясом, например 2026-10-14T12:00:00Z.",
    );
  return `${date.toISOString()}\nUnix (секунды): ${Math.floor(date.getTime() / 1000)}`;
}
async function weather(city, http = axios) {
  const options = { timeout: 12000, maxContentLength: 1024 * 1024 };
  const geo = await http.get("https://geocoding-api.open-meteo.com/v1/search", {
    ...options,
    params: { name: city, count: 1, language: "ru", format: "json" },
  });
  const place = geo.data?.results?.[0];
  if (!place) fail("Город не найден. Попробуй название на английском.");
  if (
    typeof place.name !== "string" ||
    !Number.isFinite(place.latitude) ||
    !Number.isFinite(place.longitude)
  )
    fail("Сервис вернул некорректные координаты.");
  const response = await http.get("https://api.open-meteo.com/v1/forecast", {
    ...options,
    params: {
      latitude: place.latitude,
      longitude: place.longitude,
      current:
        "temperature_2m,relative_humidity_2m,apparent_temperature,wind_speed_10m",
      timezone: "auto",
    },
  });
  const c = response.data?.current;
  if (
    !c ||
    typeof c.time !== "string" ||
    ![
      "temperature_2m",
      "relative_humidity_2m",
      "apparent_temperature",
      "wind_speed_10m",
    ].every((k) => Number.isFinite(c[k]))
  )
    fail("Сервис вернул неполную погоду.");
  return `${place.name}, ${place.country || ""}\n${c.time} (${response.data.timezone})\nТемпература: ${c.temperature_2m} °C, ощущается ${c.apparent_temperature} °C\nВлажность: ${c.relative_humidity_2m}%\nВетер: ${c.wind_speed_10m} км/ч\nИсточник: Open-Meteo (модельные погодные данные)\nhttps://open-meteo.com/`;
}
function duration(raw) {
  const match = raw.match(/^(\d+)(s|m|h|d)$/);
  if (!match) fail("Укажи интервал: 30s, 10m, 2h или 1d.");
  const ms =
    integer(match[1], 1, 365 * 86400) *
    { s: 1000, m: 60000, h: 3600000, d: 86400000 }[match[2]];
  if (ms > 365 * 86400000) fail("Максимальный интервал — 365 дней.");
  return ms;
}
async function qr(args) {
  if (Buffer.byteLength(args, "utf8") > 2000)
    fail("Для QR-кода используй текст до 2000 байт UTF-8.");
  return QRCode.toDataURL(args, {
    errorCorrectionLevel: "M",
    width: 512,
    margin: 2,
  });
}
module.exports = {
  fail,
  integer,
  calculate,
  convert,
  password,
  base64,
  timestamp,
  weather,
  duration,
  qr,
};
