const CONFIG = require("../config");
const fs = require("fs");
const { LabService } = require("./service");
const { id, scopeKey } = require("./store");
const { splitMessage } = require("../utils/text");
const { safeHandler } = require("../utils/safe");
const { admitCallback, admitMessage } = require("../handlers/guard");
const { claimIncomingMessage, isAddressedToThisBot } = require("../services/telegram");
const schema = require("./schemas");
const logger = require("../utils/logger");

const ERRORS = {
  LAB_BUSY: "Уже выполняется операция. Дождись результата или нажми «Отмена».",
  LAB_CAPACITY: "Сейчас выполняются четыре AI-задачи. Попробуй позже.",
  LAB_QUOTA: "Достигнут дневной лимит генераций лаборатории (сутки UTC).",
  LAB_DUPLICATE: "Это действие уже обработано. Повторного запроса не было.",
  LAB_NOT_FOUND: "Объект не найден в твоей лаборатории.",
  LAB_CANCELLED: "Операция отменена. Отправленный провайдеру запрос мог быть оплачен.",
  LAB_REQUEST_UNKNOWN: "Результат запроса неизвестен. Провайдер мог учесть запрос. Автоматического повтора не было.",
  LAB_STORE_LOCKED: "Хранилище лаборатории занято другим процессом или требует проверки владельца.",
  LAB_LESSON_NOT_SOLVED: "Этот переход сейчас недоступен. Открой текущий урок.",
  LAB_STORE_LIMIT: "Достигнут лимит: 30 объектов каждого типа или 100 попыток на трек. Удали ненужные данные.",
  LAB_STORE_SIZE: "Хранилище заполнено. Экспортируй и удали ненужные проекты.",
  LAB_INCOMPLETE_REPLY: "Ответ модели не завершён. Готовый результат не сохранён. Новая генерация требует нового действия."
};
const button = (label, action, entityId = null, value = null) => ({ label, action, entityId, value });
const BACK = button("← Назад", "home");
const CANCEL = button("Отмена", "cancel");

class LabTelegram {
  constructor(bot, service = new LabService()) {
    this.bot = bot;
    this.service = service;
    this.sessions = new Map();
    this.pending = new Set();
  }

  ctx(msg) { return { chatId: msg.chat.id, userId: msg.from.id }; }
  hasSession(msg) {
    if (msg.chat.type !== "private" || String(msg.chat.id) !== String(msg.from?.id)) return false;
    const ctx = this.ctx(msg);
    const key = scopeKey(ctx);
    if (this.sessions.has(key)) return true;
    if (!fs.existsSync(this.service.store.filename)) return false;
    const scope = this.service.data(ctx);
    // Preserve routing across restart, including a redelivered paid laboratory message.
    const duplicate = scope.operations.some((op) => op.eventId === `msg:${msg.message_id}`) ||
      scope.tracks.some((track) => track.attempts.some((attempt) => attempt.eventId === `msg:${msg.message_id}`));
    if (!scope.session?.active && !duplicate) return false;
    const trackId = scope.session?.trackId;
    this.sessions.set(key, { mode: trackId ? "lesson" : "home", trackId, at: Date.now() });
    return true;
  }
  leave(ctx) {
    this.service.cancel(ctx);
    this.sessions.delete(scopeKey(ctx));
    this.service.store.change(ctx, (scope) => { scope.session = null; });
  }
  exit(msg) { this.leave(this.ctx(msg)); }

  session(ctx, value) {
    const now = Date.now();
    for (const [key, item] of this.sessions) if (now - item.at > 30 * 60000) this.sessions.delete(key);
    if (this.sessions.size >= 1000 && !this.sessions.has(scopeKey(ctx))) throw new Error("LAB_CAPACITY");
    this.sessions.set(scopeKey(ctx), { ...value, at: now });
    this.service.store.change(ctx, (scope) => { scope.session = { active: true, trackId: value.trackId || null }; });
  }

  async screen(ctx, text, buttons = []) {
    const view = id();
    const actions = buttons.map((item) => ({ ...item, id: id(), view, expires: Date.now() + 86400000 }));
    const parts = splitMessage(text);
    let sent;
    for (let index = 0; index < parts.length; index += 1) {
      const options = index === parts.length - 1 ? { reply_markup: { inline_keyboard:
        actions.reduce((rows, item, i) => { if (i % 2 === 0) rows.push([]); rows.at(-1).push({ text: item.label, callback_data: `lab:${item.id}` }); return rows; }, []) } } : {};
      sent = await this.bot.sendMessage(ctx.chatId, parts[index], options);
    }
    this.service.store.change(ctx, (scope) => {
      scope.view = view;
      scope.callbacks = actions.map((action) => ({ ...action, messageId: sent.message_id }));
    });
  }

  async home(ctx) {
    this.session(ctx, { mode: "home" });
    await this.screen(ctx, "🔬 AI-лаборатория\nИдеи, сравнение промптов, обучение и небольшие инструменты.\n" +
      "Проекты, учебные треки и запущенные эксперименты сохраняются отдельно от обычного чата. " +
      "Черновики ввода живут до 30 минут в памяти. /reset очищает обычный чат; свои данные лаборатории можно экспортировать и удалить здесь.\n" +
      `Модель: ${CONFIG.AI_LAB_MODEL || CONFIG.MODEL}. Лимит: ${CONFIG.AI_LAB_DAILY_REQUESTS} генераций/сутки UTC.`, [
      button("💡 Идеи программ", "ideas"), button("🧪 AI-эксперименты", "experiments"),
      button("📚 Учиться", "learn"), button("🛠 Мини-инструменты", "tools"),
      button("📁 Мои проекты", "projects"), button("← Обычный чат", "exit"),
      button("Экспорт лаборатории", "export_all"), button("Очистить лабораторию…", "clear")
    ]);
  }

  async open(msg) {
    if (msg.chat.type !== "private" || String(msg.chat.id) !== String(msg.from.id)) {
      await this.bot.sendMessage(msg.chat.id, "Открой /lab в личном диалоге с ботом. Личные данные доступны только там.");
      return;
    }
    await this.guard(this.ctx(msg), () => this.home(this.ctx(msg)));
  }

  async guard(ctx, task) {
    try { return await task(); }
    catch (error) {
      // Never send/log provider text, arbitrary error messages or payloads.
      logger.warn("Lab action failed", { name: error.name,
        code: /^[A-Z0-9_]{1,40}$/.test(error.code || "") ? error.code : null,
        reason: /^LAB_[A-Z_]+$/.test(error.message) ? error.message : null });
      await this.bot.sendMessage(ctx.chatId, ERRORS[error.message] ||
        (error.status ? `AI-запрос не завершён (HTTP ${error.status}). Повтора не было.` :
          "Не удалось обработать данные. Проверь формат и ограничения. Незавершённый результат не выдан как готовый. /lab — открыть меню."));
    }
  }

  async progress(ctx) {
    await this.screen(ctx, "⏳ Выполняется запрос. «Отмена» остановит следующие шаги. Уже отправленный запрос мог быть учтён провайдером.", [CANCEL]);
  }

  async handleText(msg) {
    const ctx = this.ctx(msg);
    return this.guard(ctx, async () => {
      const value = schema.text(msg.text.trim(), 8000);
      if (["Отмена", "Назад", "← Обычный чат"].includes(value)) {
        this.service.cancel(ctx);
        if (value === "← Обычный чат") { this.exit(msg); await this.bot.sendMessage(ctx.chatId, "Обычный чат включён."); }
        else await this.home(ctx);
        return;
      }
      const current = this.sessions.get(scopeKey(ctx));
      if (!current || Date.now() - current.at > 30 * 60000) { await this.home(ctx); return; }
      if (this.pending.has(scopeKey(ctx))) throw new Error("LAB_BUSY");
      this.pending.add(scopeKey(ctx));
      try {
        const event = `msg:${msg.message_id}`;
        if (current.mode === "ideas_input") {
          await this.progress(ctx);
          const ideas = await this.service.ideas(ctx, event, value);
          this.session(ctx, { mode: "ideas_result", ideas });
          await this.screen(ctx, "💡 Идеи (гипотезы, без проверки рынка)\n\n" + ideas.map((idea, i) =>
            `${i + 1}. ${idea.title}\n${idea.problem}\nДля кого: ${idea.audience}\nВвод: ${idea.input}\nРезультат: ${idea.output}\nMVP: ${idea.mvp.join("; ")}\nСтек: ${idea.stack}\nТрудоёмкость: ${idea.effort}\nПроверка пользы: ${idea.validation}\nОграничения: ${idea.limitations}\nМонетизация: ${idea.monetization}`).join("\n\n"),
          [...ideas.map((idea, i) => button(`Выбрать ${i + 1}`, "idea", null, i)), BACK]);
        } else if (current.mode === "experiment_input") {
          if (value.startsWith("{")) {
            const spec = this.service.prepareExperiment(value);
            this.session(ctx, { mode: "experiment_preview", spec });
            await this.experimentPreview(ctx, spec);
          } else {
            this.session(ctx, { mode: "experiment_data", draft: { task: value } });
            await this.screen(ctx, "Пришли общий тестовый ввод для обоих промптов: например, характеристики одного товара.", [BACK]);
          }
        } else if (["experiment_data", "experiment_a", "experiment_b"].includes(current.mode)) {
          if (current.mode === "experiment_data") {
            this.session(ctx, { mode: "experiment_a", draft: { ...current.draft, input: value } });
            await this.screen(ctx, "Вариант A: как AI должен обработать эти данные? Например: опиши товар одним коротким абзацем.", [BACK]);
          } else if (current.mode === "experiment_a") {
            this.session(ctx, { mode: "experiment_b", draft: { ...current.draft, a: value } });
            await this.screen(ctx, "Вариант B: введи другую инструкцию для той же задачи. Например: перечисли три преимущества для покупателя.", [BACK]);
          } else {
            const spec = this.service.prepareExperiment({ ...current.draft, b: value });
            this.session(ctx, { mode: "experiment_preview", spec });
            await this.experimentPreview(ctx, spec);
          }
        } else if (current.mode === "tool_input") {
          const spec = { kind: current.kind, request: value };
          this.session(ctx, { mode: "tool_preview", spec });
          await this.toolPreview(ctx, spec);
        } else if (current.mode === "learning_goal") {
          this.session(ctx, { ...current, mode: "learning_confirm", goal: value });
          await this.screen(ctx, `Учебный трек: ${current.language}, ${current.level}.\nЦель: ${value}\nПлан: три занятия по основам выбранного уровня. Задания на чтение кода, затем AI-разбор своих решений. Сохраняются ответы и прогресс.`,
            [button("Создать учебный трек", "track_create"), BACK]);
        } else if (current.mode === "lesson") {
          await this.progress(ctx);
          const attempt = await this.service.checkAnswer(ctx, event, current.trackId, value);
          await this.screen(ctx, `${attempt.method === "rules" ? "Проверка ответа по правилам" : "AI-разбор кода (код не выполнялся)"}: ${attempt.status}\n${attempt.explanation}\n${attempt.recommendations}`,
            [button("Открыть задание", "track", current.trackId), BACK]);
        } else if (current.mode === "idea_refine") {
          await this.progress(ctx);
          const plan = await this.service.plan(ctx, event, current.idea, value);
          this.session(ctx, { mode: "idea_selected", idea: current.idea, plan });
          await this.selectedIdea(ctx, current.idea, plan);
        } else {
          await this.screen(ctx, "Выбери действие кнопкой. Для свободной беседы нажми «Обычный чат» в главном меню лаборатории.", [BACK]);
        }
      } finally { this.pending.delete(scopeKey(ctx)); }
    });
  }

  async selectedIdea(ctx, idea, plan = null, projectId = null) {
    const body = `${idea.title}\n${idea.problem}\n${plan ? JSON.stringify(plan, null, 2) : "Выбери следующий шаг."}`;
    await this.screen(ctx, body, [button("План первой версии", "plan", projectId), button("Уточнить идею", "refine", projectId),
      button("Разобрать слабые места", "critique", projectId), button("Создать мини-инструмент", "idea_tool", projectId),
      ...(!projectId ? [button("Сохранить в проект", "save")] : [button("Экспорт JSON", "export", projectId), button("Удалить проект…", "delete", projectId)]), BACK]);
  }

  async experimentPreview(ctx, spec, existingId = null) {
    await this.screen(ctx, `🧪 Предварительный просмотр\nЗадача: ${spec.task}\nОбщий ввод:\n${spec.input}\n\nA:\n${spec.a}\n\nB:\n${spec.b}\n\n` +
      `Модель: ${spec.model}\ntemperature: ${spec.temperature}\nmax_tokens: ${spec.maxTokens}\nПроверки: ${JSON.stringify(spec.criteria)}\n` +
      (existingId ? "Повторятся только незавершённые варианты. Предыдущие запросы могли быть оплачены, включая тайм-ауты." : "2 генерации. Стоимость заранее неизвестна. Обычная история чата не передаётся."),
    [button(existingId ? "Подтвердить новый запрос" : "Запустить: 2 генерации", "experiment_run", existingId), button("Изменить", "experiments"), CANCEL]);
  }

  async showExperiment(ctx, exp) {
    await this.screen(ctx, `🧪 Эксперимент ${exp.id}\nСтатус: ${exp.status}. Результаты сохранены.\n` + exp.runs.map((run, i) =>
      `\n${i === 0 ? "A" : "B"}: ${run.status}\n${run.text || run.error || "Запрос не отправлен"}\n` +
      `Время: ${run.elapsedMs ?? "Нет данных"} мс\nМодель провайдера: ${run.model ?? "Нет данных"}\n` +
      `Usage: ${Object.keys(run.usage || {}).length ? JSON.stringify(run.usage) : "Нет данных"}\nПроверки: ${JSON.stringify(run.checks || {})}`).join("\n") +
      "\nПроверки длины/слов/JSON — измерения. Качество оцени пользователь; AI-судья не запускался.",
    [button("Взять промпт A", "reuse", exp.id, "a"), button("Взять промпт B", "reuse", exp.id, "b"),
      ...(exp.status !== "completed" ? [button("Повторить незавершённые…", "experiment_retry", exp.id)] : []), BACK]);
  }

  async toolPreview(ctx, spec) {
    await this.screen(ctx, `🛠 Спецификация инструмента\nФормат: ${spec.kind}\nТребования: ${spec.request}\n` +
      "Ввод/вывод и примеры будут включены в инструкцию. Один автономный файл; без сети и сторонних зависимостей. " +
      "HTML открывается локально; Node.js пишет в stdout. Исходные файлы не изменяются. " +
      "Код не запускается ботом. Формат проверяется статически; корректность произвольного кода требует проверки пользователем.",
    [button("Сгенерировать", "tool_generate", spec.projectId), button("Изменить", "tool_kind", null, spec.kind), CANCEL]);
  }

  async showLesson(ctx, trackId) {
    const { track, lesson, plan } = this.service.lesson(ctx, trackId);
    this.session(ctx, { mode: "lesson", trackId });
    await this.screen(ctx, `📚 ${track.language} · ${track.level}\nЦель: ${track.goal}\nПлан: ${plan.join(" → ")}\n` +
      `Пройдено: ${track.solved.length}/3 занятий этого трека. Попыток: ${track.attempts.length}.\n\n${lesson.title}\n${lesson.explanation}\n\nЗадание: ${lesson.task}\n` +
      "Пришли вывод выражения текстом; код принимается для AI-разбора без исполнения.",
    [button("Подсказка", "hint", trackId), button("Повторить", "track", trackId), button("Показать решение", "solution", trackId),
      ...(track.solved.includes(track.current) && track.current < 2 ? [button("Следующий урок", "next", trackId)] : []), BACK]);
  }

  async projects(ctx, page = 0) {
    const data = this.service.data(ctx);
    this.session(ctx, { mode: "projects" });
    const buttons = [...data.projects.map((item) => button(`💡 ${item.title.slice(0, 35)}`, "project", item.id)),
      ...data.tracks.map((item) => button(`📚 ${item.language} ${item.solved.length}/3`, "track", item.id)),
      ...data.experiments.map((item) => button(`🧪 ${item.spec.task.slice(0, 24)} · ${item.status}`, "experiment", item.id)),
      ...data.artifacts.map((item) => button(`📄 ${item.kind} ${item.id.slice(0, 6)}`, "download", item.id))];
    // Telegram supports at most 100 buttons; paginate a bounded server-owned list.
    const visible = buttons.slice(page * 20, page * 20 + 20);
    await this.screen(ctx, "📁 Мои проекты, треки, эксперименты и инструменты\nСохранённые объекты принадлежат только тебе.",
      [...visible, ...(buttons.length > 20 ? [button("Следующая страница", "page", null, (page + 1) * 20 < buttons.length ? page + 1 : 0)] : []), BACK]);
  }

  async dispatch(ctx, action, eventId) {
    const current = this.sessions.get(scopeKey(ctx));
    const entityId = action.entityId;
    switch (action.action) {
      case "home": this.service.cancel(ctx); return this.home(ctx);
      case "cancel": this.service.cancel(ctx); return this.home(ctx);
      case "exit": this.leave(ctx); return this.bot.sendMessage(ctx.chatId, "Обычный чат включён.");
      case "ideas":
        this.session(ctx, { mode: "ideas_input" });
        return this.screen(ctx, "💡 Опиши, кому нужна программа, что она должна решать, твои навыки и доступное время. Например: три идеи для магазина, знаю JavaScript, есть выходные.", [BACK]);
      case "idea": {
        if (current?.mode !== "ideas_result" || !current.ideas[action.value]) throw new Error("LAB_NOT_FOUND");
        const idea = current.ideas[action.value]; this.session(ctx, { mode: "idea_selected", idea });
        return this.selectedIdea(ctx, idea);
      }
      case "project": {
        const project = this.service.get(ctx, "projects", entityId);
        this.session(ctx, { mode: "idea_selected", idea: project.idea, plan: project.plan, projectId: entityId });
        return this.selectedIdea(ctx, project.idea, project.plan, entityId);
      }
      case "plan": case "critique": case "refine": case "save": case "idea_tool": {
        const source = entityId ? this.service.get(ctx, "projects", entityId) : current;
        if (!source?.idea) throw new Error("LAB_NOT_FOUND");
        if (action.action === "refine") {
          this.session(ctx, { mode: "idea_refine", idea: source.idea });
          return this.screen(ctx, "Что уточнить или изменить в плане выбранной идеи?", [BACK]);
        }
        if (action.action === "save") {
          const project = this.service.saveProject(ctx, source.idea, source.plan);
          this.session(ctx, { mode: "idea_selected", ...project, projectId: project.id });
          return this.selectedIdea(ctx, project.idea, project.plan, project.id);
        }
        if (action.action === "idea_tool") {
          const spec = { kind: "html", request: JSON.stringify(source.plan || source.idea), projectId: entityId };
          this.session(ctx, { mode: "tool_preview", spec }); return this.toolPreview(ctx, spec);
        }
        await this.progress(ctx);
        const plan = await this.service.plan(ctx, eventId, source.idea, action.action === "critique" ? "Выяви слабые стороны и проверки гипотез, включи их в tasks и acceptance" : "План первой версии");
        if (entityId) this.service.store.change(ctx, (scope) => { scope.projects.find((item) => item.id === entityId).plan = plan; });
        this.session(ctx, { mode: "idea_selected", idea: source.idea, plan, projectId: entityId });
        return this.selectedIdea(ctx, source.idea, plan, entityId);
      }
      case "experiments":
        this.session(ctx, { mode: "experiment_input" });
        return this.screen(ctx, "🧪 Какую задачу сравниваем? Например: описание товара. Затем я попрошу общий пример и два варианта инструкции. До подтверждения AI-запросов не будет.", [BACK]);
      case "experiment_retry": {
        const exp = this.service.get(ctx, "experiments", entityId);
        this.session(ctx, { mode: "experiment_preview", spec: exp.spec, experimentId: exp.id });
        return this.experimentPreview(ctx, exp.spec, exp.id);
      }
      case "experiment_run": {
        if (current?.mode !== "experiment_preview" || current.experimentId !== (entityId || undefined)) throw new Error("LAB_NOT_FOUND");
        await this.progress(ctx);
        const exp = await this.service.experiment(ctx, eventId, current.spec, entityId);
        this.session(ctx, { mode: "experiment_result" }); return this.showExperiment(ctx, exp);
      }
      case "experiment": return this.showExperiment(ctx, this.service.get(ctx, "experiments", entityId));
      case "reuse": {
        const exp = this.service.get(ctx, "experiments", entityId);
        this.session(ctx, { mode: "experiment_input" });
        return this.screen(ctx, "Выбранный промпт:\n" + exp.spec[action.value] + "\nНовый эксперимент: пришли изменённый JSON настройки.", [BACK]);
      }
      case "learn":
        return this.screen(ctx, "📚 Выбери язык и уровень. Три занятия: переменные/условия/выражения либо коллекции/циклы/функции. Прогресс сохраняется после создания трека.",
          [button("JavaScript · с нуля", "learn_goal", null, "javascript:beginner"), button("JavaScript · базовый", "learn_goal", null, "javascript:basic"),
            button("Python · с нуля", "learn_goal", null, "python:beginner"), button("Python · базовый", "learn_goal", null, "python:basic"), BACK]);
      case "learn_goal": {
        const [language, level] = action.value.split(":"); this.session(ctx, { mode: "learning_goal", language, level });
        return this.screen(ctx, "Опиши учебную цель. Этот короткий трек покрывает основы выбранного уровня, затем можно разбирать свои решения с AI.", [BACK]);
      }
      case "track_create": {
        if (current?.mode !== "learning_confirm") throw new Error("LAB_NOT_FOUND");
        const track = this.service.startTrack(ctx, current.language, current.level, current.goal); return this.showLesson(ctx, track.id);
      }
      case "track": return this.showLesson(ctx, entityId);
      case "next": this.service.trackAction(ctx, entityId, "next"); return this.showLesson(ctx, entityId);
      case "hint": case "solution": {
        this.service.trackAction(ctx, entityId, action.action);
        const { lesson } = this.service.lesson(ctx, entityId);
        return this.screen(ctx, action.action === "hint" ? lesson.hint : `Решение: ${lesson.answer}\n${lesson.hint}`,
          [button("Вернуться к заданию", "track", entityId), BACK]);
      }
      case "tools": return this.screen(ctx, "🛠 Выбери формат одного небольшого инструмента. Код выдаётся файлом, бот его не запускает.",
        [button("HTML без сервера", "tool_kind", null, "html"), button("Node.js без пакетов", "tool_kind", null, "node"), BACK]);
      case "tool_kind": this.session(ctx, { mode: "tool_input", kind: action.value }); return this.screen(ctx, "Опиши назначение, входные данные и ожидаемый результат. Например: калькулятор цены по себестоимости и наценке; ввод 100 и 20%, результат 120.", [BACK]);
      case "tool_generate": {
        if (current?.mode !== "tool_preview") throw new Error("LAB_NOT_FOUND");
        await this.progress(ctx);
        const artifact = await this.service.artifact(ctx, eventId, current.spec);
        await this.download(ctx, artifact);
        return this.screen(ctx, `Файл сформирован: ${artifact.filename}\n${artifact.instructions}\nПримеры: ${JSON.stringify(artifact.examples)}\n` +
          "Проверено: формат и ограничения. Код ботом не выполнялся; примеры модели требуют проверки.\n" + artifact.validation,
        [button("Скачать повторно", "download", artifact.id), BACK]);
      }
      case "download": return this.download(ctx, this.service.get(ctx, "artifacts", entityId));
      case "export": return this.bot.sendDocument(ctx.chatId, Buffer.from(this.service.export(ctx, entityId)), {}, { filename: `lab-project-${entityId}.json`, contentType: "application/json" });
      case "export_all": return this.bot.sendDocument(ctx.chatId, Buffer.from(this.service.exportAll(ctx)), {}, { filename: "ai-lab-export.json", contentType: "application/json" });
      case "delete": {
        const project = this.service.get(ctx, "projects", entityId);
        return this.screen(ctx, `Удалить проект «${project.title}» и принадлежащие ему файлы?`, [button("Удалить проект", "delete_confirm", entityId), BACK]);
      }
      case "delete_confirm": this.service.deleteProject(ctx, entityId); return this.projects(ctx);
      case "clear": return this.screen(ctx, "Будут удалены все твои проекты, артефакты, учебные треки и результаты экспериментов. Дневной счётчик и служебная дедупликация сохраняются. Удаление из резервных копий также применяется.", [button("Удалить данные лаборатории", "clear_confirm"), BACK]);
      case "clear_confirm": {
        if (this.pending.has(scopeKey(ctx))) throw new Error("LAB_BUSY");
        this.service.clear(ctx);
        return this.home(ctx);
      }
      case "projects": return this.projects(ctx);
      case "page": return this.projects(ctx, action.value);
      default: throw new Error("LAB_NOT_FOUND");
    }
  }

  async download(ctx, artifact) {
    return this.bot.sendDocument(ctx.chatId, Buffer.from(artifact.code), {}, { filename: artifact.filename,
      contentType: artifact.kind === "html" ? "text/html" : "application/javascript" });
  }

  async callback(query) {
    const ctx = { chatId: query.message?.chat?.id, userId: query.from?.id };
    if (query.message?.chat?.type !== "private" || String(ctx.chatId) !== String(ctx.userId)) return;
    return this.guard(ctx, async () => {
      let action;
      this.service.store.change(ctx, (scope) => {
        action = scope.callbacks.find((cb) => cb.id === query.data.slice(4) && cb.view === scope.view &&
          cb.messageId === query.message.message_id && cb.expires > Date.now() && !cb.used);
        if (!action) throw new Error("LAB_DUPLICATE");
        action.used = true;
      });
      if (!["home", "cancel", "exit"].includes(action.action) && this.pending.has(scopeKey(ctx))) throw new Error("LAB_BUSY");
      const key = scopeKey(ctx);
      if (["home", "cancel", "exit"].includes(action.action)) return this.dispatch(ctx, action, `cb:${action.id}`);
      this.pending.add(key);
      try { return await this.dispatch(ctx, action, `cb:${action.id}`); }
      finally { this.pending.delete(key); }
    });
  }

  async close(graceMs = 1000) {
    for (const control of this.service.active.values()) control.cancelled = true;
    const deadline = Date.now() + graceMs;
    while (this.service.active.size && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
    // Keep the writer claim until process exit if a request is still in flight. Restart
    // recovers it as unknown. Ordinary chat memory must still get its shutdown flush.
    if (!this.service.active.size) this.service.close();
  }
}

function registerLab(bot) {
  const lab = new LabTelegram(bot);
  bot.onText(/^\/lab(?:@\w+)?(?:\s|$)/, safeHandler("Lab command", async (msg) => {
    if (msg.from?.is_bot || !isAddressedToThisBot(msg.text) || !claimIncomingMessage(msg) || !await admitMessage(bot, msg)) return;
    await lab.open(msg);
  }));
  bot.on("callback_query", safeHandler("Lab callback", async (query) => {
    if (!query.data?.startsWith("lab:")) return;
    if (!await admitCallback(bot, query)) return;
    await bot.answerCallbackQuery(query.id).catch(() => {});
    await lab.callback(query);
  }));
  return lab;
}

module.exports = { registerLab, LabTelegram };
