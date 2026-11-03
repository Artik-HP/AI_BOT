# Доказательная база первичного аудита (baseline)

Это сырые результаты, на которых построен `../AUDIT_INITIAL_2026-10-19_02-03.md`.
Они сняты с **оригинального, не изменённого кода** (`main @ e2a47fe`, тег `pre-audit-baseline`).
Файлы в этой папке **не редактируются** после коммита: они нужны, чтобы сравнивать «до» и «после».

## Что здесь лежит

| Файл | Что внутри | Закрывает находки |
|---|---|---|
| `baseline-http-scenarios.txt` | сценарии S1–S15: бот целиком (процесс `node index.js`) против фейкового Telegram Bot API и фейкового OpenRouter | F003, F006, F009, F010, F017, F018, F019, F021, F028, F029, F031 |
| `baseline-account-assistant.txt` | сценарии A2–A8: ассистент аккаунта со стабом gramjs | F012, F013, F014, F015, F027 |
| `baseline-misc-userbot-memory-config.txt` | M1–M7: производительность памяти, конфиг, утечки в логах, `scripts/userbot.js` | F004, F007, F008, F020, F022, F025, F026 |
| `baseline-bot-to-bot.txt` | режим bot-to-bot, переписывание чужих команд | F024, F032 |
| `baseline-s3b-emoji-corruption.txt` | обрезка по 4096 разрезает эмодзи 😀 → доезжает 🐀 (U+1F400) | F009 |
| `baseline-crash-token-leak.txt` | падение процесса печатает BOT_TOKEN | F003, F007 |
| `baseline-npm-audit.json` | `npm audit --json` на lock-файле baseline | F011 |
| `baseline-eslint.txt` | ESLint (`no-undef`, `no-unused-vars`) | F033 |
| `harness/` | исходники стенда (фейки + сценарии) | воспроизведение |

## Как воспроизвести на baseline

```bash
git worktree add /tmp/ai_bot_baseline pre-audit-baseline
(cd /tmp/ai_bot_baseline && npm ci --no-audit --no-fund)

export APP_ROOT=/tmp/ai_bot_baseline          # против какого checkout гонять
cd audit-reports/evidence/harness
node baseline.js            # все HTTP-сценарии (или: node baseline.js S3)
node run-acct.js            # ассистент аккаунта (или: node run-acct.js A4)
node misc.js                # M1..M7 (или: node misc.js M5)
node bb.js                  # bot-to-bot
node leakcheck.js           # токен в дампе падения
node s3b.js                 # порча эмодзи при обрезке
```

Для запуска нужен только Node 20+ и `npm ci` в проверяемом checkout. Интернет не нужен.

## Как устроен стенд (и его границы)

* `fakeTelegram.js` — HTTP-эмулятор Telegram Bot API (`getMe`, `getUpdates` long-poll, `sendMessage`,
  `getFile`, скачивание файлов, управляемые ошибки вроде `403 bot was blocked`).
* `fakeOpenRouter.js` — эмулятор `/chat/completions` и `/audio/transcriptions`.
* `redirect-shim.js` — `node --require`-шим: подставляет `baseApiUrl` в `node-telegram-bot-api` и
  перенаправляет `https://openrouter.ai` на фейк. Нужен, потому что оригинальный код этого не умеет.
* `acct.js` / `userbot-stub.js` — стаб пакета `telegram` (gramjs). Форма API сверена с исходниками
  установленной версии `telegram@2.26.22` (есть геттер `connected`, **нет** `isConnected`).

**Ограничения:** в песочнице недоступны `api.telegram.org` и `openrouter.ai`, поэтому реальные ответы
этих сервисов (доступность моделей, формат STT-эндпоинта, лимиты Telegram) здесь **не проверялись**.
Все тестовые ключи/токены в логах — заведомо фейковые (`...SECRET_KEY_FOR_LEAK_CHECK_0000`).
