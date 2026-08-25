# ТЗ: выборочное внедрение идей deepseek-harness

Источник: анализ github/deepseek-harness (dsh) от 2026-08-25. Берём не архитектуру
(Cordis/плагины — овер-инжиниринг для масштаба trcode), а четыре конкретных
механизма, каждый из которых закрывает существующую боль. Порядок этапов — по
цене/эффекту: сначала дешёвая прозрачность, потом режимы, потом PTC.

Non-goals: plugin-ядро, Web UI, agent teams/job board, смена формата session file.

---

## Этап 1. Лог проекции запроса («model-visible means logged»)

**Проблема.** Модель видит не `session.messages`, а результат `trimForRequest()` +
интержекции (skills через `interject`, `<design-reference>` uilib) + системный
промпт и схемы. После resume невозможно ответить, что именно видела модель на
шаге N. Это же пункт 3 диагноза TZ-token-optimization.md (непрозрачность) и база
для T4 (`/cost` по компонентам).

**Что делаем.**
1. Новый модуль `src/session/projection.ts`:
   ```ts
   interface RequestProjection {
     step: number; ts: number; model: string;
     systemTokens: number;      // промпт + env + workspace listing
     schemaTokens: number;      // tool-схемы
     historyTokens: number;     // после trim
     injected: { source: string; tokens: number }[];  // skill/design-reference/...
     trimmed: number;           // сообщений укорочено trim'ом
     cached?: number;           // cached_tokens из ответа, если провайдер отдал
   }
   ```
2. Точка записи — `runAgent` (`src/agent/loop.ts`) перед каждым `streamChat`:
   собрать проекцию (размеры считать через `estimateTokens` из usage.ts),
   дописать в `sessions/<id>.proj.jsonl` (append-only, рядом с session file).
3. Команда `/trace [n]` в `src/ui/commands.ts`: последние n проекций таблицей
   (step / system / schema / history / injected / saved-by-trim). Без аргумента —
   сводка последнего turn'а.
4. В `/cost` добавить разбивку fresh vs cached, если поле уже приходит из
   провайдера (T4 без новой работы с API).

**Приёмка.** После resume сессии `/trace` показывает корректные проекции прошлых
шагов; размер `.proj.jsonl` за сессию < 5% от размера session file; тест на то,
что запись не роняет turn при ошибке диска (как save() в session.ts).

---

## Этап 2. Пресеты инструментов: minimal-режим

**Что делаем.**
1. В `Config` (`src/config.ts`): `preset?: "standard" | "minimal"` (default
   standard). Minimal = `[shellTool, editTool]` + сокращённый системный промпт
   (без секций skills/memory/uilib-подсказок).
2. Сборка в `buildTools` (`src/tools/index.ts`): early-return ветка minimal,
   MCP/todo/task/skill/memory не подключаются. Subagent-вызовы наследуют пресет.
3. Переключение: флаг CLI `--preset minimal` и `/preset` в commands.ts с
   подтверждением (смена пресета mid-session меняет схемы → следующий запрос
   уйдёт с другой историей схем; предупредить, что кэш промпта сломается).
4. Промпт для minimal — отдельная короткая секция в `src/agent/prompt.ts`
   («у тебя два инструмента: shell и edit…»), чтобы модель не пыталась звать grep.

**Приёмка.** `--preset minimal` даёт первый запрос ≤ 2k токенов (базлайн из
TZ-token-optimization §1 минус половина схем); тест registry на состав списка;
тест prompt-test «stays small» остаётся зелёным (не трогаем основную секцию # Images).

---

## Этап 3. PTC (programmatic tool calling): инструмент `run_ts`

Самый дорогой этап; главный приз — удар по квадратичному росту (диагноз №1
TZ-token-optimization): одна программа вместо N шагов read→result→read, большие
дампы вообще не попадают в историю.

**Что делаем.**
1. `src/tools/codmode.ts`: инструмент `run_code` (имя нейтральнее, чем run_ts):
   - аргумент `code` — TypeScript/JS-программа; лимит как у MAX_ARGS_CHARS;
   - исполнение в **отдельном child process** `node --input-type=module` с
     таймаутом (конфиг `codeModeTimeoutMs`, default 60s) и kill по abort;
   - программе доступен только SDK-объект, переданный через stdin/bootstrap:
     `fs.read/write/list`, `shell(cmd)` (через тот же shellsnap-контекст прав),
     `web.fetch/search`. Никакого прямого import 'node:*' — блокировать нельзя
     надёжно, поэтому: процесс запускается с cwd проекта, но SDK — единственный
     канал ввода-вывода, а результат возвращается явно (`return`);
   - в историю попадает **только возвращённое значение** (cap тем же
     `boundToolOutput` из spill.js); stdout процесса не логируется целиком.
2. Инструмент выключен по умолчанию: `codeMode: true | "auto"` в конфиге;
   `"auto"` — включать только для моделей из allowlist (сначала те, что сами
   хорошо пишут код; список вести в provider/models.ts флагом `codeModeOk?`).
3. Схема инструмента содержит краткую доку SDK + пример («собери данные циклом,
   верни итог») — иначе модели будут писать print-debug вместо программы.
4. Промпт-гигиена: в системный промпт одну строку «for multi-step data gathering
   prefer run_code». Не больше — проверять по prompt-test.

**Приёмка.** Задача «найди все TODO в src и посчитай по файлам» решается за
1 шаг run_code вместо ~6 шагов read/grep; суммарный input по метрикам этапа 1
падает ≥ 3× на этом классе задач; падение процесса по таймауту возвращает
структурированную ошибку, turn продолжается; тесты: SDK-функции резолвят пути
внутри cwd, abort убивает child process, oversized return обрезается.

---

## Этап 4. Единый execution-world seam — ПЕРЕНЕСЁН в TZ-cloud-mode.md

Полностью перенесён как «Этап 0» в раздел 9 (Порядок внедрения)
TZ-cloud-mode.md: реализуется вместе с cloud-режимом, до Tier F. Кратко:
`src/exec/world.ts` с интерфейсом `{ readFile, writeFile, list, glob, grep,
runShell }`, `localWorld()` поверх fsutil/shell, инструменты files/search/shell
переводятся на world из ToolContext (1:1), будущий `remoteWorld()` = вторая
реализация того же интерфейса.

---

## Этап 5. Форк сессии из середины истории — СДЕЛАН

Реализовано:
- `Session.forkFrom(source, at)` (src/session/session.ts): копия истории до
  `at` с глубоким клонированием сообщений; срез доходит назад до границы turn,
  чтобы не оставлять висячих tool_calls/tool-результатов (правило trim).
  Оригинал не трогается. Заголовок форка получает суффикс « · fork».
- `/fork [turn|start|<индекс>]` в commands.ts: пикер по границам user-сообщений
  и чекпоинтам; выбор «перейти в ветку / остаться»; переход через
  `adoptSession` + `replayHistory`.
- Кнопка «Fork here instead» в choose внутри /rewind: ветка от выбранного
  чекпоинта без отката файлов.
- Тест test/fork-test.mjs (10 проверок): границы, целостность пар, независимость
  копий, сохранность оригинала на диске. Зарегистрирован в run-all.mjs.

---

## Порядок и зависимости

| Этап | Зависит от | Объём | Статус |
|---|---|---|---|
| 1. Проекция запросов | — | малый | ✅ сделан |
| 2. Minimal-пресет | — | малый | ✅ сделан |
| 3. PTC run_code | желателен 1 (метрики эффекта) | большой | ✅ сделан |
| 4. World-seam | → перенесён в TZ-cloud-mode.md, этап 0 | средний | перенесён |
| 5. Fork | — | малый | ✅ сделан |

Все этапы, остававшиеся в этом ТЗ, выполнены; world-seam живёт в ТЗ
cloud-синхронизации и делается вместе с ним.
