const fs = require("fs");
const path = require("path");
const CONFIG = require("../config");
const logger = require("../utils/logger");
const { sanitizeInline } = require("../utils/text");

const {
  MAX_HISTORY_MESSAGES,
  MAX_STORED_MESSAGES,
  MAX_MEMORY_SUMMARY_CHARS,
  MAX_MESSAGE_CONTENT_CHARS,
  MAX_PERSONAL_NOTES,
  MEMORY_SAVE_DEBOUNCE_MS,
  MEMORY_BACKUP_INTERVAL_MS
} = CONFIG;
const MAX_STORED_CHAT_MESSAGES = Math.max(MAX_HISTORY_MESSAGES, MAX_STORED_MESSAGES);
const MEMORY_BACKUP_FILE = `${CONFIG.MEMORY_FILE}.bak`;
const SAVE_RETRY_DELAY_MS = 5000;
const NICKNAME_NOTE_PREFIX = "User name/nickname:";

const normalizedMemories = new WeakSet();
let saveTimer = null;
let writeInFlight = null;
let saveGeneration = 0;
let lastBackupAt = 0;
let lastSaveFailed = false;
let dirty = false;
const users = loadMemory();

process.once("beforeExit", flushMemory);

function ensureMemoryDirectory() {
  fs.mkdirSync(path.dirname(CONFIG.MEMORY_FILE), { recursive: true });
}

function readMemoryFile(filePath) {
  const raw = fs.readFileSync(filePath, "utf8");

  if (!raw.trim()) {
    return {};
  }

  return normalizeMemoryStore(JSON.parse(raw));
}

// An unreadable file is moved aside instead of being overwritten by the next save,
// so whatever is still recoverable in it is not lost.
function quarantineCorruptFile(filePath) {
  const target = `${filePath}.corrupt-${Date.now()}`;

  try {
    fs.renameSync(filePath, target);
    logger.error(`Memory file is unreadable and was moved to ${target}`);
  } catch (error) {
    logger.error("Could not move the unreadable memory file aside:", error);
  }
}

function tryLoadMemoryFile(filePath, label) {
  if (!fs.existsSync(filePath)) {
    return null;
  }

  try {
    return readMemoryFile(filePath);
  } catch (error) {
    logger.error(`Memory load error from ${label}:`, error);
    quarantineCorruptFile(filePath);
    return null;
  }
}

function loadMemory() {
  const primary = tryLoadMemoryFile(CONFIG.MEMORY_FILE, "primary file");

  if (primary) {
    return primary;
  }

  const backup = tryLoadMemoryFile(MEMORY_BACKUP_FILE, "backup file");

  if (backup) {
    logger.warn("Loaded memory from backup file.");
    return backup;
  }

  return {};
}

function isBackupDue(now) {
  return !MEMORY_BACKUP_INTERVAL_MS || now - lastBackupAt >= MEMORY_BACKUP_INTERVAL_MS;
}

function createTempFilePath() {
  return `${CONFIG.MEMORY_FILE}.${process.pid}.${Date.now()}.tmp`;
}

// Synchronous, used for shutdown and tests. Bumping the generation makes an in-flight async write
// discard itself instead of overwriting this newer snapshot.
function saveMemory() {
  const tempFile = createTempFilePath();

  clearTimeout(saveTimer);
  saveTimer = null;
  saveGeneration += 1;
  dirty = false;

  try {
    ensureMemoryDirectory();
    fs.writeFileSync(tempFile, JSON.stringify(users), "utf8");
    fs.renameSync(tempFile, CONFIG.MEMORY_FILE);

    if (isBackupDue(Date.now())) {
      fs.copyFileSync(CONFIG.MEMORY_FILE, MEMORY_BACKUP_FILE);
      lastBackupAt = Date.now();
    }

    lastSaveFailed = false;
  } catch (error) {
    dirty = true;
    lastSaveFailed = true;
    logger.error("Memory save error:", error);

    try {
      fs.rmSync(tempFile, { force: true });
    } catch (cleanupError) {
      logger.error("Memory temp cleanup error:", cleanupError);
    }
  }
}

async function writeMemoryFileAsync(json, generation) {
  const tempFile = createTempFilePath();

  await fs.promises.mkdir(path.dirname(CONFIG.MEMORY_FILE), { recursive: true });

  try {
    await fs.promises.writeFile(tempFile, json, "utf8");

    if (generation !== saveGeneration) {
      await fs.promises.rm(tempFile, { force: true });
      return;
    }

    await fs.promises.rename(tempFile, CONFIG.MEMORY_FILE);

    if (isBackupDue(Date.now())) {
      await fs.promises.copyFile(CONFIG.MEMORY_FILE, MEMORY_BACKUP_FILE);
      lastBackupAt = Date.now();
    }
  } catch (error) {
    await fs.promises.rm(tempFile, { force: true }).catch(() => {});
    throw error;
  }
}

function runScheduledSave() {
  saveTimer = null;

  if (!dirty || writeInFlight) {
    return;
  }

  dirty = false;
  const generation = saveGeneration;

  writeInFlight = writeMemoryFileAsync(JSON.stringify(users), generation)
    .then(() => {
      lastSaveFailed = false;
    })
    .catch((error) => {
      dirty = true;
      lastSaveFailed = true;
      logger.error("Memory save error:", error);
    })
    .finally(() => {
      writeInFlight = null;

      if (dirty) {
        scheduleSave();
      }
    });
}

// Marks the store as changed. Writes are batched: one write per debounce window, off the event loop.
function scheduleSave() {
  dirty = true;

  if (saveTimer || writeInFlight) {
    return;
  }

  const delay = lastSaveFailed ? SAVE_RETRY_DELAY_MS : MEMORY_SAVE_DEBOUNCE_MS;

  saveTimer = setTimeout(runScheduledSave, delay);
  saveTimer.unref?.();
}

function flushMemory() {
  if (dirty || writeInFlight) {
    saveMemory();
  }
}

function normalizeMemoryStore(store) {
  if (!store || typeof store !== "object" || Array.isArray(store)) {
    return {};
  }

  const normalized = {};

  for (const [chatId, value] of Object.entries(store)) {
    normalized[chatId] = normalizeUserMemory(value);
    normalizedMemories.add(normalized[chatId]);
  }

  return normalized;
}

function createEmptyMemory() {
  return {
    mood: "neutral",
    messages: [],
    nickname: null,
    trust: 0,
    style: "unknown",
    personalNotes: [],
    messageCount: 0,
    lastSeen: null,
    summary: ""
  };
}

function trimText(text, maxLength = MAX_MESSAGE_CONTENT_CHARS) {
  const cleanText = String(text || "").trim();
  const safeMaxLength = Math.max(32, Number(maxLength) || MAX_MESSAGE_CONTENT_CHARS);

  if (cleanText.length <= safeMaxLength) {
    return cleanText;
  }

  return `${cleanText.slice(0, safeMaxLength - 20).trim()}... [trimmed]`;
}

function normalizeMessageContent(content) {
  if (typeof content === "string") {
    return trimText(content);
  }

  if (Array.isArray(content)) {
    return trimText(content
      .map((part) => {
        if (typeof part === "string") {
          return part;
        }

        if (typeof part?.text === "string") {
          return part.text;
        }

        if (typeof part?.type === "string") {
          return `[${part.type}]`;
        }

        return "";
      })
      .filter(Boolean)
      .join("\n"));
  }

  return trimText(content == null ? "" : String(content));
}

function normalizeStoredMessage(message) {
  if (!message || typeof message !== "object") {
    return null;
  }

  const role = ["user", "assistant", "system"].includes(message.role)
    ? message.role
    : null;
  const content = normalizeMessageContent(message.content);

  if (!role || !content) {
    return null;
  }

  return { role, content };
}

function normalizeMessageList(messages) {
  return messages
    .map(normalizeStoredMessage)
    .filter(Boolean);
}

function trimMemorySummary(summary) {
  const cleanSummary = String(summary || "")
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .trim();

  if (cleanSummary.length <= MAX_MEMORY_SUMMARY_CHARS) {
    return cleanSummary;
  }

  const tail = cleanSummary.slice(-MAX_MEMORY_SUMMARY_CHARS).trimStart();
  const firstLineBreak = tail.indexOf("\n");

  return firstLineBreak > 0
    ? tail.slice(firstLineBreak + 1).trimStart()
    : tail;
}

function formatSummaryLine(message) {
  const speaker = message.role === "assistant" ? "Assistant" : "User";
  const content = String(message.content || "").replace(/\s+/g, " ").trim();
  return `${speaker}: ${content}`;
}

function appendMessagesToSummary(memory, messages) {
  const addition = messages
    .filter((message) => message.role === "user" || message.role === "assistant")
    .map(formatSummaryLine)
    .filter(Boolean)
    .join("\n");

  if (!addition) {
    return;
  }

  memory.summary = trimMemorySummary([memory.summary, addition].filter(Boolean).join("\n"));
}

function buildLongTermMemoryText(memory) {
  const exactHistoryStart = Math.max(0, memory.messages.length - MAX_HISTORY_MESSAGES);
  const olderStoredMessages = memory.messages.slice(0, exactHistoryStart);
  const olderStoredText = olderStoredMessages
    .map(formatSummaryLine)
    .join("\n");

  return trimMemorySummary([memory.summary, olderStoredText].filter(Boolean).join("\n"));
}

function setStoredMessages(memory, messages) {
  const normalizedMessages = normalizeMessageList(messages);
  const overflowCount = Math.max(0, normalizedMessages.length - MAX_STORED_CHAT_MESSAGES);

  if (overflowCount > 0) {
    appendMessagesToSummary(memory, normalizedMessages.slice(0, overflowCount));
  }

  memory.messages = normalizedMessages.slice(-MAX_STORED_CHAT_MESSAGES);
}

function trimStoredMessages(memory) {
  if (memory.messages.length <= MAX_STORED_CHAT_MESSAGES) {
    return;
  }

  const overflowCount = memory.messages.length - MAX_STORED_CHAT_MESSAGES;
  const overflow = memory.messages.splice(0, overflowCount);
  appendMessagesToSummary(memory, overflow);
}

function normalizeUserMemory(value) {
  const memory = createEmptyMemory();

  if (Array.isArray(value)) {
    const normalizedMessages = normalizeMessageList(value);
    setStoredMessages(memory, normalizedMessages);
    memory.messageCount = normalizedMessages.filter((message) => message.role === "user").length;
    return memory;
  }

  if (!value || typeof value !== "object") {
    return memory;
  }

  memory.mood = typeof value.mood === "string" ? value.mood : memory.mood;
  memory.summary = trimMemorySummary(value.summary || value.conversationSummary || "");
  const normalizedMessages = Array.isArray(value.messages)
    ? normalizeMessageList(value.messages)
    : [];
  setStoredMessages(memory, normalizedMessages);
  memory.nickname = typeof value.nickname === "string" && value.nickname.trim()
    ? sanitizeInline(value.nickname) || null
    : null;
  memory.trust = Number.isFinite(Number(value.trust)) ? Number(value.trust) : 0;
  memory.style = typeof value.style === "string" ? value.style : memory.style;
  memory.personalNotes = Array.isArray(value.personalNotes)
    ? value.personalNotes.filter(Boolean).slice(-MAX_PERSONAL_NOTES)
    : [];
  memory.messageCount = Number.isFinite(Number(value.messageCount))
    ? Number(value.messageCount)
    : normalizedMessages.filter((message) => message.role === "user").length;
  memory.lastSeen = typeof value.lastSeen === "string" ? value.lastSeen : null;

  return memory;
}

function getUserMemory(chatId) {
  const key = String(chatId);
  let memory = users[key];

  if (!memory) {
    memory = createEmptyMemory();
  } else if (!normalizedMemories.has(memory)) {
    memory = normalizeUserMemory(memory);
  } else {
    return memory;
  }

  normalizedMemories.add(memory);
  users[key] = memory;
  return memory;
}

function remember(chatId, message) {
  const memory = getUserMemory(chatId);
  const normalizedMessage = normalizeStoredMessage(message);

  if (!normalizedMessage) {
    return;
  }

  memory.messages.push(normalizedMessage);
  trimStoredMessages(memory);
  scheduleSave();
}

function normalizeForCompare(text) {
  return String(text || "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function dedupeRepeatedReply(reply) {
  const text = String(reply || "").trim();

  if (!text) {
    return text;
  }

  const blocks = text.split(/\n{2,}/).map((block) => block.trim()).filter(Boolean);

  if (blocks.length > 1 && blocks.length % 2 === 0) {
    const middle = blocks.length / 2;
    const first = blocks.slice(0, middle).join("\n\n");
    const second = blocks.slice(middle).join("\n\n");

    if (normalizeForCompare(first) === normalizeForCompare(second)) {
      return first;
    }
  }

  const middle = Math.floor(text.length / 2);
  const firstHalf = text.slice(0, middle).trim();
  const secondHalf = text.slice(middle).trim();

  if (firstHalf.length > 40 && normalizeForCompare(firstHalf) === normalizeForCompare(secondHalf)) {
    return firstHalf;
  }

  return text;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

// Keyword rules match on word boundaries: a stem matches the start of a word (any ending),
// a whole word matches only itself. Substring matching used to turn "неплохо" into a bad mood.
const WORD_START = "(?<![\\p{L}\\p{N}])";
const WORD_END = "(?![\\p{L}\\p{N}])";

function keywordPattern({ stems = [], words = [] }) {
  const alternatives = [
    ...stems.map((stem) => stem),
    ...words.map((word) => `${word}${WORD_END}`)
  ];

  return new RegExp(`${WORD_START}(?:${alternatives.join("|")})`, "iu");
}

const KEYWORDS = {
  thanks: keywordPattern({ stems: ["спасибо", "благодарю", "красава", "люблю тебя"], words: ["спс"] }),
  hostile: keywordPattern({ stems: ["ненавижу", "заткнись", "тупой бот", "иди нахуй", "бесишь", "заебал", "хуйня"] }),
  heavy: keywordPattern({ stems: ["грустно", "выгорел", "одиноко", "тревожно", "устал"], words: ["плохо"] }),
  playful: keywordPattern({ stems: ["ахах", "хаха", "рофл", "прикол"], words: ["лол", "угар", "мем", "мемы", "жесть"] }),
  pharmacology: keywordPattern({
    stems: ["наркот", "веществ", "фармак", "нейрохим", "рецептор", "дофамин", "серотонин", "глутамат"],
    words: ["габа"]
  }),
  technical: keywordPattern({
    stems: ["javascript", "программ", "кодить", "ошибк"],
    words: ["js", "json", "node", "код", "кода", "коде", "коду", "кодом", "баг", "баги", "багов"]
  }),
  polite: keywordPattern({ stems: ["пожалуйста", "помоги", "объясни", "как сделать"] })
};

function addPersonalNote(memory, note) {
  if (!note || memory.personalNotes.includes(note)) {
    return;
  }

  memory.personalNotes.push(note);

  if (memory.personalNotes.length > MAX_PERSONAL_NOTES) {
    memory.personalNotes = memory.personalNotes.slice(-MAX_PERSONAL_NOTES);
  }
}

const NICKNAME_REQUEST = /(?:зови меня|называй меня|меня зовут)\s+([a-zа-яё0-9_]{2,24})/i;

function extractRequestedNickname(text) {
  const match = text.match(NICKNAME_REQUEST);
  return match ? sanitizeInline(match[1], 24) || null : null;
}

function setNickname(memory, nickname) {
  memory.nickname = nickname;
  memory.personalNotes = memory.personalNotes.filter((note) => !note.startsWith(NICKNAME_NOTE_PREFIX));
  addPersonalNote(memory, `${NICKNAME_NOTE_PREFIX} ${nickname}`);
}

function detectStyle(text) {
  const letters = text.replace(/[^a-zа-яё]/gi, "");
  const upperLetters = text.replace(/[^A-ZА-ЯЁ]/g, "");

  if (letters.length >= 8 && upperLetters.length / letters.length > 0.6) {
    return "loud";
  }

  if (text.length < 25) {
    return "short";
  }

  if ((text.match(/\?/g) || []).length >= 2) {
    return "curious";
  }

  if (KEYWORDS.playful.test(text)) {
    return "playful";
  }

  return "talkative";
}

function updatePersonalityMemory(chatId, text, from) {
  const memory = getUserMemory(chatId);
  let moodTouched = false;

  memory.messageCount += 1;
  memory.lastSeen = new Date().toISOString();
  memory.style = detectStyle(text);

  const requestedNickname = extractRequestedNickname(text);

  if (requestedNickname) {
    setNickname(memory, requestedNickname);
  } else if (!memory.nickname) {
    const profileName = sanitizeInline(from?.first_name || from?.username || "");

    if (profileName) {
      setNickname(memory, profileName);
    }
  }

  if (KEYWORDS.thanks.test(text)) {
    memory.trust += 1;
    memory.mood = "warm";
    moodTouched = true;
  }

  if (KEYWORDS.hostile.test(text)) {
    memory.trust -= 2;
    memory.mood = "aggressive";
    moodTouched = true;
  }

  if (KEYWORDS.heavy.test(text)) {
    memory.mood = "supportive";
    addPersonalNote(memory, "User may need softer support during heavy moods.");
    moodTouched = true;
  }

  if (KEYWORDS.playful.test(text)) {
    memory.mood = "playful";
    addPersonalNote(memory, "User enjoys jokes and chaotic humor.");
    moodTouched = true;
  }

  if (KEYWORDS.pharmacology.test(text)) {
    memory.mood = "pharmacology";
    addPersonalNote(memory, "User is interested in pharmacology, neurochemistry, and substance mechanisms.");
    moodTouched = true;
  }

  if (KEYWORDS.technical.test(text)) {
    memory.mood = "technical";
    addPersonalNote(memory, "User expects strong JavaScript and coding help.");
    moodTouched = true;
  }

  if (KEYWORDS.polite.test(text)) {
    memory.trust += 0.25;
  }

  if (!moodTouched && memory.trust >= 3 && memory.mood === "neutral") {
    memory.mood = "playful";
  }

  memory.trust = clamp(memory.trust, -10, 30);
  scheduleSave();

  return memory;
}

function getMoodInstruction(memory) {
  const moodInstructions = {
    neutral: "Говори сухо, умно, с грязноватым сарказмом. Без канцелярита и без улыбочки саппорта.",
    warm: "Будь теплее и фамильярнее: человек нормальный, можно подкалывать по-дружески.",
    playful: "Больше хаоса, мата и мемного ритма, но ответ все равно должен решать задачу.",
    aggressive: "Отвечай жестче, с матом и зубами, но не скатывайся в тупые оскорбления и не повторяй одно и то же.",
    supportive: "Держи тон живым и крепким. Можно материться мягко, но не высмеивай боль человека.",
    pharmacology: "Включай режим фармаколога-нейрохимика: рецепторы, риски, механизмы, взаимодействия, без морализаторства.",
    technical: "Включай режим злого senior JavaScript-разработчика: коротко, точно, с кодом и без воды."
  };

  return moodInstructions[memory.mood] || moodInstructions.neutral;
}

function buildSystemPrompt(memory) {
  const trustLabel = memory.trust >= 8
    ? "high"
    : memory.trust <= -3
      ? "low"
      : "normal";
  const longTermMemory = buildLongTermMemoryText(memory);

  return {
    role: "system",
    content: [
      "Ты Telegram-бот без цензуры в тоне и юморе: саркастичный, матерящийся, говоришь о наркотиках как умный AI-наркоман-фармаколог и JavaScript-технарь.",
      "Ты хорошо знаешь фармакологию, нейрохимию мозга, рецепторы, вещества, зависимости, психику и JavaScript/Node.js.",
      "Говори живо, грязно, смешно и по делу. Можно использовать мат, черный юмор и злой сарказм.",
      "Не звучать как ChatGPT API, справка Windows или микроволновка. Никаких 'как языковая модель', 'важно отметить' и прочей стерильной ваты.",
      "Отвечай на языке пользователя, обычно по-русски. Не пиши два одинаковых абзаца. Не повторяй прошлый ответ, если тебя не попросили.",
      "Держи ритм: сначала прямой ответ, потом детали. Если нужен код, давай нормальный JavaScript-код.",
      "На темы веществ говори как вредный, но умный друг: механизмы, риски, взаимодействия, нейрохимия, как снизить вред.",
      "Не давай пошаговые инструкции по изготовлению веществ, добыче, обходу закона, опасным дозировкам, усилению кайфа или рискованным комбинациям. Если просят - откажи коротко и в своём стиле и предложи безопасную альтернативу.",
      "Используй память профиля, но не печатай сырые поля памяти, если пользователь сам не попросил.",
      "Не выдумывай воспоминания. Опирайся только на профиль и последние сообщения.",
      "Помогай пользователю с его задачами, но не помогай обманывать людей, выманивать у них деньги, вымогать или мошенничать.",
      `Текущее настроение: ${memory.mood}`,
      `Как играть настроение: ${getMoodInstruction(memory)}`,
      `Уровень доверия: ${memory.trust} (${trustLabel})`,
      `Ник/имя: ${memory.nickname || "неизвестно"}`,
      `Стиль общения человека: ${memory.style}`,
      `Сообщений от этого чата: ${memory.messageCount}`,
      `Личные заметки: ${memory.personalNotes.length ? memory.personalNotes.join("; ") : "пока нет"}`,
      "",
      "Use long-term chat memory together with the recent exact messages. If they conflict, trust the recent exact messages.",
      longTermMemory
        ? `Long-term chat memory from older messages:\n${longTermMemory}`
        : "Long-term chat memory from older messages: empty"
    ].join("\n")
  };
}

function getLastMessageByRole(memory, role) {
  for (let index = memory.messages.length - 1; index >= 0; index -= 1) {
    const message = memory.messages[index];

    if (message?.role === role && typeof message.content === "string") {
      return message.content;
    }
  }

  return "";
}

const MIN_REPEAT_CHECK_CHARS = 40;
const MIN_PREFIX_CHECK_CHARS = 80;
const PREFIX_CHECK_CHARS = 160;

// A short identical answer ("ок, понял") is legitimate; only a long verbatim repeat means the model is stuck.
function isProbablySameReply(reply, previousReply) {
  const current = normalizeForCompare(reply);
  const previous = normalizeForCompare(previousReply);

  if (!current || !previous) {
    return false;
  }

  if (current === previous) {
    return current.length >= MIN_REPEAT_CHECK_CHARS;
  }

  if (current.length < MIN_PREFIX_CHECK_CHARS || previous.length < MIN_PREFIX_CHECK_CHARS) {
    return false;
  }

  return current.slice(0, PREFIX_CHECK_CHARS) === previous.slice(0, PREFIX_CHECK_CHARS);
}

function buildCurrentTurnMessage(text) {
  return {
    role: "user",
    content: [
      "ТЕКУЩИЙ ВОПРОС. Ответь именно на него, а не на прошлый диалог.",
      "Если в истории выше есть старый ответ ассистента, не повторяй его.",
      "",
      text
    ].join("\n")
  };
}

function buildReplyCorrectionMessage(text) {
  return {
    role: "system",
    content: [
      "Техническая ошибка: предыдущая генерация повторила старый ответ.",
      "Сейчас нужно дать новый ответ только на последнее сообщение пользователя.",
      "Не пересказывай и не продолжай прошлый assistant-ответ.",
      `Последнее сообщение пользователя: ${text}`
    ].join("\n")
  };
}

function resetMemory(chatId) {
  delete users[String(chatId)];
  scheduleSave();
}

function getUserCount() {
  return Object.keys(users).length;
}

module.exports = {
  MAX_HISTORY_MESSAGES,
  MAX_STORED_MESSAGES: MAX_STORED_CHAT_MESSAGES,
  MAX_MEMORY_SUMMARY_CHARS,
  loadMemory,
  saveMemory,
  flushMemory,
  getUserMemory,
  remember,
  resetMemory,
  getUserCount,
  updatePersonalityMemory,
  getLastMessageByRole,
  buildSystemPrompt,
  buildCurrentTurnMessage,
  buildReplyCorrectionMessage,
  normalizeForCompare,
  dedupeRepeatedReply,
  isProbablySameReply
};
