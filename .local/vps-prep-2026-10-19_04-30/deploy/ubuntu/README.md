# Развёртывание на Ubuntu VPS с поддоменом

Эта схема запускает Node.js как службу `systemd`, а Caddy принимает HTTPS и пересылает запросы боту на локальный порт. Обычный polling работает на VPS без домена; поддомен нужен для webhook.

## 1. DNS и сеть

1. Узнайте внешний IPv4 VPS у хостинг-провайдера.
2. В панели управления DNS домена добавьте запись типа `A`: имя `bot`, значение — IPv4 VPS. Например, для `example.com` это создаёт `bot.example.com`.
3. Разрешите входящие TCP-порты `80` и `443` в firewall VPS и панели хостинга. Не открывайте порт приложения `12722` наружу.
4. Дождитесь, пока DNS-имя начнёт указывать на IP сервера.

## 2. Приложение

Установите поддерживаемую LTS-версию Node.js и Caddy по официальным инструкциям:

- [Node.js: поддерживаемые версии](https://nodejs.org/en/about/previous-releases)
- [Caddy: установка на Ubuntu](https://caddyserver.com/docs/install)

Скопируйте проект на VPS в `/opt/ai-bot`, создайте системного пользователя `ai-bot`, назначьте ему каталог проекта и установите зависимости:

```bash
sudo useradd --system --user-group --home-dir /opt/ai-bot --shell /usr/sbin/nologin ai-bot
sudo install -d -o ai-bot -g ai-bot /opt/ai-bot
cd /opt/ai-bot
npm ci --omit=dev
```

Поместите `.env` в `/opt/ai-bot`. Для webhook задайте следующие параметры своими значениями. Секрет сгенерируйте командой `openssl rand -hex 32`; не отправляйте его в переписку и не добавляйте в Git.

```env
BOT_TOKEN=токен_бота
OPENROUTER_API_KEY=ключ_openrouter
HOST=127.0.0.1
PORT=12722
WEBHOOK_URL=https://bot.example.com
WEBHOOK_PATH=/telegram-webhook
WEBHOOK_SECRET_TOKEN=случайный_секрет
```

Замените `bot.example.com` на свой поддомен. Ограничьте чтение `.env` пользователем службы:

```bash
sudo chown ai-bot:ai-bot /opt/ai-bot/.env
sudo chmod 600 /opt/ai-bot/.env
```

Перед запуском остановите локальную копию бота с тем же `BOT_TOKEN`.

## 3. Caddy и systemd

1. Скопируйте `Caddyfile.example` в `/etc/caddy/Caddyfile` и замените `bot.example.com` на свой адрес.
2. Проверьте конфигурацию и перезапустите Caddy:

```bash
sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl reload caddy
```

3. Скопируйте `ai-bot.service.example` в `/etc/systemd/system/ai-bot.service`, затем включите службу:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now ai-bot
sudo systemctl status ai-bot
```

4. Проверьте логи `sudo journalctl -u ai-bot -n 100 --no-pager` и откройте `https://bot.example.com/health`. Ожидаемый ответ — `{"ok":true}`.

При запуске приложение само устанавливает webhook на `WEBHOOK_URL` + `WEBHOOK_PATH`. Не запускайте одновременно два процесса одного бота.

## Без домена

Оставьте `WEBHOOK_URL` пустым. Бот будет работать через polling; для этого достаточно службы `systemd`, Caddy и DNS не нужны. Если health endpoint не требуется, web-порт можно закрыть на firewall.
