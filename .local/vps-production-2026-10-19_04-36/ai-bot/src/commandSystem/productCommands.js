const crypto = require("node:crypto");
const CONFIG = require("../config");
const prefs = require("../services/preferences");
const personal = require("../services/personalData");
function registerProductCommands(register, result, btn) {
  register('selfcheck','Самопроверка','Проверить код, конфигурацию, реестр и хранилище','system','🔎','',async ctx=>{
    const key=ctx.scope+':selfcheck',cached=ctx.store.get(key,null),check=cached&&Date.now()-Date.parse(cached.checkedAt)<60000?cached:await require('../services/selfCheck').selfCheck(ctx.store);ctx.store.set(key,check);
    return result('Самопроверка\n'+check.checks.map(c=>`${c.ok?'✓':'!'} ${c.name}${c.errors!==undefined?`: ошибок ${c.errors}, предупреждений ${c.warnings}`:''}${c.detail?' — '+c.detail:''}`).join('\n')+'\n\n'+check.boundary);
  });
  register(
    "lock",
    "Заблокировать",
    "Закрыть доступ до повторного входа",
    "system",
    "🔒",
    "",
    (ctx) => {
      if (ctx.transport === "telegram")
        require("../services/access").getAccessGate().lock(ctx.msg);
      return result("🔒 Доступ закрыт. Для входа отправь /start с паролем.");
    },
    { availability: { telegram: true, web: false, userbot: false } },
  );
  register(
    "cancel",
    "Отмена",
    "Завершить текущий ввод или выбор",
    "system",
    "✕",
    "",
    (ctx) => {
      ctx.store.set(ctx.scope + ":selection", null);
      ctx.store.set(ctx.scope + ":aiQuestion", null);
      return result("Действие отменено.", [btn("Главное меню", "menu")]);
    },
  );
  register(
    "web",
    "Веб-интерфейс",
    "Открыть удобную панель в браузере",
    "system",
    "🌐",
    "",
    (_ctx) => {
      if (CONFIG.WEB_PUBLIC_URL)
        return {
          ...result("🌐 Веб-интерфейс\nОткрой защищённую панель в браузере."),
          links: [{ label: "🌐 ВЕБ-ИНТЕРФЕЙС", url: CONFIG.WEB_PUBLIC_URL }],
        };
      return result(
        "🌐 ВЕБ-ИНТЕРФЕЙС\nЛокальная панель: http://127.0.0.1:12723\nЭтот адрес работает только на компьютере, где запущен бот. На этом компьютере запусти npm run open:web — сервер запустится при необходимости и откроется браузер.\nДля доступа с телефона администратор должен настроить публичный WEB_PUBLIC_URL с HTTPS и авторизацией.",
      );
    },
  );
  register(
    "models",
    "AI-модели",
    "Выбрать разрешённую модель для своих диалогов",
    "ai",
    "🧠",
    "",
    (ctx, args) => {
      if (args) prefs.savePreferences(ctx.scope, { model: args }, ctx.store);
      const p = prefs.getPreferences(ctx.scope, ctx.store);
      return result(
        `Твоя модель: ${p.model}\nВыбери модель:`,
        prefs
          .models()
          .map((model) =>
            btn(`${model === p.model ? "✓ " : ""}${model}`, "models", model),
          ),
      );
    },
  );
  register(
    "mode",
    "Режим AI",
    "Чат, программист, учитель или креатив",
    "ai",
    "🎛",
    "teacher",
    (ctx, args) => {
      if (args) prefs.savePreferences(ctx.scope, { mode: args }, ctx.store);
      const p = prefs.getPreferences(ctx.scope, ctx.store);
      return result(
        `Режим: ${prefs.MODES[p.mode]}`,
        Object.entries(prefs.MODES).map(([id, label]) =>
          btn(`${id === p.mode ? "✓ " : ""}${label}`, "mode", id),
        ),
      );
    },
  );
  register(
    "instructions",
    "Личные инструкции",
    "Задать собственные пожелания к AI",
    "ai",
    "✍",
    "Отвечай коротко и с примерами",
    (ctx, args) => {
      if (!args)
        return result(
          "Напиши пожелания к стилю ответа (до 2000 символов). Для удаления — clear.",
          [],
          {
            command: "instructions",
            placeholder: "Например: объясняй на бытовых примерах",
          },
        );
      prefs.savePreferences(
        ctx.scope,
        { instructions: args === "clear" ? "" : args },
        ctx.store,
      );
      return result(
        args === "clear" ? "Инструкции удалены." : "Инструкции сохранены.",
        [btn("Мои настройки", "settings")],
      );
    },
  );
  register(
    "settings",
    "Настройки",
    "Стиль, язык, контекст и персональные инструкции",
    "system",
    "⚙",
    "style concise",
    (ctx, args) => {
      if (args) {
        const [key, ...rest] = args.split(" "),
          value = rest.join(" ");
        const patch =
          key === "history"
            ? { historyLimit: Number(value) }
            : key === "memory"
              ? { memoryEnabled: value === "on" }
              : { [key]: value };
        if (key === "memory" && !["on", "off"].includes(value))
          throw prefs.userError("Используй memory on или memory off.");
        prefs.savePreferences(ctx.scope, patch, ctx.store);
      }
      const p = prefs.getPreferences(ctx.scope, ctx.store);
      return result(
        `⚙ Мои настройки\nМодель: ${p.model}\nРежим: ${prefs.MODES[p.mode]}\nСтиль: ${prefs.STYLES[p.style]}\nЯзык ответа: ${p.language}\nКонтекст: ${p.memoryEnabled ? "включён" : "выключен"}, ${p.historyLimit} сообщений\nЛичные инструкции: ${p.instructions ? "заданы" : "пусто"}`,
        Object.entries(prefs.STYLES)
          .map(([id, label]) => btn(label, "settings", "style " + id))
          .concat([
            btn("Выбрать модель", "models"),
            btn("Выбрать режим", "mode"),
            btn("Мои инструкции", "instructions"),
            btn("Управление памятью", "memory"),
          ]),
      );
    },
  );
  register(
    "history",
    "История диалогов",
    "Поиск, создание и продолжение своих диалогов",
    "system",
    "🕘",
    "",
    (ctx, args) => {
      if (args.startsWith("new ")) {
        const t = personal.newThread(ctx.scope, args.slice(4), ctx.store);
        return result("Создан диалог: " + t.title, [
          btn("Начать разговор", "chat"),
        ]);
      }
      if (args.startsWith("use ")) {
        personal.useThread(ctx.scope, args.slice(4), ctx.store);
        ctx.store.set(ctx.scope + ":aiQuestion", null);
        return result("Диалог выбран. Можешь продолжить его.", [
          btn("Продолжить", "chat"),
        ]);
      }
      if (args && !args.startsWith("search "))
        throw prefs.userError(
          "Используй new название, use ID или search текст.",
        );
      const all = personal.history(
          ctx.scope,
          args.startsWith("search ") ? args.slice(7) : "",
          ctx.store,
        ),
        p = prefs.getPreferences(ctx.scope, ctx.store);
      const text = all
        .map(
          (t) =>
            `${t.id === p.activeThread ? "● " : "○ "}${t.title} (${t.id}) — ${t.messages.length} сообщений${
              args
                ? "\n" +
                  t.messages
                    .slice(-5)
                    .map((m) => m.content.slice(0, 300))
                    .join("\n")
                : ""
            }`,
        )
        .join("\n\n");
      return result(
        "История\n" + text,
        all.map((t) => btn("Продолжить: " + t.title, "history", "use " + t.id)),
        {
          command: "history",
          placeholder: "new Новый диалог или search текст",
        },
      );
    },
  );
  register(
    "memory",
    "Память AI",
    "Просмотреть или очистить контекст текущего диалога",
    "system",
    "🗂",
    "",
    (ctx, args) => {
      const memory = require("../services/memory");
      if (args === "clear") {
        personal.clearCurrent(ctx.scope, ctx.store);
        return result(
          "Контекст текущего диалога очищен. Другие диалоги, заметки и задачи сохранены.",
        );
      }
      if (args) throw prefs.userError("Используй /memory или /memory clear.");
      const m = memory.getUserMemory(
        prefs.threadKey(ctx.scope, prefs.getPreferences(ctx.scope, ctx.store)),
      );
      return result(
        `Сообщений: ${m.messages.length}\n${m.summary ? "Сводка: " + m.summary.slice(0, 3000) : "Сводка пока пустая."}\nИмя: ${m.nickname || "не указано"}`,
        [
          btn("Очистить этот контекст", "memory", "clear"),
          btn("История диалогов", "history"),
        ],
      );
    },
  );
  register(
    "diagnostics",
    "Диагностика",
    "Проверить состояние приложения и AI-подключение",
    "system",
    "🩺",
    "",
    async (ctx, args) => {
      if (args === "check") {
        const provider = prefs.getPreferences(ctx.scope, ctx.store).provider;
        const checked = await require("../services/aiProviders").checkProvider(
          provider,
        );
        ctx.store.set(ctx.scope + ":provider-checks", { [provider]: checked });
      } else if (args)
        throw prefs.userError("Используй /diagnostics или /diagnostics check.");
      const d = require("../services/diagnostics").snapshot(
        ctx.scope,
        ctx.store,
      );
      return result(
        `🩺 ${d.product}\nСервер работает ${d.uptimeSeconds} сек.\nХранилище: ${d.database}\nЗапросов команд: ${d.stats.total}; ошибок: ${d.stats.errors}\nAI сегодня: ${d.budget.daily || 0}/${d.limits.daily}\nПоследняя проверка провайдера: ${d.providerChecks[d.preferences.provider]?.status || "ещё не выполнялась"}`,
        [btn("Проверить подключение AI", "diagnostics", "check")],
      );
    },
  );
  register(
    "export",
    "Экспорт данных",
    "Скачать свою историю, настройки, заметки и задачи в JSON",
    "system",
    "📤",
    "",
    (_ctx) => ({
      ...result("Экспорт содержит только данные этой пользовательской сессии."),
      download: "personal-data",
    }),
  );
  register(
    "delete_data",
    "Удалить мои данные",
    "Удалить свои диалоги, настройки и сохранённые записи",
    "system",
    "🗑",
    "",
    (ctx, args) => {
      const key = ctx.scope + ":delete-confirm",
        pending = ctx.store.get(key, null);
      if (args) {
        if (!pending || pending.nonce !== args || pending.expires < Date.now())
          throw prefs.userError(
            "Подтверждение устарело. Открой удаление заново.",
          );
        personal.deleteData(ctx.scope, ctx.store);
        return result("Твои данные этой сессии удалены.");
      }
      const nonce = crypto.randomBytes(8).toString("hex");
      ctx.store.set(key, { nonce, expires: Date.now() + 300000 });
      return result(
        "Будут удалены твои диалоги, заметки, задачи, напоминания и настройки этой сессии. Это действие нельзя отменить.",
        [
          btn("Да, удалить мои данные", "delete_data", nonce),
          btn("Отмена", "cancel"),
        ],
      );
    },
  );
  register(
    "habits",
    "Привычки",
    "Личный дневник привычек и отметки по дням",
    "daily",
    "🌱",
    "add Читать 15 минут",
    (ctx, args) =>
      ctx.store.transaction(() => {
        const key = ctx.scope + ":habits",
          all = ctx.store.get(key, []),
          today = new Date().toISOString().slice(0, 10);
        if (args.startsWith("add ")) {
          const text = args.slice(4).trim();
          if (!text || text.length > 100 || all.length >= 30)
            throw prefs.userError("До 30 привычек; название до 100 символов.");
          all.push({
            id: crypto.randomBytes(4).toString("hex"),
            text,
            days: [],
          });
        } else if (args.startsWith("check ")) {
          const h = all.find((h) => h.id === args.slice(6));
          if (!h) throw prefs.userError("Привычка не найдена.");
          h.days = [...new Set([...h.days, today])].slice(-366);
        } else if (args)
          throw prefs.userError("Используй add название или check ID.");
        ctx.store.set(key, all);
        return result(
          all.length
            ? all
                .map(
                  (h) =>
                    `${h.days.includes(today) ? "✅" : "▫"} ${h.text} — отмечено дней: ${h.days.length}`,
                )
                .join("\n")
            : "Добавь привычку и отмечай выполнение.",
          all
            .filter((h) => !h.days.includes(today))
            .map((h) => btn("✓ " + h.text, "habits", "check " + h.id)),
          { command: "habits", placeholder: "add Новая привычка" },
        );
      }),
  );
  register(
    "flashcards",
    "Карточки знаний",
    "Свои карточки: вопрос, ответ и проверка памяти",
    "code",
    "🎴",
    "add Что такое замыкание? | Функция с доступом к внешней области",
    (ctx, args) => {
      const key = ctx.scope + ":flashcards",
        all = ctx.store.get(key, []);
      if (args.startsWith("add ")) {
        const parts = args
          .slice(4)
          .split("|")
          .map((t) => t.trim());
        if (
          parts.length !== 2 ||
          parts.some((t) => !t || t.length > 1000) ||
          all.length >= 200
        )
          throw prefs.userError(
            "Используй add вопрос | ответ. До 200 карточек, по 1000 символов.",
          );
        all.push({
          id: crypto.randomBytes(4).toString("hex"),
          question: parts[0],
          answer: parts[1],
          reviews: 0,
        });
        ctx.store.set(key, all);
        return result("Карточка сохранена.", [
          btn("Начать повторение", "flashcards", "study"),
        ]);
      }
      if (args === "study") {
        if (!all.length)
          return result("Добавь первую карточку.", [], {
            command: "flashcards",
            placeholder: "add вопрос | ответ",
          });
        const card = [...all].sort((a, b) => a.reviews - b.reviews)[0];
        return result(card.question, [
          btn("Показать ответ", "flashcards", "reveal " + card.id),
        ]);
      }
      if (args.startsWith("reveal ") || args.startsWith("done ")) {
        const card = all.find((c) => c.id === args.split(" ")[1]);
        if (!card) throw prefs.userError("Карточка не найдена.");
        if (args.startsWith("done ")) {
          card.reviews++;
          ctx.store.set(key, all);
          return result("Повторение записано.", [
            btn("Следующая карточка", "flashcards", "study"),
          ]);
        }
        return result(card.answer, [
          btn("Запомнил", "flashcards", "done " + card.id),
          btn("Повторить ещё", "flashcards", "study"),
        ]);
      }
      if (args)
        throw prefs.userError("Используй add вопрос | ответ или study.");
      return result(
        `Карточек: ${all.length}`,
        [btn("Повторить знания", "flashcards", "study")],
        { command: "flashcards", placeholder: "add вопрос | ответ" },
      );
    },
  );
}
module.exports = { registerProductCommands };
