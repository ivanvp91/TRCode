# TRCode v0.1.9 — двенадцать поставщиков, умное автосжатие, надёжный MCP

Крупный релиз: три новых поставщика (OpenAI, Google Gemini, Meta Muse), полноценный
MCP-клиент, компакция с тремя ступенями, автоповторы 503 и пачка исправлений, из-за
которых терминал «висел» или не видел скриншот.

## Added

- **OpenAI двумя путями** — `/login openai` предлагает «Подписка / Ключ API».
  Подписка — браузерный OAuth (PKCE) под официальным клиентом ChatGPT: служебные
  заголовки бэкенда (`originator`, `OpenAI-Beta`, `ChatGPT-Account-Id`, три
  session-заголовка), аккаунт читается из `id_token`. Бэкенд принимает только
  `/responses` и только стрим, не берёт `max_output_tokens`
  и требует `store: false` — это выражено флагами режима, а нестримовые вызовы
  (компакция, заголовки) собираются из стрима. Ключ — обычный `api.openai.com/v1`.
  Сессию стороннего CLI намеренно не переиспользуем: тот сервер ротирует refresh-токен.
- **Google Gemini** — `/login gemini` (или `/login google`). Ключ из AI Studio идёт через
  официальный OpenAI-совместимый шим. Вход по аккаунту — OAuth-клиент Gemini CLI против
  Code Assist (`{model, project, request}`, проект сам через `loadCodeAssist`/`onboardUser`,
  возобновляемая сессия `~/.gemini/oauth_creds.json`) с предупреждением: Google считает
  такое использование нарушением ToS. Ключ остаётся поддерживаемым путём.
- **Meta Muse** — `muse-wonder-1.0`, `muse-spark-1.3`, `muse-spark-1.3-contributor`
  (1M окна, Responses); `/login meta` переиспользует сессию `~/.config/muse/auth.json`.
- **OpenCode Zen и OpenCode Go через аккаунт** — device flow OpenCode Console, без
  копирования ключа; `trc auth login --provider opencode-go --oauth` пропускает выбор.
- **MCP стал полноценным**: Streamable HTTP рядом со stdio, протокол 2026-07-28
  (`legacy` / `auto` / `2026-07-28`), ресурсы тремя инструментами
  (`list_mcp_resources`, `read_mcp_resource`, `list_mcp_resource_templates`),
  `mcpToolSearch` с `find_mcp_tools` для жирных серверов, `/mcp restart|stop|logs`.

## Changed

- **Компакция — handoff-summary плюс последние сообщения пользователя** дословно,
  между tool-раундами внутри одного хода, история меняется на месте.
- **Автосжатие стало лестницей.** 25% окна — лёгкая чистка без вызова модели (старые
  результаты инструментов и размышления), 50% — конспект с сохранением рабочего хвоста,
  90% — полная сводка. Ступени квотируются на цикл: **3 лёгких и 2 средних**, чтобы
  история, застрявшая чуть выше порога, не чистилась каждый ход и дошла до следующей
  ступени; полная сводка открывает новый цикл, счётчики лежат в сессии.
  Выключатель: `/compact auto off`, строка **Контекст** в `/settings` или
  `autoCompact: false` в config.json.
- **Временный 503 больше не сдаётся** — до 10 повторов с паузой 10 с
  (`upstreamRetries`, `upstreamRetryDelayMs`), каждая пауза с номером попытки в
  транскрипте; Esc прерывает ожидание.
- **MCP: схемы едут по бюджету** (`toolInputSchemaMaxBytes`), каталог обновляется по
  `list_changed`, появились `enabledTools` / `disabledTools`, `approval`, `outputLimit`,
  `startupTimeoutSec` / `toolTimeoutSec`.

## Fixed

- **Пиксели инструмента на gRPC-шлюзе.** Отказ «only text parts are supported on the gRPC
  path» относится только к tool-сообщениям: картинки инструмента теперь переезжают в
  user-сообщение с подписью, и модель видит скриншот, ради которого вызвала `read_image`.
- **Esc прерывает и вне хода** — `escWatch()` для OAuth-входа, поиска проекта Code Assist
  и обновления каталога; Spinner обещает клавишу только там, где её кто-то слушает.
- **400 «The `reasoning_content` … must be passed back»** — клиент ловит его один раз на
  модель и досылает пустое поле вместо падения хода.
- **MCP: зомби-процессы, потерянные картинки, мёртвый каталог** — дерево процессов через
  `killTree`, image-блоки доходят до модели, 404 сессии переинициализируется и повторяет
  вызов, упавший сервер перезапускается с backoff.

## Install

```sh
npm install -g trcode-0.1.9.tgz
```
