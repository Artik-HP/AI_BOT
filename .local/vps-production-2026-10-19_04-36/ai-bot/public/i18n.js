(() => {
  let dictionaries = {},
    language = localStorage.getItem("orbit-language") || "ru";
  const originalText = new WeakMap(),
    originalAttributes = new WeakMap();
  const canonical = (text) => text.trim().replace(/\s+/g, " ");
  function translated(text) {
    const values = dictionaries[language] || {},
      key = canonical(text);
    if (values[key]) return values[key];
    if (key.startsWith("Открыть "))
      return (
        (language === "en"
          ? "Open "
          : language === "uk"
            ? "Відкрити "
            : "Открыть ") + key.slice(8)
      );
    if (key.startsWith("Избранное: "))
      return (values["Избранное"] || "Избранное") + ": " + key.slice(11);
    return text;
  }
  function apply() {
    const walker = document.createTreeWalker(
      document.body,
      NodeFilter.SHOW_TEXT,
    );
    let node;
    while ((node = walker.nextNode())) {
      if (
        node.parentElement?.closest(
          "script,style,textarea,.markdown,.message p,#result-text,#notification-list,#dashboard-events,#diagnostic-events,#conversations,#chat-error",
        )
      )
        continue;
      if (!originalText.has(node)) originalText.set(node, node.nodeValue);
      const source = originalText.get(node);
      if (!source.trim()) continue;
      node.nodeValue = translated(source);
    }
    for (const element of document.querySelectorAll(
      "[placeholder],[aria-label]",
    )) {
      if (!originalAttributes.has(element))
        originalAttributes.set(
          element,
          Object.fromEntries(
            ["placeholder", "aria-label"]
              .filter((a) => element.hasAttribute(a))
              .map((a) => [a, element.getAttribute(a)]),
          ),
        );
      for (const [attribute, source] of Object.entries(
        originalAttributes.get(element),
      ))
        element.setAttribute(attribute, translated(source));
    }
    document.documentElement.lang = language;
  }
  window.applyOrbitLanguage = (next) => {
    language = ["ru", "en", "uk"].includes(next) ? next : "ru";
    localStorage.setItem("orbit-language", language);
    apply();
  };
  fetch("/locales.json")
    .then((response) => response.json())
    .then((data) => {
      dictionaries = data;
      apply();
      new MutationObserver(apply).observe(document.body, {
        childList: true,
        subtree: true,
      });
    })
    .catch(() => {});
  window.addEventListener("orbit-ready", () =>
    window.orbit
      .api("/api/preferences")
      .then((data) => window.applyOrbitLanguage(data.preferences.language))
      .catch(() => {}),
  );
})();
