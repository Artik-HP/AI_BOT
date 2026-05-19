async function createChatCompletion({ axios, systemMessage, chats, chatId }) {
  return axios.post(
    "https://openrouter.ai/api/v1/chat/completions",
    {
      model: process.env.OPENROUTER_MODEL || "google/gemini-3.1-flash-lite",
      temperature: 0.9,
      top_p: 0.95,
      messages: [
        systemMessage,
        ...chats[chatId]
      ]
    },
    {
      headers: {
        Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
        "Content-Type": "application/json"
      }
    }
  );
}

module.exports = createChatCompletion;
