const { TelegramClient } = require("telegram");
const { StringSession } = require("telegram/sessions");
const { NewMessage } = require("telegram/events");
const CONFIG = require("../config");
const logger = require("../utils/logger");
const { draftAccountReply } = require("./openrouter");
const { getStore } = require("../commandSystem/store");
const { fail } = require("../commandSystem/tools");
const { rememberTurn } = require("./memory");
const { splitTelegramMessage } = require("./telegram");

const VALID_MODES = new Set(["approval", "auto", "dry-run"]);
const TELEGRAM_MESSAGE_LIMIT = 4096;

let accountClient = null;
let controlBot = null;
let started = false;
let handlersRegistered = false;
let accountAssistantEnabled = Boolean(CONFIG.ACCOUNT_ASSISTANT_ENABLED);
let accountAssistantMode = String(CONFIG.ACCOUNT_ASSISTANT_MODE || "approval")
  .trim()
  .toLowerCase();
let accountAssistantPrivateOnly = Boolean(
  CONFIG.ACCOUNT_ASSISTANT_PRIVATE_ONLY,
);
const accountAssistantAllow = new Set(
  CONFIG.ACCOUNT_ASSISTANT_ALLOW_CHATS.map(normalizeToken),
);
const accountAssistantBlock = new Set(
  CONFIG.ACCOUNT_ASSISTANT_BLOCK_CHATS.map(normalizeToken),
);

const pendingDrafts = new Map();
const chatQueues = new Map();
const lastHandledAt = new Map();
const processedMessages = new Set();
const savedSettings = getStore().get("account:settings", null);
if (savedSettings) {
  accountAssistantEnabled = savedSettings.enabled;
  accountAssistantMode = savedSettings.mode;
  accountAssistantPrivateOnly = savedSettings.privateOnly;
  accountAssistantAllow.clear();
  for (const peer of savedSettings.allow) accountAssistantAllow.add(peer);
  accountAssistantBlock.clear();
  for (const peer of savedSettings.block) accountAssistantBlock.add(peer);
}
for (const draft of getStore().get("account:drafts", [])) {
  if (
    Date.parse(draft.createdAt) + CONFIG.ACCOUNT_ASSISTANT_DRAFT_TTL_MS >
    Date.now()
  )
    pendingDrafts.set(draft.id, {
      ...draft,
      deliveryUncertain: Boolean(draft.sending || draft.deliveryUncertain),
      sending: false,
      redrafting: false,
    });
}
function persistSettings() {
  getStore().set("account:settings", {
    enabled: accountAssistantEnabled,
    mode: accountAssistantMode,
    privateOnly: accountAssistantPrivateOnly,
    allow: [...accountAssistantAllow],
    block: [...accountAssistantBlock],
  });
}
function persistDrafts() {
  getStore().set(
    "account:drafts",
    [...pendingDrafts.values()].map(({ inputChat, ...draft }) => draft),
  );
}

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
    connected: Boolean(accountClient?.isConnected),
    mode: getAccountAssistantMode(),
    privateOnly: accountAssistantPrivateOnly,
    pendingDrafts: pendingDrafts.size,
    allowList: Array.from(accountAssistantAllow).join(", ") || "all",
    blockList: Array.from(accountAssistantBlock).join(", ") || "none",
    ownerChatIdConfigured: Boolean(CONFIG.ACCOUNT_ASSISTANT_OWNER_CHAT_ID),
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

  if (
    getAccountAssistantMode() !== "auto" &&
    !CONFIG.ACCOUNT_ASSISTANT_OWNER_CHAT_ID
  ) {
    missing.push("ACCOUNT_ASSISTANT_OWNER_CHAT_ID");
  }

  return missing;
}

function normalizeToken(value) {
  return String(value || "")
    .trim()
    .replace(/^@/, "")
    .toLowerCase();
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
    isBot: Boolean(sender?.bot),
  };
}

function getPeerKeys(profile) {
  return [
    profile.chatId,
    profile.id,
    profile.username,
    profile.username ? `@${profile.username}` : "",
    profile.name,
  ]
    .map(normalizeToken)
    .filter(Boolean);
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
  const cleanMode = String(mode || "")
    .trim()
    .toLowerCase();

  if (!VALID_MODES.has(cleanMode)) {
    return false;
  }

  accountAssistantMode = cleanMode;
  persistSettings();
  return true;
}

function addPeerToSet(set, value) {
  const token = normalizeToken(String(value || ""));

  if (!token) {
    return false;
  }

  set.add(token);
  persistSettings();
  return true;
}

function removePeerFromSet(set, value) {
  const token = normalizeToken(String(value || ""));

  if (!token) {
    return false;
  }

  const removed = set.delete(token);
  persistSettings();
  return removed;
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
    "/account_config — показать текущие настройки",
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
    `owner chat id configured: ${Boolean(CONFIG.ACCOUNT_ASSISTANT_OWNER_CHAT_ID)}`,
  ].join("\n");
}

async function sendDirectAccountMessage(chatId, text) {
  if (!accountClient) {
    fail(
      "Аккаунт не подключён. Используй /account_enable и проверь TELEGRAM_STRING_SESSION.",
    );
  }

  const peer = resolvePeer(chatId);

  if (!peer) {
    throw new Error("Неверный chatId или @username");
  }

  if (!String(text || "").trim()) fail("Нельзя отправить пустой текст.");
  let sent;
  for (const chunk of splitTelegramMessage(text))
    sent = await accountClient.sendMessage(peer, {
      message: chunk,
      linkPreview: false,
    });
  return sent;
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
  setTimeout(
    () => processedMessages.delete(key),
    CONFIG.PROCESSED_MESSAGE_TTL_MS,
  ).unref?.();
  return true;
}

function createDraftId() {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

function isOwnerMessage(msg) {
  const ownerId = String(CONFIG.ACCOUNT_ASSISTANT_OWNER_CHAT_ID || "");
  return Boolean(
    ownerId &&
    msg?.chat?.type === "private" &&
    String(msg.chat.id || "") === ownerId &&
    String(msg.from?.id || "") === ownerId,
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
    `Свой текст: /account_reply ${draft.id} твой ответ`,
  ].join("\n");

  return trimText(text, TELEGRAM_MESSAGE_LIMIT);
}

function buildDraftKeyboard(id) {
  return {
    reply_markup: {
      inline_keyboard: [
        [
          { text: "Отправить", callback_data: `account:send:${id}` },
          { text: "Редрафт", callback_data: `account:redraft:${id}` },
        ],
        [
          { text: "Отклонить", callback_data: `account:drop:${id}` },
          {
            text: "Заблокировать отправителя",
            callback_data: `account:block:${id}`,
          },
        ],
      ],
    },
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
  if (
    !controlBot ||
    !draft.noticeMessageId ||
    !CONFIG.ACCOUNT_ASSISTANT_OWNER_CHAT_ID
  ) {
    return;
  }

  await controlBot
    .editMessageText(trimText(text, TELEGRAM_MESSAGE_LIMIT), {
      chat_id: CONFIG.ACCOUNT_ASSISTANT_OWNER_CHAT_ID,
      message_id: draft.noticeMessageId,
    })
    .catch(() => {});
}

async function notifyOwner(chatId, text) {
  if (!controlBot || !chatId) {
    return;
  }

  await controlBot
    .sendMessage(chatId, trimText(text, TELEGRAM_MESSAGE_LIMIT))
    .catch(() => {});
}

function storePendingDraft(draft) {
  pendingDrafts.set(draft.id, draft);
  persistDrafts();
  setTimeout(() => {
    pendingDrafts.delete(draft.id);
    persistDrafts();
  }, CONFIG.ACCOUNT_ASSISTANT_DRAFT_TTL_MS).unref?.();
}

async function notifyOwnerAboutDraft(draft, title) {
  if (!controlBot || !CONFIG.ACCOUNT_ASSISTANT_OWNER_CHAT_ID) {
    logger.warn(
      "Account assistant draft skipped: owner chat id is not configured.",
    );
    return;
  }

  storePendingDraft(draft);
  const notice = await controlBot.sendMessage(
    CONFIG.ACCOUNT_ASSISTANT_OWNER_CHAT_ID,
    buildDraftNotice(draft, title),
    buildDraftKeyboard(draft.id),
  );

  draft.noticeMessageId = notice.message_id;
  persistDrafts();
}

async function sendAccountText(draft, text) {
  if (!accountClient?.isConnected)
    fail(
      "Аккаунт не подключён. Используй /account_enable и проверь TELEGRAM_API_ID, TELEGRAM_API_HASH, TELEGRAM_STRING_SESSION.",
    );
  const message = trimText(text, CONFIG.ACCOUNT_ASSISTANT_MAX_TEXT_CHARS);

  if (!message) {
    throw new Error("Cannot send an empty account reply");
  }

  const inputChat =
    draft.inputChat ||
    (await accountClient.getInputEntity(resolvePeer(draft.chatId)));
  try {
    return await accountClient.sendMessage(inputChat, {
      message,
      replyTo: draft.replyToMessageId,
      linkPreview: false,
    });
  } catch (error) {
    if (
      !draft.replyToMessageId ||
      !/REPLY_TO|MSG_ID_INVALID/.test(error.errorMessage || "")
    ) {
      throw error;
    }

    return accountClient.sendMessage(inputChat, {
      message,
      linkPreview: false,
    });
  }
}

async function sendPendingDraft(id, overrideText) {
  const draft = pendingDrafts.get(id);

  if (
    !draft ||
    Date.parse(draft.createdAt) + CONFIG.ACCOUNT_ASSISTANT_DRAFT_TTL_MS <=
      Date.now()
  ) {
    fail("Черновик не найден или истёк.");
  }
  if (draft.deliveryUncertain)
    fail(
      "Отправка была прервана перезапуском. Проверь целевой чат; повторная отправка этого черновика заблокирована.",
    );
  if (
    (overrideText || draft.reply).length >
    CONFIG.ACCOUNT_ASSISTANT_MAX_TEXT_CHARS
  )
    fail(
      `Ответ превышает лимит ${CONFIG.ACCOUNT_ASSISTANT_MAX_TEXT_CHARS} символов.`,
    );

  if (draft.sending || draft.redrafting) {
    fail("Черновик уже обрабатывается.");
  }

  draft.sending = true;
  persistDrafts();

  try {
    await sendAccountText(draft, overrideText || draft.reply);
    pendingDrafts.delete(id);
    persistDrafts();
    try {
      rememberTurn(
        `account:${draft.chatId}`,
        draft.incomingText,
        overrideText || draft.reply,
        draft.id,
      );
    } catch (error) {
      logger.error("Account history persistence:", error.code || error.name);
    }
    await editOwnerNotice(
      draft,
      `Отправлено в аккаунт.\n\nID: ${draft.id}\nКому: ${draft.senderName}`,
    );
  } catch (error) {
    draft.sending = false;
    persistDrafts();
    throw error;
  }
}

function shouldThrottleChat(chatId) {
  const lastHandled = lastHandledAt.get(String(chatId)) || 0;
  return Date.now() - lastHandled < CONFIG.ACCOUNT_ASSISTANT_MIN_INTERVAL_MS;
}

async function processIncomingAccountMessage(event) {
  const access = require("./access").getAccessGate();
  if (
    access.enabled &&
    !access.authorized(
      {
        chat: { id: CONFIG.ACCOUNT_ASSISTANT_OWNER_CHAT_ID, type: "private" },
        from: { id: CONFIG.ACCOUNT_ASSISTANT_OWNER_CHAT_ID },
      },
      false,
    )
  )
    return;
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

  const incomingText = trimText(
    message.text || message.message || message.rawText || "",
    3000,
  );

  if (!incomingText) {
    return;
  }

  const sender = await message.getSender().catch(() => null);
  const profile = buildSenderProfile(sender, message);
  const chatId = profile.chatId || profile.id;

  if (
    !chatId ||
    !shouldHandlePeer(profile) ||
    !claimAccountMessage(chatId, message.id)
  ) {
    return;
  }

  await enqueueChatTask(chatId, async () => {
    if (shouldThrottleChat(chatId)) {
      const wait =
        CONFIG.ACCOUNT_ASSISTANT_MIN_INTERVAL_MS -
        (Date.now() - (lastHandledAt.get(String(chatId)) || 0));
      await delay(Math.max(0, wait));
    }

    if (
      !accountAssistantEnabled ||
      !accountClient ||
      !shouldHandlePeer(profile)
    )
      return;

    if (CONFIG.ACCOUNT_ASSISTANT_REPLY_DELAY_MS > 0) {
      await delay(CONFIG.ACCOUNT_ASSISTANT_REPLY_DELAY_MS);
    }

    const inputChat = await message.getInputChat();

    if (!inputChat) {
      logger.warn(
        `Account assistant skipped ${chatId}: could not resolve input chat.`,
      );
      return;
    }

    const draft = await draftAccountReply(
      `account:${chatId}`,
      incomingText,
      profile,
    );
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
      createdAt: new Date().toISOString(),
    };

    const mode = getAccountAssistantMode();

    if (mode === "auto" && draft.sendable) {
      await sendAccountText(pendingDraft, draft.reply);
      rememberTurn(
        `account:${chatId}`,
        incomingText,
        draft.reply,
        pendingDraft.id,
      );
      logger.info(`Account assistant auto-replied to ${chatId}`);
    } else if (mode === "dry-run") {
      await notifyOwnerAboutDraft(
        pendingDraft,
        "DRY-RUN: черновик без отправки",
      );
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
  if (!(await require("./access").guardCallback(controlBot, query))) return;

  if (!isOwnerMessage({ chat: query.message?.chat, from: query.from })) {
    await controlBot
      .answerCallbackQuery(query.id, {
        text: "Эта кнопка доступна только владельцу.",
        show_alert: false,
      })
      .catch(() => {});
    return;
  }

  const [, action, id] = data.split(":");
  const draft = pendingDrafts.get(id);

  try {
    if (!draft) {
      await controlBot.answerCallbackQuery(query.id, {
        text: "Черновик уже отправлен, отклонен или истек.",
        show_alert: false,
      });
      return;
    }
    if (draft.sending || draft.redrafting) {
      await controlBot
        .answerCallbackQuery(query.id, { text: "Черновик уже обрабатывается." })
        .catch(() => {});
      return;
    }

    if (action === "send") {
      await sendPendingDraft(id);
      await controlBot.answerCallbackQuery(query.id, {
        text: "Отправлено.",
        show_alert: false,
      });
      await notifyOwner(
        CONFIG.ACCOUNT_ASSISTANT_OWNER_CHAT_ID,
        [
          `Сообщение отправлено: ${draft.senderName}${draft.username ? ` (@${draft.username})` : ""}`,
          `ID: ${draft.id}`,
          `Chat ID: ${draft.chatId}`,
        ].join("\n"),
      );
      return;
    }

    if (action === "redraft") {
      const updatedDraft = await redraftPendingDraft(id);
      await controlBot.answerCallbackQuery(query.id, {
        text: "Черновик обновлён.",
        show_alert: false,
      });
      await notifyOwner(
        CONFIG.ACCOUNT_ASSISTANT_OWNER_CHAT_ID,
        [
          `Редрафт завершён для ${updatedDraft.senderName}${updatedDraft.username ? ` (@${updatedDraft.username})` : ""}`,
          `ID: ${updatedDraft.id}`,
          `Sendable: ${updatedDraft.sendable}`,
          `Причина: ${updatedDraft.reason}`,
        ].join("\n"),
      );
      return;
    }

    if (action === "drop") {
      pendingDrafts.delete(id);
      persistDrafts();
      await editOwnerNotice(
        draft,
        `Отклонено.\n\nID: ${draft.id}\nОт: ${draft.senderName}`,
      );
      await controlBot.answerCallbackQuery(query.id, {
        text: "Отклонено.",
        show_alert: false,
      });
      await notifyOwner(
        CONFIG.ACCOUNT_ASSISTANT_OWNER_CHAT_ID,
        [
          `Черновик отклонён: ${draft.senderName}${draft.username ? ` (@${draft.username})` : ""}`,
          `ID: ${draft.id}`,
          `Chat ID: ${draft.chatId}`,
        ].join("\n"),
      );
      return;
    }

    if (action === "block") {
      const blocked = blockDraftSender(draft);
      pendingDrafts.delete(id);
      persistDrafts();
      await editOwnerNotice(
        draft,
        `Заблокирован отправитель.\n\nID: ${draft.id}\nОт: ${draft.senderName}`,
      );
      await controlBot.answerCallbackQuery(query.id, {
        text: blocked
          ? "Отправитель заблокирован."
          : "Не удалось заблокировать.",
        show_alert: false,
      });
      await notifyOwner(
        CONFIG.ACCOUNT_ASSISTANT_OWNER_CHAT_ID,
        [
          `Отправитель заблокирован: ${draft.senderName}${draft.username ? ` (@${draft.username})` : ""}`,
          `ID: ${draft.id}`,
          `Chat ID: ${draft.chatId}`,
        ].join("\n"),
      );
      return;
    }
  } catch (error) {
    logger.error("Account assistant callback error:", error.message);
    await controlBot
      .answerCallbackQuery(query.id, {
        text: `Ошибка: ${error.message}`,
        show_alert: true,
      })
      .catch(() => {});
  }
}

async function sendStatus(chatId) {
  const status = getAccountAssistantStatus();
  await controlBot.sendMessage(
    chatId,
    [
      "Account assistant:",
      `enabled: ${status.enabled}`,
      `started: ${status.started}`,
      `connected: ${status.connected}`,
      `mode: ${status.mode}`,
      `privateOnly: ${status.privateOnly}`,
      `pendingDrafts: ${status.pendingDrafts}`,
      `allowList: ${status.allowList}`,
      `blockList: ${status.blockList}`,
      `ownerChatIdConfigured: ${status.ownerChatIdConfigured}`,
    ].join("\n"),
  );
}

async function sendPendingList(chatId) {
  if (!pendingDrafts.size) {
    await controlBot.sendMessage(chatId, "Активных черновиков нет.");
    return;
  }

  const lines = Array.from(pendingDrafts.values()).map((draft) => {
    return `${draft.id}: ${draft.senderName}${draft.username ? ` (@${draft.username})` : ""}${draft.deliveryUncertain ? " — проверь доставку, повтор заблокирован" : ""}`;
  });

  await controlBot.sendMessage(
    chatId,
    trimText(["Черновики:", ...lines].join("\n")),
  );
}

async function redraftPendingDraft(id) {
  const draft = pendingDrafts.get(id);

  if (!draft) {
    fail("Черновик не найден или истёк.");
  }
  if (draft.sending || draft.redrafting) fail("Черновик уже обрабатывается.");
  draft.redrafting = true;
  try {
    const senderProfile = {
      name: draft.senderName,
      username: draft.username,
      id: draft.chatId,
    };

    const newDraft = await draftAccountReply(
      `account:${draft.chatId}`,
      draft.incomingText,
      senderProfile,
    );

    draft.reply = newDraft.reply;
    draft.sendable = newDraft.sendable;
    draft.reason = newDraft.reason;
    draft.updatedAt = new Date().toISOString();

    await controlBot
      .editMessageText(buildDraftNotice(draft, "Черновик обновлён"), {
        chat_id: CONFIG.ACCOUNT_ASSISTANT_OWNER_CHAT_ID,
        message_id: draft.noticeMessageId,
        ...buildDraftKeyboard(draft.id),
      })
      .catch(() => {});

    return draft;
  } finally {
    draft.redrafting = false;
    persistDrafts();
  }
}

async function connectAccountAssistant() {
  const missing = getMissingConfig();

  if (missing.length) {
    fail(`Не хватает настроек аккаунта: ${missing.join(", ")}.`);
  }

  if (accountClient && accountClient.isConnected) {
    return accountClient;
  }

  accountClient = new TelegramClient(
    new StringSession(CONFIG.TELEGRAM_STRING_SESSION),
    CONFIG.TELEGRAM_API_ID,
    CONFIG.TELEGRAM_API_HASH,
    { connectionRetries: 5 },
  );

  try {
    await accountClient.connect();
    if (!(await accountClient.checkAuthorization()))
      fail(
        "Сессия Telegram-аккаунта не авторизована. Создай новую через npm run telegram:session и обнови TELEGRAM_STRING_SESSION.",
      );
  } catch (error) {
    await accountClient.disconnect().catch(() => {});
    accountClient = null;
    started = false;
    throw error;
  }

  accountClient.addEventHandler(
    (event) => {
      processIncomingAccountMessage(event).catch((error) => {
        logger.error("Account assistant message handler error:", error.message);
      });
    },
    new NewMessage({ incoming: true }),
  );
  started = true;
  logger.info(
    `Account assistant connected in ${getAccountAssistantMode()} mode.`,
  );
  return accountClient;
}

async function enableAccountAssistant(chatId) {
  if (!accountClient?.isConnected) await connectAccountAssistant();
  accountAssistantEnabled = true;
  persistSettings();

  await controlBot.sendMessage(
    chatId,
    "Account assistant включён и готов к работе.",
  );
}

async function disableAccountAssistant(chatId) {
  accountAssistantEnabled = false;
  persistSettings();

  if (accountClient) {
    await accountClient.disconnect().catch(() => {});
    accountClient = null;
    started = false;
  }

  await controlBot.sendMessage(chatId, "Account assistant отключён.");
}

function registerControlBotHandlers(bot) {
  if (!bot || handlersRegistered) return;
  handlersRegistered = true;
  controlBot = bot;
  bot.on("callback_query", (query) =>
    handleAccountCallback(query).catch((error) =>
      console.error("Account callback:", error.code || error.name),
    ),
  );
}

async function executeAccountCommand(msg, command, args) {
  if (!require("./access").getAccessGate().authorized(msg))
    fail("🔒 Доступ истёк. Войди через /start с паролем.");
  if (!isOwnerMessage(msg))
    fail("Эта команда доступна только владельцу в личном чате.");
  const chatId = msg.chat.id;
  const name = command.replace(/^account_/, "");
  if (
    ["help", "status", "config", "pending", "enable", "disable"].includes(
      name,
    ) &&
    args
  )
    fail("Эта команда не принимает аргументы.");
  if (name === "help") {
    await controlBot.sendMessage(chatId, buildAccountAssistantHelpText());
    return;
  }
  if (name === "status") return sendStatus(chatId);
  if (name === "config") {
    await controlBot.sendMessage(chatId, buildAccountAssistantConfigText());
    return;
  }
  if (name === "pending") return sendPendingList(chatId);
  if (name === "enable") return enableAccountAssistant(chatId);
  if (name === "disable") return disableAccountAssistant(chatId);
  if (name === "mode") {
    if (args && !setAccountAssistantMode(args))
      fail("Допустимые режимы: approval, auto, dry-run.");
    await controlBot.sendMessage(chatId, "Режим: " + getAccountAssistantMode());
    return;
  }
  if (name === "private") {
    if (args && !/^(true|false)$/i.test(args))
      fail("Используй true или false.");
    if (args) {
      accountAssistantPrivateOnly = args.toLowerCase() === "true";
      persistSettings();
    }
    await controlBot.sendMessage(
      chatId,
      "Только личные чаты: " + accountAssistantPrivateOnly,
    );
    return;
  }
  if (["allow", "unallow", "block", "unblock"].includes(name)) {
    if (!/^(@?[a-zA-Z][a-zA-Z0-9_]{4,31}|-?\d+)$/.test(args))
      fail("Укажи Telegram chatId или @username.");
    const set = name.includes("allow")
      ? accountAssistantAllow
      : accountAssistantBlock;
    const changed = name.startsWith("un")
      ? removePeerFromSet(set, args)
      : addPeerToSet(set, args);
    await controlBot.sendMessage(
      chatId,
      changed ? "Список обновлён." : "Элемент не найден.",
    );
    return;
  }
  if (name === "message") {
    const m = args.match(/^(@?[a-zA-Z][a-zA-Z0-9_]{4,31}|-?\d+)\s+([\s\S]+)$/);
    if (!m) fail("Используй /account_message @username текст.");
    await sendDirectAccountMessage(m[1], m[2]);
    await controlBot.sendMessage(chatId, "Сообщение отправлено.");
    return;
  }
  const m = args.match(/^([a-z0-9]+)(?:\s+([\s\S]+))?$/i);
  if (!m || (name === "reply" ? !m[2] : !!m[2]))
    fail("Укажи ID черновика" + (name === "reply" ? " и текст ответа." : "."));
  const draft = pendingDrafts.get(m[1]);
  if (
    !draft ||
    Date.parse(draft.createdAt) + CONFIG.ACCOUNT_ASSISTANT_DRAFT_TTL_MS <=
      Date.now()
  )
    fail("Черновик не найден или истёк.");
  if (name === "send" || name === "reply") {
    await sendPendingDraft(m[1], m[2]);
    await controlBot.sendMessage(chatId, "Отправлено.");
    return;
  }
  if (name === "redraft") {
    await redraftPendingDraft(m[1]);
    await controlBot.sendMessage(chatId, "Черновик обновлён.");
    return;
  }
  if (name === "drop") {
    if (draft.sending || draft.redrafting) fail("Черновик уже обрабатывается.");
    pendingDrafts.delete(m[1]);
    persistDrafts();
    await editOwnerNotice(draft, "Черновик отклонён.");
    await controlBot.sendMessage(chatId, "Отклонено.");
    return;
  }
  fail("Неизвестная команда аккаунта.");
}
async function startAccountAssistant(bot) {
  registerControlBotHandlers(bot);

  if (!accountAssistantEnabled) {
    logger.info(
      "Account assistant disabled. Set ACCOUNT_ASSISTANT_ENABLED=true to enable it.",
    );
    return null;
  }

  if (
    accountAssistantMode === "auto" &&
    !CONFIG.ACCOUNT_ASSISTANT_OWNER_CHAT_ID
  ) {
    logger.warn(
      "Account assistant auto mode has no owner chat id; unsafe drafts will be skipped silently.",
    );
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
  stopAccountAssistant: async () => {
    if (accountClient) await accountClient.disconnect();
    accountClient = null;
    started = false;
  },
  startAccountAssistant,
  getAccountAssistantStatus,
  executeAccountCommand,
  registerControlBotHandlers,
};
