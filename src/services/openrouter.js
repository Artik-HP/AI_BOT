const axios = require("axios");
const CONFIG = require("../config");
const { getErrorDetails } = require("../utils/errors");
const {
  MAX_HISTORY_MESSAGES,
  remember,
  updatePersonalityMemory,
  getLastMessageByRole,
  buildSystemPrompt,
  buildCurrentTurnMessage,
  buildReplyCorrectionMessage,
  dedupeRepeatedReply,
  isProbablySameReply
} = require("./memory");

async function requestAICompletion(messages) {
  const response = await axios.post(
    "https://openrouter.ai/api/v1/chat/completions",
    {
      model: CONFIG.MODEL,
      messages,
      temperature: 1.05,
      top_p: 0.92,
      frequency_penalty: 0.45,
      presence_penalty: 0.35
    },
    {
      headers: {
        Authorization: `Bearer ${CONFIG.OPENROUTER_API_KEY}`,
        "Content-Type": "application/json",
        "HTTP-Referer": process.env.APP_URL || "http://localhost",
        "X-Title": "AI Telegram Bot"
      },
      timeout: 60000
    }
  );

  return dedupeRepeatedReply(response.data?.choices?.[0]?.message?.content);
}

async function askAI(chatId, text, from) {
  const memory = updatePersonalityMemory(chatId, text, from);
  const previousAssistantReply = getLastMessageByRole(memory, "assistant");
  const currentUserMessage = {
    role: "user",
    content: text
  };

  const history = memory.messages.slice(-MAX_HISTORY_MESSAGES);

  const messages = [
    buildSystemPrompt(memory),
    ...history,
    buildCurrentTurnMessage(text)
  ];

  let aiReply = await requestAICompletion(messages);

  if (isProbablySameReply(aiReply, previousAssistantReply)) {
    aiReply = await requestAICompletion([
      buildSystemPrompt(memory),
      buildReplyCorrectionMessage(text),
      ...history.filter((message) => message.role !== "assistant").slice(-6),
      buildCurrentTurnMessage(text)
    ]);
  }

  if (isProbablySameReply(aiReply, previousAssistantReply)) {
    aiReply = await requestAICompletion([
      buildSystemPrompt(memory),
      buildReplyCorrectionMessage(text),
      buildCurrentTurnMessage(text)
    ]);
  }

  if (!aiReply) {
    throw new Error("OpenRouter вернул пустой ответ");
  }

  remember(chatId, currentUserMessage);

  remember(chatId, {
    role: "assistant",
    content: aiReply
  });

  return aiReply;
}

async function transcribeAudio(audioBuffer, format) {
  const errors = [];

  for (const model of getSttModels()) {
    try {
      return await transcribeWithSttEndpoint(audioBuffer, format, model);
    } catch (error) {
      errors.push({ model, error });
      console.warn("STT endpoint failed:", model, getErrorDetails(error));
    }
  }

  try {
    console.warn("Trying audio chat fallback:", CONFIG.AUDIO_FALLBACK_MODEL);
    return await transcribeWithAudioChat(audioBuffer, format);
  } catch (error) {
    errors.push({ model: CONFIG.AUDIO_FALLBACK_MODEL, error });
    console.warn("Audio chat fallback failed:", getErrorDetails(error));
  }

  const lastError = errors[errors.length - 1]?.error || new Error("Audio transcription failed");
  lastError.transcriptionErrors = errors.map(({ model, error }) => ({
    model,
    details: getErrorDetails(error)
  }));
  throw lastError;
}


function getSttModels() {
  const models = [
    CONFIG.STT_MODEL,
    "mistralai/voxtral-mini-transcribe",
    "openai/gpt-4o-mini-transcribe",
    "openai/whisper-large-v3-turbo",
    "openai/whisper-1"
  ];

  return [...new Set(models.map((model) => model.trim()).filter(Boolean))];
}

async function transcribeWithSttEndpoint(audioBuffer, format, model) {
  const response = await axios.post(
    "https://openrouter.ai/api/v1/audio/transcriptions",
    {
      model,
      input_audio: {
        data: audioBuffer.toString("base64"),
        format
      },
      ...(CONFIG.STT_LANGUAGE ? { language: CONFIG.STT_LANGUAGE } : {}),
      temperature: 0
    },
    {
      headers: {
        Authorization: `Bearer ${CONFIG.OPENROUTER_API_KEY}`,
        "Content-Type": "application/json",
        "HTTP-Referer": process.env.APP_URL || "http://localhost",
        "X-Title": "AI Telegram Bot"
      },
      timeout: 60000,
      maxContentLength: Infinity,
      maxBodyLength: Infinity
    }
  );

  const transcript = response.data?.text?.trim();

  if (!transcript) {
    throw new Error("OpenRouter returned an empty transcription");
  }

  return transcript;
}


async function transcribeWithAudioChat(audioBuffer, format) {
  const response = await axios.post(
    "https://openrouter.ai/api/v1/chat/completions",
    {
      model: CONFIG.AUDIO_FALLBACK_MODEL,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: "Transcribe this audio exactly. Return only the transcript text, without comments."
            },
            {
              type: "input_audio",
              input_audio: {
                data: audioBuffer.toString("base64"),
                format
              }
            }
          ]
        }
      ],
      temperature: 0
    },
    {
      headers: {
        Authorization: `Bearer ${CONFIG.OPENROUTER_API_KEY}`,
        "Content-Type": "application/json",
        "HTTP-Referer": process.env.APP_URL || "http://localhost",
        "X-Title": "AI Telegram Bot"
      },
      timeout: 60000,
      maxContentLength: Infinity,
      maxBodyLength: Infinity
    }
  );

  const transcript = response.data?.choices?.[0]?.message?.content?.trim();

  if (!transcript) {
    throw new Error("OpenRouter audio fallback returned an empty transcription");
  }

  return transcript;
}

module.exports = {
  requestAICompletion,
  askAI,
  transcribeAudio,
  getSttModels
};
