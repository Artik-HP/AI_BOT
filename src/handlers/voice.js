const path = require("path");
const { transcribeAudio } = require("../services/openrouter");
const { processUserText } = require("../services/conversation");
const {
  claimIncomingMessage,
  enqueueChatTask,
  downloadTelegramFile,
} = require("../services/telegram");

const AUDIO_ERROR_MESSAGE =
  "Не смог прочитать голосовое сообщение. Попробуй короче или проверь OPENROUTER_STT_MODEL / OPENROUTER_AUDIO_MODEL и доступ к OpenRouter.";

function getAudioMessage(msg) {
  if (msg.voice?.file_id) {
    return {
      fileId: msg.voice.file_id,
      format: "ogg",
      source: "voice",
    };
  }

  if (msg.audio?.file_id) {
    return {
      fileId: msg.audio.file_id,
      format: getAudioFormat(msg.audio),
      source: "audio",
    };
  }

  if (msg.document?.file_id && msg.document.mime_type?.startsWith("audio/")) {
    return {
      fileId: msg.document.file_id,
      format: getAudioFormat(msg.document),
      source: "document",
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
    "audio/x-wav": "wav",
  }[file.mime_type];

  if (mimeFormat) {
    return mimeFormat;
  }

  const extension = path
    .extname(file.file_name || "")
    .slice(1)
    .toLowerCase();
  return extension || "ogg";
}

async function handleAudioMessage(bot, chatId, msg, audio) {
  await bot.sendChatAction(chatId, "typing");

  const audioBuffer = await downloadTelegramFile(audio.fileId);
  const transcript = await transcribeAudio(audioBuffer, audio.format,{budgetScope:msg.commandScope});
  const caption = msg.caption?.trim();
  const userText = caption
    ? `Voice message transcript: ${transcript}\nCaption: ${caption}`
    : transcript;

  await processUserText(bot, chatId, userText, msg.from, {
    memoryScope: msg.commandScope,
  });
}

function registerVoiceHandler(bot) {
  bot.on("message", async (msg) => {
    const chatId = msg.chat.id;
    const audio = getAudioMessage(msg);

    if (!audio) {
      return;
    }
    if (!(await require("../services/access").guardMessage(bot, msg))) return;

    if (!claimIncomingMessage(msg)) {
      return;
    }

    await enqueueChatTask(chatId, async () => {
      try {
        msg.commandScope = `t:${chatId}:${msg.from.id}`;
        await handleAudioMessage(bot, chatId, msg, audio);
      } catch (error) {
        const status = error.response?.status;
        const details = require("../utils/errors").getErrorDetails(error);

        console.error(
          "Audio transcription error:",
          status,
          details,
          error.transcriptionErrors || "",
        );
        await bot.sendMessage(chatId, AUDIO_ERROR_MESSAGE).catch(() => {});
      }
    });
  });
}

module.exports = {
  registerVoiceHandler,
  getAudioMessage,
  getAudioFormat,
  handleAudioMessage,
};
