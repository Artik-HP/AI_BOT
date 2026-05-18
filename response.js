const response = await axios.post(
  "https://openrouter.ai/api/v1/chat/completions",
  {
    model: "deepseek/deepseek-chat-v3.1",
    temperature: 0.9,
    top_p: 0.95,
    messages: [
      systemMessage,
      ...chats[chatId]
    ]
  },
  {
    headers: {
      "Authorization": `Bearer ${process.env.OPENROUTER_API_KEY}`,
      "Content-Type": "application/json"
    }
  }
);
