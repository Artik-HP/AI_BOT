const axios = require("axios");
const CONFIG = require("../config");
const { getErrorDetails } = require("../utils/errors");
const { requestInteractiveCompletion } = require("./openrouterInteractive");
const { historyText, validateQuestion } = require("./interactiveQuestion");
const {
  MAX_HISTORY_MESSAGES,
  getUserMemory,
  rememberTurn,
  updatePersonalityMemory,
  getLastMessageByRole,
  buildSystemPrompt,
  buildCurrentTurnMessage,
  buildReplyCorrectionMessage,
  dedupeRepeatedReply,
  isProbablySameReply,
} = require("./memory");

function repeatsSelection(reply, previousQuestion) {
  if (!previousQuestion || !validateQuestion(reply)) return false;
  if (
    reply.question.trim().toLowerCase() ===
    previousQuestion.question.trim().toLowerCase()
  )
    return true;
  const oldValues = previousQuestion.options
    .map((option) => option.value.trim().toLowerCase())
    .sort();
  const newValues = reply.options
    .map((option) => option.value.trim().toLowerCase())
    .sort();
  const oldLabels = previousQuestion.options
    .map((option) => option.label.trim().toLowerCase())
    .sort();
  const newLabels = reply.options
    .map((option) => option.label.trim().toLowerCase())
    .sort();
  // Repeated yes/no labels alone do not mean a repeated question.
  return (
    (oldValues.some((value) => value.length > 10) &&
      JSON.stringify(oldValues) === JSON.stringify(newValues)) ||
    (oldLabels.some((value) => value.length > 10) &&
      JSON.stringify(oldLabels) === JSON.stringify(newLabels))
  );
}

async function requestAICompletion(messages, options = {}) {
  if (options.provider === "compatible")
    return require("./aiProviders").compatibleCompletion(messages, {
      ...options,
      interactive: false,
    });
  if (options.budgetScope)
    require("./aiProviders").consumeBudget(options.budgetScope);
  if (!CONFIG.OPENROUTER_API_KEY)
    throw new Error("OPENROUTER_API_KEY is not configured");
  const response = await axios.post(
    "https://openrouter.ai/api/v1/chat/completions",
    {
      model: options.model || CONFIG.MODEL,
      messages,
      max_tokens: CONFIG.AI_MAX_OUTPUT_TOKENS,
      temperature: 1.05,
      top_p: 0.92,
      frequency_penalty: 0.45,
      presence_penalty: 0.35,
    },
    {
      headers: {
        Authorization: `Bearer ${CONFIG.OPENROUTER_API_KEY}`,
        "Content-Type": "application/json",
        "HTTP-Referer": process.env.APP_URL || "http://localhost",
        "X-Title": "AI Telegram Bot",
      },
      timeout: options.timeout || 60000,
      maxContentLength: 256 * 1024,
      maxBodyLength: Infinity,
    },
  );

  return dedupeRepeatedReply(response.data?.choices?.[0]?.message?.content);
}

async function requestChatCompletion(messages, options) {
  require('./aiProviders').headers(options.provider||'openrouter');
  if (options.provider === "compatible")
    return require("./aiProviders").compatibleCompletion(messages, options);
  const reply = await (options.interactive === false
    ? requestAICompletion(messages, options)
    : requestInteractiveCompletion(messages, options));
  return typeof reply === "string" ? dedupeRepeatedReply(reply) : reply;
}

async function askAI(chatId, text, from, options = {}) {
  const prefs = require("./preferences").getPreferences(String(chatId));
  options = {
    ...options,
    model: options.model || prefs.model,
    provider: options.provider || prefs.provider,
  };
  options.budgetScope = String(chatId);
  const activeKey = require("./preferences").threadKey(String(chatId), prefs);
  const historyKey = activeKey;
  chatId = historyKey;
  const memory = updatePersonalityMemory(chatId, text, from);
  const previousAssistantReply = getLastMessageByRole(memory, "assistant");
  const currentUserMessage = {
    role: "user",
    content: text,
  };

  const history = prefs.memoryEnabled
    ? memory.messages
        .slice(-Math.min(MAX_HISTORY_MESSAGES, prefs.historyLimit))
        .map(({ role, content }) => ({ role, content }))
    : [];
  const basePrompt = prefs.memoryEnabled
    ? buildSystemPrompt(memory)
    : {
        role: "system",
        content:
          "Ты персональный помощник. Не используй историю или память прошлых диалогов.",
      };
  const selectionContext = options.selectionQuestion
    ? [
        {
          role: "system",
          content: `The current user message is a confirmed selection answering this question: ${options.selectionQuestion.question}\nSelected answer: ${text}\nSelected option labels: ${(options.selectionLabels || []).join(", ")}\nAccept this answer and move the conversation forward. Do not ask the same question or offer the same selection again.`,
        },
      ]
    : [];
  const currentTurn = options.selectionQuestion
    ? {
        role: "user",
        content: `Я отвечаю на вопрос: ${options.selectionQuestion.question}\nЯ уже подтвердил выбор. Мои выбранные ответы:\n${text}\nПодтверди все выбранные ответы и перейди к следующему шагу. Не предлагай заново тот же выбор.`,
      }
    : buildCurrentTurnMessage(text);

  const messages = [
    basePrompt,
    require("./preferences").prompt(prefs),
    ...history,
    ...selectionContext,
    currentTurn,
  ];

  let aiReply = await requestChatCompletion(messages, options);

  if (
    isProbablySameReply(historyText(aiReply), previousAssistantReply) ||
    repeatsSelection(aiReply, options.selectionQuestion)
  ) {
    aiReply = await requestChatCompletion(
      [
        basePrompt,
        require("./preferences").prompt(prefs),
        buildReplyCorrectionMessage(text),
        ...history.filter((message) => message.role !== "assistant").slice(-6),
        ...selectionContext,
        currentTurn,
      ],
      options,
    );
  }

  if (
    isProbablySameReply(historyText(aiReply), previousAssistantReply) ||
    repeatsSelection(aiReply, options.selectionQuestion)
  ) {
    aiReply = await requestChatCompletion(
      [
        basePrompt,
        require("./preferences").prompt(prefs),
        buildReplyCorrectionMessage(text),
        ...selectionContext,
        currentTurn,
      ],
      options,
    );
  }

  if (!aiReply) {
    throw new Error("OpenRouter вернул пустой ответ");
  }
  if (repeatsSelection(aiReply, options.selectionQuestion))
    throw new Error("AI repeated the already answered selection question");

  if (options.onReplyReady) await options.onReplyReady(aiReply);
  rememberTurn(
    chatId,
    currentUserMessage.content,
    historyText(aiReply),
    options.turnId,
    validateQuestion(aiReply),
  );

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
          text,
        ].join("\n"),
      },
      {
        type: "image_url",
        image_url: {
          url: imageDataUrl,
          detail: "auto",
        },
      },
    ],
  };
}

async function askAIWithImage(chatId, text, image, from, options = {}) {
  const originalScope=String(chatId),prefs=require('./preferences').getPreferences(originalScope);
  chatId=require('./preferences').threadKey(originalScope,prefs);
  const promptText =
    text?.trim() || "Describe this image and answer based on it.";
  const memoryText = text?.trim()
    ? `[Image attached]\nCaption/request: ${text.trim()}`
    : "[Image attached]";

  const memory = updatePersonalityMemory(chatId, memoryText, from);
  const previousAssistantReply = getLastMessageByRole(memory, "assistant");
  const currentUserMessage = {
    role: "user",
    content: memoryText,
  };

  const history = (prefs.memoryEnabled?memory.messages:[])
    .slice(-MAX_HISTORY_MESSAGES)
    .map(({ role, content }) => ({ role, content }));
  const currentTurn = buildImageTurnMessage(promptText, image.dataUrl);
  const requestOptions = {
    ...options,
    model: options.model || CONFIG.VISION_MODEL,
    provider:options.provider||prefs.provider,
    budgetScope:originalScope,
  };

  let aiReply = await requestChatCompletion(
    [prefs.memoryEnabled?buildSystemPrompt(memory):{role:'system',content:'Не используй память прошлых диалогов.'},require('./preferences').prompt(prefs), ...history, currentTurn],
    requestOptions,
  );

  if (isProbablySameReply(historyText(aiReply), previousAssistantReply)) {
    aiReply = await requestChatCompletion(
      [
        buildSystemPrompt(memory),
        buildReplyCorrectionMessage(promptText),
        ...history.filter((message) => message.role !== "assistant").slice(-6),
        currentTurn,
      ],
      requestOptions,
    );
  }

  if (isProbablySameReply(historyText(aiReply), previousAssistantReply)) {
    aiReply = await requestChatCompletion(
      [
        buildSystemPrompt(memory),
        buildReplyCorrectionMessage(promptText),
        currentTurn,
      ],
      requestOptions,
    );
  }

  if (!aiReply) {
    throw new Error("OpenRouter returned an empty image response");
  }

  if (options.onReplyReady) await options.onReplyReady(aiReply);
  rememberTurn(
    chatId,
    currentUserMessage.content,
    historyText(aiReply),
    options.turnId,
    validateQuestion(aiReply),
  );

  return aiReply;
}

async function transcribeAudio(audioBuffer, format,options={}) {
  require('./aiProviders').headers('openrouter');
  const errors = [];

  for (const model of getSttModels()) {
    try {
      require('./aiProviders').consumeBudget(options.budgetScope||'media');
      return await transcribeWithSttEndpoint(audioBuffer, format, model);
    } catch (error) {
      errors.push({ model, error });
      console.warn("STT endpoint failed:", model, getErrorDetails(error));
    }
  }

  try {
    require('./aiProviders').consumeBudget(options.budgetScope||'media');
    console.warn("Trying audio chat fallback:", CONFIG.AUDIO_FALLBACK_MODEL);
    return await transcribeWithAudioChat(audioBuffer, format);
  } catch (error) {
    errors.push({ model: CONFIG.AUDIO_FALLBACK_MODEL, error });
    console.warn("Audio chat fallback failed:", getErrorDetails(error));
  }

  const lastError =
    errors[errors.length - 1]?.error || new Error("Audio transcription failed");
  lastError.transcriptionErrors = errors.map(({ model, error }) => ({
    model,
    details: getErrorDetails(error),
  }));
  throw lastError;
}

function getSttModels() {
  const models = [
    CONFIG.STT_MODEL,
    "mistralai/voxtral-mini-transcribe",
    "openai/gpt-4o-mini-transcribe",
    "openai/whisper-large-v3-turbo",
    "openai/whisper-1",
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
        format,
      },
      ...(CONFIG.STT_LANGUAGE ? { language: CONFIG.STT_LANGUAGE } : {}),
      temperature: 0,
    },
    {
      headers: {
        Authorization: `Bearer ${CONFIG.OPENROUTER_API_KEY}`,
        "Content-Type": "application/json",
        "HTTP-Referer": process.env.APP_URL || "http://localhost",
        "X-Title": "AI Telegram Bot",
      },
      timeout: 60000,
      maxContentLength: Infinity,
      maxBodyLength: Infinity,
    },
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
              text: "Transcribe this audio exactly. Return only the transcript text, without comments.",
            },
            {
              type: "input_audio",
              input_audio: {
                data: audioBuffer.toString("base64"),
                format,
              },
            },
          ],
        },
      ],
      temperature: 0,
    },
    {
      headers: {
        Authorization: `Bearer ${CONFIG.OPENROUTER_API_KEY}`,
        "Content-Type": "application/json",
        "HTTP-Referer": process.env.APP_URL || "http://localhost",
        "X-Title": "AI Telegram Bot",
      },
      timeout: 60000,
      maxContentLength: Infinity,
      maxBodyLength: Infinity,
    },
  );

  const transcript = response.data?.choices?.[0]?.message?.content?.trim();

  if (!transcript) {
    throw new Error(
      "OpenRouter audio fallback returned an empty transcription",
    );
  }

  return transcript;
}

function buildAccountAssistantSystemPrompt(
  memory,
  senderProfile = {},
  options = {},
) {
  const customPrompt = String(
    options.prompt || CONFIG.ACCOUNT_ASSISTANT_PROMPT || "",
  ).trim();
  const senderLabel =
    [
      senderProfile.name ? `name=${senderProfile.name}` : "",
      senderProfile.username ? `username=@${senderProfile.username}` : "",
      senderProfile.id ? `id=${senderProfile.id}` : "",
    ]
      .filter(Boolean)
      .join(", ") || "unknown";

  return {
    role: "system",
    content: [
      "You draft Telegram replies for the owner of this account.",
      'Return only JSON with this exact shape: {"reply":"text","sendable":true,"reason":"short reason"}.',
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
      `Personal notes: ${memory.personalNotes.length ? memory.personalNotes.join("; ") : "none"}`,
    ]
      .filter(Boolean)
      .join("\n"),
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

function parseAccountAssistantDraft(rawReply) {
  const jsonText = extractJsonObject(rawReply);

  if (jsonText) {
    try {
      const parsed = JSON.parse(jsonText);
      if (
        !parsed ||
        Array.isArray(parsed) ||
        Object.keys(parsed).some(
          (key) => !["reply", "sendable", "reason"].includes(key),
        ) ||
        typeof parsed.reply !== "string" ||
        typeof parsed.sendable !== "boolean" ||
        typeof parsed.reason !== "string"
      )
        throw new Error("Invalid draft structure");
      const reply = trimAccountReply(parsed.reply);

      return {
        reply,
        sendable: parsed.sendable && Boolean(reply),
        reason:
          String(parsed.reason || "").trim() ||
          "model returned structured draft",
      };
    } catch (error) {
      // Fall through to plain-text draft handling.
    }
  }

  const reply = trimAccountReply(rawReply);

  return {
    reply,
    sendable: false,
    reason: "model returned plain text, owner approval required",
  };
}

async function draftAccountReply(
  chatId,
  text,
  senderProfile = {},
  options = {},
) {
  const memory = getUserMemory(chatId);
  const cleanText = trimAccountReply(text);

  if (!cleanText) {
    return {
      reply: "",
      sendable: false,
      reason: "empty incoming message",
    };
  }

  const history = memory.messages
    .slice(-Math.min(MAX_HISTORY_MESSAGES, 20))
    .map(({ role, content }) => ({ role, content }));
  const userMessage = {
    role: "user",
    content: [
      "Incoming Telegram message to the account owner.",
      senderProfile.name ? `Sender name: ${senderProfile.name}` : "",
      senderProfile.username
        ? `Sender username: @${senderProfile.username}`
        : "",
      "",
      cleanText,
    ]
      .filter(Boolean)
      .join("\n"),
  };

  const rawReply = await requestAICompletion(
    [
      buildAccountAssistantSystemPrompt(memory, senderProfile, options),
      ...history,
      userMessage,
    ],
    {
      timeout: options.timeout || 60000,
      budgetScope:String(chatId),
    },
  );

  const draft = parseAccountAssistantDraft(rawReply);
  return draft;
}

module.exports = {
  requestAICompletion,
  askAI,
  askAIWithImage,
  draftAccountReply,
  transcribeAudio,
  getSttModels,
  parseAccountAssistantDraft,
};
