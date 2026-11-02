## AGENTS.md — инструкции для AI-агентов

Проект: Telegram-бот на Node.js (CommonJS, Node 20+). Подробности — в `README.md` и `ARCHITECTURE.md`.

### Команды

```bash
cp .env.example .env     # заполнить BOT_TOKEN и OPENROUTER_API_KEY (заглушки не принимаются)
npm ci
npm start                # бот (index.js)
npm run userbot          # userbot (scripts/userbot.js)
npm run telegram:session # создать TELEGRAM_STRING_SESSION
npm run lint             # ESLint
npm test                 # unit + интеграционные тесты (интернет не нужен)
npm run check            # lint + test
```

### Правила для изменений

- Тесты обязательны: каждое исправление или поведение покрывается тестом в `tests/`. Интеграционные тесты запускают настоящий бот против фейков Telegram/OpenRouter (`tests/helpers`).
- Логи — только через `src/utils/logger.js` (`console.*` запрещён линтером). Секреты, токены и тексты сообщений в лог не писать.
- Любой обработчик событий Telegram оборачивается в `safeHandler` (`src/utils/safe.js`): ошибка в async-обработчике иначе роняет процесс.
- Ошибки HTTP-клиентов наружу сервисов выходят как `ApiError` (`toSafeError`), никогда не сырой `AxiosError`: в нём лежат ключ и диалог.
- Переменные окружения читаются только в `src/config.js` (`buildConfig`). Новую переменную добавлять туда, в `.env.example` и в README. Исключение: `src/utils/logger.js` и `redact.js` лежат ниже `config` в графе зависимостей (сам `config` пишет предупреждения через логгер) и читают `LOG_LEVEL`, `LOG_MESSAGES` и значения секретов лениво; сами `LOG_*` при этом проверяются в `buildConfig`, а булевы значения разбирает общий `src/utils/parse.js`.
- Не коммитить `.env`, `*.session`, `memory.json*`. Не печатать содержимое этих файлов.
- Не писать в исходники невидимые символы и `\u`-последовательности внутри регулярок: для таких символов использовать `String.fromCodePoint` (проверяет `tests/unit/source-hygiene.test.js`).

### Ключевые файлы

- `index.js` — вход; `src/bot.js` — сборка, Express, остановка.
- `src/config.js` — окружение и валидация; `src/commands.js` — команды и меню.
- `src/handlers/` — `text`, `voice`, `photo`, `guard` (допуск и лимиты).
- `src/services/` — `telegram`, `openrouter`, `memory`, `access`, `accountAssistant`.
- `src/utils/` — `logger`, `errors`, `redact`, `text`, `queue`, `ttlSet`, `safe`.
- `src/ideas/` — генератор идей (характер по умолчанию): `prompt.md`, `catalog.js` (пулы искр, приёмы), `spark.js` (формы искры `SPARK_SHAPES`; новый ингредиент = пул в `SPARK_POOLS` + `INGREDIENT_POOLS` + подпись в `SPARK_LABELS`), `recent.js` (недавние искры чата: только память процесса), `bank.js`, `tools.js` (функции модели), `commands.js` (команды и кнопки: из него строятся меню Telegram, `/help` и сайт). `src/handlers/ideas.js` — их обработчики, `src/handlers/reply.js` — общий ответ ИИ (его использует и текстовый обработчик).
- `src/site.js` + `public/` — сайт на `/` и `GET /api/spark`. Только статика без секретов под строгим CSP: без инлайн-стилей и скриптов, без внешних адресов.
- Функция модели добавляется в `HANDLERS` и в набор своего характера (`toolsFor` в `src/companion/tools.js`), её имя — в промпте этого характера: договор «промпт ↔ код» проверяют тесты. У каждого нового кода отказа должна быть подсказка модели: `hint` в ответе или запись в `src/companion/hints.js` (проверяет `tests/unit/companion-hints.test.js`).
- `scripts/` — `userbot.js`, `create-telegram-session.js`.
- `audit-reports/` — отчёты аудита; старые отчёты не удалять и не переписывать.

### Обязательные переменные

`BOT_TOKEN` (вид `123456789:AAH...`) и `OPENROUTER_API_KEY`. Без них или с заглушками `validateConfig()` останавливает запуск и перечисляет все проблемы.
