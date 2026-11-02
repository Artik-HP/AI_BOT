# HANDOFF — ideas-links-20261102

Проход «закрыть этап генератора идей, улучшить функции, связать модули». При продолжении обнаружен уже существующий коммит `3f0cd5e` с этапами 0–7; рабочее дерево на входе было чистым. В текущем продолжении коммиты и push не выполнялись; дополнительные правки оставлены в рабочем дереве.
Корень проекта: `D:\Проекты\AI_BOT\AI_BOT`; проверка: `npm run check`.

## Исходное состояние (2026-11-02)

- `git status --short` — пусто: рабочее дерево чистое, последний коммит `cbc6e42 iskra` (работа прошлых сессий закоммичена).
- `npm run check`: ESLint без замечаний; **409 тестов, 409 зелёных** (около 55 с). Node v24.21.0.

## Этап 0 — сверка composeSpark: закрыт, код не менялся

- `src/ideas/spark.js` совпадает с описанием задания: `SPARK_SHAPES` (classic 4, audience_twist 2, audience_constraint 2, minimal 1, maximal 1), `INGREDIENT_POOLS`, `pickShape` (один бросок `rng.int(0, 9)`), защита от урезанных пулов, `SPARK_POOLS_TOO_SMALL`, `pickFresh`, `rerollSpark`, `rollSparks`, `drawSparks`, `shapeOf`.
- Договор подтверждён тестами `tests/unit/ideas-catalog.test.js` и `tests/unit/ideas-spark-history.test.js` (30/30) и одноразовым скриптом (в репозиторий не добавлялся):
  - `fixedRng([0])` → classic с первыми элементами пулов; `fixedRng([9])` → maximal (domain, constraint, twist, audience);
  - одинаковая последовательность чисел → одинаковая искра;
  - 200 бросков `systemRng` → 200 разных искр; 5000 бросков → все пять форм, classic 2023 > maximal 486;
  - без `audiences` — всегда не меньше двух ингредиентов; только `domains` → `SPARK_POOLS_TOO_SMALL`;
  - область первая, значения только из пулов, порядок ключей = порядок строк `formatSpark`.
- `Math.random` в `src/ideas`, `src/site.js`, `public/` — только комментарий в `spark.js`; в `src/services/accountAssistant.js` это id черновиков, не искры.
- `TODO(human)` в `src`, `tests`, `scripts` — нет; тесты от числа маркеров не зависят.
- Потребители: `idea_spark` (`spark_unavailable`), карточка (`src/handlers/ideas.js`), сайт (`src/site.js`, `public/`); `grep "Ограничение:" tests` пуст — никто не ждёт ограничения в каждой искре.

## Ход работ

| Этап | Состояние |
|---|---|
| 0. Сверка composeSpark | готово |
| 1. D1–D6 | готово (D3 — в этапе 2, как велит задание); `npm run check` 419/419 |
| 2. src/lifecycle.js | готово (D3 закрыт); `npm run check` 430/430 |
| 3. U1–U6 | готово; `npm run check` 443/443 |
| 4. L1–L3 | готово; `npm run check` 454/454 |
| 5. Кнопки действий | готово; `npm run check` 464/464 |
| 6. Код искры | готово; `npm run check` 475/475 |
| 7. Искра дня | готово; итоговый `npm run check` 480/480 |

## Этап 1 — дефекты

Каждый тест на дефект сначала запускался на старом коде и краснел (старый код в рабочем дереве, тест добавлен, `node --test <файл>` → fail), затем код исправлялся.

- **D1** `src/companion/outcomes.js` (новый) + `engine.js`: в `turn.outcomes` исходы вызовов; пустой итог после неисправленного отказа — честная фраза. Тест: `tests/integration/ideas-defects.test.js` (было «Готово.»).
- **D2** `searchText` / `searchTokens` в `src/utils/text.js`; банк (`score`) и `memory_search` используют их, дубли `searchTokens`/`stemOf` удалены. Тесты: `text.test.js`, `ideas-bank.test.js`, `companion-tools.test.js` (3 красных на старом коде). Расхождение с заданием: «елка» не находит «Ёлочная» и после правки — это морфология, её добавлять запрещено; «елка» находит «ёлка/ёлки».
- **D4** `db.account()` и `accountState()` (`src/database.js`), `createAccessCheck()` и асинхронная проверка «да/нет/неизвестно» в `createReminderScheduler` (`src/companion/reminders.js`). Тесты: `companion-reminders.test.js` (2), `database.test.js` (PGlite).
- **D5** `spark()` в `src/handlers/ideas.js`: карточка и запрос к модели — две задачи очереди чата подряд; `answerWithAi` принимает функцию-текст; из `reply.js` выделен общий шаг `replyWithAi` (основа для U5). Тесты: `ideas-defects.test.js` (порядок и переброс по карточке 2), `tests/unit/ideas-cards.test.js` (сбой генератора без запроса к модели, выход до броска).
- **D6** `canReroll` учитывает `toolsBlocked(CONFIG.MODEL)`. Тест: `ideas-defects.test.js`.

## Этап 2 — связующий слой

- `src/lifecycle.js`: `registerModule`, `forgetChat`, `revokeUser`, `statusLines`, `exportData`, `moduleNames`, `resetModules`. Ошибка хука → лог (имя и код, без текста) и `failed` в результате.
- Регистрация — `registerLifecycle` в `src/bot.js`: chatMemory, sparkHistory, facts / ideaBank / reminders (при `COMPANION_TOOLS_ENABLED`), lab (при `AI_LAB_ENABLED`), menu. Хуки экспортируют сами модули (`lifecycleHooks`).
- **D3**: `PasswordAuth.logout` вызывает `onRevoke` (`setRevokeHandler` в `bot.js` → `lifecycle.revokeUser`); третий параметр `registerAuth` убран. Тесты: `auth.test.js` (обработчик, сбой обработчика), `database.test.js` (`/access … blocked` → шпион-хук; красный на старом коде), `lab-flow.test.js` (`/logout` снимает сессию лаборатории через lifecycle).
- Попутный дефект (1 из 5 разрешённых): `LabTelegram.revokeUser` при каждом выходе/входе любого человека заводил пустую запись в файле лаборатории (лимит файла — 1000 записей, дальше `LAB_STORE_FORMAT`). Теперь пишет, только если есть что закрыть. Тест: `lab.test.js` (красный на старом коде).
- `/reset` → `lifecycle.forgetChat`; `/status` → прежние строки + «Банк идей: N (…)», «Напоминаний: N, ближайшее …», «Лаборатория: генераций сегодня X из Y, проектов N» (только личный чат). Тесты: `lifecycle-flow.test.js`, `tests/unit/lifecycle.test.js`.
- Время в `/reminders` и `/status` — общий `src/utils/time.js` (`formatUtc`), U3 добавит пояс.

## Этап 3 — улучшения

- **U1** `parseIdeasArgument`, `ideasCommand`, новый `renderIdeas` (`src/handlers/ideas.js`): статус словами и кодами, страницы по 10, «Дальше: /ideas …», «На странице N ничего нет». Число в конце — всегда страница. Тесты: `tests/integration/ideas-commands.test.js`.
- **U2** `parseSparkArgument`: `проще` / `свободнее` → minimal, `конкретнее` → maximal, только у `/spark`; описание `/spark` в `IDEA_COMMANDS` (короткое `description` прежнее).
- **U3** `BOT_TIMEZONE` (`buildConfig` → `readTimeZone`, `.env.example`, README); `src/utils/time.js` (`formatTime`, `localParts`, `isValidTimeZone`); строка «Сейчас» + строка о поясе бота (`persona.js`); `/reminders`, `/status`. Тесты: `time.test.js`, `config.test.js`, `companion-persona.test.js`, `ideas-commands.test.js`.
- **U4** `/me` через `db.account()` и `describeAccess` (`src/accounts.js`): «активен до …», «активен, без срока», «отключён», «срок истёк». Человек без строки — «активен, без срока» (как в D4). Тест: `database.test.js`.
- **U5** `handleAudioMessage` вызывает `replyWithAi`. Изменение поведения: сбой ИИ после успешной расшифровки — `AI_ERROR_MESSAGE` вместо `AUDIO_ERROR_MESSAGE`. Тест: `bot-flow.test.js` (красный на старом коде).
- **U6** `formatPlan`, `formatExamples` (`src/lab/telegram.js`). Тест: `lab-flow.test.js`.
- Починен нестабильный тест `ideas-flow` («искру с карточки можно поменять»): регулярка `/Приём «.+?»/` ломалась на приёме «Пять «почему»» (≈1 из 12 запусков); теперь сравнивается вся строка.

## Этап 4 — связи

- **L1** `reminder_create` + `idea_id` (`src/companion/tools.js`, `scheduleReminder`), отказ `idea_not_found` + подсказка в `hints.js`; `ideaId` в записи напоминания; доставка с «💡 «название» (код)» и «Шаг: …» (`formatReminder(item, idea)`); удаление идеи снимает её напоминания в той же `store.change` (`cancelIdeaReminders` в `bank.js`; `removeIdeaFor`, `clearFor`); `/reminders` — «(идея код)», `/ideas` — «⏰ время»; строка в `src/ideas/prompt.md` (раздел «БАНК ИДЕЙ И ПАМЯТЬ»). `reminders_cancelled` в ответе удаления — только когда что-то отменено (прежний тест на точный ответ без напоминаний не менялся). Тесты: `tests/unit/ideas-reminders.test.js`, `ideas-commands.test.js`.
- **L2** `src/lab/telegram.js`: «📚 В банк идей» (`labIdeaForBank`, `saveToBank`, «← К идее»), `/lab <код>` (`bankIdea`, кнопка «Сделать 3 варианта» → `bank_ideas`), «🎲 Искра» на экране идей программ (`lab_spark` → `spark_ideas`); общий `showIdeas`. Подсказка «В лабораторию: /lab код» в подвале `/ideas` при `AI_LAB_ENABLED`. Тесты: `lab-flow.test.js` (3).
- **L3** хуки `exportData` (банк `bank.exportFor`, факты `factsOf`, напоминания `remindersOf`, лаборатория `exportData`); `/export` в `src/commands.js` (только личный чат, `redact`, `my-data-ГГГГ-ММ-ДД.json`); `/ideas export` → Markdown (`renderIdeasMarkdown`). Тесты: `tests/integration/export-flow.test.js`.
- Намеренно изменённый тест: `bot-commands.test.js` (меню команд) — в публичный список добавлена `export`, у владельца 39 команд вместо 38.

## Этап 5 — кнопки действий

- `src/handlers/actions.js` (новый): `createActionRegistry` (токены `act:<16 знаков base64url>`, сутки, не больше 5000, одна клавиатура вида на человека в чате, `revokeUser`), `registerActions` (`admitCallback`, «Кнопка устарела», «Эта кнопка для того, кто задал вопрос.», ответ на callback всегда, работа — после ответа), `callbackMessage` (свой `message_id` = `cb:<query.id>` и свежий lease), `clearKeyboard`, `ideaMarkers` / `ideaReplyRows` (маркеры через `String.fromCodePoint`, с U+FE0F и без).
- Под карточкой: `sparkRows` и `sparkButton` в `src/handlers/ideas.js`, повторная проверка «искра всё ещё последняя» внутри задачи очереди (`expectLast`).
- Под ответом с идеями: `ideasKeyboard` в `src/handlers/reply.js` (только характер идей, только люди, ≥ 2 маркеров); `sendAIResponse` теперь возвращает последнее сообщение и принимает `replyMarkup` для последней части.
- Регистрация обработчиков — `initCommands` (`src/commands.js`); хук `actions` в `registerLifecycle`.
- Тесты: `tests/unit/actions.test.js` (4), `tests/integration/actions-flow.test.js` (6, в том числе голосовое). `fakeTelegram.callback` получил `chatType`.

## Этап 6 — код искры

- `src/ideas/code.js` (новый): `SPARK_CODE_PATTERN` (`^[0-9][A-Za-z0-9_-]{7}$`), `encodeSpark`, `decodeSpark` (`spark_code_invalid` / `spark_code_outdated`), `encodeIndexes` (для тестов). Цифра версии и контрольная сумма считаются от содержимого каталога.
- Сайт: `sparkPayload` → `code` и `link` (`botLink` через `URL`), `public/index.html` (строка кода, скрыта до первой искры), `public/app.js` (`showCode`: `textContent`, `href` только `https://`), `public/style.css`.
- Бот: `parseSparkArgument` распознаёт код, `sparkFromCode`, `spark(..., { fixed })` записывает искру в историю; `/start spark_<код>` в `src/commands.js`; через вход — `auth.challenge(userId, payload)` / `takeStartPayload` / `startPayloadOf` (`src/services/auth.js`), `onLogin(msg, payload)` → `commands.afterLogin` (служебное сообщение `login:<hex>` со свежим lease, без текста и id сообщения с паролем).
- Тесты: `tests/unit/spark-code.test.js` (4), `site.test.js` (+2), `auth.test.js` (+1), `tests/integration/spark-code-flow.test.js` (4).

## Живая проверка (платные запросы разрешены владельцем по ходу работы)

Скрипт вне проекта (scratchpad), без запуска бота: `.env` читается dotenv и не печатается, `MEMORY_FILE`, `COMPANION_FILE`, `AI_LAB_FILE` подменены на временную папку. Около 8 запросов к `openai/gpt-6.1-sol`: маркеры 1️⃣ 2️⃣ 3️⃣ есть (тема и искра); «сохрани идею 2 в банк» сохранила вторую идею; модель сама предложила напоминание, «да, напомни через 2 часа» создало напоминание с `ideaId`; «развей 2» развил вторую идею.

## Этап 7 — «Искра дня»

- Ключ `daily` в `COMPANION_FILE` (`emptyData`, `MAP_KEYS`; старые файлы дополняются), `setDaily` / `cancelDaily` / `dailyOf` / `dailyHooks` (`src/companion/reminders.js`), `tickDaily` в `createReminderScheduler` (D4, перенос на следующий день, повтор через минуту, после трёх неудач — следующий день, пропущенные дни не догоняются).
- `nextDailyMoment` (`src/utils/time.js`); `/daily` в `src/commands.js` (только личный чат, ответ говорит про пояс); карточка `renderDailyCard` и `deliverDaily` / `dailyButton` (`src/handlers/ideas.js`), кнопка через реестр с `anySession: true`.
- Тесты: `companion-reminders.test.js` (+2), `time.test.js` (+1), `tests/integration/daily-flow.test.js` (2). `bot-commands.test.js`: в меню добавлена `daily` (40 команд у владельца).

## Продолжение 2026-11-02 — контроль сохранённого результата

Состояние на входе отличалось от последнего сообщения чата: этапы 6 и 7 уже завершены и находятся в `3f0cd5e`. Новый исходный прогон: ESLint чист, **480/480**. Секретные файлы не читались и не менялись; живой бот и платные запросы не запускались. Упоминания живой модели выше — сведения сохранённого предыдущего отчёта, не новая проверка.

Подтверждены и исправлены:

1. `src/handlers/actions.js`: при истечении/вытеснении токенов записи клавиатур сохранялись в `keyboards`. Очистка теперь удаляет и их; выполняется также перед созданием новой клавиатуры. Новый тест — `tests/unit/actions.test.js`.
2. `src/companion/reminders.js`: отменённое во время асинхронной проверки допуска напоминание отправлялось из старого снимка. Перед отправкой проверяется наличие записи. Это распространяется на отмену через `/reminders` и атомарное удаление идеи. Тесты — `companion-reminders.test.js`, `ideas-reminders.test.js`.
3. Там же: выключение/перенос `/daily` во время проверки допуска не отменяло старую отправку; ошибка уже начатой отправки могла перезаписать новое расписание. Новая подписка получает добавочное поле `id`; проверка актуальности выполняется после проверки допуска и перед изменением результата доставки. Старые записи без `id` поддерживаются. Три теста — `companion-reminders.test.js`.
4. `src/ideas/spark.js`: если `domains` отсутствовал или был пуст, остальные пулы могли дать искру без области. Добавлена только проверка обязательного пула с прежним `SPARK_POOLS_TOO_SMALL`; основной композитор, веса, пулы и приёмы не переписывались. Новый тест всех форм — `ideas-catalog.test.js`.

Семь новых тестов сначала краснели на неизменённом коде. Дополнительно после исправлений временно подставлены три старых файла из `HEAD`: **0/7, 7 отказов**, затем новые файлы восстановлены в `finally` с побайтовой проверкой SHA-256. После восстановления — **7/7**. Прежние ожидания тестов в текущем продолжении не менялись.

Итоговый `npm run check`: ESLint чист, **487/487**, около 65 с, Node v24.21.0. Итого к первоначальным 409 добавлено **78 тестов**, в текущем продолжении — **7**. `git diff --check` чист. Манифесты зависимостей не менялись относительно `cbc6e42` и текущего `HEAD`.

Дополнительно выполнен обзор ключевых путей ассистента аккаунта (lease, очередь, отправка, кнопки), userbot (допуск, разбор команд, safeHandler), bot-to-bot (направление сообщения, allow-list, ограничение ходов), лаборатории (эксперименты, учебные проверки, артефакты) и RPG (валидация, серверные изменения, лимиты). Это обзор выбранных путей, не полный построчный аудит. В этих модулях дополнительных правок нет.

## Итог

Все этапы 0–7 сделаны; актуальный `npm run check`: ESLint чист, **487/487** (первоначально 409; перед продолжением 480). Отчёт — `REPORT.md` рядом. Сведения о браузерной проверке на 375 px унаследованы из предыдущего прохода; в текущем продолжении она не повторялась. Не проверено заново: живой Telegram, реальная модель, PostgreSQL на VPS, нативные сигналы Windows.

## Если продолжать

Вопросы владельцу — в `REPORT.md`, раздел 7. Текущие дополнительные правки не закоммичены; незавершённого этапа нет. Следующие проверки требуют отдельной среды: живой Telegram, PostgreSQL на VPS, ручной просмотр кнопок и ссылки. Второй процесс с настоящим токеном не запускать.
