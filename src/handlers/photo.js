const path = require("path");
const CONFIG = require("../config");
const logger = require("../utils/logger");
const { safeHandler, trySendMessage } = require("../utils/safe");
const { askAIWithImage } = require("../services/openrouter");
const {
  claimIncomingMessage,
  enqueueChatTask,
  downloadTelegramFile,
  isFileTooLargeError,
  sendAIResponse
} = require("../services/telegram");
const { admitMessage, showTyping } = require("./guard");

const IMAGE_ERROR_MESSAGE = "Не получилось прочитать изображение. Попробуй другое или поменьше размером.";
const UNSUPPORTED_IMAGE_MESSAGE = "Этот формат изображения не поддерживается. Отправь JPEG, PNG, WebP или GIF.";

const SUPPORTED_IMAGE_MIME_TYPES = new Set([
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp"
]);

function buildImageTooLargeMessage() {
  return `Изображение слишком большое. Лимит: ${Math.round(CONFIG.MAX_IMAGE_BYTES / 1024 / 1024)} МБ.`;
}

function getImageMessage(msg) {
  if (Array.isArray(msg.photo) && msg.photo.length > 0) {
    const photo = msg.photo.reduce((best, current) => {
      return getPhotoScore(current) > getPhotoScore(best) ? current : best;
    });

    return {
      fileId: photo.file_id,
      fileSize: photo.file_size,
      mimeType: "image/jpeg",
      source: "photo"
    };
  }

  if (msg.document?.file_id) {
    const mimeType = getSupportedMimeType(msg.document);

    if (mimeType) {
      return {
        fileId: msg.document.file_id,
        fileSize: msg.document.file_size,
        mimeType,
        source: "document"
      };
    }
  }

  return null;
}

// An image sent as a file in a format the model cannot read (HEIC, BMP, TIFF, SVG...).
function isUnsupportedImageDocument(msg) {
  return Boolean(
    msg.document?.file_id &&
    String(msg.document.mime_type || "").toLowerCase().startsWith("image/") &&
    !getSupportedMimeType(msg.document)
  );
}

function getPhotoScore(photo) {
  if (!photo) {
    return 0;
  }

  return Number(photo.file_size || 0) || Number(photo.width || 0) * Number(photo.height || 0);
}

function getSupportedMimeType(file) {
  const normalizedMimeType = normalizeImageMimeType(file.mime_type);

  if (SUPPORTED_IMAGE_MIME_TYPES.has(normalizedMimeType)) {
    return normalizedMimeType;
  }

  const extension = path.extname(file.file_name || "").slice(1).toLowerCase();
  const mimeType = {
    gif: "image/gif",
    jpeg: "image/jpeg",
    jpg: "image/jpeg",
    png: "image/png",
    webp: "image/webp"
  }[extension];

  return SUPPORTED_IMAGE_MIME_TYPES.has(mimeType) ? mimeType : null;
}

function normalizeImageMimeType(mimeType) {
  if (!mimeType) {
    return "";
  }

  const normalized = String(mimeType).toLowerCase();
  return normalized === "image/jpg" ? "image/jpeg" : normalized;
}

function buildImageDataUrl(imageBuffer, mimeType) {
  return `data:${mimeType};base64,${imageBuffer.toString("base64")}`;
}

async function handleImageMessage(bot, chatId, msg, image) {
  await showTyping(bot, chatId);

  const imageBuffer = await downloadTelegramFile(image.fileId, {
    maxBytes: CONFIG.MAX_IMAGE_BYTES,
    fileLabel: "Image"
  });
  const imageDataUrl = buildImageDataUrl(imageBuffer, image.mimeType);
  const prompt = msg.caption?.trim() || "Что на изображении? Опиши важные детали и ответь по сути.";
  const aiReply = await askAIWithImage(chatId, prompt, {
    dataUrl: imageDataUrl,
    mimeType: image.mimeType
  }, msg.from);

  await sendAIResponse(chatId, aiReply, { sourceMessageId: msg.message_id });
}

function registerPhotoHandler(bot) {
  bot.on("message", safeHandler("Photo message handler", async (msg) => {
    const chatId = msg.chat.id;
    const image = getImageMessage(msg);
    const unsupported = !image && isUnsupportedImageDocument(msg);

    if (!image && !unsupported) {
      return;
    }

    if (!claimIncomingMessage(msg)) {
      return;
    }

    if (!await admitMessage(bot, msg)) {
      return;
    }

    if (unsupported) {
      await trySendMessage(bot, chatId, UNSUPPORTED_IMAGE_MESSAGE);
      return;
    }

    if (image.fileSize && image.fileSize > CONFIG.MAX_IMAGE_BYTES) {
      await trySendMessage(bot, chatId, buildImageTooLargeMessage());
      return;
    }

    await enqueueChatTask(chatId, async () => {
      try {
        await handleImageMessage(bot, chatId, msg, image);
      } catch (error) {
        logger.error("Image recognition error:", error);
        await trySendMessage(bot, chatId, isFileTooLargeError(error) ? buildImageTooLargeMessage() : IMAGE_ERROR_MESSAGE);
      }
    });
  }));
}

module.exports = {
  registerPhotoHandler,
  getImageMessage,
  getSupportedMimeType,
  buildImageDataUrl,
  handleImageMessage
};
