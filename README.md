# AI_BOT

## О проекте

AI_BOT — это Telegram-бот на Node.js, который поддерживает:
- обычного бота с командами и голосовой обработкой;
- пользовательский userbot для работы с аккаунтом Telegram;
- режим аккаунт-ассистента с черновиками и утверждением ответов.

Репозиторий использует CommonJS и `.env` для конфигурации.

## Быстрый старт

1. Скопируйте `.env.example` в `.env` и заполните значения.
2. Установите зависимости:

```bash
npm install
```

3. Запустите основного бота:

```bash
npm start
```

4. Для режима `userbot` используйте:

```bash
npm run userbot
```

5. Для генерации Telegram session используйте:

```bash
npm run telegram:session
```

## Зависимости

Проект использует следующие пакеты:

- `@neondatabase/serverless` — вспомогательные инструменты для работы с базами данных и серверлесс-средой;
- `@vercel/speed-insights` — утилиты для измерения производительности и аналитики;
- `axios` — HTTP-клиент для запросов к внешним API;
- `dotenv` — загрузка переменных окружения из `.env`;
- `express` — веб-сервер для проверки состояния и простых HTTP-эндпоинтов;
- `node-telegram-bot-api` — библиотека для Telegram-бота;
- `telegram` — библиотека для Telegram userbot и работы с пользовательской сессией.

## Структура проекта

- `index.js` — основной вход приложения.
- `scripts/userbot.js` — запуск Telegram userbot.
- `scripts/create-telegram-session.js` — генерация `TELEGRAM_STRING_SESSION`.
- `src/bot.js` — инициализация обычного бота, регистрация обработчиков, запуск Express-сервера.
- `src/commands.js` — команды Telegram и интерфейс кнопок.
- `src/handlers/` — обработчики голосовых, фото и текстовых сообщений.
- `src/services/` — интеграции с Telegram, OpenRouter, памятью и аккаунт-ассистентом.
- `src/config.js` — загрузка и валидация переменных окружения.

## Переменные окружения

Обязательные переменные:

```env
BOT_TOKEN=ваш_telegram_bot_token
OPENROUTER_API_KEY=ваш_openrouter_api_key
```

Дополнительные переменные:

```env
PORT=12722
MAX_AUDIO_BYTES=26214400
OPENROUTER_MODEL=openai/gpt-4o-mini
OPENROUTER_STT_MODEL=openai/whisper-large-v3-turbo
OPENROUTER_AUDIO_MODEL=thedrummer/cydonia-24b-v4.1
OPENROUTER_TTS_MODEL=openai/gpt-4o-mini-tts-2025-12-15
OPENROUTER_TTS_VOICE=nova
OPENROUTER_TTS_VOICES=alloy,echo,fable,onyx,nova,shimmer
VOICE_REPLY_MODE=always
```

### Настройки аккаунт-ассистента

```env
ACCOUNT_ASSISTANT_ENABLED=false
ACCOUNT_ASSISTANT_MODE=approval
ACCOUNT_ASSISTANT_OWNER_CHAT_ID=ваш_chat_id
ACCOUNT_ASSISTANT_PRIVATE_ONLY=true
ACCOUNT_ASSISTANT_ALLOW_CHATS=
ACCOUNT_ASSISTANT_BLOCK_CHATS=
ACCOUNT_ASSISTANT_REPLY_DELAY_MS=1200
ACCOUNT_ASSISTANT_MIN_INTERVAL_MS=30000
ACCOUNT_ASSISTANT_PROMPT=answer briefly and casually
```

### Настройки бота-to-bot

```env
BOT_TO_BOT_ENABLED=false
BOT_TO_BOT_OWNER_CHAT_ID=ваш_chat_id
BOT_TO_BOT_CHAT_ID=-1003996551226
BOT_TO_BOT_TARGET_BOT_USERNAME=bot_API_TL_bot
BOT_TO_BOT_ALLOW_BOTS=bot1,bot2
BOT_TO_BOT_MAX_TURNS=6
BOT_TO_BOT_WINDOW_MS=120000
BOT_TO_BOT_MIN_INTERVAL_MS=2000
```

### Telegram userbot

```env
TELEGRAM_API_ID=123456
TELEGRAM_API_HASH=your_api_hash
TELEGRAM_STRING_SESSION=ваша_сессия
```

## Как пользоваться

### Обычный бот

Запустите `npm start`, затем используйте бота в Telegram. В боте доступны команды и кнопки меню.

### Userbot

Запустите `npm run userbot`, чтобы подключиться как пользователь Telegram и обрабатывать входящие сообщения от имени аккаунта.

Userbot поддерживает команды в диалоге с вашим аккаунтом:

- `.help` — показать список команд
- `.ping` — проверить связь
- `.say <текст>` — повторить текст
- `.echo <текст>` — дублировать текст
- `.whoami` — информация об аккаунте
- `.status` — состояние userbot
- `.chatid` — ID текущего чата
- `.time` — текущее время

### Account assistant

Account assistant работает на фоне обычного бота и обрабатывает входящие сообщения аккаунта Telegram.
Для владельца доступны команды управления через основной бот:

- `/account_help` — список команд аккаунт-ассистента
- `/account_status` — статус аккаунт-ассистента
- `/account_config` — текущие настройки
- `/account_pending` — активные черновики
- `/account_send id` — отправить черновик
- `/account_drop id` — отклонить черновик
- `/account_reply id текст` — отправить свой ответ
- `/account_redraft id` — пересоздать AI-черновик
- `/account_message @username текст` — отправить сообщение от аккаунта
- `/account_mode approval|auto|dry-run` — посмотреть или сменить режим
- `/account_private true|false` — включить/выключить личные чаты
- `/account_allow @username` — добавить разрешённый контакт
- `/account_block @username` — заблокировать контакт
- `/account_enable` — включить ассистента
- `/account_disable` — отключить ассистента

При получении черновика владельцу будут приходить inline-кнопки: Отправить, Редрафт, Отклонить и Заблокировать отправителя.
Дополнительные переменные окружения:

```env
USERBOT_START_MESSAGE=Userbot started.
USERBOT_SEND_SELF=false
```

### Создание сессии

Для создания `TELEGRAM_STRING_SESSION` используйте команду:

```bash
npm run telegram:session
```

Следуйте инструкциям в консоли и сохраните выданное значение в `.env`.

## Команды

Обычный бот поддерживает команды:

- `/start` — показать главное меню;
- `/help` — помощь;
- `/menu` — открыть меню;
- `/voice` — информация о голосовом вводе;
- `/voice_on` / `/voice_off` / `/voice_toggle` — управление голосовыми ответами;
- `/voices` — выбор голоса;
- `/voice_set` — задать голос командой;
- `/status` — статус модели и памяти;
- `/reset` — очистить память чата.

Команды аккаунт-ассистента:

- `/account_status` — статус ассистента аккаунта;
- `/account_pending` — черновики ответов;
- `/account_send <id>` — отправить черновик;
- `/account_drop <id>` — отклонить черновик;
- `/account_reply <id> текст` — отправить пользовательский ответ.

Команды bot-to-bot:

- `/bot_status` — статус режима bot-to-bot;
- `/bot_send текст` — отправить сообщение целевому боту в `BOT_TO_BOT_CHAT_ID`;
- `/bot_send @username текст` — отправить сообщение указанному боту.

## Полезные проверки

Если запуск падает:

1. Проверьте `.env` на наличие обязательных переменных.
2. Повторно выполните `npm install`.
3. Запустите `npm start` или `npm run userbot` снова.
4. Если `src/config.js` сообщает об ошибке, проверьте `.env` на пустые значения и исправьте их.

Если `BOT_TOKEN` или `OPENROUTER_API_KEY` пусты или неверны, исправьте `.env` и не запускайте бота с неполной конфигурацией.

## Диагностика

- `npm install` — устанавливает зависимости.
- `npm start` — запускает обычного бота.
- `npm run userbot` — запускает пользовательский аккаунт-бот.
- `npm run telegram:session` — создает Telegram-сессию.

Если что-то не работает, сначала проверьте `.env`, затем повторите `npm install`, и только после этого изучайте логи и `src/config.js`.

## Важно

Храните `TELEGRAM_STRING_SESSION` в секрете — это ваша авторизованная сессия Telegram.

## Дополнения

Для более подробного понимания архитектуры смотрите `ARCHITECTURE.md`.
