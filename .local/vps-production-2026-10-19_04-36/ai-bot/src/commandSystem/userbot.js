function registerUserbot(register) {
  register('userbot_start','Вход в userbot','Открыть доступ с паролем в личном чате','userbot','🔐','',ctx=>{
    const gate=require('../services/access').getAccessGate();return {text:gate.enabled?'Используй /start с паролем для входа.':'Userbot готов. Напиши .help.'};
  },{availability:{telegram:false,web:false,userbot:true},hidden:true});
  register('userbot_lock','Заблокировать userbot','Закрыть доступ к отдельному userbot','userbot','🔒','',ctx=>{require('../services/access').getAccessGate().lock(ctx.msg);return {text:'Доступ userbot закрыт.'};},{availability:{telegram:false,web:false,userbot:true},hidden:true});
  const specs = [
    ["help", "Помощь", ""],
    ["ping", "Проверка связи", ""],
    ["say", "Повторить текст", "Привет"],
    ["echo", "Дублировать текст", "Привет"],
    ["whoami", "Мой аккаунт", ""],
    ["status", "Состояние userbot", ""],
    ["chatid", "ID чата", ""],
    ["time", "Текущее время", ""],
  ];
  for (const [name, title, example] of specs)
    register(
      "userbot_" + name,
      title,
      "Userbot: " + title.toLowerCase(),
      "userbot",
      "📡",
      example,
      async (ctx, args) => {
        if (!["say", "echo"].includes(name) && args)
          require("./tools").fail(
            "Эта userbot-команда не принимает аргументы.",
          );
        if (["say", "echo"].includes(name)) {
          if (!args) require("./tools").fail(`Использование: .${name} текст`);
          return { text: args };
        }
        if (name === "help")
          return {
            text:
              "Userbot команды:\n" +
              specs.map(([id, label]) => `.${id} — ${label}`).join("\n"),
          };
        if (name === "ping") return { text: "pong" };
        if (name === "chatid")
          return { text: "Chat ID: " + String(ctx.chatId) };
        if (name === "time")
          return {
            text:
              "Текущее время: " +
              new Intl.DateTimeFormat("ru-RU", {
                timeZone: "Europe/Kyiv",
                dateStyle: "full",
                timeStyle: "long",
              }).format(new Date()),
          };
        const me = await ctx.client.getMe(),
          fullName =
            [me.firstName, me.lastName].filter(Boolean).join(" ") ||
            "<unknown>";
        return {
          text:
            name === "whoami"
              ? `Я: ${fullName}\nUsername: ${me.username || "<none>"}\nID: ${me.id}`
              : `Userbot статус:\nUsername: ${me.username || "<none>"}\nName: ${fullName}\nUser ID: ${me.id}\nSession: loaded\nConnected: ${ctx.client.isConnected ? "yes" : "no"}\nEnvironment: ${process.env.NODE_ENV || "development"}`,
        };
      },
      {
        availability: { telegram: false, web: false, userbot: true },
        external: ["whoami", "status"].includes(name)
          ? "Telegram Account"
          : undefined,
      },
    );
}
module.exports = { registerUserbot };
