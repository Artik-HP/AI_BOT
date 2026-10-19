const CONFIG = require("../config");
const logger = require("../utils/logger");
const { safeHandler } = require("../utils/safe");
const { createKeyedQueue } = require("../utils/queue");
const { createTtlSet } = require("../utils/ttlSet");
const { TELEGRAM_MESSAGE_LIMIT } = require("../utils/text");
const { draftAccountReply } = require("./openrouter");
const { isAddressedToThisBot } = require("./telegram");

const { parseBoolean } = CONFIG;
const MAX_BURST_ITEMS = 20;
const MAX_INCOMING_TEXT_CHARS = 3000;
const MAX_TRACKED_CHATS = 500;
const TASKS_GRACE_MS = 8000;

// Cloud connections to the owner's own Telegram account: loaded only when the assistant is switched on.
let clientFactory = () => {
  const { TelegramClient } = require("telegram");
  const { StringSession } = require("telegram/sessions");

  return new TelegramClient(
    new StringSession(CONFIG.TELEGRAM_STRING_SESSION),
    CONFIG.TELEGRAM_API_ID,
    CONFIG.TELEGRAM_API_HASH,
    { connectionRetries: 5 }
  );
};
let eventFilterFactory = () => {
  const { NewMessage } = require("telegram/events");
  return new NewMessage({ incoming: true });
};

let accountClient = null;
let connecting = null;
let lifecycleGeneration = 0;
let desiredEnabled = Boolean(CONFIG.ACCOUNT_ASSISTANT_ENABLED);
let controlBot = null;
let started = false;
let handlersRegistered = false;
let autoDowngradeWarned = false;
let accountAssistantEnabled = Boolean(CONFIG.ACCOUNT_ASSISTANT_ENABLED);
let accountAssistantMode = CONFIG.ACCOUNT_ASSISTANT_MODE;
let accountAssistantPrivateOnly = Boolean(CONFIG.ACCOUNT_ASSISTANT_PRIVATE_ONLY);
const accountAssistantAllow = new Set(CONFIG.ACCOUNT_ASSISTANT_ALLOW_CHATS.map(normalizeToken));
const accountAssistantBlock = new Set(CONFIG.ACCOUNT_ASSISTANT_BLOCK_CHATS.map(normalizeToken));

const VALID_MODES = new Set(["approval", "auto", "dry-run"]);
const pendingDrafts = new Map();
const pendingBursts = new Map();
const lastHandledAt = new Map();
const enqueueChatTask = createKeyedQueue();
const processedMessages = createTtlSet(CONFIG.PROCESSED_MESSAGE_TTL_MS);

// Deterministic guard for the "auto" mode: whatever the model says, a reply that looks like
// money, credentials, a link or contact data is never sent without the owner's approval.
const AUTO_SEND_RISK_RULES = [
  [/https?:\/\/|\bwww\.|\bt\.me\/|\b[a-z0-9-]+\.(?:com|ru|org|net|io|me|ua|by|kz|su)\b/i, "ссылка"],
  [/\b(?:\d{4}[ -]?){3}\d{1,4}\b/, "номер карты"],
  [/\d{10,}/, "длинное число"],
  [/\+\d[\d\s().-]{8,}\d/, "номер телефона"],
  [/\b(?:0x[a-fA-F0-9]{20,}|bc1[a-z0-9]{20,}|[13][a-km-zA-HJ-NP-Z1-9]{25,34})\b/, "криптоадрес"],
  [/\b[A-Z]{2}\d{2}[A-Z0-9]{10,30}\b/, "реквизиты счёта"],
  [/парол|код\s+(?:из\s+)?(?:смс|sms)|\bcvv\b|\bcvc\b|пин-?код|seed|сид-?фраз|секретн/i, "секретные данные"],
  [/перев(?:еди|ожу|ести|од)|деньг|одолж|займ|реквизит|оплат|(?<![\p{L}\p{N}])карт[аыуе](?![\p{L}\p{N}])|\busdt\b|\bbtc\b|биткоин|крипт/iu, "деньги"]
];

// Returns the reason a reply must not be auto-sent, or null when it looks harmless.
function findAutoSendRisk(text) {
  for (const [pattern, reason] of AUTO_SEND_RISK_RULES) {
    if (pattern.test(String(text || ""))) {
      return reason;
    }
  }

  return null;
}

function normalizeToken(value) {
  return String(value || "").trim().replace(/^@/, "").toLowerCase();
}

function normalizeId(value) {
  return value == null ? "" : String(value);
}

function getAccountAssistantMode() {
  return accountAssistantMode;
}

// "auto" sends from the personal account without asking, so it needs a list of people it may talk to.
function getEffectiveMode() {
  if (accountAssistantMode === "auto" && !accountAssistantAllow.size && !CONFIG.ACCOUNT_ASSISTANT_AUTO_ALLOW_ANY) {
    return "approval";
  }

  return accountAssistantMode;
}

function warnIfAutoDowngraded() {
  if (getEffectiveMode() === accountAssistantMode || autoDowngradeWarned) {
    return;
  }

  autoDowngradeWarned = true;
  logger.warn(
    "Режим auto работает как approval, пока пуст allow-list (ACCOUNT_ASSISTANT_ALLOW_CHATS). " +
    "Для автоответов любым контактам задайте ACCOUNT_ASSISTANT_AUTO_ALLOW_ANY=true (небезопасно)."
  );
}

function getAccountAssistantStatus() {
  return {
    enabled: accountAssistantEnabled,
    started,
    connected: Boolean(accountClient?.connected),
    mode: getAccountAssistantMode(),
    effectiveMode: getEffectiveMode(),
    privateOnly: accountAssistantPrivateOnly,
    pendingDrafts: pendingDrafts.size,
    allowListSize: accountAssistantAllow.size,
    blockListSize: accountAssistantBlock.size,
    ownerChatIdConfigured: Boolean(CONFIG.ACCOUNT_ASSISTANT_OWNER_CHAT_ID)
  };
}

function getMissingConfig() {
  const missing = [];

  if (!Number.isFinite(CONFIG.TELEGRAM_API_ID) || CONFIG.TELEGRAM_API_ID <= 0) {
    missing.push("TELEGRAM_API_ID");
  }

  if (!CONFIG.TELEGRAM_API_HASH) {
    missing.push("TELEGRAM_API_HASH");
  }

  if (!CONFIG.TELEGRAM_STRING_SESSION) {
    missing.push("TELEGRAM_STRING_SESSION");
  }

  if (getEffectiveMode() !== "auto" && !CONFIG.ACCOUNT_ASSISTANT_OWNER_CHAT_ID) {
    missing.push("ACCOUNT_ASSISTANT_OWNER_CHAT_ID");
  }

  return missing;
}

function buildSenderName(sender) {
  const firstName = sender?.firstName || sender?.first_name || "";
  const lastName = sender?.lastName || sender?.last_name || "";
  const fullName = `${firstName} ${lastName}`.trim();
  return fullName || sender?.title || "unknown";
}

function buildSenderProfile(sender, message) {
  return {
    id: normalizeId(sender?.id || message.senderId),
    chatId: normalizeId(message.chatId || message.senderId || sender?.id),
    username: sender?.username || "",
    name: buildSenderName(sender),
    isBot: Boolean(sender?.bot)
  };
}

// Only stable identifiers: the display name is chosen by the sender and proves nothing.
function getPeerKeys(profile) {
  return [
    profile.chatId,
    profile.id,
    profile.username,
    profile.username ? `@${profile.username}` : ""
  ].map(normalizeToken).filter(Boolean);
}

function isPeerBlocked(profile) {
  const keys = getPeerKeys(profile);
  return keys.some((key) => accountAssistantBlock.has(key));
}

function isPeerAllowed(profile) {
  if (accountAssistantAllow.size === 0) {
    return true;
  }

  const keys = getPeerKeys(profile);
  return keys.some((key) => accountAssistantAllow.has(key));
}

function setAccountAssistantMode(mode) {
  const cleanMode = String(mode || "").trim().toLowerCase();

  if (!VALID_MODES.has(cleanMode)) {
    return false;
  }

  accountAssistantMode = cleanMode;
  return true;
}

function addPeerToSet(set, value) {
  const token = normalizeToken(String(value || ""));

  if (!token) {
    return false;
  }

  set.add(token);
  return true;
}

function removePeerFromSet(set, value) {
  const token = normalizeToken(String(value || ""));

  if (!token) {
    return false;
  }

  return set.delete(token);
}

function shouldHandlePeer(profile) {
  if (profile.isBot) {
    return false;
  }

  if (isPeerBlocked(profile)) {
    return false;
  }

  return isPeerAllowed(profile);
}

function trimText(text, maxLength = TELEGRAM_MESSAGE_LIMIT) {
  const cleanText = String(text || "").trim();

  if (cleanText.length <= maxLength) {
    return cleanText;
  }

  return `${cleanText.slice(0, maxLength - 3).trim()}...`;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatPeerSet(set) {
  return set.size ? Array.from(set).sort().join(", ") : "none";
}

function resolvePeer(value) {
  const raw = String(value || "").trim();

  if (!raw) {
    return null;
  }

  return /^-?\d+$/.test(raw) ? Number(raw) : raw;
}

function describeModes() {
  const effective = getEffectiveMode();
  return effective === getAccountAssistantMode()
    ? effective
    : `${getAccountAssistantMode()} (работает как ${effective}: пуст allow-list)`;
}

function buildAccountAssistantHelpText() {
  return [
    "Account assistant команды для владельца:",
    "/account_help — показать это сообщение",
    "/account_status — статус аккаунт-ассистента",
    "/account_pending — список черновиков",
    "/account_send <id> — отправить черновик",
    "/account_drop <id> — отклонить черновик",
    "/account_reply <id> текст — отправить собственный ответ",
    "/account_redraft <id> — получить новый черновик AI",
    "/account_message <chatId|@username> текст — отправить сообщение от аккаунта",
    "/account_mode [approval|auto|dry-run] — просмотреть или сменить режим",
    "/account_private [true|false] — включить/выключить только личные чаты",
    "/account_allow <chatId|@username> — добавить в разрешённые чаты",
    "/account_block <chatId|@username> — добавить в блок-лист",
    "/account_unallow <chatId|@username> — убрать из разрешённых",
    "/account_unblock <chatId|@username> — убрать из блок-листа",
    "/account_config — показать текущие настройки",
    "",
    "Режим, списки и private-only, изменённые командами, действуют до перезапуска бота.",
    "Постоянные значения задаются в .env."
  ].join("\n");
}

function buildAccountAssistantConfigText() {
  return [
    "Account assistant конфигурация:",
    `enabled: ${accountAssistantEnabled}`,
    `mode: ${describeModes()}`,
    `privateOnly: ${accountAssistantPrivateOnly}`,
    `allow list: ${formatPeerSet(accountAssistantAllow)}`,
    `block list: ${formatPeerSet(accountAssistantBlock)}`,
    `pending drafts: ${pendingDrafts.size}`,
    `owner chat id configured: ${Boolean(CONFIG.ACCOUNT_ASSISTANT_OWNER_CHAT_ID)}`
  ].join("\n");
}

async function sendDirectAccountMessage(chatId, text) {
  if (!accountClient) {
    throw new Error("Account client is not connected");
  }

  const peer = resolvePeer(chatId);

  if (!peer) {
    throw new Error("Неверный chatId или @username");
  }

  return accountClient.sendMessage(peer, {
    message: String(text || "").trim(),
    linkPreview: false
  });
}

function createDraftId() {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

// The owner is a person, not just a chat: in a group the chat id alone would let every member in.
function isOwnerActor(chatId, userId) {
  const ownerId = CONFIG.ACCOUNT_ASSISTANT_OWNER_CHAT_ID;

  return Boolean(
    ownerId &&
    String(chatId) === String(ownerId) &&
    (userId == null || String(userId) === String(ownerId))
  );
}

function buildDraftNotice(draft, title = "Новый входящий в Telegram-аккаунте") {
  const incomingText = trimText(draft.incomingText, 1200);
  const replyText = trimText(draft.reply || "Черновик не создан.", 1200);
  const reason = trimText(draft.reason || "-", 400);
  const text = [
    title,
    `ID: ${draft.id}`,
    `От: ${draft.senderName}${draft.username ? ` (@${draft.username})` : ""}`,
    `Chat ID: ${draft.chatId}`,
    "",
    "Сообщение:",
    incomingText,
    "",
    "Черновик:",
    replyText,
    "",
    `Решение AI: ${draft.sendable ? "можно отправить" : "нужно подтверждение"}`,
    `Причина: ${reason}`,
    draft.autoBlockedReason ? `Автоотправка заблокирована: ${draft.autoBlockedReason}` : "",
    "",
    `Свой текст: /account_reply ${draft.id} твой ответ`
  ].filter((line, index, lines) => line !== "" || lines[index - 1] !== "").join("\n");

  return trimText(text, TELEGRAM_MESSAGE_LIMIT);
}

function buildDraftKeyboard(id) {
  return {
    reply_markup: {
      inline_keyboard: [
        [
          { text: "Отправить", callback_data: `account:send:${id}` },
          { text: "Редрафт", callback_data: `account:redraft:${id}` }
        ],
        [
          { text: "Отклонить", callback_data: `account:drop:${id}` },
          { text: "Заблокировать отправителя", callback_data: `account:block:${id}` }
        ]
      ]
    }
  };
}

// Blocks by the stable ids as well as by the username: changing a username must not lift the block.
function blockDraftSender(draft) {
  if (!draft) {
    return false;
  }

  const targets = [draft.senderId, draft.username].filter(Boolean);

  if (!targets.length && draft.chatId) {
    targets.push(draft.chatId);
  }

  return targets.map((target) => addPeerToSet(accountAssistantBlock, target)).some(Boolean);
}

async function editOwnerNotice(draft, text) {
  if (!controlBot || !draft.noticeMessageId || !CONFIG.ACCOUNT_ASSISTANT_OWNER_CHAT_ID) {
    return;
  }

  await controlBot.editMessageText(trimText(text, TELEGRAM_MESSAGE_LIMIT), {
    chat_id: CONFIG.ACCOUNT_ASSISTANT_OWNER_CHAT_ID,
    message_id: draft.noticeMessageId
  }).catch(() => {});
}

async function notifyOwner(chatId, text) {
  if (!controlBot || !chatId) {
    return;
  }

  await controlBot.sendMessage(chatId, trimText(text, TELEGRAM_MESSAGE_LIMIT)).catch(() => {});
}

function storePendingDraft(draft) {
  pendingDrafts.set(draft.id, draft);
  setTimeout(() => {
    pendingDrafts.delete(draft.id);
  }, CONFIG.ACCOUNT_ASSISTANT_DRAFT_TTL_MS).unref?.();
}

async function notifyOwnerAboutDraft(draft, title) {
  if (!controlBot || !CONFIG.ACCOUNT_ASSISTANT_OWNER_CHAT_ID) {
    logger.warn("Account assistant draft skipped: owner chat id is not configured.");
    return;
  }

  storePendingDraft(draft);
  const notice = await controlBot.sendMessage(
    CONFIG.ACCOUNT_ASSISTANT_OWNER_CHAT_ID,
    buildDraftNotice(draft, title),
    buildDraftKeyboard(draft.id)
  );

  draft.noticeMessageId = notice.message_id;
}

async function sendAccountText(draft, text) {
  const message = trimText(text, CONFIG.ACCOUNT_ASSISTANT_MAX_TEXT_CHARS);

  if (!message) {
    throw new Error("Cannot send an empty account reply");
  }

  try {
    return await accountClient.sendMessage(draft.inputChat, {
      message,
      replyTo: draft.replyToMessageId,
      linkPreview: false
    });
  } catch (error) {
    if (!draft.replyToMessageId) {
      throw error;
    }

    return accountClient.sendMessage(draft.inputChat, {
      message,
      linkPreview: false
    });
  }
}

function createBusyError() {
  return Object.assign(new Error("Draft is already being sent"), { code: "DRAFT_BUSY" });
}

// Only one caller at a time may send a draft: a double tap must not message the contact twice.
function claimDraft(id) {
  const draft = pendingDrafts.get(id);

  if (!draft) {
    throw new Error("Draft not found or expired");
  }

  if (draft.sending) {
    throw createBusyError();
  }

  draft.sending = true;
  return draft;
}

async function sendPendingDraft(id, overrideText) {
  const draft = claimDraft(id);

  try {
    await sendAccountText(draft, overrideText || draft.reply);
  } catch (error) {
    draft.sending = false;
    throw error;
  }

  pendingDrafts.delete(id);
  await editOwnerNotice(draft, `Отправлено в аккаунт.\n\nID: ${draft.id}\nКому: ${draft.senderName}`);
}

function getRemainingThrottleMs(chatId) {
  const lastHandled = lastHandledAt.get(String(chatId)) || 0;
  return Math.max(0, CONFIG.ACCOUNT_ASSISTANT_MIN_INTERVAL_MS - (Date.now() - lastHandled));
}

function markHandled(chatId) {
  const key = String(chatId);

  lastHandledAt.delete(key);
  lastHandledAt.set(key, Date.now());

  if (lastHandledAt.size > MAX_TRACKED_CHATS) {
    lastHandledAt.delete(lastHandledAt.keys().next().value);
  }
}

// Messages that arrive too soon after the previous one are not dropped: they are collected
// and handled together as one draft once the interval has passed.
function addToBurst(entry, waitMs) {
  const key = String(entry.chatId);
  let burst = pendingBursts.get(key);

  if (!burst) {
    burst = { items: [], timer: null };
    burst.timer = setTimeout(() => flushBurst(key), Math.max(waitMs, 0));
    burst.timer.unref?.();
    pendingBursts.set(key, burst);
  }

  burst.items.push(entry);

  if (burst.items.length > MAX_BURST_ITEMS) {
    burst.items.shift();
  }
}

function flushBurst(key) {
  const burst = pendingBursts.get(key);

  pendingBursts.delete(key);

  if (!burst?.items.length) {
    return;
  }

  const last = burst.items[burst.items.length - 1];
  const combinedText = trimText(burst.items.map((item) => item.incomingText).join("\n"), MAX_INCOMING_TEXT_CHARS);

  dispatchEntry({ ...last, incomingText: combinedText })
    .catch((error) => logger.error("Account assistant task failed:", error));
}

function dispatchEntry(entry) {
  markHandled(entry.chatId);
  return enqueueChatTask(entry.chatId, () => processEntry(entry));
}

async function processEntry({ message, incomingText, profile, chatId }) {
  if (CONFIG.ACCOUNT_ASSISTANT_REPLY_DELAY_MS > 0) {
    await delay(CONFIG.ACCOUNT_ASSISTANT_REPLY_DELAY_MS);
  }

  const inputChat = await message.getInputChat();

  if (!inputChat) {
    logger.warn(`Account assistant skipped ${chatId}: could not resolve input chat.`);
    return;
  }

  let draft;

  try {
    draft = await draftAccountReply(`account:${chatId}`, incomingText, profile);
  } catch (error) {
    logger.error(`Account assistant could not draft a reply for ${chatId}:`, error);
    await notifyOwner(
      CONFIG.ACCOUNT_ASSISTANT_OWNER_CHAT_ID,
      `Не удалось подготовить черновик для ${profile.name}${profile.username ? ` (@${profile.username})` : ""}: сбой AI-запроса, подробности в логе.`
    );
    return;
  }

  const pendingDraft = {
    id: createDraftId(),
    chatId,
    senderId: profile.id,
    inputChat,
    replyTo: message.id,
    replyToMessageId: message.id,
    incomingText,
    reply: draft.reply,
    sendable: draft.sendable,
    reason: draft.reason,
    senderName: profile.name,
    username: profile.username,
    createdAt: new Date().toISOString()
  };

  const mode = getEffectiveMode();
  const autoRisk = mode === "auto" && draft.sendable ? findAutoSendRisk(draft.reply) : null;

  if (mode === "auto" && draft.sendable && !autoRisk) {
    await sendAccountText(pendingDraft, draft.reply);
    logger.info(`Account assistant auto-replied to ${chatId}`);
    await notifyOwner(
      CONFIG.ACCOUNT_ASSISTANT_OWNER_CHAT_ID,
      `Авто-ответ отправлен: ${profile.name}${profile.username ? ` (@${profile.username})` : ""}\n\nСообщение: ${trimText(incomingText, 300)}\nОтвет: ${trimText(draft.reply, 300)}`
    );
  } else if (mode === "dry-run") {
    await notifyOwnerAboutDraft(pendingDraft, "DRY-RUN: черновик без отправки");
  } else {
    pendingDraft.autoBlockedReason = autoRisk || "";
    await notifyOwnerAboutDraft(pendingDraft);
  }
}

async function processIncomingAccountMessage(event) {
  if (!accountAssistantEnabled || !started || !accountClient) {
    return;
  }

  const message = event.message;

  if (!message || message.out) {
    return;
  }

  const isPrivate = Boolean(event.isPrivate || message.isPrivate);

  if (accountAssistantPrivateOnly && !isPrivate) {
    return;
  }

  const incomingText = trimText(message.text || message.message || message.rawText || "", MAX_INCOMING_TEXT_CHARS);

  if (!incomingText) {
    return;
  }

  const sender = await message.getSender().catch(() => null);
  const profile = buildSenderProfile(sender, message);
  const chatId = profile.chatId || profile.id;

  // A message without an id cannot be deduplicated, so it is let through rather than mistaken for a repeat.
  const isRepeat = message.id ? !processedMessages.claim(`${chatId}:${message.id}`) : false;

  if (!chatId || !shouldHandlePeer(profile) || isRepeat) {
    return;
  }

  const entry = { message, incomingText, profile, chatId };
  const waitMs = getRemainingThrottleMs(chatId);

  if (waitMs > 0 || pendingBursts.has(String(chatId))) {
    addToBurst(entry, waitMs);
    return;
  }

  // Not awaited: a slow AI request for one contact must not hold up the Telegram update loop.
  dispatchEntry(entry).catch((error) => logger.error("Account assistant task failed:", error));
}

async function answerCallback(query, text, showAlert = false) {
  await controlBot.answerCallbackQuery(query.id, { text, show_alert: showAlert }).catch(() => {});
}

function describeSender(draft) {
  return `${draft.senderName}${draft.username ? ` (@${draft.username})` : ""}`;
}

async function handleAccountCallback(query) {
  const data = query.data || "";

  if (!data.startsWith("account:")) {
    return;
  }

  if (!isOwnerActor(query.message?.chat?.id, query.from?.id)) {
    await answerCallback(query, "Эта кнопка доступна только владельцу.");
    return;
  }

  const [, action, id] = data.split(":");
  const draft = pendingDrafts.get(id);

  try {
    if (!draft) {
      await answerCallback(query, "Черновик уже отправлен, отклонен или истек.");
      return;
    }

    if (draft.sending) {
      await answerCallback(query, "Черновик уже отправляется.");
      return;
    }

    if (action === "send") {
      await sendPendingDraft(id);
      await answerCallback(query, "Отправлено.");
      await notifyOwner(CONFIG.ACCOUNT_ASSISTANT_OWNER_CHAT_ID, [
        `Сообщение отправлено: ${describeSender(draft)}`,
        `ID: ${draft.id}`,
        `Chat ID: ${draft.chatId}`
      ].join("\n"));
      return;
    }

    if (action === "redraft") {
      const updatedDraft = await redraftPendingDraft(id);
      await answerCallback(query, "Черновик обновлён.");
      await notifyOwner(CONFIG.ACCOUNT_ASSISTANT_OWNER_CHAT_ID, [
        `Редрафт завершён для ${describeSender(updatedDraft)}`,
        `ID: ${updatedDraft.id}`,
        `Sendable: ${updatedDraft.sendable}`,
        `Причина: ${updatedDraft.reason}`
      ].join("\n"));
      return;
    }

    if (action === "drop") {
      pendingDrafts.delete(id);
      await editOwnerNotice(draft, `Отклонено.\n\nID: ${draft.id}\nОт: ${draft.senderName}`);
      await answerCallback(query, "Отклонено.");
      await notifyOwner(CONFIG.ACCOUNT_ASSISTANT_OWNER_CHAT_ID, [
        `Черновик отклонён: ${describeSender(draft)}`,
        `ID: ${draft.id}`,
        `Chat ID: ${draft.chatId}`
      ].join("\n"));
      return;
    }

    if (action === "block") {
      const blocked = blockDraftSender(draft);
      pendingDrafts.delete(id);
      await editOwnerNotice(draft, `Заблокирован отправитель.\n\nID: ${draft.id}\nОт: ${draft.senderName}`);
      await answerCallback(query, blocked ? "Отправитель заблокирован." : "Не удалось заблокировать.");
      await notifyOwner(CONFIG.ACCOUNT_ASSISTANT_OWNER_CHAT_ID, [
        `Отправитель заблокирован: ${describeSender(draft)}`,
        `ID: ${draft.id}`,
        `Chat ID: ${draft.chatId}`
      ].join("\n"));
      return;
    }
  } catch (error) {
    if (error.code === "DRAFT_BUSY") {
      await answerCallback(query, "Черновик уже отправляется.");
      return;
    }

    logger.error("Account assistant callback error:", error);
    await answerCallback(query, `Ошибка: ${error.message}`, true);
  }
}

async function sendStatus(chatId) {
  const status = getAccountAssistantStatus();
  await controlBot.sendMessage(chatId, [
    "Account assistant:",
    `enabled: ${status.enabled}`,
    `started: ${status.started}`,
    `connected: ${status.connected}`,
    `mode: ${describeModes()}`,
    `privateOnly: ${status.privateOnly}`,
    `pendingDrafts: ${status.pendingDrafts}`,
    `allowList: ${accountAssistantAllow.size ? formatPeerSet(accountAssistantAllow) : "all"}`,
    `blockList: ${accountAssistantBlock.size ? formatPeerSet(accountAssistantBlock) : "none"}`,
    `ownerChatIdConfigured: ${status.ownerChatIdConfigured}`
  ].join("\n"));
}

async function sendPendingList(chatId) {
  if (!pendingDrafts.size) {
    await controlBot.sendMessage(chatId, "Активных черновиков нет.");
    return;
  }

  const lines = Array.from(pendingDrafts.values()).map((draft) => {
    return `${draft.id}: ${describeSender(draft)}`;
  });

  await controlBot.sendMessage(chatId, trimText(["Черновики:", ...lines].join("\n")));
}

async function redraftPendingDraft(id) {
  const draft = pendingDrafts.get(id);

  if (!draft) {
    throw new Error("Draft not found or expired");
  }

  if (draft.sending) {
    throw createBusyError();
  }

  const senderProfile = {
    name: draft.senderName,
    username: draft.username,
    id: draft.senderId || draft.chatId
  };

  const newDraft = await draftAccountReply(`account:${draft.chatId}`, draft.incomingText, senderProfile);

  draft.reply = newDraft.reply;
  draft.sendable = newDraft.sendable;
  draft.reason = newDraft.reason;
  draft.updatedAt = new Date().toISOString();

  await editOwnerNotice(
    draft,
    `Redraft выполнен.\n\nID: ${draft.id}\nОт: ${draft.senderName}\nSendable: ${draft.sendable}`
  );

  return draft;
}

async function openConnection() {
  const missing = getMissingConfig();

  if (missing.length) {
    throw new Error(`Missing env: ${missing.join(", ")}`);
  }

  if (accountClient?.connected) {
    return accountClient;
  }

  const client = clientFactory();

  await client.connect();

  if (!(await client.checkAuthorization())) {
    await client.disconnect().catch(() => {});
    throw new Error("Account assistant session is not authorized. Run npm run telegram:session.");
  }

  client.addEventHandler(safeHandler("Account message handler", processIncomingAccountMessage), eventFilterFactory());
  accountClient = client;
  started = true;
  logger.info(`Account assistant connected in ${describeModes()} mode.`);
  return client;
}

// Two quick /account_enable taps must not open two connections with one session.
function connectAccountAssistant() {
  if (!connecting) {
    connecting = openConnection().finally(() => {
      connecting = null;
    });
  }

  return connecting;
}

async function disconnectClient() {
  const client = accountClient;

  accountClient = null;
  started = false;

  if (client) {
    await client.disconnect().catch(() => {});
  }
}

// The latest /account_enable or /account_disable wins. Opening the connection can take long, and a disable that
// arrives meanwhile finds no client to close: whoever finishes connecting afterwards must notice that and clean up.
async function enableAccountAssistant(chatId) {
  const generation = ++lifecycleGeneration;

  desiredEnabled = true;

  if (!accountClient) {
    await connectAccountAssistant();
  }

  if (generation !== lifecycleGeneration) {
    if (!desiredEnabled) {
      await disconnectClient();
    }

    return;
  }

  accountAssistantEnabled = true;
  warnIfAutoDowngraded();
  await controlBot.sendMessage(chatId, "Account assistant включён и готов к работе.");
}

async function disableAccountAssistant(chatId) {
  lifecycleGeneration += 1;
  desiredEnabled = false;
  accountAssistantEnabled = false;
  await disconnectClient();

  await controlBot.sendMessage(chatId, "Account assistant отключён.");
}

// Lets drafts that are being prepared finish (bounded), so their notices are not lost.
async function waitForAccountTasks(timeoutMs = TASKS_GRACE_MS) {
  await Promise.race([
    enqueueChatTask.whenIdle(),
    new Promise((resolve) => setTimeout(resolve, timeoutMs).unref?.())
  ]);
}

// Called on shutdown: releases the Telegram connection and timers. Messages that were held back by the
// throttle are already consumed from Telegram, so they get their draft now instead of being lost.
async function stopAccountAssistant() {
  for (const [key, burst] of Array.from(pendingBursts.entries())) {
    clearTimeout(burst.timer);
    flushBurst(key);
  }

  await waitForAccountTasks();
  await disconnectClient();
}

function registerControlBotHandlers(bot) {
  if (!bot || handlersRegistered) {
    return;
  }

  handlersRegistered = true;
  controlBot = bot;

  bot.on("callback_query", safeHandler("Account callback", handleAccountCallback));

  function ownerCommand(regexp, handler) {
    bot.onText(regexp, safeHandler(`Account command ${regexp.source.slice(0, 24)}`, async (msg, match) => {
      if (msg.from?.is_bot || !isAddressedToThisBot(msg.text) || !isOwnerActor(msg.chat.id, msg.from?.id)) {
        return;
      }

      await handler(msg, match);
    }));
  }

  ownerCommand(/^\/account_help(?:@\w+)?(?:\s|$)/, async (msg) => {
    await controlBot.sendMessage(msg.chat.id, buildAccountAssistantHelpText());
  });

  ownerCommand(/^\/account_status(?:@\w+)?(?:\s|$)/, async (msg) => {
    await sendStatus(msg.chat.id);
  });

  ownerCommand(/^\/account_config(?:@\w+)?(?:\s|$)/, async (msg) => {
    await controlBot.sendMessage(msg.chat.id, buildAccountAssistantConfigText());
  });

  ownerCommand(/^\/account_pending(?:@\w+)?(?:\s|$)/, async (msg) => {
    await sendPendingList(msg.chat.id);
  });

  ownerCommand(/^\/account_enable(?:@\w+)?(?:\s|$)/, async (msg) => {
    try {
      await enableAccountAssistant(msg.chat.id);
    } catch (error) {
      await controlBot.sendMessage(msg.chat.id, `Не удалось включить: ${error.message}`);
    }
  });

  ownerCommand(/^\/account_disable(?:@\w+)?(?:\s|$)/, async (msg) => {
    await disableAccountAssistant(msg.chat.id);
  });

  ownerCommand(/^\/account_mode(?:@\w+)?(?:\s+([a-z-]+))?\s*$/i, async (msg, match) => {
    const requestedMode = match[1];

    if (!requestedMode) {
      await controlBot.sendMessage(msg.chat.id, `Текущий режим: ${describeModes()}`);
      return;
    }

    if (!setAccountAssistantMode(requestedMode)) {
      await controlBot.sendMessage(msg.chat.id, "Режим не изменён. Допустимые: approval, auto, dry-run.");
      return;
    }

    warnIfAutoDowngraded();
    await controlBot.sendMessage(msg.chat.id, `Режим изменён на ${describeModes()}. Действует до перезапуска.`);
  });

  ownerCommand(/^\/account_private(?:@\w+)?(?:\s+(\S+))?\s*$/i, async (msg, match) => {
    const requested = match[1];

    if (!requested) {
      await controlBot.sendMessage(msg.chat.id, `privateOnly: ${accountAssistantPrivateOnly}`);
      return;
    }

    const value = parseBoolean(requested);

    if (value === null) {
      await controlBot.sendMessage(msg.chat.id, `Не понял «${trimText(requested, 30)}». Используй: /account_private true или /account_private false. Значение не изменено.`);
      return;
    }

    accountAssistantPrivateOnly = value;
    await controlBot.sendMessage(msg.chat.id, `Private-only установлен в ${accountAssistantPrivateOnly}. Действует до перезапуска.`);
  });

  ownerCommand(/^\/account_allow(?:@\w+)?\s+(@?[\S]+)\s*$/i, async (msg, match) => {
    if (!addPeerToSet(accountAssistantAllow, match[1])) {
      await controlBot.sendMessage(msg.chat.id, "Не удалось добавить разрешённый чат.");
      return;
    }

    await controlBot.sendMessage(msg.chat.id, `Добавлено в allow-list: ${normalizeToken(match[1])}`);
  });

  ownerCommand(/^\/account_unallow(?:@\w+)?\s+(@?[\S]+)\s*$/i, async (msg, match) => {
    if (!removePeerFromSet(accountAssistantAllow, match[1])) {
      await controlBot.sendMessage(msg.chat.id, "Элемент не найден в allow-list.");
      return;
    }

    await controlBot.sendMessage(msg.chat.id, `Удалено из allow-list: ${normalizeToken(match[1])}`);
  });

  ownerCommand(/^\/account_block(?:@\w+)?\s+(@?[\S]+)\s*$/i, async (msg, match) => {
    if (!addPeerToSet(accountAssistantBlock, match[1])) {
      await controlBot.sendMessage(msg.chat.id, "Не удалось добавить блокировку.");
      return;
    }

    await controlBot.sendMessage(msg.chat.id, `Добавлено в block-list: ${normalizeToken(match[1])}`);
  });

  ownerCommand(/^\/account_unblock(?:@\w+)?\s+(@?[\S]+)\s*$/i, async (msg, match) => {
    if (!removePeerFromSet(accountAssistantBlock, match[1])) {
      await controlBot.sendMessage(msg.chat.id, "Элемент не найден в block-list.");
      return;
    }

    await controlBot.sendMessage(msg.chat.id, `Удалено из block-list: ${normalizeToken(match[1])}`);
  });

  ownerCommand(/^\/account_message(?:@\w+)?\s+(@?[\S]+)\s+([\s\S]+)$/i, async (msg, match) => {
    try {
      await sendDirectAccountMessage(match[1], match[2]);
      await controlBot.sendMessage(msg.chat.id, `Сообщение отправлено: ${normalizeToken(match[1])}`);
    } catch (error) {
      await controlBot.sendMessage(msg.chat.id, `Не отправлено: ${error.message}`);
    }
  });

  ownerCommand(/^\/account_redraft(?:@\w+)?\s+([a-z0-9]+)\s*$/i, async (msg, match) => {
    try {
      const draft = await redraftPendingDraft(match[1]);
      await controlBot.sendMessage(msg.chat.id, `Черновик обновлён. Sendable: ${draft.sendable}.`);
    } catch (error) {
      await controlBot.sendMessage(msg.chat.id, `Не удалось редрафт: ${error.message}`);
    }
  });

  ownerCommand(/^\/account_send(?:@\w+)?\s+([a-z0-9]+)\s*$/i, async (msg, match) => {
    try {
      await sendPendingDraft(match[1]);
      await controlBot.sendMessage(msg.chat.id, "Отправлено.");
    } catch (error) {
      await controlBot.sendMessage(msg.chat.id, `Не отправил: ${error.message}`);
    }
  });

  ownerCommand(/^\/account_drop(?:@\w+)?\s+([a-z0-9]+)\s*$/i, async (msg, match) => {
    const id = match[1];
    const draft = pendingDrafts.get(id);

    if (draft?.sending) {
      await controlBot.sendMessage(msg.chat.id, "Черновик уже отправляется.");
      return;
    }

    pendingDrafts.delete(id);

    if (draft) {
      await editOwnerNotice(draft, `Отклонено.\n\nID: ${draft.id}\nОт: ${draft.senderName}`);
    }

    await controlBot.sendMessage(msg.chat.id, draft ? "Отклонено." : "Черновик не найден.");
  });

  ownerCommand(/^\/account_reply(?:@\w+)?\s+([a-z0-9]+)\s+([\s\S]+)$/i, async (msg, match) => {
    try {
      await sendPendingDraft(match[1], match[2]);
      await controlBot.sendMessage(msg.chat.id, "Твой текст отправлен.");
    } catch (error) {
      await controlBot.sendMessage(msg.chat.id, `Не отправил: ${error.message}`);
    }
  });
}

// `deps` lets tests replace the Telegram client; production passes nothing.
async function startAccountAssistant(bot, deps = {}) {
  if (deps.createClient) {
    clientFactory = deps.createClient;
  }

  if (deps.createEventFilter) {
    eventFilterFactory = deps.createEventFilter;
  }

  registerControlBotHandlers(bot);

  if (!accountAssistantEnabled) {
    logger.info("Account assistant disabled. Set ACCOUNT_ASSISTANT_ENABLED=true to enable it.");
    return null;
  }

  warnIfAutoDowngraded();

  if (getEffectiveMode() === "auto" && !CONFIG.ACCOUNT_ASSISTANT_OWNER_CHAT_ID) {
    logger.warn("Account assistant auto mode has no owner chat id; unsafe drafts will be skipped silently.");
  }

  try {
    await connectAccountAssistant();
  } catch (error) {
    logger.warn(`Account assistant not started: ${error.message}`);
    return null;
  }

  return accountClient;
}

module.exports = {
  startAccountAssistant,
  stopAccountAssistant,
  waitForAccountTasks,
  getAccountAssistantStatus,
  findAutoSendRisk
};
