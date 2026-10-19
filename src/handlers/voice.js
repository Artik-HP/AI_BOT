const path = require("path");
const CONFIG = require("../config");
const logger = require("../utils/logger");
const { safeHandler, trySendMessage } = require("../utils/safe");
const { askAI, transcribeAudio } = require("../services/openrouter");
const {
  claimIncomingMessage,
  enqueueChatTask,
  downloadTelegramFile,
  getBotToBotReplyOptions,
  isFileTooLargeError,
  sendAIResponse
} = require("../services/telegram");
const { admitMessage, showTyping } = require("./guard");

const AUDIO_ERROR_MESSAGE = "Не получилось обработать голосовое сообщение. Попробуй ещё раз или отправь покороче.";

function buildAudioTooLargeMessage() {
  return `Файл слишком большой. Лимит: ${Math.round(CONFIG.MAX_AUDIO_BYTES / 1024 / 1024)} МБ.`;
}

function getAudioMessage(msg) {
  if (msg.voice?.file_id) {
    return {
      fileId: msg.voice.file_id,
      fileSize: msg.voice.file_size,
      format: "ogg",
      source: "voice"
    };
  }

  if (msg.audio?.file_id) {
    return {
      fileId: msg.audio.file_id,
      fileSize: msg.audio.file_size,
      format: getAudioFormat(msg.audio),
      source: "audio"
    };
  }

  if (msg.document?.file_id && msg.document.mime_type?.startsWith("audio/")) {
    return {
      fileId: msg.document.file_id,
      fileSize: msg.document.file_size,
      format: getAudioFormat(msg.document),
      source: "document"
    };
  }

  return null;
}

function getAudioFormat(file) {
  const mimeFormat = {
    "audio/aac": "aac",
    "audio/flac": "flac",
    "audio/m4a": "m4a",
    "audio/mp4": "m4a",
    "audio/mpeg": "mp3",
    "audio/mp3": "mp3",
    "audio/ogg": "ogg",
    "audio/wav": "wav",
    "audio/webm": "webm",
    "audio/x-m4a": "m4a",
    "audio/x-wav": "wav"
  }[file.mime_type];

  if (mimeFormat) {
    return mimeFormat;
  }

  const extension = path.extname(file.file_name || "").slice(1).toLowerCase();
  return extension || "ogg";
}

async function handleAudioMessage(bot, chatId, msg, audio) {
  await showTyping(bot, chatId);

  const audioBuffer = await downloadTelegramFile(audio.fileId);
  const transcript = await transcribeAudio(audioBuffer, audio.format);
  const caption = msg.caption?.trim();
  const userText = caption
    ? `Voice message transcript: ${transcript}\nCaption: ${caption}`
    : transcript;

  const aiReply = await askAI(chatId, userText, msg.from);
  await sendAIResponse(chatId, aiReply, { sourceMessageId: msg.message_id, ...getBotToBotReplyOptions(msg) });
}

function registerVoiceHandler(bot) {
  bot.on("message", safeHandler("Voice message handler", async (msg) => {
    const chatId = msg.chat.id;
    const audio = getAudioMessage(msg);

    if (!audio) {
      return;
    }

    if (!claimIncomingMessage(msg)) {
      return;
    }

    if (!await admitMessage(bot, msg)) {
      return;
    }

    if (audio.fileSize && audio.fileSize > CONFIG.MAX_AUDIO_BYTES) {
      await trySendMessage(bot, chatId, buildAudioTooLargeMessage());
      return;
    }

    await enqueueChatTask(chatId, async () => {
      try {
        await handleAudioMessage(bot, chatId, msg, audio);
      } catch (error) {
        logger.error("Audio transcription error:", error, error.transcriptionErrors || "");
        await trySendMessage(bot, chatId, isFileTooLargeError(error) ? buildAudioTooLargeMessage() : AUDIO_ERROR_MESSAGE);
      }
    });
  }));
}

module.exports = {
  registerVoiceHandler,
  getAudioMessage,
  getAudioFormat,
  handleAudioMessage
};
