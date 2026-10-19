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
- `scripts/` — `userbot.js`, `create-telegram-session.js`.
- `audit-reports/` — отчёты аудита; старые отчёты не удалять и не переписывать.

### Обязательные переменные

`BOT_TOKEN` (вид `123456789:AAH...`) и `OPENROUTER_API_KEY`. Без них или с заглушками `validateConfig()` останавливает запуск и перечисляет все проблемы.
