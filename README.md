# AI_BOT

## Telegram account assistant

The bot can also watch incoming private messages on your Telegram user account and prepare replies.
By default it works in approval mode: it sends a draft to the owner chat, and only sends from the
account after you press the button or use a command.

### Setup

1. Create Telegram API credentials at https://my.telegram.org/ and put them into `.env`:

```env
TELEGRAM_API_ID=123456
TELEGRAM_API_HASH=your_api_hash
```

2. Generate a user session:

```bash
npm run telegram:session
```

3. Put the printed session and owner chat id into `.env`:

```env
ACCOUNT_ASSISTANT_ENABLED=true
ACCOUNT_ASSISTANT_MODE=approval
ACCOUNT_ASSISTANT_OWNER_CHAT_ID=123456789
TELEGRAM_STRING_SESSION=your_generated_session
```

### Useful options

```env
# approval | auto | dry-run
ACCOUNT_ASSISTANT_MODE=approval

# Keep this true if you only want direct messages, not groups/channels.
ACCOUNT_ASSISTANT_PRIVATE_ONLY=true

# Optional comma-separated filters by chat id, sender id, username, or @username.
ACCOUNT_ASSISTANT_ALLOW_CHATS=
ACCOUNT_ASSISTANT_BLOCK_CHATS=

# Avoid answering every message in a burst.
ACCOUNT_ASSISTANT_MIN_INTERVAL_MS=30000
ACCOUNT_ASSISTANT_REPLY_DELAY_MS=1200

# Extra style instructions for account replies.
ACCOUNT_ASSISTANT_PROMPT=answer briefly and casually
```

Owner commands in the regular bot chat:

```text
/account_status
/account_pending
/account_send <id>
/account_drop <id>
/account_reply <id> custom text
```

Keep `TELEGRAM_STRING_SESSION` private. It is an authorized Telegram account session.

## Bot-to-bot communication

Telegram supports bot-to-bot messages when Bot-to-Bot Communication Mode is enabled in `@BotFather`.
Enable the mode for this bot and for every bot that should receive private messages from it.

Recommended Render environment variables:

```env
BOT_TO_BOT_ENABLED=true
BOT_TO_BOT_OWNER_CHAT_ID=123456789

# Optional comma-separated allowlist. Leave empty to accept any bot.
BOT_TO_BOT_ALLOW_BOTS=reviewer_bot,planner_bot

# Stops accidental endless reply loops.
BOT_TO_BOT_MAX_TURNS=6
BOT_TO_BOT_WINDOW_MS=120000
BOT_TO_BOT_MIN_INTERVAL_MS=2000
```

Owner commands in the regular bot chat:

```text
/bot_status
/bot_send @other_bot hello
```

Incoming private messages from allowed bots are answered automatically. In groups, the bot only
answers another bot when the message mentions its username or replies directly to one of its messages.
Another bot can explicitly start a group conversation with `/bot_chat@your_bot hello`.
