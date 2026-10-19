(() => {
  const $ = (id) => document.getElementById(id);
  let csrf = "",
    commands = [],
    categories = {},
    profile = { favorites: [], recent: [] },
    category = "all",
    selected = null,
    busy = false,
    notificationSignature = "",
    pendingRequest = null;
  const names = {
    all: "Все команды",
    favorites: "Избранное",
    recent: "Недавние",
  };
  const toast = (text) => {
    $("toast").textContent = text;
    $("toast").hidden = false;
    setTimeout(() => ($("toast").hidden = true), 3000);
  };
  function element(tag, className, text) {
    const el = document.createElement(tag);
    if (className) el.className = className;
    if (text !== undefined) el.textContent = text;
    return el;
  }
  async function api(url, options = {}) {
    const response = await fetch(url, {
      ...options,
      headers: {
        "Content-Type": "application/json",
        "X-CSRF-Token": csrf,
        ...options.headers,
      },
      signal: AbortSignal.timeout(90000),
    });
    const data = await response.json();
    if (!response.ok) {
      if (response.status === 401) {
        document.body.classList.add("locked");
        if (!$("login").open) $("login").showModal();
      }
      throw new Error(data.error || "Запрос не выполнен.");
    }
    return data;
  }
  function title(id) {
    return names[id] || categories[id]?.replace(/^\S+\s/, "") || id;
  }
  function navigate(id) {
    category = id;
    $("search").value = "";
    render();
    $("commands").scrollIntoView({ behavior: "smooth", block: "start" });
  }
  function render() {
    $("current-category").textContent = title(category);
    $("section-title").replaceChildren(
      document.createTextNode(title(category) + " "),
      $("command-count"),
    );
    const list = commands.filter((c) => !c.hidden),
      query = $("search").value.trim().toLowerCase();
    let visible = list.filter(
      (c) =>
        category === "all" ||
        (category === "favorites"
          ? profile.favorites.includes(c.id)
          : category === "recent"
            ? profile.recent.includes(c.id)
            : c.category === category),
    );
    if (category === "recent")
      visible.sort(
        (a, b) => profile.recent.indexOf(a.id) - profile.recent.indexOf(b.id),
      );
    if (category === "all") {
      const featured = [
        "explain",
        "quiz",
        "ideas",
        "password",
        "calculator",
        "learnjs",
        "notes",
        "weather",
        "qr",
        "story",
      ];
      const rank = (id) =>
        featured.includes(id) ? featured.indexOf(id) : featured.length;
      visible.sort((a, b) => rank(a.id) - rank(b.id));
    }
    if (query)
      visible = visible.filter((c) =>
        `${c.id} ${c.title} ${c.description}`.toLowerCase().includes(query),
      );
    $("command-count").textContent = visible.length;
    $("cards").replaceChildren();
    $("empty").hidden = !!visible.length;
    for (const c of visible) {
      const card = element(
        "article",
        "card" + (selected?.id === c.id ? " active" : ""),
      );
      card.dataset.command = c.id;
      const top = element("div", "card-top"),
        icon = element("span", "card-icon", c.icon),
        favorite = element(
          "button",
          "favorite",
          profile.favorites.includes(c.id) ? "★" : "☆",
        );
      favorite.type = "button";
      favorite.setAttribute("aria-label", "Избранное: " + c.title);
      favorite.setAttribute("aria-pressed", profile.favorites.includes(c.id));
      favorite.onclick = async () => {
        favorite.disabled = true;
        try {
          const r = await api("/api/commands/favorite", {
            method: "POST",
            headers: { "Idempotency-Key": crypto.randomUUID() },
            body: JSON.stringify({ args: c.id }),
          });
          if (r.error) throw new Error(r.text);
          profile = r.profile;
          render();
          toast(r.text);
        } catch (e) {
          toast(e.message);
          favorite.disabled = false;
        }
      };
      top.append(icon, favorite);
      card.append(
        top,
        element("h3", "", c.title),
        element("p", "", c.description),
      );
      const bottom = element("div", "card-bottom"),
        open = element("button", "card-open", "Открыть ↗");
      open.type = "button";
      open.setAttribute("aria-label", "Открыть " + c.title);
      open.onclick = () => openCommand(c.id);
      bottom.append(element("span", "card-code", "/" + c.id), open);
      card.append(bottom);
      $("cards").append(card);
    }
    for (const el of document.querySelectorAll("[data-category]")) {
      const active = el.dataset.category === category;
      el.classList.toggle("active", active);
      el.setAttribute("aria-pressed", active);
    }
  }
  function buildNavigation() {
    const ids = [
      "all",
      "favorites",
      "recent",
      ...Object.keys(categories).filter((id) =>
        commands.some((c) => c.category === id),
      ),
    ];
    $("navigation").replaceChildren();
    $("filters").replaceChildren();
    for (const id of ids) {
      if (id === "system")
        $("navigation").append(element("div", "nav-divider"));
      const raw =
        categories[id] ||
        {
          all: "◈ Все команды",
          favorites: "☆ Избранное",
          recent: "◷ Недавние",
        }[id];
      const button = element("button", "nav-button");
      button.dataset.category = id;
      button.title = title(id);
      button.setAttribute("aria-label", title(id));
      button.append(
        element("span", "nav-icon", raw.split(" ")[0]),
        element("span", "nav-label", title(id)),
      );
      button.onclick = () => navigate(id);
      $("navigation").append(button);
      if (!["favorites", "recent", "system"].includes(id)) {
        const filter = element("button", "filter", id === "all" ? "Все" : raw);
        filter.dataset.category = id;
        filter.onclick = () => navigate(id);
        $("filters").append(filter);
      }
    }
  }
  function openCommand(id, args = "", auto = false) {
    const c = commands.find((c) => c.id === id);
    if (!c) {
      toast("Команда недоступна.");
      return;
    }
    selected = c;
    $("runner-title").textContent = `${c.icon} ${c.title}`;
    $("runner-description").textContent = c.description;
    $("command-id").textContent = c.id;
    $("command-meta").textContent = c.external
      ? "Использует " + c.external
      : "Работает локально";
    $("arguments").value = args;
    $("arguments").placeholder = c.example || "Параметры не обязательны";
    $("result").hidden = true;
    $("insert-example").hidden = !c.example;
    if (!$("runner").open) $("runner").showModal();
    render();
    if (auto) run(id, args);
    else $("arguments").focus();
  }
  async function run(id = selected.id, args = $("arguments").value) {
    if (busy) return;
    busy = true;
    setBusy(true);
    $("result").hidden = false;
    $("result").classList.remove("error");
    $("result-text").textContent = "Готовлю результат…";
    $("result-buttons").replaceChildren();
    $("result-image").hidden = true;
    $("download-image").hidden = true;
    try {
      if (
        !pendingRequest ||
        pendingRequest.id !== id ||
        pendingRequest.args !== args
      )
        pendingRequest = { id, args, key: crypto.randomUUID() };
      const r = await api("/api/commands/" + id, {
        method: "POST",
        headers: { "Idempotency-Key": pendingRequest.key },
        body: JSON.stringify({ args }),
      });
      pendingRequest = null;
      profile = r.profile;
      $("result-text").textContent = r.text;
      $("result-status").textContent = r.error
        ? "Не удалось выполнить"
        : "Результат";
      $("result").classList.toggle("error", !!r.error);
      if (r.image && r.image.startsWith("data:image/png;base64,")) {
        $("result-image").src = r.image;
        $("result-image").hidden = false;
        $("download-image").href = r.image;
        $("download-image").hidden = false;
      }
      if (r.download) {
        const link = element("a", "secondary", "Скачать мои данные в JSON");
        link.href = "/api/export";
        link.download = "orbit-personal-data.json";
        $("result-buttons").append(link);
      }
      for (const link of r.links || []) {
        const a = element("a", "secondary", link.label);
        a.href = link.url;
        a.target = "_blank";
        a.rel = "noopener";
        $("result-buttons").append(a);
      }
      for (const b of r.buttons || []) {
        const button = element("button", "", b.label);
        button.type = "button";
        button.onclick = () => {
          if (b.command === "menu" && !b.args) {
            $("runner").close();
            navigate("all");
            return;
          }
          if (b.command === "select") {
            run(b.command, b.args);
            return;
          }
          openCommand(b.command, b.args, true);
        };
        $("result-buttons").append(button);
      }
      if (r.input) {
        selected = commands.find((c) => c.id === r.input.command) || selected;
        $("arguments").value = "";
        $("arguments").placeholder = r.input.placeholder;
        $("command-id").textContent = selected.id;
      }
      render();
    } catch (e) {
      $("result-status").textContent = "Ошибка";
      $("result-text").textContent =
        e.name === "TimeoutError"
          ? "Ответ задержался. Обнови список или проверь результат перед повторной операцией."
          : e.message;
      $("result").classList.add("error");
    } finally {
      busy = false;
      setBusy(false);
    }
  }
  function setBusy(value) {
    $("run-command").disabled = value;
    $("run-command").textContent = value ? "⏳ Выполняю…" : "Запустить ↗";
    $("result").setAttribute("aria-busy", value);
    $("arguments").disabled = value;
    for (const b of document.querySelectorAll("#result-buttons button"))
      b.disabled = value;
    $("close-runner").disabled = value;
    $("back-menu").disabled = value;
  }
  async function notifications() {
    try {
      const data = await api("/api/notifications"),
        signature = JSON.stringify(data.notifications);
      if (signature === notificationSignature) return;
      notificationSignature = signature;
      $("notifications").hidden = !data.notifications.length;
      $("notification-list").replaceChildren(
        ...data.notifications.map((n) => element("p", "", n.text)),
      );
    } catch {
      /* Login and connection errors are displayed by the API wrapper. */
    }
  }
  async function init(token = "") {
    const session = await api("/api/session", {
      headers: token ? { "X-Access-Token": token } : {},
    });
    csrf = session.csrf;
    const data = await api("/api/commands");
    commands = data.commands;
    categories = data.categories;
    profile = data.profile;
    buildNavigation();
    render();
    await notifications();
    document.body.classList.remove("locked");
    window.dispatchEvent(new Event("orbit-ready"));
  }
  $("search").oninput = render;
  $("command-form").onsubmit = (e) => {
    e.preventDefault();
    run();
  };
  $("close-runner").onclick = () => $("runner").close();
  $("back-menu").onclick = () => {
    $("runner").close();
    navigate("all");
  };
  $("runner").addEventListener("cancel", (e) => {
    if (busy) e.preventDefault();
  });
  $("insert-example").onclick = () => {
    if (selected) $("arguments").value = selected.example;
  };
  $("copy-result").onclick = async () => {
    try {
      await navigator.clipboard.writeText($("result-text").textContent);
      toast("Скопировано");
    } catch {
      toast("Выдели текст результата и скопируй вручную.");
    }
  };
  $("explore").onclick = () => openCommand("ideas");
  $("play").onclick = () => openCommand("quiz", "", true);
  const savedTheme = localStorage.getItem("orbit-theme");
  if (savedTheme) document.documentElement.dataset.theme = savedTheme;
  $("theme").onclick = () => {
    const theme =
      document.documentElement.dataset.theme === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("orbit-theme", theme);
    $("theme").textContent = theme === "dark" ? "☀" : "☾";
  };
  document.addEventListener("keydown", (e) => {
    if (
      e.key === "/" &&
      !["INPUT", "TEXTAREA"].includes(document.activeElement.tagName) &&
      !$("runner").open
    ) {
      e.preventDefault();
      $("search").focus();
    }
  });
  $("login-form").onsubmit = async (e) => {
    e.preventDefault();
    try {
      await init($("access-token").value);
      $("access-token").value = "";
      $("login").close();
    } catch (error) {
      $("login-error").textContent = error.message;
    }
  };
  $("login").addEventListener("cancel", (event) => event.preventDefault());
  window.orbit = { api, element, toast, openCommand, init };
  init().catch((e) => {
    $("login-error").textContent = e.message;
    if (!$("login").open) $("login").showModal();
  });
  setInterval(notifications, 15000);
})();
