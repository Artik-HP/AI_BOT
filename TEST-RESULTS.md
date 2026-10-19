# Проверки — 19 октября 2026

## Исходное состояние

- `npm test`: 174 PASS, 0 FAIL, 0 SKIP; локальные данные изолированы. Telegram/AI-транспорты заменены тестовыми там, где используются интеграции.
- `npm run test:e2e`: 16 PASS; настоящий Edge и локальный Express/SQLite. AI protocol fixtures в двух сценариях; генерация AI и Telegram delivery не подтверждены.
- `npm run check`: PASS.
- `npm run lint`: 0 ошибок, 1 предупреждение (`src/commandSystem/userbot.js`, unused ctx).
- `npm audit --json`: 0 уязвимостей; 383 зависимости.
- Runtime: Node.js v24.21.0, npm 11.19.0, Windows.

## Границы

Managed security scan BLOCKED до начала анализа: нужен managed filesystem permission profile. Production, Linux/VPS, реальные Telegram-клики/доставка, polling/webhook и платные AI-запросы в этом запуске NOT TESTED.

## Реальный OpenRouter после первых исправлений

`scripts/check-interactive-live.js` с отдельными JSON history, SQLite и interactive state в `.local/audit-live-2026-10-19/`, max output 1024:

- 10 PASS, 2 FAIL из 12 сценариев. Успешны single/multiple/open вопросы на двух настроенных моделях, продолжение выбранных ответов, schema/json/prompt streaming и анализ синтетического изображения.
- FAIL: direct tools + direct streamed tools на openai/gpt-4o-mini — HTTP 403 от внешнего сервиса. Не скрыто, настройки/ключи не менялись.
- Реальные Telegram-сообщения не отправлялись; клики/доставка не проверены. Аудио/STT в этом прогоне отсутствует.
- Результаты и синтетическая история: `.local/audit-live-2026-10-19/results.json`; старые live-отчёты в docs не перезаписаны.
