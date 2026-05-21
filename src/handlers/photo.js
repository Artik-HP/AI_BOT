const path = require("path");
const CONFIG = require("../config");
const { askAIWithImage } = require("../services/openrouter");
const {
  claimIncomingMessage,
  enqueueChatTask,
  downloadTelegramFile,
  sendAIResponse
} = require("../services/telegram");

const IMAGE_ERROR_MESSAGE = "Не смог прочитать изображение. Проверь размер файла или OPENROUTER_VISION_MODEL.";

const SUPPORTED_IMAGE_MIME_TYPES = new Set([
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp"
]);

function getImageMessage(msg) {
  if (Array.isArray(msg.photo) && msg.photo.length > 0) {
    const photo = msg.photo.reduce((best, current) => {
      return getPhotoScore(current) > getPhotoScore(best) ? current : best;
    });

    return {
      fileId: photo.file_id,
      mimeType: "image/jpeg",
      source: "photo"
    };
  }

  if (msg.document?.file_id) {
    const mimeType = getSupportedMimeType(msg.document);

    if (mimeType) {
      return {
        fileId: msg.document.file_id,
        mimeType,
        source: "document"
      };
    }
  }

  return null;
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
  await bot.sendChatAction(chatId, "typing");

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

  await sendAIResponse(chatId, aiReply);
}

function registerPhotoHandler(bot) {
  bot.on("message", async (msg) => {
    const chatId = msg.chat.id;
    const image = getImageMessage(msg);

    if (!image) {
      return;
    }

    if (!claimIncomingMessage(msg)) {
      return;
    }

    await enqueueChatTask(chatId, async () => {
      try {
        await handleImageMessage(bot, chatId, msg, image);
      } catch (error) {
        const status = error.response?.status;
        const details = error.response?.data || error.message;

        console.error("Image recognition error:", status, details);
        await bot.sendMessage(chatId, IMAGE_ERROR_MESSAGE);
      }
    });
  });
}

module.exports = {
  registerPhotoHandler,
  getImageMessage,
  getSupportedMimeType,
  buildImageDataUrl,
  handleImageMessage
};
