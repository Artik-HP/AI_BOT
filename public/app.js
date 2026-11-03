// The spark roller of the landing page. The page works without it (the sections are plain HTML); this script only
// asks the server for a spark (GET /api/spark) and shows it. Everything is written as plain text, never as markup.
(() => {
  const spark = document.getElementById("spark");
  const slots = document.getElementById("slots");
  const technique = document.getElementById("technique");
  const rollButton = document.getElementById("roll");
  const copyButton = document.getElementById("copy");
  const note = document.getElementById("spark-note");
  const shapeButtons = Array.from(document.querySelectorAll("[data-shape]"));

  if (!spark || !slots || !rollButton) {
    return;
  }

  const ROLL_MIN_MS = 450;
  let current = null;
  // "" lets the server choose the shape; "minimal" and "maximal" are two and four ingredients.
  let shape = "";

  const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  function slot(label, value) {
    const row = document.createElement("div");
    const term = document.createElement("dt");
    const detail = document.createElement("dd");

    row.className = "slot";
    term.textContent = label;
    detail.textContent = value;
    row.append(term, detail);
    return row;
  }

  function show(payload) {
    current = payload;
    slots.replaceChildren(...payload.ingredients.map(({ label, value }) => slot(label, value)));
    technique.textContent = `Приём «${payload.technique.name}»: ${payload.technique.how}`;
    note.textContent = "";
  }

  async function load() {
    const url = shape ? `/api/spark?shape=${encodeURIComponent(shape)}` : "/api/spark";
    const response = await fetch(url, { headers: { accept: "application/json" } });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    return response.json();
  }

  // While a spark is on its way, nothing can start a second one.
  function busy(state) {
    rollButton.disabled = state;

    for (const button of shapeButtons) {
      button.disabled = state;
    }
  }

  async function roll() {
    busy(true);
    spark.classList.add("rolling");

    try {
      const [payload] = await Promise.all([load(), pause(ROLL_MIN_MS)]);

      show(payload);
    } catch {
      note.textContent = "Не получилось бросить кости. Попробуй ещё раз.";
    } finally {
      spark.classList.remove("rolling");
      busy(false);
    }
  }

  async function copy() {
    if (!current) {
      return;
    }

    // The server sends the card as the bot writes it; the fallback builds the same lines.
    const text = current.text || [
      ...current.ingredients.map(({ label, value }) => `${label}: ${value}`),
      `Приём «${current.technique.name}»: ${current.technique.how}`
    ].join("\n");

    try {
      await navigator.clipboard.writeText(text);
      note.textContent = "Скопировано.";
    } catch {
      note.textContent = "Не получилось скопировать. Выдели текст и скопируй вручную.";
    }
  }

  // Choosing a shape rolls at once: the choice is visible only through a new spark.
  function choose(button) {
    shape = button.dataset.shape;

    for (const other of shapeButtons) {
      other.setAttribute("aria-pressed", String(other === button));
    }

    roll();
  }

  for (const button of shapeButtons) {
    button.addEventListener("click", () => choose(button));
  }

  rollButton.addEventListener("click", roll);
  copyButton.addEventListener("click", copy);
  roll();
})();
