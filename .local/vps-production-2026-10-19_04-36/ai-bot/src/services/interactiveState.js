const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const CONFIG = require("../config");
const { validateQuestion } = require("./interactiveQuestion");

const CALLBACK_PREFIX = "iq:";
const PAGE_SIZE = 6;
class InteractiveState {
  constructor(file = CONFIG.INTERACTIVE_STATE_FILE) {
    this.file = file;
    this.records = {};
    if (fs.existsSync(file)) {
      const saved = JSON.parse(fs.readFileSync(file, "utf8"));
      if (saved.version !== 1 || !saved.records || typeof saved.records !== "object" || Array.isArray(saved.records)) throw new Error("Invalid interactive state file");
      for (const [id, record] of Object.entries(saved.records)) {
        if (!/^[a-f0-9]{16}$/.test(id) || record.id !== id || !validateQuestion(record.question) || !Array.isArray(record.selected)) throw new Error("Invalid saved interactive question");
        // Restart never resends work automatically. A failed generation can be retried explicitly.
        if (["processing", "generated"].includes(record.status)) record.status = "failed";
      }
      this.records = saved.records;
    }
  }
  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const temp = `${this.file}.${process.pid}.tmp`;
    try {
      fs.writeFileSync(temp, JSON.stringify({ version: 1, records: this.records }), { mode: 0o600 });
      fs.renameSync(temp, this.file);
    } finally {
      if (fs.existsSync(temp)) fs.unlinkSync(temp);
    }
  }
  mutate(fn) {
    const before = structuredClone(this.records);
    try { const result = fn(); this.save(); return result; }
    catch (error) { this.records = before; throw error; }
  }
  create(chatId, userId, question, model = CONFIG.MODEL) {
    if (!validateQuestion(question) || userId == null) throw new Error("Invalid interactive question or owner");
    return this.mutate(() => {
      const id = crypto.randomBytes(8).toString("hex");
      const record = {
        id, chatId: String(chatId), userId: String(userId), question, model,
        selected: [], page: 0, status: "active", messageId: null,
        expiresAt: Date.now() + CONFIG.INTERACTIVE_QUESTION_TTL_MS,
        createdAt: Date.now(), reply: null, delivery: { chunksSent: 0 }, attempts: 0, seenCallbacks: []
      };
      this.records[id] = record;
      // Tombstones are only needed while Telegram can still show recent controls.
      for (const old of Object.values(this.records)) {
        if (["completed", "expired"].includes(old.status) && old.createdAt < Date.now() - 7 * 86400000) delete this.records[old.id];
      }
      return record;
    });
  }
  get(id) { return this.records[id]; }
  update(id, changes) {
    return this.mutate(() => {
      const record = this.get(id);
      if (!record) throw new Error("Interactive question not found");
      Object.assign(record, changes);
      return record;
    });
  }
  invalidate(chatId, exceptId) {
    const exceptions = new Set(Array.isArray(exceptId) ? exceptId : [exceptId]);
    return this.mutate(() => {
      const invalidated = [];
      for (const record of Object.values(this.records)) {
        if (record.chatId === String(chatId) && !exceptions.has(record.id) && !["completed", "expired"].includes(record.status)) {
          record.status = "expired";
          invalidated.push(record);
        }
      }
      return invalidated;
    });
  }
  resolve(query) {
    const match = String(query.data || "").match(/^iq:([a-f0-9]{16}):([ospcr]):?(\d+)?$/);
    const record = match && this.get(match[1]);
    if (!record || record.chatId !== String(query.message?.chat?.id) || record.messageId !== query.message?.message_id) return { error: "Эта кнопка больше недоступна. Ответь текстом." };
    if (record.userId !== String(query.from?.id)) return { error: "На этот вопрос отвечает автор диалога." };
    if (record.status === "expired" || record.expiresAt <= Date.now()) return { error: "Этот вопрос устарел. Напиши ответ текстом." };
    if (record.status === "completed") return { error: "Ответ уже отправлен." };
    if (["processing", "generated"].includes(record.status) && match[2] !== "r") return { error: "Ответ обрабатывается." };
    const action = match[2], index = match[3] === undefined ? null : Number(match[3]);
    if (action === "o" && (!Number.isInteger(index) || !record.question.options[index])) return { error: "Такого варианта нет." };
    if (action === "p" && (!Number.isInteger(index) || index < 0 || index >= Math.ceil(record.question.options.length / PAGE_SIZE))) return { error: "Такой страницы нет." };
    return { record, action, index };
  }
}

function label(text, max = 44) {
  const chars = Array.from(text);
  return chars.length > max ? `${chars.slice(0, max - 1).join("")}…` : text;
}
function renderQuestionKeyboard(record) {
  const button = (text, action, index) => ({ text, callback_data: `${CALLBACK_PREFIX}${record.id}:${action}${index == null ? "" : `:${index}`}` });
  if (record.status === "completed" || record.status === "expired" || record.status === "manual") return { inline_keyboard: [] };
  if (record.status === "processing") return { inline_keyboard: [[button("⏳ Обрабатываю ответ…", "s")]] };
  if (["failed", "generated"].includes(record.status)) return { inline_keyboard: [[button("🔄 Повторить отправку", "r")], [button("✍️ Написать самому", "s")]] };
  const multiple = record.question.selection_mode === "multiple";
  const start = record.page * PAGE_SIZE;
  const rows = record.question.options.slice(start, start + PAGE_SIZE).map((option, offset) => [button(`${multiple ? (record.selected.includes(start + offset) ? "✅ " : "▫️ ") : ""}${label(option.label)}`, "o", start + offset)]);
  const pages = Math.ceil(record.question.options.length / PAGE_SIZE);
  if (pages > 1) {
    const nav = [];
    if (record.page > 0) nav.push(button("← Назад", "p", record.page - 1));
    if (record.page + 1 < pages) nav.push(button("Далее →", "p", record.page + 1));
    rows.push(nav);
  }
  if (multiple) rows.push([button(`✓ Подтвердить (${record.selected.length})`, "c")]);
  rows.push([button("✍️ Написать самому", "s")]);
  return { inline_keyboard: rows };
}
let instance;
function getInteractiveState() { return instance ||= new InteractiveState(); }
module.exports = { InteractiveState, getInteractiveState, renderQuestionKeyboard, CALLBACK_PREFIX, PAGE_SIZE };
