const axios = require("axios");
const CONFIG = require("../config");
const { getErrorDetails } = require("../utils/errors");
const {
  MAX_HISTORY_MESSAGES,
  getUserMemory,
  remember,
  updatePersonalityMemory,
  getLastMessageByRole,
  buildSystemPrompt,
  buildCurrentTurnMessage,
  buildReplyCorrectionMessage,
  dedupeRepeatedReply,
  isProbablySameReply
} = require("./memory");

async function requestAICompletion(messages, options = {}) {
  const response = await axios.post(
    "https://openrouter.ai/api/v1/chat/completions",
    {
      model: options.model || CONFIG.MODEL,
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
      timeout: options.timeout || 60000,
      maxContentLength: Infinity,
      maxBodyLength: Infinity
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

function buildImageTurnMessage(text, imageDataUrl) {
  return {
    role: "user",
    content: [
      {
        type: "text",
        text: [
          "CURRENT QUESTION. Answer this exact message, not the previous dialog.",
          "The user attached an image. Use the image itself as primary context.",
          "",
          text
        ].join("\n")
      },
      {
        type: "image_url",
        image_url: {
          url: imageDataUrl,
          detail: "auto"
        }
      }
    ]
  };
}

async function askAIWithImage(chatId, text, image, from) {
  const promptText = text?.trim() || "Describe this image and answer based on it.";
  const memoryText = text?.trim()
    ? `[Image attached]\nCaption/request: ${text.trim()}`
    : "[Image attached]";

  const memory = updatePersonalityMemory(chatId, memoryText, from);
  const previousAssistantReply = getLastMessageByRole(memory, "assistant");
  const currentUserMessage = {
    role: "user",
    content: memoryText
  };

  const history = memory.messages.slice(-MAX_HISTORY_MESSAGES);
  const currentTurn = buildImageTurnMessage(promptText, image.dataUrl);
  const requestOptions = { model: CONFIG.VISION_MODEL };

  let aiReply = await requestAICompletion([
    buildSystemPrompt(memory),
    ...history,
    currentTurn
  ], requestOptions);

  if (isProbablySameReply(aiReply, previousAssistantReply)) {
    aiReply = await requestAICompletion([
      buildSystemPrompt(memory),
      buildReplyCorrectionMessage(promptText),
      ...history.filter((message) => message.role !== "assistant").slice(-6),
      currentTurn
    ], requestOptions);
  }

  if (isProbablySameReply(aiReply, previousAssistantReply)) {
    aiReply = await requestAICompletion([
      buildSystemPrompt(memory),
      buildReplyCorrectionMessage(promptText),
      currentTurn
    ], requestOptions);
  }

  if (!aiReply) {
    throw new Error("OpenRouter returned an empty image response");
  }

  remember(chatId, currentUserMessage);

  remember(chatId, {
    role: "assistant",
    content: aiReply
  });

  return aiReply;
}

function trimTextForSpeech(text) {
  const normalized = String(text || "")
    .replace(/\s+/g, " ")
    .trim();

  if (normalized.length <= CONFIG.TTS_MAX_CHARS) {
    return normalized;
  }

  return `${normalized.slice(0, CONFIG.TTS_MAX_CHARS - 3).trim()}...`;
}

async function synthesizeSpeech(text, options = {}) {
  const input = trimTextForSpeech(text);

  if (!input) {
    throw new Error("No text to synthesize");
  }

  const response = await axios.post(
    "https://openrouter.ai/api/v1/audio/speech",
    {
      model: CONFIG.TTS_MODEL,
      input,
      voice: options.voice || CONFIG.TTS_VOICE,
      response_format: CONFIG.TTS_FORMAT,
      speed: CONFIG.TTS_SPEED
    },
    {
      headers: {
        Authorization: `Bearer ${CONFIG.OPENROUTER_API_KEY}`,
        "Content-Type": "application/json",
        "HTTP-Referer": process.env.APP_URL || "http://localhost",
        "X-Title": "AI Telegram Bot"
      },
      responseType: "arraybuffer",
      timeout: 120000,
      maxContentLength: Infinity,
      maxBodyLength: Infinity
    }
  );

  const audioBuffer = Buffer.from(response.data);

  if (!audioBuffer.length) {
    throw new Error("OpenRouter returned empty speech audio");
  }

  return audioBuffer;
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

function buildAccountAssistantSystemPrompt(memory, senderProfile = {}, options = {}) {
  const customPrompt = String(options.prompt || CONFIG.ACCOUNT_ASSISTANT_PROMPT || "").trim();
  const senderLabel = [
    senderProfile.name ? `name=${senderProfile.name}` : "",
    senderProfile.username ? `username=@${senderProfile.username}` : "",
    senderProfile.id ? `id=${senderProfile.id}` : ""
  ].filter(Boolean).join(", ") || "unknown";

  return {
    role: "system",
    content: [
      "You draft Telegram replies for the owner of this account.",
      "Return only JSON with this exact shape: {\"reply\":\"text\",\"sendable\":true,\"reason\":\"short reason\"}.",
      "Write the reply as the account owner, in first person when natural.",
      "Use the same language as the incoming message unless context strongly says otherwise.",
      "Keep it natural, brief, and human: usually 1-3 short sentences.",
      "Do not invent private facts, promises, plans, prices, addresses, or commitments.",
      "Do not ask for passwords, login codes, card data, seed phrases, documents, or other secrets.",
      "Set sendable=false if the message needs the owner's personal decision, asks for money or credentials, contains threats/emergencies, looks like fraud, or requires knowledge not present in chat memory.",
      "If unsure, write a safe neutral draft and set sendable=false.",
      "Never generate spam, harassment, threats, illegal instructions, or manipulative messages.",
      customPrompt ? `Owner style/instructions: ${customPrompt}` : "",
      "",
      `Current sender: ${senderLabel}`,
      `Known nickname: ${memory.nickname || "unknown"}`,
      `Conversation style: ${memory.style}`,
      `Personal notes: ${memory.personalNotes.length ? memory.personalNotes.join("; ") : "none"}`
    ].filter(Boolean).join("\n")
  };
}

function extractJsonObject(text) {
  const cleanText = String(text || "").trim();
  const fenced = cleanText.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1].trim() : cleanText;

  if (candidate.startsWith("{") && candidate.endsWith("}")) {
    return candidate;
  }

  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");

  if (start >= 0 && end > start) {
    return candidate.slice(start, end + 1);
  }

  return "";
}

function trimAccountReply(text) {
  const cleanText = String(text || "")
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .trim();

  if (cleanText.length <= CONFIG.ACCOUNT_ASSISTANT_MAX_TEXT_CHARS) {
    return cleanText;
  }

  return `${cleanText.slice(0, CONFIG.ACCOUNT_ASSISTANT_MAX_TEXT_CHARS - 3).trim()}...`;
}

function parseSendableFlag(value) {
  if (typeof value === "boolean") {
    return value;
  }

  return ["1", "true", "yes", "y"].includes(String(value || "").trim().toLowerCase());
}

function parseAccountAssistantDraft(rawReply) {
  const jsonText = extractJsonObject(rawReply);

  if (jsonText) {
    try {
      const parsed = JSON.parse(jsonText);
      const reply = trimAccountReply(parsed.reply);

      return {
        reply,
        sendable: parseSendableFlag(parsed.sendable) && Boolean(reply),
        reason: String(parsed.reason || "").trim() || "model returned structured draft"
      };
    } catch (error) {
      // Fall through to plain-text draft handling.
    }
  }

  const reply = trimAccountReply(rawReply);

  return {
    reply,
    sendable: false,
    reason: "model returned plain text, owner approval required"
  };
}

async function draftAccountReply(chatId, text, senderProfile = {}, options = {}) {
  const memory = getUserMemory(chatId);
  const cleanText = trimAccountReply(text);

  if (!cleanText) {
    return {
      reply: "",
      sendable: false,
      reason: "empty incoming message"
    };
  }

  const history = memory.messages.slice(-Math.min(MAX_HISTORY_MESSAGES, 20));
  const userMessage = {
    role: "user",
    content: [
      "Incoming Telegram message to the account owner.",
      senderProfile.name ? `Sender name: ${senderProfile.name}` : "",
      senderProfile.username ? `Sender username: @${senderProfile.username}` : "",
      "",
      cleanText
    ].filter(Boolean).join("\n")
  };

  const rawReply = await requestAICompletion([
    buildAccountAssistantSystemPrompt(memory, senderProfile, options),
    ...history,
    userMessage
  ], {
    timeout: options.timeout || 60000
  });

  const draft = parseAccountAssistantDraft(rawReply);
  remember(chatId, { role: "user", content: cleanText });

  if (draft.reply) {
    remember(chatId, { role: "assistant", content: draft.reply });
  }

  return draft;
}

module.exports = {
  requestAICompletion,
  askAI,
  askAIWithImage,
  draftAccountReply,
  synthesizeSpeech,
  trimTextForSpeech,
  transcribeAudio,
  getSttModels
};
