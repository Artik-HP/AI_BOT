CREATE TABLE ai_bot.users (
  telegram_id BIGINT PRIMARY KEY CHECK (telegram_id > 0),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'blocked')),
  access_until TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_login_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE ai_bot.access_events (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  actor_id BIGINT NOT NULL,
  user_id BIGINT NOT NULL REFERENCES ai_bot.users(telegram_id),
  action TEXT NOT NULL CHECK (action IN ('active', 'blocked')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX users_status_idx ON ai_bot.users(status);
CREATE INDEX access_events_user_idx ON ai_bot.access_events(user_id, created_at);
