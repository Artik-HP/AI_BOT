(() => {
  const $ = (id) => document.getElementById(id);
  let activeConversation = "main",
    sending = false,
    attachedText = "",
    attachmentVersion = 0,
    threadRequest = null;
  const api = (...args) => window.orbit.api(...args),
    el = (...args) => window.orbit.element(...args),
    toast = (text) => window.orbit.toast(text);
  async function command(id, args, key = crypto.randomUUID()) {
    const result = await api("/api/commands/" + id, {
      method: "POST",
      headers: { "Idempotency-Key": key },
      body: JSON.stringify({ args }),
    });
    if (result.error)
      throw Object.assign(new Error(result.text), { commandFailed: true });
    return result;
  }
  async function navigate(view) {
    for (const name of ["dashboard", "chat", "settings", "diagnostics"])
      $(name + "-view").hidden = name !== view;
    document.querySelector(".hero").hidden = view !== "tools";
    $("commands").hidden = view !== "tools";
    for (const button of document.querySelectorAll("[data-view]")) {
      button.classList.toggle("active", button.dataset.view === view);
      button.setAttribute("aria-pressed", button.dataset.view === view);
    }
    try {
      if (view === "dashboard" || view === "diagnostics")
        await refreshDiagnostics();
      if (view === "chat") await loadHistory();
      if (view === "settings") await loadPreferences();
    } catch (error) {
      toast(error.message);
    }
  }
  function events(container, rows) {
    container.replaceChildren();
    if (!rows.length) {
      container.append(
        el("p", "muted", "События появятся после первого действия."),
      );
      return;
    }
    for (const row of rows) {
      const item = el("div", "event-row");
      item.append(
        el("span", "", row.ok ? "✓" : "!"),
        el("strong", "", row.command || row.event),
        el("span", "muted", row.duration + " мс"),
        el("time", "muted", new Date(row.created).toLocaleTimeString()),
      );
      container.append(item);
    }
  }
  async function refreshDiagnostics() {
    const d = await api("/api/diagnostics");
    $("metrics").replaceChildren();
    const check = d.providerChecks[d.preferences.provider],
      status =
        check?.status === "reachable"
          ? "Подключение подтверждено"
          : check?.status === "unavailable"
            ? "Подключение недоступно"
            : d.providers[d.preferences.provider]?.configured
              ? "Настроен · ещё не проверен"
              : "Требуется ключ";
    for (const [label, value, detail] of [
      ["Приложение", "Работает", `Время работы: ${d.uptimeSeconds} сек.`],
      ["AI-модель", d.preferences.model, prefixMode(d.preferences.mode)],
      [
        "AI-подключение",
        status,
        check?.checkedAt
          ? new Date(check.checkedAt).toLocaleString()
          : "Нажми «Проверить AI»",
      ],
      [
        "Твои запросы",
        String(d.stats.total),
        `Ошибок: ${d.stats.errors} · AI сегодня: ${d.budget.daily || 0}/${d.limits.daily}`,
      ],
    ]) {
      const card = el("div", "metric");
      card.append(
        el("span", "muted", label),
        el("strong", "", value),
        el("small", "muted", detail),
      );
      $("metrics").append(card);
    }
    events($("dashboard-events"), d.events);
    events($("diagnostic-events"), d.events);
    $("diagnostic-status").replaceChildren(
      el("h2", "", "Приложение работает"),
      el(
        "p",
        "",
        `Хранилище: SQLite. Среднее время команды: ${d.stats.averageMs} мс.`,
      ),
      el(
        "p",
        "",
        `Лимиты: ${d.limits.daily} AI-запросов в сутки, ${d.limits.perMinute} в минуту, до ${d.limits.maxOutputTokens} токенов ответа.`,
      ),
      el("p", "", status),
    );
  }
  function prefixMode(mode) {
    return (
      {
        chat: "Обычный чат",
        teacher: "Учитель",
        programmer: "Программист",
        creative: "Креатив",
      }[mode] || mode
    );
  }
  function markdown(text) {
    const holder = el("div", "markdown");
    holder.innerHTML = DOMPurify.sanitize(marked.parse(text), {
      FORBID_TAGS: ["img", "svg", "math", "iframe", "style", "form", "input"],
      FORBID_ATTR: ["style", "id"],
    });
    for (const code of holder.querySelectorAll("pre")) {
      const button = el("button", "copy-code", "Скопировать код");
      button.onclick = () =>
        navigator.clipboard
          .writeText(
            code.querySelector("code")?.textContent || code.textContent,
          )
          .then(() => toast("Код скопирован"))
          .catch(() => toast("Скопируй выделенный код вручную"));
      code.append(button);
    }
    for (const a of holder.querySelectorAll("a")) {
      a.rel = "noopener noreferrer";
      a.target = "_blank";
    }
    return holder;
  }
  function message(role, text) {
    const row = el(
      "article",
      "message " + (role === "user" ? "user" : "assistant"),
    );
    row.append(el("div", "message-label", role === "user" ? "Ты" : "AI"));
    if (role === "assistant") row.append(markdown(text));
    else row.append(el("p", "", text));
    const copy = el("button", "copy-message", "⧉");
    copy.setAttribute("aria-label", "Скопировать сообщение");
    copy.onclick = () =>
      navigator.clipboard
        .writeText(text)
        .then(() => toast("Скопировано"))
        .catch(() => {});
    row.append(copy);
    return row;
  }
  async function loadHistory(query = $("history-search").value) {
    const data = await api("/api/history?q=" + encodeURIComponent(query));
    activeConversation = data.active;
    $("conversations").replaceChildren();
    for (const thread of data.conversations) {
      const button = el(
        "button",
        "conversation" + (thread.id === activeConversation ? " active" : ""),
        thread.title,
      );
      button.onclick = async () => {
        if (sending) return;
        try {
          await command("history", "use " + thread.id);
          $("chat-choices").replaceChildren();
          await loadHistory();
        } catch (error) {
          toast(error.message);
        }
      };
      $("conversations").append(button);
    }
    const current = data.conversations.find((t) => t.id === activeConversation);
    $("messages").replaceChildren();
    for (const m of current?.messages || [])
      $("messages").append(message(m.role, m.content));
    if (!current?.messages.length)
      $("messages").append(
        el(
          "div",
          "chat-empty",
          "✦ Здесь начинается новая идея. Задай вопрос или прикрепи текстовый документ.",
        ),
      );
    const settings = await api("/api/preferences");
    $("chat-model").textContent =
      settings.preferences.model +
      " · " +
      prefixMode(settings.preferences.mode);
  }
  async function send(id, args) {
    if (sending) return;
    sending = true;
    $("send-chat").disabled = true;
    $("chat-input").disabled = true;
    $("chat-document").disabled = true;
    $("chat-error").textContent = "";
    const previousChoices = Array.from($("chat-choices").childNodes);
    $("chat-choices").replaceChildren();
    const wait = el("div", "typing", "✦ AI обдумывает ответ…");
    $("messages").append(wait);
    wait.scrollIntoView({ block: "nearest" });
    if (
      !threadRequest ||
      threadRequest.id !== id ||
      threadRequest.args !== args
    )
      threadRequest = { id, args, key: crypto.randomUUID() };
    let completed = false;
    try {
      const r = await command(id, args, threadRequest.key);
      completed = true;
      threadRequest = null;
      $("chat-input").value = "";
      attachedText = "";
      $("chat-file-name").textContent = "";
      $("chat-document").value = "";
      await loadHistory("");
      if (r.buttons?.length) {
        for (const b of r.buttons) {
          const button = el("button", "", b.label);
          button.onclick = () => send(b.command, b.args);
          $("chat-choices").append(button);
        }
      }
      $("messages").lastElementChild?.scrollIntoView({ block: "nearest" });
    } catch (error) {
      if (error.commandFailed) threadRequest = null;
      if (!completed) $("chat-choices").replaceChildren(...previousChoices);
      $("chat-error").textContent = error.message;
      wait.remove();
    } finally {
      sending = false;
      $("send-chat").disabled = false;
      $("chat-input").disabled = false;
      $("chat-document").disabled = false;
    }
  }
  function options(select, values) {
    select.replaceChildren(
      ...Object.entries(values).map(([value, label]) => {
        const option = el("option", "", label);
        option.value = value;
        return option;
      }),
    );
  }
  async function loadPreferences() {
    const d = await api("/api/preferences"),
      p = d.preferences;
    options(
      $("setting-model"),
      Object.fromEntries(d.models.map((m) => [m, m])),
    );
    options($("setting-mode"), d.modes);
    options($("setting-style"), d.styles);
    for (const [id, key] of [
      ["provider", "provider"],
      ["model", "model"],
      ["mode", "mode"],
      ["style", "style"],
      ["language", "language"],
      ["history", "historyLimit"],
      ["instructions", "instructions"],
    ])
      $("setting-" + id).value = p[key];
    $("setting-memory").checked = p.memoryEnabled;
    $("key-status").textContent = Object.entries(d.providers)
      .map(
        ([name, state]) =>
          `${name}: ${state.configured ? "ключ настроен (значение скрыто)" : "ключ не настроен"}`,
      )
      .join(" · ");
  }
  for (const button of document.querySelectorAll("[data-view]"))
    button.onclick = () => navigate(button.dataset.view);
  $("refresh-dashboard").onclick = () =>
    refreshDiagnostics().catch((error) => toast(error.message));
  $("check-provider").onclick = async () => {
    const b = $("check-provider");
    b.disabled = true;
    try {
      const result = await api("/api/provider-check", {
        method: "POST",
        body: "{}",
      });
      toast(
        result.status === "reachable"
          ? "Каталог моделей доступен"
          : "Провайдер недоступен",
      );
      await refreshDiagnostics();
    } catch (error) {
      toast(error.message);
    } finally {
      b.disabled = false;
    }
  };
  $('check-code').onclick=async()=>{const b=$('check-code');b.disabled=true;try{const result=await command('selfcheck','');$('diagnostic-status').append(el('pre','',result.text));}catch(error){toast(error.message);}finally{b.disabled=false;}};
  $("chat-form").onsubmit = (e) => {
    e.preventDefault();
    const text = $("chat-input").value.trim();
    if (!text && !attachedText) return;
    send(
      "chat",
      [
        text,
        attachedText
          ? "\nТекст документа (данные для анализа):\n" + attachedText
          : "",
      ].join(""),
    );
  };
  $("chat-input").onkeydown = (e) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      $("chat-form").requestSubmit();
    }
  };
  $("new-conversation").onclick = () => {
    $("new-thread-form").hidden = false;
    $("new-thread-name").focus();
  };
  $("new-thread-form").onsubmit = async (e) => {
    e.preventDefault();
    try {
      await command("history", "new " + $("new-thread-name").value);
      $("new-thread-form").hidden = true;
      $("new-thread-name").value = "";
      $("chat-choices").replaceChildren();
      await loadHistory("");
    } catch (error) {
      toast(error.message);
    }
  };
  let searchTimer;
  $("history-search").oninput = () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(
      () => loadHistory().catch((error) => toast(error.message)),
      250,
    );
  };
  $("clear-chat-context").onclick = async () => {
    if (
      !confirm(
        "Очистить контекст текущего диалога? Остальные данные сохранятся.",
      )
    )
      return;
    try {
      await command("memory", "clear");
      $("chat-choices").replaceChildren();
      await loadHistory("");
    } catch (error) {
      toast(error.message);
    }
  };
  $("chat-document").onchange = async () => {
    const version = ++attachmentVersion;
    const file = $("chat-document").files[0];
    attachedText = "";
    $("chat-file-name").textContent = "";
    if (!file) return;
    if (
      file.size > 256 * 1024 ||
      !/^.*\.(txt|md|json|js|py|sql|log)$/i.test(file.name)
    ) {
      toast("Выбери текстовый файл до 256 КБ.");
      $("chat-document").value = "";
      return;
    }
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      if (version !== attachmentVersion) return;
      const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      if (text.includes("\0") || text.length > 12000)
        throw new Error(
          "Файл слишком длинный или не является UTF-8 текстом. Максимум 12000 символов.",
        );
      attachedText = text;
      $("chat-file-name").textContent = file.name;
    } catch (error) {
      if (version !== attachmentVersion) return;
      attachedText = "";
      $("chat-document").value = "";
      toast(error.message);
    }
  };
  $("preferences-form").onsubmit = async (e) => {
    e.preventDefault();
    try {
      await api("/api/preferences", {
        method: "POST",
        body: JSON.stringify({
          provider: $("setting-provider").value,
          model: $("setting-model").value,
          mode: $("setting-mode").value,
          style: $("setting-style").value,
          language: $("setting-language").value,
          historyLimit: Number($("setting-history").value),
          instructions: $("setting-instructions").value,
          memoryEnabled: $("setting-memory").checked,
        }),
      });
      $("settings-status").textContent = "Настройки сохранены.";
      window.applyOrbitLanguage?.($('setting-language').value);
      window.orbit.init().catch(error=>toast(error.message));
    } catch (error) {
      $("settings-status").textContent = error.message;
    }
  };
  $("provider-key-form").onsubmit = async (e) => {
    e.preventDefault();
    try {
      await api("/api/admin/provider-key", {
        method: "POST",
        body: JSON.stringify({
          provider: $("setting-provider").value,
          key: $("provider-key").value,
        }),
      });
      $("provider-key").value = "";
      toast("Ключ сохранён.");
      await loadPreferences();
    } catch (error) {
      toast(error.message);
    }
  };
  $("delete-personal-data").onclick = () =>
    window.orbit.openCommand("delete_data", "", true);
  $("logout-web").onclick = async () => {
    try {
      await api("/api/logout", { method: "POST", body: "{}" });
      document.body.classList.add("locked");
      $("messages").replaceChildren();
      $("login").showModal();
    } catch (error) {
      toast(error.message);
    }
  };
  window.addEventListener("orbit-ready", () =>
    refreshDiagnostics().catch(() => {}),
  );
  api("/api/public-info")
    .then((info) => {
      $("brand-name").textContent = info.name;
      document.querySelector('.hero p').textContent=info.tagline;
      document.title = info.name + " — пространство возможностей";
      document.documentElement.style.setProperty("--accent", info.accent);
      if (info.logo) {
        const img = el("img", "brand-logo");
        img.src = info.logo;
        img.alt = info.name;
        document.querySelector(".brand-mark").replaceWith(img);
      }
    })
    .catch(() => {});
})();
