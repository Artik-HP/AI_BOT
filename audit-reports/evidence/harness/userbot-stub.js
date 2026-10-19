"use strict";
// Preload for scripts/userbot.js: stub gramjs and replay synthetic incoming events from a STRANGER.
const Module = require("module");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const replies = [];

class StringSession { constructor(s) { this.s = s; } save() { return this.s; } }
class NewMessage { constructor(o) { this.o = o; } }
class TelegramClient {
  constructor() { this.handlers = []; }
  async connect() { setTimeout(() => this._replay().catch((e) => console.log("STUB-ERR", e.message)), 80); }
  addEventHandler(cb, builder) { this.handlers.push({ cb, builder }); console.log("BUILDER " + JSON.stringify(builder.o)); }
  async getMe() { return { id: 1, username: "owner_user", firstName: "Owner" }; }
  async sendMessage() {}
  async disconnect() {}
  get connected() { return true; } // real gramjs: getter `connected`; there is NO `isConnected`
  async _replay() {
    const events = [
      { label: "stranger private .ping", chatId: 900, senderId: 900, text: ".ping" },
      { label: "stranger private .status", chatId: 900, senderId: 900, text: ".status" },
      { label: "stranger private .whoami", chatId: 900, senderId: 900, text: ".whoami" },
      { label: "stranger private .say", chatId: 900, senderId: 900, text: ".say привет всем" },
      { label: "stranger slash /echo", chatId: 900, senderId: 900, text: "/echo через слэш" },
      { label: "stranger in GROUP .say", chatId: -100500, senderId: 901, text: ".say спам в группе от имени владельца" },
      { label: "stranger keyword 'userbot'", chatId: 902, senderId: 902, text: "а ты случайно не userbot?" },
      { label: "OWNER's own outgoing .ping", chatId: 1, senderId: 1, text: ".ping", out: true }
    ];
    for (const e of events) {
      const before = replies.length;
      const message = {
        out: !!e.out, message: e.text, text: e.text, rawText: e.text, chatId: e.chatId, senderId: e.senderId,
        reply: async (o) => { replies.push({ label: e.label, text: o.message }); }
      };
      for (const h of this.handlers) await h.cb({ message });
      console.log("EVENT " + JSON.stringify({ label: e.label, answered: replies.length > before, answer: (replies[replies.length - 1] || {}).text && replies.length > before ? replies[replies.length - 1].text.split("\n").slice(0, 9).join(" / ") : null }));
      await sleep(20);
    }
    console.log("DONE");
    process.exit(0);
  }
}
const orig = Module._load;
Module._load = function (request) {
  if (request === "telegram") return { TelegramClient };
  if (request === "telegram/sessions") return { StringSession };
  if (request === "telegram/events") return { NewMessage };
  return orig.apply(this, arguments);
};
