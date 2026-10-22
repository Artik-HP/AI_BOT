# AI_BOT на VPS: подготовка, запуск и обновление

Комплект для Ubuntu/Debian с `systemd`. Основной вариант — Telegram polling без домена. Webhook и HTTPS через Caddy включаются отдельно. Один процесс `index.js` обслуживает Telegram и веб-панель; отдельный `npm run web` на сервере не нужен.

**Статус:** заготовка и локальные проверки подготовлены; установка на настоящий VPS, HTTPS, регистрация webhook и доставка Telegram требуют отдельной проверки на сервере. Установщик подготавливает службу, но сам её не запускает.

## Что входит

| Файл | Назначение |
|---|---|
| `install.sh` | Проверка пакета, установка версии кода и службы; `--update` для обновления остановленного экземпляра |
| `bot.env.example` | Серверные настройки; ключи заполняются только на VPS |
| `ai-bot.service.example` | Автозапуск, перезапуск после сбоя, отдельный пользователь и ограничения файловой системы |
| `Caddyfile.example` | Отдельный сайт для webhook; веб-панель по умолчанию остаётся приватной |
| `../../scripts/package-vps.js` | Архив из текущих исходников, включая незакоммиченные изменения, без локальных данных |
| `../../scripts/check-vps.js` | Проверка настроек и SQLite без запросов к Telegram или AI |

Размещение:

```text
/opt/ai-bot/releases/<version>/     исходники и зависимости, владелец root
/opt/ai-bot/current                ссылка на активную версию
/opt/ai-bot/previous               ссылка на предыдущую версию после обновления
/opt/ai-bot/backups/<version>/     закрытая резервная копия данных и unit-файла
/var/lib/ai-bot/config/.env        ключи и изменяемые настройки, права 600
/var/lib/ai-bot/commands.sqlite    заметки, задания, история и настройки
/var/lib/ai-bot/memory.json        путь для совместимости/импорта старой памяти
/var/lib/ai-bot/interactive-state.json
/var/cache/ai-bot/                кэш установки npm
```

Служба может писать в каталог состояния, а исходники защищены от записи. `.env` загружается через `dotenv/config`; `CONFIG_ENV_FILE` указывает на тот же файл, поэтому сохранение пароля и настроек из приложения продолжает работать. Изменения настроек, которые приложение читает при запуске, применяются после перезапуска.

## 1. Подготовить архив на компьютере

В PowerShell из папки с `package.json`:

```powershell
cd D:\Проекты\AI_BOT\AI_BOT
npm run verify
npm run package:vps
```

Результат: `artifacts/vps/ai-bot-vps-<дата>.tar.gz` и соответствующий `.sha256`. Внутри — каталог `ai-bot` с `DEPLOY-MANIFEST.json` и SHA-256 каждого исходного файла. Нужен `tar` (в современных Windows он уже есть). Новая сборка не перезаписывает предыдущий архив.

Упаковщик использует список разрешённых исходников, а не `git archive` или копирование всей папки. Он исключает `.env`, `.git`, `node_modules`, локальные БД, память и её резервные копии, Telegram-сессии, отчёты и логи. Символические ссылки в исходных каталогах запрещены. Это особенно важно для исторически отслеживаемых Git-файлов `userbot.session` и `memory.json.bak`: упаковка их не переносит, историю Git не изменяет.

Передача последнего архива (заменить SSH-логин и IP):

```powershell
$vpsAddress = 'ubuntu@VPS_IP'
$bundle = Get-ChildItem .\artifacts\vps\*.tar.gz | Sort-Object LastWriteTime | Select-Object -Last 1
scp $bundle.FullName ($bundle.FullName + '.sha256') "${vpsAddress}:~/"
ssh $vpsAddress
```

## 2. Подготовить сервер и установить файлы

Предпосылки: Ubuntu/Debian, `sudo`, работающий `systemd`, исходящий HTTPS к Telegram, npm и AI-провайдеру. Установите системно **Node.js 24 LTS** и npm по [официальным инструкциям Node.js](https://nodejs.org/en/download). Установщик ожидает `/usr/bin/node` и `/usr/bin/npm`; пользовательская установка через `nvm` в `/home` с этой службой несовместима. Минимум приложения — Node.js 22.13 с `node:sqlite`; для нового VPS используйте актуальный патч 24 LTS. [Поддерживаемые версии](https://nodejs.org/en/about/previous-releases).

```bash
sudo apt-get update
sudo apt-get install -y ca-certificates curl tar util-linux
/usr/bin/node --version
/usr/bin/npm --version
```

Следующий блок выполняется **на VPS**. В первой строке укажите имя загруженного архива:

```bash
archive=ai-bot-vps-REPLACE_WITH_ACTUAL_FILENAME.tar.gz
sha256sum -c "$archive.sha256"
upload_dir=$(mktemp -d "$HOME/ai-bot-upload.XXXXXX")
tar -xzf "$archive" -C "$upload_dir"
cd "$upload_dir/ai-bot"
sudo bash deploy/ubuntu/install.sh
```

Установщик проверяет manifest, версию Node и SQLite, создаёт пользователя `ai-bot`, ставит зависимости через `npm ci --omit=dev --ignore-scripts`, создаёт конфигурацию с двумя независимыми случайными секретами, проверяет unit-файл и выполняет `daemon-reload`. Код после установки принадлежит `root`. Служба, Caddy, DNS и firewall не включаются автоматически. Существующая старая установка `/opt/ai-bot/index.js` не перезаписывается: сначала нужен её отдельный перенос с резервной копией.

## 3. Заполнить ключи и пароль на сервере

```bash
cd /opt/ai-bot/current
sudo -u ai-bot env \
  DOTENV_CONFIG_PATH=/var/lib/ai-bot/config/.env \
  CONFIG_ENV_FILE=/var/lib/ai-bot/config/.env \
  /usr/bin/node --require dotenv/config scripts/setup.js
```

Мастер запросит токен BotFather, ключ OpenRouter, пароль доступа к боту и модель. Секретный ввод скрыт. Для приватного профиля VPS пароль обязателен; в `.env` сохраняется только scrypt-хеш. OpenRouter можно оставить пустым, тогда AI-команды будут недоступны, а локальные команды продолжат работать. Не переносите свой локальный `.env` поверх серверного: это может вернуть локальные пути и сетевые настройки.

Другие параметры редактируются командой:

```bash
sudoedit /var/lib/ai-bot/config/.env
```

Оставьте `WEBHOOK_URL=` пустым для polling. Автоматически созданный `WEB_ACCESS_TOKEN` понадобится для веб-панели; он находится в этом файле. В базовом профиле адреса и пути фиксированы, чтобы совпадать со службой и Caddy. Произвольное изменение портов потребует согласованного изменения шаблонов и проверки.

Проверка без внешних запросов:

```bash
sudo -u ai-bot /usr/bin/node /opt/ai-bot/current/scripts/check-vps.js \
  --env /var/lib/ai-bot/config/.env
```

Проверяются формат токена, пароль, отдельный секрет веб-панели, локальные интерфейсы, пути, права конфигурации, запись в каталог данных, HTTPS-настройки и наличие SQLite. Успех этой команды не доказывает действительность ключей или доступность Telegram.

## 4. Запустить и проверить

Сначала остановите старый процесс бота с этим же токеном на компьютере/другом сервере. Затем:

```bash
sudo systemctl enable --now ai-bot.service
sudo systemctl status ai-bot.service --no-pager
sudo journalctl -u ai-bot.service -n 80 --no-pager
curl --fail --silent --show-error http://127.0.0.1:12722/health
sudo systemctl show ai-bot.service -p ActiveState -p NRestarts -p ExecMainStatus
```

`/health` должен вернуть `{"ok":true}`. Через минуту повторите `systemctl show`: служба должна оставаться `active`, а число рестартов не должно расти. Напишите боту `/start`, введите пароль и проверьте `/calculator 2+2`, затем обычный AI-вопрос при заданном ключе. Это отдельно проверяет доставку Telegram и работу AI. Сам `/health` проверяет только HTTP-приложение.

Для polling не нужны домен и входящие порты приложения. Оставьте `12722` и `12723` закрытыми в firewall. Служба работает на localhost.

Чтобы открыть веб-панель, выполните **на своём компьютере**:

```powershell
ssh -N -L 127.0.0.1:12725:127.0.0.1:12722 ubuntu@VPS_IP
```

Откройте `http://127.0.0.1:12725` и войдите с `WEB_ACCESS_TOKEN`. В базовом режиме `WEB_SECURE_COOKIE=false` нужен для HTTP внутри защищённого SSH-туннеля. Если включите HTTPS-профиль ниже, используйте веб-панель через HTTPS.

## 5. Необязательно: домен, webhook и Caddy

1. Создайте A-запись отдельного поддомена (например, `bot.example.com`) на IP VPS. AAAA оставляйте только при работающем IPv6. Корневой домен и существующий сайт менять не требуется.
2. Разрешите входящие 80/443 на сервере и у хостера, сохраняя доступ SSH. Если эти порты заняты существующим reverse proxy, настройте его или интегрируйте отдельный сайт; второй proxy на тех же портах не запустится.
3. Установите Caddy по [официальной инструкции](https://caddyserver.com/docs/install#debian-ubuntu-raspbian).
4. Создайте отдельный файл сайта. Команда копирования ниже предназначена для первого добавления; существующий файл сначала сохраните.

```bash
sudo install -d -m 755 /etc/caddy/conf.d
sudo install -m 644 /opt/ai-bot/current/deploy/ubuntu/Caddyfile.example /etc/caddy/conf.d/ai-bot.caddy
sudoedit /etc/caddy/conf.d/ai-bot.caddy
sudoedit /etc/caddy/Caddyfile
```

В `ai-bot.caddy` замените `bot.example.com` на свой поддомен. В существующий главный Caddyfile добавьте один раз на верхнем уровне строку `import /etc/caddy/conf.d/*.caddy`, сохранив остальные сайты и глобальные настройки. **Не заменяйте общий Caddyfile целиком.** [Как работает import](https://caddyserver.com/docs/caddyfile/directives/import).

```bash
sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl reload caddy
curl --fail --silent --show-error https://bot.example.com/health
```

Дождитесь корректного HTTPS и ответа health, затем измените серверный `.env`:

```dotenv
WEBHOOK_URL=https://bot.example.com
WEBHOOK_PATH=/telegram-webhook
WEB_SECURE_COOKIE=true
# WEBHOOK_SECRET_TOKEN уже создан установщиком — сохраните его.
```

Проверьте конфигурацию и перезапустите:

```bash
sudo -u ai-bot /usr/bin/node /opt/ai-bot/current/scripts/check-vps.js --env /var/lib/ai-bot/config/.env
sudo systemctl restart ai-bot.service
sudo journalctl -u ai-bot.service -n 80 --no-pager
```

Бот сам вызывает `setWebhook`; в журнале ожидается успешная регистрация. Проверьте сообщение в Telegram. При ошибке регистрации HTTP health может оставаться зелёным — исправьте DNS/TLS/ключи и повторите проверку.

По умолчанию Caddy публикует только `/health` и `/telegram-webhook`; прочие пути возвращают 404. Для публичной веб-панели замените `respond` в последнем `handle` на `reverse_proxy 127.0.0.1:12722`, установите `WEB_PUBLIC_URL=https://bot.example.com`, сохраните независимый `WEB_ACCESS_TOKEN` и `WEB_SECURE_COOKIE=true`, затем проверьте Caddy и перезапустите приложение. Авторизация и cookie уже реализованы в приложении.

## 6. Обновление с сохранением данных

Соберите и передайте новый архив, проверьте `.sha256` и распакуйте его в **новую** папку, как на шаге 2. Затем из новой папки `ai-bot`:

```bash
sudo systemctl stop ai-bot.service
sudo bash deploy/ubuntu/install.sh --update && sudo systemctl start ai-bot.service
curl --fail --silent --show-error http://127.0.0.1:12722/health
sudo systemctl show ai-bot.service -p ActiveState -p NRestarts -p ExecMainStatus
```

Не выполняйте `start`, если установка завершилась ошибкой: сначала изучите сообщение. Обновление отказывается работать с активной службой, архивирует весь каталог состояния (включая `.env`, SQLite/WAL и память), сохраняет unit и путь предыдущей версии, устанавливает зависимости в новом каталоге и проверяет конфигурацию перед переключением. При ошибке установки зависимостей текущая ссылка не меняется. Старые версии и бэкапы автоматически не удаляются. Unit заменяется шаблоном с резервной копией; собственные дополнительные настройки храните в `systemctl edit ai-bot.service` (drop-in).

Откат **кода** после неудачного обновления:

```bash
sudo systemctl stop ai-bot.service
sudo test -L /opt/ai-bot/previous && sudo ln -sfnT "$(readlink -f /opt/ai-bot/previous)" /opt/ai-bot/current && sudo systemctl start ai-bot.service
```

Выполняйте команды последовательно, останавливаясь при ошибке. Такой откат сохраняет текущее состояние данных и unit. Если версия меняла схему БД или unit несовместим, потребуется согласованное восстановление `state.tar.gz` и `ai-bot.service` из одной копии `/opt/ai-bot/backups/<version>/`. Перед восстановлением остановите службу и сохраните текущее состояние отдельно; не распаковывайте старую БД поверх работающей. Архив состояния содержит секреты — храните его с закрытыми правами, включая внешнюю резервную копию. Регулярное внешнее резервирование администратор настраивает отдельно.

## 7. Перенос существующих данных и дополнительные режимы

Новый пакет запускает чистое хранилище. Для переноса старой памяти/заметок сначала остановите исходный процесс и новую службу, создайте отдельный защищённый архив `commands.sqlite` вместе с `-wal`/`-shm` при наличии, `memory.json`, `memory.json.bak` и `interactive-state.json`. Перенесите только необходимые данные в `/var/lib/ai-bot`, сохраните новый `config/.env`, задайте владельца `ai-bot:ai-bot` и закрытые права. Не переносите эти данные внутри архива исходников. Доступ к старому экземпляру, формат и актуальность его данных нужно проверить перед переносом.

В комплекте сохранены скрипты userbot и создания Telegram-сессии. Шаблон службы предназначен для обычного Telegram-бота; режим аккаунта включается только после отдельной настройки актуальной сессии, владельца и режима `approval`. Не запускайте два обработчика одного аккаунта/бота параллельно. Локальная `userbot.session` автоматически не переносится.

Полезные команды:

```bash
sudo systemctl restart ai-bot.service
sudo systemctl stop ai-bot.service
sudo journalctl -u ai-bot.service -f
sudo ss -ltnp
```

При лимите рестартов сначала устраните причину, затем выполните `sudo systemctl reset-failed ai-bot.service` и `sudo systemctl start ai-bot.service`. `409 Conflict` указывает на конфликт потребления Telegram updates; проверяйте другие запущенные копии и выбранный режим webhook/polling. При `EADDRINUSE` выясните, кто занимает порт, прежде чем менять настройки или останавливать процессы.

`npm run doctor` включает ESLint и ожидает devDependencies; минимальный production-пакет их не устанавливает. Для серверной предпроверки используйте `check-vps.js`, health, журнал службы и реальные проверки Telegram/AI. Локальная регрессия выполняется до упаковки через `npm run verify` и при необходимости `npm run test:e2e`.
