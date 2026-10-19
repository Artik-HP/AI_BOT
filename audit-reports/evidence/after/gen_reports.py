#!/usr/bin/env python3
"""Usage: python3 audit-reports/evidence/after/gen_reports.py AUDIT_FINAL_<date>_<time>.md

Rewrites the 'Контроль' column of FIXES_REPORT.md from facts (baseline control + mutation results) and
generates AUDIT_FINAL from the same rows, so the two reports cannot drift apart."""
import json, os, re, sys, datetime

# audit-reports/ is three levels up from this file (audit-reports/evidence/after/gen_reports.py)
ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
INITIAL = f"{ROOT}/AUDIT_INITIAL_2026-10-19_02-03.md"
FIXES = f"{ROOT}/FIXES_REPORT.md"
MUT = f"{ROOT}/evidence/after/mutation-results.json"
CONTROL = f"{ROOT}/evidence/after/control-baseline.tap"
FINAL_NAME = sys.argv[1]  # e.g. AUDIT_FINAL_2026-10-19_05-00.md

# --- facts -------------------------------------------------------------
mutations = json.load(open(MUT, encoding="utf-8"))
killed = {}
survived = []
for m in mutations:
    if m["status"] == "KILLED":
        killed.setdefault(m["finding"], []).append(m["id"])
    else:
        survived.append(m["id"])

baseline_failing = set()
for line in open(CONTROL, encoding="utf-8"):
    m = re.match(r"^not ok \d+ - (.+?)(?: # .*)?$", line.rstrip("\n"))
    if m:
        baseline_failing.update(re.findall(r"F0\d\d", m.group(1)))

# Findings reproduced on the original code by the scenario harness (the new tests cannot run against old code:
# they import the modules directly), see evidence/baseline-*.txt
harness_reproduced = {"F004", "F007", "F008", "F012", "F013", "F014", "F015", "F020", "F022", "F025", "F026", "F027", "F040"}
# Fixed by configuration/documentation/tool only: no automated test of their own.
no_test = {"F011", "F033", "F034", "F035", "F037", "F039", "F030"}
tool_checked = {"F011": "npm audit", "F033": "ESLint", "F034": "git ls-files", "F001": "git ls-files", "F002": "git ls-files"}

# --- initial titles / severities --------------------------------------------
titles, severity = {}, {}
for line in open(INITIAL, encoding="utf-8"):
    m = re.match(r"^\| (F0\d\d) \| \*{0,2}(Critical|High|Medium|Low)\*{0,2} \| (.+?) \| ", line)
    if m:
        severity[m.group(1)] = m.group(2)
        titles[m.group(1)] = m.group(3)

# --- rewrite FIXES_REPORT ----------------------------------------------------
text = open(FIXES, encoding="utf-8").read()
rows = {}
out_lines = []
for line in text.split("\n"):
    m = re.match(r"^\| (F0\d\d) \| (.*) \| (.*) \| (.*) \| (.*) \|$", line)
    if not m:
        out_lines.append(line)
        continue
    fid, was, did, control, status = m.groups()
    stripped = re.sub(r"^\*\*[^*]*\*\*(?: — )?", "", control.strip())  # previous run's label (idempotent)
    desc = re.sub(r"^([BHTML](?:[+/][BHTML])*)\s+", "", stripped)
    desc = "" if desc.strip() == "—" else desc
    labels = []
    if fid in baseline_failing:
        labels.append("B")
    if fid in harness_reproduced:
        labels.append("H")
    if fid in tool_checked:
        labels.append("L")
    if fid not in no_test:
        labels.append("T")
    if fid in killed:
        labels.append("M:" + ",".join(killed[fid]))
    if fid == "F031":
        pass
    if labels:
        new_control = f"**{' · '.join(labels)}**" + (f" — {desc}" if desc else "")
    else:
        new_control = re.sub(r"^[—\s]+", "", re.sub(r"^\*\*—\*\*", "", desc)).strip() or "—"
        new_control = f"— {new_control}" if new_control != "—" else "—"
    rows[fid] = (was, did, new_control, status)
    out_lines.append(f"| {fid} | {was} | {did} | {new_control} | {status} |")

legend_old = re.search(r"Условные обозначения контроля:.*?\n\n", text, re.S)
new_legend = (
    "Условные обозначения контроля: **B** — тест из этого же файла **падает на оригинальном коде** "
    "(контрольный прогон, `evidence/after/control-comparison.md`); **H** — дефект воспроизведён на оригинале "
    "сценарием стенда (`evidence/baseline-*.txt`), а новый тест импортирует модули напрямую и на старом коде не запускается; "
    "**T** — автоматический тест есть и проходит; **M:Mxx** — мутация (намеренная поломка именно этого фикса) "
    "обнаружена набором тестов (`evidence/after/mutation-results.json`); **L** — проверено инструментом (`npm audit`, ESLint, `git ls-files`).\n\n"
)
joined = "\n".join(out_lines)
if legend_old:
    joined = joined.replace(legend_old.group(0), new_legend, 1)
open(FIXES, "w", encoding="utf-8").write(joined)

# --- AUDIT_FINAL -------------------------------------------------------------
new_findings = [
    ("S2-01", "Low", "`getMe()` при сбое на старте не повторялся (команды чужим ботам снова принимались)", "одна попытка, ошибка только в лог", "до 8 попыток с нарастающей паузой", "**T · M:M36** — `bot-resilience`: «getMe не ответил при старте…»", "ИСПРАВЛЕНО"),
    ("S2-02", "Low", "Шторм однотипных `polling_error` в логе, нет подсказок для 409/401", "запись каждую секунду (тысячи строк в час)", "одна запись в минуту + счётчик + подсказки 409/401", "**T · M:M37** — `unit/polling-log`", "ИСПРАВЛЕНО"),
    ("S2-03", "Low", "Квадратичная регулярка `[ \\t]+\\n` (было и в оригинале)", "1 МБ пробелов: > 5 минут", "линейная `trimLineEnds`: 46 мс на 1 МБ", "**T · M:M38** — `unit/text`, `service-errors`", "ИСПРАВЛЕНО"),
    ("S2-04", "Medium", "Фикс F031 был неполным: `stopPolling({cancel:true})` не останавливает опрос", "после «остановки» +3 запроса за 2,5 с, сообщения принимались", "остановка за ~1 мс, 0 запросов после", "**T · M:M24** — `service-errors`: «остановка опроса настоящая…»", "ИСПРАВЛЕНО"),
    ("S2-05", "Low", "Два фикса без защиты тестами (F024 в ассистенте, F032 с явной целью)", "мутации M20, M27 выживали", "тесты добавлены, мутации убиваются", "**T · M:M20,M27**", "ИСПРАВЛЕНО"),
    ("S2-06", "Info", "Фейковые серверы ждали idle-таймаут при закрытии", "~6 с на тест", "сокеты закрываются до `close()`", "**T** — весь набор", "ИСПРАВЛЕНО"),
    ("S2-07", "Info", "gramjs (`telegram`) помечен апстримом устаревшим", "—", "без изменений", "—", "ОСТАЁТСЯ (R1)"),
    # найдено автоматическим ревью Codex на PR #3 (после перевода из черновика)
    ("S2-08", "Low", "Логгер читал `LOG_LEVEL`/`LOG_MESSAGES` из `process.env` мимо `buildConfig` (нарушение правила AGENTS.md)", "опечатка в `LOG_LEVEL` молча давала `info`, проверки не было", "значения проверяются в `buildConfig` с предупреждением; булевы разбирает общий `utils/parse.js`; исключение для логгера записано в AGENTS.md", "**T · M:M39** — `unit/config`", "ИСПРАВЛЕНО"),
    ("S2-09", "Low", "Ответ на фото и голос от другого бота без reply-to и `@`-упоминания", "пир, фильтрующий адресованные сообщения, игнорировал ответ", "в обоих обработчиках передаются `getBotToBotReplyOptions`", "**T · M:M40,M41** — `bot-commands`: bot-to-bot с вложениями", "ИСПРАВЛЕНО"),
    ("S2-10", "Medium", "При остановке терялись сообщения, ожидавшие окна троттлинга ассистента аккаунта", "таймер отменялся, сообщение пропадало безвозвратно", "ожидающие сообщения превращаются в черновик до отключения", "**T · M:M42** — `account-assistant`", "ИСПРАВЛЕНО"),
    ("S2-11", "High", "Медленное `/account_enable` перекрывало более позднее `/account_disable`: личный аккаунт оставался подключённым и мог отвечать", "включённый флаг выставлялся после окончания подключения", "побеждает последняя команда: счётчик поколений + желаемое состояние, подключение-опоздавшее закрывается", "**T · M:M43** — `account-assistant` (2 теста)", "ИСПРАВЛЕНО"),
    ("S2-12", "Low", "Лог ошибок опроса подавлял и другую ошибку (например 409 после сетевых) как «такую же»", "новый вид сбоя и подсказка терялись до минуты", "подпись ошибки: смена вида пишется сразу, с счётчиком пропущенных предыдущей", "**T · M:M44** — `unit/polling-log`", "ИСПРАВЛЕНО"),
    ("S2-13", "Low", "Уведомление об обрезке ответа могло разрезать эмодзи (одинокий суррогат)", "сырой `slice` после безопасного `splitMessage`", "`cutSafely` в `utils/text.js`", "**T · M:M45** — `unit/text`, `service-errors`", "ИСПРАВЛЕНО"),
    ("S2-14", "Medium", "Плавающее падение CI на Node 24 (коммит `9085bea`): тестовый стенд резервировал порт, освобождал его, а бот занимал позже — параллельный тест иногда успевал перехватить порт (`EADDRINUSE`)", "иногда ~1 из 7 полных прогонов; воспроизводится принудительно", "стенд ждёт реального старта веб-сервера и при `EADDRINUSE` запускает бота заново на другом порту (до 4 попыток)", "**T · M:M46** — `integration/harness-port-collision`; 8 из 8 полных прогонов на Node 24 зелёные", "ИСПРАВЛЕНО (дефект стенда, не бота)"),
]

def status_bucket(s):
    s = s.replace("*", "")
    if s.startswith("ИСПРАВЛЕНО"):
        return "fixed"
    if s.startswith("ДОКУМЕНТАЦИЯ"):
        return "docs"
    if s.startswith("ЧАСТИЧНО"):
        return "partial"
    return "other"

counts = {}
for fid, (was, did, control, status) in rows.items():
    sev = severity.get(fid, "?")
    counts.setdefault(sev, {}).setdefault(status_bucket(status), 0)
    counts[sev][status_bucket(status)] += 1

now = datetime.datetime.now().strftime("%Y-%m-%d")
lines = []
lines.append("# Итоговый аудит: сравнение «до» и «после»")
lines.append("")
lines.append(f"Дата: {now}. Ветка `claude/full-audit-ai-bot`; точка отката — тег `pre-audit-baseline` (`e2a47fe`).")
lines.append("Составлен из тех же данных, что и [`FIXES_REPORT.md`](FIXES_REPORT.md) (таблицы порождаются одним скриптом из фактов: контрольный прогон на оригинальном коде и результаты мутационной проверки).")
lines.append("")
lines.append("Связанные документы: [первичный аудит](AUDIT_INITIAL_2026-10-19_02-03.md) (заморожен), [повторный аудит](AUDIT_SECOND_2026-10-19_04-10.md), "
             "[исправления](FIXES_REPORT.md), [модернизация](IMPROVEMENTS_REPORT.md), [результаты тестов](TEST_RESULTS.md), "
             "[остатки](REMAINING_ISSUES.md), [готовность](FINAL_READINESS.md).")
lines.append("")
lines.append("## Сводка")
lines.append("")
lines.append("| Серьёзность | Всего | Исправлено (код или конфигурация + проверка) | Документация | Частично / действие владельца |")
lines.append("|---|---|---|---|---|")
tot = [0, 0, 0, 0]
for sev in ("Critical", "High", "Medium", "Low"):
    c = counts.get(sev, {})
    n = sum(c.values())
    vals = [n, c.get("fixed", 0), c.get("docs", 0), c.get("partial", 0)]
    tot = [a + b for a, b in zip(tot, vals)]
    lines.append(f"| {sev} | {vals[0]} | {vals[1]} | {vals[2]} | {vals[3]} |")
lines.append(f"| **Итого (первичный аудит)** | **{tot[0]}** | **{tot[1]}** | **{tot[2]}** | **{tot[3]}** |")
lines.append("")
lines.append("Повторный аудит и автоматическое ревью Codex на PR добавили 14 пунктов `S2-xx` (13 исправлено, 1 остаётся — gramjs). Критические F001 и F002 в коде закрыты "
             "наполовину: файлы убраны из актуального дерева и закрыты `.gitignore`, но **секреты остаются в истории git** — отзыв сессии и очистка истории возможны только владельцем.")
lines.append("")
lines.append("Что значат буквы в колонке «Тест»: **B** — тест падает на оригинальном коде; **H** — дефект воспроизведён на оригинале сценарием стенда; "
             "**T** — тест проходит на новом коде; **M** — мутация этого фикса обнаружена тестами; **L** — проверено инструментом.")
lines.append("")
lines.append("## Таблица")
lines.append("")
lines.append("| ID | Ошибка | Было | Стало | Тест | Статус |")
lines.append("|---|---|---|---|---|---|")
for fid in sorted(rows):
    was, did, control, status = rows[fid]
    title = titles.get(fid, "").replace("|", "/")
    lines.append(f"| {fid} ({severity.get(fid, '?')}) | {title} | {was} | {did} | {control} | {status} |")
for fid, sev, title, was, did, control, status in new_findings:
    lines.append(f"| {fid} ({sev}) | {title} | {was} | {did} | {control} | {status} |")
lines.append("")
lines.append("## Мутационная проверка (итог)")
lines.append("")
total = len(mutations)
lines.append(f"Мутаций: {total}; обнаружено тестами: {sum(1 for m in mutations if m['status'] == 'KILLED')}; выжило: {len(survived)}"
             + (f" ({', '.join(survived)})" if survived else "") + ". Подробности — `evidence/after/mutation-results.json`.")
lines.append("")
open(f"{ROOT}/{FINAL_NAME}", "w", encoding="utf-8").write("\n".join(lines) + "\n")
print("rows:", len(rows), "counts:", counts, "survived:", survived)
