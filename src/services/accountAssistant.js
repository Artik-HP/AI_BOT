const { TelegramClient } = require("telegram");
const { StringSession } = require("telegram/sessions");
const { NewMessage } = require("telegram/events");
const CONFIG = require("../config");
const logger = require("../utils/logger");
const { draftAccountReply } = require("./openrouter");

const VALID_MODES = new Set(["approval", "auto", "dry-run"]);
const TELEGRAM_MESSAGE_LIMIT = 4096;

let accountClient = null;
let controlBot = null;
let started = false;
let handlersRegistered = false;
let accountAssistantEnabled = Boolean(CONFIG.ACCOUNT_ASSISTANT_ENABLED);
let accountAssistantMode = String(CONFIG.ACCOUNT_ASSISTANT_MODE || "approval").trim().toLowerCase();
let accountAssistantPrivateOnly = Boolean(CONFIG.ACCOUNT_ASSISTANT_PRIVATE_ONLY);
const accountAssistantAllow = new Set(CONFIG.ACCOUNT_ASSISTANT_ALLOW_CHATS.map(normalizeToken));
const accountAssistantBlock = new Set(CONFIG.ACCOUNT_ASSISTANT_BLOCK_CHATS.map(normalizeToken));

const pendingDrafts = new Map();
const chatQueues = new Map();
const lastHandledAt = new Map();
const processedMessages = new Set();

if (!VALID_MODES.has(accountAssistantMode)) {
  accountAssistantMode = "approval";
}

function getAccountAssistantMode() {
  return accountAssistantMode;
}

function getAccountAssistantStatus() {
  return {
    enabled: accountAssistantEnabled,
    started,
    connected: Boolean(accountClient),
    mode: getAccountAssistantMode(),
    privateOnly: accountAssistantPrivateOnly,
    pendingDrafts: pendingDrafts.size,
    allowList: Array.from(accountAssistantAllow).join(", ") || "all",
    blockList: Array.from(accountAssistantBlock).join(", ") || "none",
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

  if (getAccountAssistantMode() !== "auto" && !CONFIG.ACCOUNT_ASSISTANT_OWNER_CHAT_ID) {
    missing.push("ACCOUNT_ASSISTANT_OWNER_CHAT_ID");
  }

  return missing;
}

function normalizeToken(value) {
  return String(value || "").trim().replace(/^@/, "").toLowerCase();
}
function normalizeId(value) {
  return value == null ? "" : String(value);
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

function getPeerKeys(profile) {
  return [
    profile.chatId,
    profile.id,
    profile.username,
    profile.username ? `@${profile.username}` : "",
    profile.name
  ].map(normalizeToken).filter(Boolean);
}

function listHasPeer(list, profile) {
  if (!Array.isArray(list) || list.length === 0) {
    return false;
  }

  const keys = new Set(getPeerKeys(profile));
  return list.map(normalizeToken).some((item) => keys.has(item));
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

function parseBooleanValue(value) {
  if (typeof value === "boolean") {
    return value;
  }

  return ["1", "true", "yes", "y", "on"]
    .includes(String(value || "").trim().toLowerCase());
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

  if (/^-?\d+$/.test(raw)) {
    return Number(raw);
  }

  return raw.startsWith("@") ? raw : raw;
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
    "/account_config — показать текущие настройки"
  ].join("\n");
}

function buildAccountAssistantConfigText() {
  return [
    "Account assistant конфигурация:",
    `enabled: ${accountAssistantEnabled}`,
    `mode: ${getAccountAssistantMode()}`,
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

function enqueueChatTask(chatId, task) {
  const key = String(chatId);
  const previous = chatQueues.get(key) || Promise.resolve();
  const next = previous
    .catch(() => {})
    .then(task)
    .finally(() => {
      if (chatQueues.get(key) === next) {
        chatQueues.delete(key);
      }
    });

  chatQueues.set(key, next);
  return next;
}

function claimAccountMessage(chatId, messageId) {
  if (!chatId || !messageId) {
    return true;
  }

  const key = `${chatId}:${messageId}`;

  if (processedMessages.has(key)) {
    return false;
  }

  processedMessages.add(key);
  setTimeout(() => processedMessages.delete(key), CONFIG.PROCESSED_MESSAGE_TTL_MS).unref?.();
  return true;
}

function createDraftId() {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

function isOwnerChat(chatId) {
  return Boolean(
    CONFIG.ACCOUNT_ASSISTANT_OWNER_CHAT_ID &&
    String(chatId) === String(CONFIG.ACCOUNT_ASSISTANT_OWNER_CHAT_ID)
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
    "",
    `Свой текст: /account_reply ${draft.id} твой ответ`
  ].join("\n");

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

function blockDraftSender(draft) {
  if (!draft) {
    return false;
  }

  const target = draft.username || draft.chatId;

  if (!target) {
    return false;
  }

  return addPeerToSet(accountAssistantBlock, target);
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

async function sendPendingDraft(id, overrideText) {
  const draft = pendingDrafts.get(id);

  if (!draft) {
    throw new Error("Draft not found or expired");
  }

  await sendAccountText(draft, overrideText || draft.reply);
  pendingDrafts.delete(id);
  await editOwnerNotice(draft, `Отправлено в аккаунт.\n\nID: ${draft.id}\nКому: ${draft.senderName}`);
}

function shouldThrottleChat(chatId) {
  const lastHandled = lastHandledAt.get(String(chatId)) || 0;
  return Date.now() - lastHandled < CONFIG.ACCOUNT_ASSISTANT_MIN_INTERVAL_MS;
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

  const incomingText = trimText(message.text || message.message || message.rawText || "", 3000);

  if (!incomingText) {
    return;
  }

  const sender = await message.getSender().catch(() => null);
  const profile = buildSenderProfile(sender, message);
  const chatId = profile.chatId || profile.id;

  if (!chatId || !shouldHandlePeer(profile) || !claimAccountMessage(chatId, message.id)) {
    return;
  }

  await enqueueChatTask(chatId, async () => {
    if (shouldThrottleChat(chatId)) {
      return;
    }

    if (CONFIG.ACCOUNT_ASSISTANT_REPLY_DELAY_MS > 0) {
      await delay(CONFIG.ACCOUNT_ASSISTANT_REPLY_DELAY_MS);
    }

    const inputChat = await message.getInputChat();

    if (!inputChat) {
      logger.warn(`Account assistant skipped ${chatId}: could not resolve input chat.`);
      return;
    }

    const draft = await draftAccountReply(`account:${chatId}`, incomingText, profile);
    const pendingDraft = {
      id: createDraftId(),
      chatId,
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

    const mode = getAccountAssistantMode();

    if (mode === "auto" && draft.sendable) {
      await sendAccountText(pendingDraft, draft.reply);
      logger.info(`Account assistant auto-replied to ${chatId}`);
    } else if (mode === "dry-run") {
      await notifyOwnerAboutDraft(pendingDraft, "DRY-RUN: черновик без отправки");
    } else {
      await notifyOwnerAboutDraft(pendingDraft);
    }

    lastHandledAt.set(String(chatId), Date.now());
  });
}

async function handleAccountCallback(query) {
  const data = query.data || "";

  if (!data.startsWith("account:")) {
    return;
  }

  if (!isOwnerChat(query.message?.chat?.id)) {
    await controlBot.answerCallbackQuery(query.id, {
      text: "Эта кнопка доступна только владельцу.",
      show_alert: false
    }).catch(() => {});
    return;
  }

  const [, action, id] = data.split(":");
  const draft = pendingDrafts.get(id);

  try {
    if (!draft) {
      await controlBot.answerCallbackQuery(query.id, {
        text: "Черновик уже отправлен, отклонен или истек.",
        show_alert: false
      });
      return;
    }

    if (action === "send") {
      await sendPendingDraft(id);
      await controlBot.answerCallbackQuery(query.id, {
        text: "Отправлено.",
        show_alert: false
      });
      await notifyOwner(CONFIG.ACCOUNT_ASSISTANT_OWNER_CHAT_ID, [
        `Сообщение отправлено: ${draft.senderName}${draft.username ? ` (@${draft.username})` : ""}`,
        `ID: ${draft.id}`,
        `Chat ID: ${draft.chatId}`
      ].join("\n"));
      return;
    }

    if (action === "redraft") {
      const updatedDraft = await redraftPendingDraft(id);
      await controlBot.answerCallbackQuery(query.id, {
        text: "Черновик обновлён.",
        show_alert: false
      });
      await notifyOwner(CONFIG.ACCOUNT_ASSISTANT_OWNER_CHAT_ID, [
        `Редрафт завершён для ${updatedDraft.senderName}${updatedDraft.username ? ` (@${updatedDraft.username})` : ""}`,
        `ID: ${updatedDraft.id}`,
        `Sendable: ${updatedDraft.sendable}`,
        `Причина: ${updatedDraft.reason}`
      ].join("\n"));
      return;
    }

    if (action === "drop") {
      pendingDrafts.delete(id);
      await editOwnerNotice(draft, `Отклонено.\n\nID: ${draft.id}\nОт: ${draft.senderName}`);
      await controlBot.answerCallbackQuery(query.id, {
        text: "Отклонено.",
        show_alert: false
      });
      await notifyOwner(CONFIG.ACCOUNT_ASSISTANT_OWNER_CHAT_ID, [
        `Черновик отклонён: ${draft.senderName}${draft.username ? ` (@${draft.username})` : ""}`,
        `ID: ${draft.id}`,
        `Chat ID: ${draft.chatId}`
      ].join("\n"));
      return;
    }

    if (action === "block") {
      const blocked = blockDraftSender(draft);
      pendingDrafts.delete(id);
      await editOwnerNotice(draft, `Заблокирован отправитель.\n\nID: ${draft.id}\nОт: ${draft.senderName}`);
      await controlBot.answerCallbackQuery(query.id, {
        text: blocked ? "Отправитель заблокирован." : "Не удалось заблокировать.",
        show_alert: false
      });
      await notifyOwner(CONFIG.ACCOUNT_ASSISTANT_OWNER_CHAT_ID, [
        `Отправитель заблокирован: ${draft.senderName}${draft.username ? ` (@${draft.username})` : ""}`,
        `ID: ${draft.id}`,
        `Chat ID: ${draft.chatId}`
      ].join("\n"));
      return;
    }
  } catch (error) {
    logger.error("Account assistant callback error:", error.message);
    await controlBot.answerCallbackQuery(query.id, {
      text: `Ошибка: ${error.message}`,
      show_alert: true
    }).catch(() => {});
  }
}

async function sendStatus(chatId) {
  const status = getAccountAssistantStatus();
  await controlBot.sendMessage(chatId, [
    "Account assistant:",
    `enabled: ${status.enabled}`,
    `started: ${status.started}`,
    `connected: ${status.connected}`,
    `mode: ${status.mode}`,
    `privateOnly: ${status.privateOnly}`,
    `pendingDrafts: ${status.pendingDrafts}`,
    `allowList: ${status.allowList}`,
    `blockList: ${status.blockList}`,
    `ownerChatIdConfigured: ${status.ownerChatIdConfigured}`
  ].join("\n"));
}

async function sendPendingList(chatId) {
  if (!pendingDrafts.size) {
    await controlBot.sendMessage(chatId, "Активных черновиков нет.");
    return;
  }

  const lines = Array.from(pendingDrafts.values()).map((draft) => {
    return `${draft.id}: ${draft.senderName}${draft.username ? ` (@${draft.username})` : ""}`;
  });

  await controlBot.sendMessage(chatId, trimText(["Черновики:", ...lines].join("\n")));
}

async function redraftPendingDraft(id) {
  const draft = pendingDrafts.get(id);

  if (!draft) {
    throw new Error("Draft not found or expired");
  }

  const senderProfile = {
    name: draft.senderName,
    username: draft.username,
    id: draft.chatId
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

async function connectAccountAssistant() {
  const missing = getMissingConfig();

  if (missing.length) {
    throw new Error(`Missing env: ${missing.join(", ")}`);
  }

  if (accountClient && accountClient.isConnected) {
    return accountClient;
  }

  accountClient = new TelegramClient(
    new StringSession(CONFIG.TELEGRAM_STRING_SESSION),
    CONFIG.TELEGRAM_API_ID,
    CONFIG.TELEGRAM_API_HASH,
    { connectionRetries: 5 }
  );

  await accountClient.connect();

  if (!(await accountClient.checkAuthorization())) {
    accountClient = null;
    throw new Error("Account assistant session is not authorized. Run npm run telegram:session.");
  }

  accountClient.addEventHandler(processIncomingAccountMessage, new NewMessage({ incoming: true }));
  started = true;
  logger.info(`Account assistant connected in ${getAccountAssistantMode()} mode.`);
  return accountClient;
}

async function enableAccountAssistant(chatId) {
  accountAssistantEnabled = true;

  if (!accountClient) {
    await connectAccountAssistant();
  }

  await controlBot.sendMessage(chatId, "Account assistant включён и готов к работе.");
}

async function disableAccountAssistant(chatId) {
  accountAssistantEnabled = false;

  if (accountClient) {
    await accountClient.disconnect().catch(() => {});
    accountClient = null;
    started = false;
  }

  await controlBot.sendMessage(chatId, "Account assistant отключён.");
}

function registerControlBotHandlers(bot) {
  if (!bot || handlersRegistered) {
    return;
  }

  handlersRegistered = true;
  controlBot = bot;

  bot.on("callback_query", handleAccountCallback);

  bot.onText(/^\/account_help(?:@\w+)?(?:\s|$)/, async (msg) => {
    if (isOwnerChat(msg.chat.id)) {
      await controlBot.sendMessage(msg.chat.id, buildAccountAssistantHelpText());
    }
  });

  bot.onText(/^\/account_status(?:@\w+)?(?:\s|$)/, async (msg) => {
    if (isOwnerChat(msg.chat.id)) {
      await sendStatus(msg.chat.id);
    }
  });

  bot.onText(/^\/account_config(?:@\w+)?(?:\s|$)/, async (msg) => {
    if (isOwnerChat(msg.chat.id)) {
      await controlBot.sendMessage(msg.chat.id, buildAccountAssistantConfigText());
    }
  });

  bot.onText(/^\/account_pending(?:@\w+)?(?:\s|$)/, async (msg) => {
    if (isOwnerChat(msg.chat.id)) {
      await sendPendingList(msg.chat.id);
    }
  });

  bot.onText(/^\/account_enable(?:@\w+)?(?:\s|$)/, async (msg) => {
    if (!isOwnerChat(msg.chat.id)) {
      return;
    }

    try {
      await enableAccountAssistant(msg.chat.id);
    } catch (error) {
      await controlBot.sendMessage(msg.chat.id, `Не удалось включить: ${error.message}`);
    }
  });

  bot.onText(/^\/account_disable(?:@\w+)?(?:\s|$)/, async (msg) => {
    if (!isOwnerChat(msg.chat.id)) {
      return;
    }

    await disableAccountAssistant(msg.chat.id);
  });

  bot.onText(/^\/account_mode(?:@\w+)?(?:\s+([a-z-]+))?\s*$/i, async (msg, match) => {
    if (!isOwnerChat(msg.chat.id)) {
      return;
    }

    const requestedMode = match[1];

    if (!requestedMode) {
      await controlBot.sendMessage(msg.chat.id, `Текущий режим: ${getAccountAssistantMode()}`);
      return;
    }

    if (!setAccountAssistantMode(requestedMode)) {
      await controlBot.sendMessage(msg.chat.id, `Режим не изменён. Допустимые: approval, auto, dry-run.`);
      return;
    }

    await controlBot.sendMessage(msg.chat.id, `Режим изменён на ${getAccountAssistantMode()}.`);
  });

  bot.onText(/^\/account_private(?:@\w+)?(?:\s+([a-z0-9]+))?\s*$/i, async (msg, match) => {
    if (!isOwnerChat(msg.chat.id)) {
      return;
    }

    const requested = match[1];

    if (!requested) {
      await controlBot.sendMessage(msg.chat.id, `privateOnly: ${accountAssistantPrivateOnly}`);
      return;
    }

    accountAssistantPrivateOnly = parseBooleanValue(requested);
    await controlBot.sendMessage(msg.chat.id, `Private-only установлен в ${accountAssistantPrivateOnly}.`);
  });

  bot.onText(/^\/account_allow(?:@\w+)?\s+(@?[\S]+)\s*$/i, async (msg, match) => {
    if (!isOwnerChat(msg.chat.id)) {
      return;
    }

    if (!addPeerToSet(accountAssistantAllow, match[1])) {
      await controlBot.sendMessage(msg.chat.id, "Не удалось добавить разрешённый чат.");
      return;
    }

    await controlBot.sendMessage(msg.chat.id, `Добавлено в allow-list: ${normalizeToken(match[1])}`);
  });

  bot.onText(/^\/account_unallow(?:@\w+)?\s+(@?[\S]+)\s*$/i, async (msg, match) => {
    if (!isOwnerChat(msg.chat.id)) {
      return;
    }

    if (!removePeerFromSet(accountAssistantAllow, match[1])) {
      await controlBot.sendMessage(msg.chat.id, "Элемент не найден в allow-list.");
      return;
    }

    await controlBot.sendMessage(msg.chat.id, `Удалено из allow-list: ${normalizeToken(match[1])}`);
  });

  bot.onText(/^\/account_block(?:@\w+)?\s+(@?[\S]+)\s*$/i, async (msg, match) => {
    if (!isOwnerChat(msg.chat.id)) {
      return;
    }

    if (!addPeerToSet(accountAssistantBlock, match[1])) {
      await controlBot.sendMessage(msg.chat.id, "Не удалось добавить блокировку.");
      return;
    }

    await controlBot.sendMessage(msg.chat.id, `Добавлено в block-list: ${normalizeToken(match[1])}`);
  });

  bot.onText(/^\/account_unblock(?:@\w+)?\s+(@?[\S]+)\s*$/i, async (msg, match) => {
    if (!isOwnerChat(msg.chat.id)) {
      return;
    }

    if (!removePeerFromSet(accountAssistantBlock, match[1])) {
      await controlBot.sendMessage(msg.chat.id, "Элемент не найден в block-list.");
      return;
    }

    await controlBot.sendMessage(msg.chat.id, `Удалено из block-list: ${normalizeToken(match[1])}`);
  });

  bot.onText(/^\/account_message(?:@\w+)?\s+(@?[\S]+)\s+([\s\S]+)$/i, async (msg, match) => {
    if (!isOwnerChat(msg.chat.id)) {
      return;
    }

    try {
      await sendDirectAccountMessage(match[1], match[2]);
      await controlBot.sendMessage(msg.chat.id, `Сообщение отправлено: ${normalizeToken(match[1])}`);
    } catch (error) {
      await controlBot.sendMessage(msg.chat.id, `Не отправлено: ${error.message}`);
    }
  });

  bot.onText(/^\/account_redraft(?:@\w+)?\s+([a-z0-9]+)\s*$/i, async (msg, match) => {
    if (!isOwnerChat(msg.chat.id)) {
      return;
    }

    try {
      const draft = await redraftPendingDraft(match[1]);
      await controlBot.sendMessage(msg.chat.id, `Черновик обновлён. Sendable: ${draft.sendable}.`);
    } catch (error) {
      await controlBot.sendMessage(msg.chat.id, `Не удалось редрафт: ${error.message}`);
    }
  });

  bot.onText(/^\/account_send(?:@\w+)?\s+([a-z0-9]+)\s*$/i, async (msg, match) => {
    if (!isOwnerChat(msg.chat.id)) {
      return;
    }

    try {
      await sendPendingDraft(match[1]);
      await controlBot.sendMessage(msg.chat.id, "Отправлено.");
    } catch (error) {
      await controlBot.sendMessage(msg.chat.id, `Не отправил: ${error.message}`);
    }
  });

  bot.onText(/^\/account_drop(?:@\w+)?\s+([a-z0-9]+)\s*$/i, async (msg, match) => {
    if (!isOwnerChat(msg.chat.id)) {
      return;
    }

    const id = match[1];
    const draft = pendingDrafts.get(id);
    pendingDrafts.delete(id);

    if (draft) {
      await editOwnerNotice(draft, `Отклонено.\n\nID: ${draft.id}\nОт: ${draft.senderName}`);
    }

    await controlBot.sendMessage(msg.chat.id, draft ? "Отклонено." : "Черновик не найден.");
  });

  bot.onText(/^\/account_reply(?:@\w+)?\s+([a-z0-9]+)\s+([\s\S]+)$/i, async (msg, match) => {
    if (!isOwnerChat(msg.chat.id)) {
      return;
    }

    try {
      await sendPendingDraft(match[1], match[2]);
      await controlBot.sendMessage(msg.chat.id, "Твой текст отправлен.");
    } catch (error) {
      await controlBot.sendMessage(msg.chat.id, `Не отправил: ${error.message}`);
    }
  });
}

async function startAccountAssistant(bot) {
  registerControlBotHandlers(bot);

  if (!accountAssistantEnabled) {
    logger.info("Account assistant disabled. Set ACCOUNT_ASSISTANT_ENABLED=true to enable it.");
    return null;
  }

  if (accountAssistantMode === "auto" && !CONFIG.ACCOUNT_ASSISTANT_OWNER_CHAT_ID) {
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
  getAccountAssistantStatus
};
