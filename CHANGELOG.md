# Changelog

All notable changes to TRCode are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the versioning is
[SemVer](https://semver.org/) while the client stays pre-1.0.

## [Unreleased]

## [0.2.0] — 2026-10-22

### Added

- **Подсказки о неиспробованных возможностях.** После обычного завершённого хода под
  ответом иногда появляется одна строка `tip — …`: `/brain`, `/uilib add`, `/swarm`,
  `/goal`, `/rewind`, `/fork`, `/trace`, `/preset minimal`, `/stat`, `/subagents`,
  `/compact` или `!` для команд оболочки. Не чаще одного раза за ход, никогда на
  первых двух ходах и во время цели, ни одна не повторяется между запусками
  (`config.tipsSeen`), а подсказка о том, что в сессии уже используется, пропускается.
  Какая именно — выбирается случайно из ещё не показанных и подходящих (раньше шли
  по порядку списка, и до `!`, `/stat` и `/subagents` дело почти не доходило). Ритм
  «каждый третий ход» считается по завершённым ходам (`App.turnsDone`), а не по
  user-сообщениям: автоскиллы, дизайны `/uilib`, steer-строки и `/brain` сбивали
  счёт, а `/compact` его обнулял. «Субагенты уже использовались» — это вызов
  инструмента `task`, а не слово `subagent` в выводе любого инструмента.
  Выключатель — `/tips off`, вернуть — `/tips on`, забыть показанное — `/tips reset`.
- **`!команда` выполняет команду в оболочке, не отправляя её модели.** Строка идёт
  через тот же инструмент `shell`, что и у агента: подтверждения, таймауты, живой
  хвост и Esc работают как в ходе, вывод печатается обычным блоком `Ran <cmd>`.
  Команда и её вывод добавляются в историю скрытым user-сообщением, поэтому
  следующий ход уже знает, что вы выяснили, а повторный показ сессии их не дублирует.
  Подсказка в строке статуса называет `!`, а при наборе строки с `!` она меняется на
  «выполнит в оболочке · модели это не уйдёт». Прежний смысл `!` («отправить мои
  слова без переписывания промпта») убран — для этого есть `/prompt off`.
- **Список команд работает и во время хода.** В баре под спиннером `/` открывает тот
  же список, что и в простое: фильтр по вводу, `↑↓` по строкам, Enter подставляет
  команду в строку; список держит высоту, пока сужается (`suggestionLines` общая для
  композера и бара). Строка, начинающаяся с `/`, при этом **не** уходит в текущий ход,
  а ставится в очередь — иначе модель прочитала бы `/model k3` как текст. Подсказка
  спиннера в этот момент говорит `enter to pick`, а на команде — `enter to queue the
  command`.

### Security

- **MCP-серверы из `.trcode/mcp.json` проекта больше не запускаются без спроса.**
  Раньше любой клонированный репозиторий с этим файлом исполнял указанную там команду в
  момент запуска `trc` в папке (а его инструменты могли ещё и объявить себе
  `approval: "auto"`). Теперь такие серверы ждут `/mcp trust`. Одобрение действует на
  эту папку и на ровно эту конфигурацию: любое изменение команды, аргументов или
  окружения требует одобрить заново (`config.mcpTrusted`, отпечаток `id + config`).
  При старте выводится предупреждение со списком, а `/mcp` показывает, что именно
  будет запущено. Серверы из глобального конфига пользователя запускаются как раньше.

### Fixed

- **Автообновление: `/update --check` только проверяет релиз.** Аргумент больше не
  теряется в обработчике команды и не запускает установку.
- **Автообновление проверяет диапазоны версий зависимостей.** Недостающие или
  несовместимые зависимости готовятся в отдельной копии `node_modules`; любая
  ошибка npm останавливает установку, даже если npm оставил `package.json`.
  Новая сборка и зависимости заменяются переименованиями на одном диске.
  При ошибке восстанавливаются оба каталога; если блокировка мешает и откату,
  резервные копии сохраняются, а ошибка указывает их расположение.
- **Многострочный ввод и история больше не накапливают пустые строки.** При
  уменьшении поля ввода освобождённые строки возвращаются сразу, а статус
  остаётся внизу экрана.
- **Рассуждение закрывается перед ответом.** Начальные пустые строки ответа
  пропускаются; перед текстом выводится разделитель `Ответ` (`Response` в
  английском интерфейсе) с одной пустой строкой под ним.
- **MCP: сессия Streamable HTTP, которую сервер забыл, теперь действительно
  восстанавливается.** На 404 клиент переинициализировался, но слал `initialize` со
  старым `Mcp-Session-Id`, и серверы на официальном SDK отвечали отказом. Теперь
  идентификатор сбрасывается, как требует спецификация.
- **MCP stdio: кириллица и эмодзи на границе чанков больше не превращаются в `�`.**
  stdout сервера декодировался по кускам; теперь потоком (`setEncoding`). Строки
  stderr тоже собираются целиком.
- **MCP на Windows: аргументы с `&`, `|`, `<`, `>`, `^`, `()` берутся в кавычки.**
  `npx mcp-remote https://host/sse?a=1&b=2` выполнял `b=2` как вторую команду cmd.
- **MCP: на серверный `ping` приходит пустой результат, а на `roots/list` — папка
  проекта.** Раньше на оба отвечалось «method not found», хотя клиент объявляет
  `roots`.
- **MCP: `structuredContent` больше не дублируется**, если сервер уже положил тот же
  JSON в текстовый блок (как советует спецификация).
- **MCP HTTP: ответ больше 8 МиБ сразу даёт понятную ошибку**, а не висит до
  таймаута.
- **`/sessions` и другие окна выбора больше не мигают при движении стрелками.** Окно
  стиралось и печаталось построчно; теперь кадр перерисовывается одной
  синхронизированной записью поверх старого. Перерисовки окна к тому же больше не
  попадают в журнал строк транскрипта и в счётчик прокрутки.
- **OAuth-вход через браузер не обрывается от лишнего запроса** на адрес callback
  без кода (повтор, prefetch).
- **Обновление OAuth-токена при нескольких сессиях `trc`.** Если другой процесс
  успел обновить токен первым, а хост отверг наш refresh-токен как использованный,
  берутся свежие данные с диска вместо требования войти заново (у ChatGPT это уже
  делала его блокировка профиля).
- **Список команд: курсор, ширина, Esc.** (1) После отрисовки панели над композером
  курсор оставался в колонке 1, левее `›`: каждая строка оверлея кончается переводом
  строки, а колонку каретки никто не возвращал. Теперь `paintOverlay` ставит её на место.
  (2) Ширина панели считалась по самой длинной строке, поэтому при фильтрации
  панель прыгала. Теперь она занимает ровно колонки полосы ввода: от левого края
  (без отступа поля) до правого. Во время хода под панелью была своя пустая строка
  плюс пустая строка над полосой — теперь одна, как в простое.
  (3) Во время хода Esc при открытом списке прерывал весь ход, а панель оставалась на
  месте бара. Теперь Esc закрывает только список, как в простое; следующий Esc и
  Ctrl+C прерывают ход, как раньше. Подсказка бара при открытом списке:
  «esc to close the list».
- **Список команд во время хода больше не оставляет дыру.** Бар рос на высоту
  списка (транскрипт уезжал вверх), а после закрытия сжимался, оставляя ~10 пустых
  строк над собой: рассуждение и спиннер проваливались вниз, бар выглядел как пустой
  композер, и казалось, что ход прервался. Теперь строки списка «заимствуются»
  (`setFooter(..., cover)` в `render.ts`): список рисуется поверх транскрипта над
  баром и при закрытии возвращает перекрытые строки из журнала строк, включая
  напечатанное за это время.
- **Первый ответ сессии больше не отделён от поля ввода тремя пустыми строками.**
  После первого сообщения заставка снимается (`dismissWelcome`) и поле ввода
  открепляется. Когда ход кончался, `readInput()` перемерял экран как при старте и
  забывал строки, которые держал бар, поэтому композер опускался вниз на разницу
  высот бара и композера (обычно 2 строки). Теперь долг бара сохраняется, и
  композер забирает его строки, как после любого следующего хода. Тест:
  `firstturn-test.mjs` (настоящий `App` против mock-сервера).
- **Журнал строк больше не держит зазор композера в хвосте.** Пустые строки, на
  которые композер опускался вниз (`noteBlankRows`), оставались «в конце» журнала
  навсегда, и весь последующий текст записывался перед ними, хотя на экране он
  ложится под ними. Всё, что восстанавливалось из журнала (список команд в простое и
  в ходе), рисовало пустоту поверх последних строк ответа. Теперь зазор
  «запечатывается», когда композер стирает свой кадр (`sealBlankRows`).
- **Метка спиннера (`thinking`, `continuing`, …) выделена цветом модели** из строки
  статуса (`brightCyan`), а не серым.
- **Пассивная проверка обновлений запускается ровно один раз и слушает
  выключатели.** `TRCODE_NO_UPDATE_CHECK` и `TRCODE_UPDATE_API` проверял только CLI,
  а старт сессии (App.init) держал свою копию условия — при выключенной проверке
  запрос всё равно уходил, а на чистой установке один и тот же GET уходил дважды
  (CLI + init). Теперь в `src/update.ts` один `passiveCheckEnabled(cfg)`, и вызывает
  его только `App.init()`.
- **Автообновление больше не может поставить сборку, которой не хватает
  зависимости.** Архив релиза несёт `dist` и `package.json`, но не `node_modules` —
  их ставит пакетный менеджер. Релиз, добавивший зависимость (так появился `sharp`),
  раньше подменял `dist` и оставлял `trc`, падающий на импорте при старте. Теперь
  `applyUpdate` сверяет `dependencies` из архива с установленными версиями
  (обход родителей, как у Node), и недостающие или несовместимые готовит сам —
  `npm install --no-save <dep>@<range>` в отдельном каталоге, через `npm-cli.js`
  рядом с node, без shell; `trc update` и `/update` показывают этот шаг. Если npm не смог,
  подмена не делается, а ошибка называет причину и точную команду
  (`npm install "sharp@^0.35.5"` в папке установки). Проверено на живом релизе:
  0.1.7 → 0.1.9 раньше давало `ERR_MODULE_NOT_FOUND: sharp` при каждом запуске,
  теперь `sharp` доставляется за ~8 с и `trc` стартует.
- **`sharp` грузится при первом использовании, а не при старте** (`src/tools/sharp.ts`).
  Клиенты до 0.1.9 обновляются старым кодом без проверки выше; следующий релиз,
  поставленный ими, всё равно запустится, а без `sharp` откажут только инструменты
  картинок — с подсказкой выполнить `/update`. `update-test.mjs` проверяет, что ни
  один модуль в `dist` не импортирует `sharp` статически.

### Changed

- **Перенос строк в поле ввода — по словам, а не по клеткам.** Длинное сообщение
  раньше резалось ровно на ширине полосы, и слово уезжало на следующую строку
  половиной («в cод» / «ex»). Теперь разрыв ставится после последнего пробела,
  который помещается; принудительно режется только то, у чего пробела нет вовсе —
  путь, base64, минифицированный JSON. Полоса ввода во время хода переносится так же.
- **Строки статуса под полем ввода идут до края полосы.** Раньше они укладывались
  в ширину текста чата, и правый край бара висел в восьми клетках от края терминала;
  теперь подсказка и `context:` прижаты к тому же краю, что и набранный текст, и бар
  читается как часть полосы, а не как отдельный абзац.
- **Enter во время хода направляет текущий ход, а не ждёт его конца.** Сообщение,
  набранное в нижней строке, пока модель работает, попадает в историю на ближайшей
  границе шага — после результатов инструментов и перед следующим запросом, — так что
  модель читает его и меняет курс, не теряя уже сделанного. Пока ход его не забрал,
  строка видна в баре как `⎿ steering:`. **Tab** отправляет сообщение отдельным ходом
  после текущего, как раньше; в панелях (`/brain`, `/orchestrate`, `/swarm`) и долгих
  командах шаговой границы нет, поэтому там Enter по-прежнему ставит в очередь.
  Прерванный ход (Esc) возвращает в редактор и steered-, и queued-строки.

## [0.1.9] — 2026-10-21

### Added

- **MCP: клиент стал полноценным.** Рядом со stdio появился Streamable HTTP
  (`url`, `headers`, `bearerToken`/`bearerTokenEnvVar`; legacy SSE намеренно не
  поддерживается). Ресурсы сервера видны модели тремя инструментами —
  `list_mcp_resources`, `read_mcp_resource`, `list_mcp_resource_templates`. Добавлен
  протокол 2026-07-28: режимы `legacy` (по умолчанию), `auto` (пробует
  `server/discover` и откатывается на `initialize`) и `2026-07-28` (каждый запрос
  несёт версию и клиентские capabilities в `_meta`). Для жирных серверов —
  `mcpToolSearch: true`: в запросе живёт один `find_mcp_tools`, а схемы найденных
  инструментов подключаются на следующем шаге того же хода. `/mcp` научился
  `restart <id>`, `stop` и `logs <id>`.
- **MCP: ресурсы и вложения вместо заглушек.** Блоки `image` из результатов теперь
  уходят модели как вложения, `structuredContent` — JSON-блоком, `resource_link` и
  встроенные ресурсы — текстом.
- **Google Gemini: ключ и (с предупреждением) вход по аккаунту.** `/login gemini`
  (или `/login google`) предлагает два пути. Ключ из AI Studio идёт через официальный
  OpenAI-совместимый шим `generativelanguage.googleapis.com/v1beta/openai`, каталог
  берётся у хоста. Аккаунт — это OAuth-клиент Gemini CLI против Code Assist
  (`cloudcode-pa.googleapis.com/v1internal`, формат `{model, project, request}`),
  проект определяется сам через `loadCodeAssist`/`onboardUser`; сессия
  `~/.gemini/oauth_creds.json` переиспользуется. Перед браузером печатается
  предупреждение: Google считает такой вход нарушением ToS и банит аккаунты с февраля
  2026 — ключ остаётся поддерживаемым путём.
- **Muse Wonder и Muse Spark 1.3 в Meta.** В опубликованный ростер добавлены
  `muse-wonder-1.0`, `muse-spark-1.3` и `muse-spark-1.3-contributor` (1M окна,
  Responses). `muse login` оставляет сессию в `~/.config/muse/auth.json` — `/login meta`
  переиспользует её (или лежащий там ключ) с предупреждением: подписка Muse Code
  рассчитана только на CLI Meta, и такое использование может её лишить.
- **OpenAI: ключ на платформе и подписка ChatGPT** — `/login openai`
  предлагает «Подписка / Ключ API». Подписка — браузерный OAuth (PKCE) под
  официальным клиентом ChatGPT; запросы идут на бэкенд ChatGPT с его служебными
  заголовками (`originator`, `OpenAI-Beta`, `ChatGPT-Account-Id`), аккаунт читается из
  `id_token`. Ключ — обычный `api.openai.com/v1`. Сессия стороннего CLI намеренно не
  переиспользуется: тот сервер ротирует refresh-токен, и обновление отсюда разлогинило бы
  его владельца. Только Responses и только стрим — так
  требует бэкенд; нестримовые вызовы (компакт, заголовки) собираются из стрима.
- **Вход в OpenCode Zen и OpenCode Go через аккаунт** — `/login opencode-go` и
  `/login opencode` предлагают «Подписка / Ключ API»; подписка — device flow OpenCode
  Console (тот же, что у самого opencode), без копирования ключа. Токен обновляется
  сам; `trc auth login --provider opencode-go --oauth` пропускает выбор.

### Changed

- **Автосжатие стало лестницей.** Раньше компакция включалась только на 90% окна и сразу
  теряла всё, кроме сводки и слов пользователя. Теперь по мере заполнения включаются три
  ступени: на 25% (`autoCompactLightAt`) — лёгкая чистка без вызова модели (старые
  результаты инструментов сжимаются до заголовка, старые размышления снимаются, последние
  ходы не трогаются); на 50% (`autoCompactMediumAt`) — конспект старой истории с
  сохранением рабочего хвоста (~12 сообщений) дословно; на 90% (`autoCompactAt`) — полная
  сводка как раньше. Ступени квотируются на цикл: **3 лёгких и 2 средних**, дальше
  лестница ждёт следующего порога вместо повтора ступени, иначе история, застрявшая чуть
  выше 25%, чистилась бы каждый ход и до 50% не дошла. Тройка — из `1/(1−φ)`, где φ — доля
  роста, приходящаяся на вывод инструментов: у кодовых ходов φ ≈ 2/3. Счётчики переживают
  перезапуск (лежат в session-файле), полная сводка открывает новый цикл. Выключить всё
  можно через `/compact auto off`, строку **Контекст** в `/settings` или `autoCompact: false`
  в config.json; `/compact` руками работает в любом случае.
- **MCP: схемы едут по бюджету, каталог остаётся живым.** `toolInputSchemaMaxBytes`
  (по умолчанию 5000) сжимает схему в три прохода: описания → `$defs` → глубокие
  объекты. `tools/list` читается по `nextCursor`, `notifications/tools/list_changed`
  перечитывает каталог (при ошибке остаётся прежний). Появились `enabledTools` /
  `disabledTools`, `approval` / `toolApprovals` (read-only тул с `auto` идёт как
  `read`), `outputLimit`, `startupTimeoutSec` / `toolTimeoutSec`, `enabled` /
  `required`.
- **Компакция переделана: handoff-summary вместо дайджеста.** Вместо дайджеста всей
  истории новая история — это handoff-summary плюс последние сообщения **пользователя**
  дословно (до 20k токенов; слишком большое обрезается с пометкой), а assistant-тёры и
  tool-трафик выпадают. Промпт — «CONTEXT CHECKPOINT COMPACTION», без
  инструментов, транскрипт вписывается в окно суммаризатора. Компакция проверяется и
  **между tool-раундами** внутри хода (не больше двух раз за ход); история при этом
  меняется на месте, чтобы агентский цикл продолжал отправлять живую. `/compact`
  использует те же правила.
- **Временный 503 больше не сдаётся через три быстрые попытки.** Транзиентные
  ответы хоста (503 «Endpoint is unavailable», 502/504/500) повторяются до
  `upstreamRetries` раз (по умолчанию 10) с паузой `upstreamRetryDelayMs` (10 с), и
  каждая пауза пишется в транскрипт с номером попытки — терминал сам досылает тот же
  запрос вместо того, чтобы отдавать ошибку человеку. Esc прерывает ожидание.

### Fixed

- **MCP: зомби-процессы, потерянные картинки, мёртвый каталог.** `stop()` убивал
  только лаунчер (`npx.cmd` оставлял живой node), теперь дерево снимается через
  `killTree`, а stderr дренируется после выхода. Блоки `image` больше не заменяются
  на «[image content omitted]». 404 на установленной HTTP-сессии переинициализирует
  её и повторяет вызов, Esc отправляет `notifications/cancelled`, рукопожатие и
  каталог ретраятся трижды (250 мс, 1 с), а упавший сервер перезапускается с
  backoff 1 с → 30 с.
- **Пиксели инструмента больше не теряются на gRPC-шлюзе.** Отказ «tool message
  content part 1 is not text; only text parts are supported on the gRPC path»
  относится только к tool-сообщениям, а вставленный пользователем скриншот такой хост
  принимает. Раньше первый откат выкидывал пиксели из результатов инструментов — ход
  выживал, но модель не видела того скриншота, ради которого вызвала `read_image`
  («не распознаёт скрин»). Теперь изображения инструмента переезжают в user-сообщение
  сразу после результата, с подписью «Output of read_image»; снятие пикселей со всей
  истории осталось вторым рубежом — на случай хоста, который не берёт картинки вовсе.
- **Esc прерывает и там, где нет хода.** Спиннер печатал «esc to interrupt» во всех
  местах подряд, но клавиатуру читал только TurnBar: браузерный вход (`/login openai`,
  `/login gemini`) висел минутами, а Esc не делал ничего. Появился `escWatch()` —
  подписка на Esc/Ctrl+C для ожиданий вне хода; им обвязаны оба OAuth-флоу (отмена
  через `AbortSignal` доходит до `pollForToken`/`webLogin`), поиск проекта Code Assist
  и обновление каталога моделей. Сам Spinner показывает подсказку только там, где её
  кто-то обслуживает.
- **400 «The `reasoning_content` in the thinking mode must be passed back» на
  сохранённой истории.** Если assistant-тёрн с tool_calls пришёл без thinking (сессия
  из версии до этого поля, смена модели посреди хода, синтезированная пара после
  правки истории), клиент получает 400 один раз, запоминает модель и досылает
  `reasoning_content: ""`, который хост принимает — вместо того чтобы отдавать ошибку
  человеку. Проверено живьём на `opencode-go:deepseek-v4.1-flash`: 400 → автоматический
  ресенд → 200.

## [0.1.8] — 2026-10-16

### Added

- **`ask_user_question`** — модель собирает 1–4 связанных решения в одной модалке: ↑↓ и
  Enter, Space для множественного выбора, свой ответ, «Назад», экран проверки и
  «Отправить». Esc отменяет ход без частичных ответов; вопросы параллельных агентов и
  запросы разрешений встают в очередь. В headless инструмент сообщает, что спросить
  нельзя.
- **`/orchestrate resume | status | replan`** — задача, план, результаты шагов и история
  каждого исполнителя сохраняются по ходу работы. Прерванную или упавшую работу можно
  продолжить, в том числе после `/resume`; `replan` пересматривает только незавершённые
  шаги.
- **`/subagents auto on|off`** — при выключенном auto запуск помощников спрашивает
  «Да / Нет / Включить авто». Явная просьба «запусти субагентов» разрешает один ход,
  явный запрет блокирует даже при auto. Если модели помощников не выбраны, после
  одобрения открывается выбор модели.
- **`resume_media`** — продолжает ожидание и загрузку существующего видео, восстанавливает
  удержанные картинки и звук без повторной оплаты. Платные генерации учитываются в
  стоимости сессии.
- `read_image` декодирует картинку через Sharp: уменьшенный превью до 1,6 МБ, `crop`,
  метаданные без пикселей; результат генерации сверяется с запрошенными размером,
  пропорциями, форматом и прозрачностью.

### Changed

- **Медиа больше не мусорит.** Результат сохраняется в каталог запуска
  (`image-<время>.png`, `video-….mp4`, `audio-….wav`), временные файлы — в `.tmp/`.
  Папка разовой генерации удаляется сразу после сохранения, рабочая область
  `prepare_media_workspace` — при выходе. Остаётся только папка с оплаченным, но не
  сохранённым результатом или незаконченным видео — до `resume_media`.
- Платные генерации разрешаются отдельно (`permissions.paidMedia`), разрешение сети их
  не покрывает. MCP-инструменты без пометки read-only требуют разрешения `write`.
- `src/ui/commands.ts` (4600 строк) разнесён по `src/ui/commands/*`.

### Fixed

- Исправлены все 25 воспроизведённых проблем аудита (`docs/audit/`): потеря файла при
  `/rewind` после ошибки бэкапа, очередь инструментов после Esc, обход разрешений и
  зависания в `run_code`, перезапись файла, изменённого во время подтверждения, выход за
  cwd через junction, CRLF, обрыв SSE в звуке, PCM вместо MP3, HTML вместо MP4,
  повторы polling, параметры xAI-видео, GIF-размеры, `~/` в путях и другие.
- Сессии сохраняются атомарно с резервной копией; оркестрация не считает успехом шаг,
  упёршийся в лимит или прерванный.
- Полоса разделов в панелях (`/fav`, `/brain`, `/model`) переносится на следующие строки,
  как и ряд кнопок: при десятке подключённых провайдеров хвост табов срезался рамкой и
  раздел нельзя было выбрать. Тест — `test/picker-test.mjs`.
- **Resume больше не читается кусками.** Восстановленная сессия прокручивается целиком:
  промпты, ответы (без потолка в 24 строки) и каждый вызов инструмента с именем
  цели и первыми строками вывода (`ctrl+o` — остальное). Раньше печатались только последние
  четыре хода, вызовы шли строками `tool({"json"…})` без вывода, а всё старшее сворачивалось
  в оглавление. Дайджест сжатия показывается первыми 20 строками с раскрытием. Тест —
  `test/resume-test.mjs`.

## [0.1.7] — 2026-10-01

### Added

- **Картинки, видео и звук прямо из чата.** Медиамодели не отвечают на
  `/chat/completions`, поэтому они подключаются как инструменты: чат-модель сама пишет
  промпт и вызывает `generate_image`, `generate_video` или `generate_audio`, а файл
  сохраняется в папке проекта. Каждая генерация платная и спрашивает подтверждение, как
  команда шелла; Esc прерывает ожидание.
- **`/image`, `/audio`, `/video model` — выбор модели в той же панели, что `/model`**:
  вкладки поставщиков, поиск, «Обновить», у картинок и звука ещё «Выключить». Там, где
  `/model` показывает контекст и цену, здесь строка возможностей — пропорции, разрешения,
  длительности, n, цена за секунду. Модель можно назвать и сразу: `/image seedream`,
  `/audio off`, `/image status`. Пока модель картинок или звука не выбрана, инструмента
  в чате нет и запросы не платят за его описание.
- **Поставщики**: OpenRouter — картинки (`POST /images`, 55 моделей, параметры
  сверяются с его каталогом), видео (`/videos`, 30 моделей) и звук (gpt-audio, Lyria);
  TokenRouter — картинки, видео (задачи new-api `/video/generations`) и звук по типам
  эндпоинтов из каталога; xAI по API-ключу — grok-imagine для картинок (с правкой по
  исходнику) и видео; Z.AI — glm-image, cogview и cogvideox-3. Выбранная модель хранится
  вместе с поставщиком (`tokenrouter:kling-v3`): от него зависит, какой API вызывается.
- **`/video` — режим видео.** Каждое сообщение становится заказом ролика: модель
  промптов (любая текстовая, `/video prompt_model`) смотрит вложенные картинки, пишет
  описание кадра с раскадровкой по секундам и вызывает видеомодель; допустимые
  длительности, разрешения и пропорции выбранной модели попадают в её системный промпт.
  `/video off` возвращает прежнюю модель сессии. Режим живёт до выхода из программы —
  после перезапуска он выключен, чтобы генерации не пошли сами.
- **Звук**: речевая модель читает текст дословно выбранным голосом и с заданной подачей,
  музыкальная получает бриф. Поток собирается из кусков base64, формат определяется по
  сигнатуре, голый PCM оборачивается в WAV.
- Ошибка поставщика разворачивается до его собственных слов: OpenRouter вкладывает
  ответ апстрима строкой в свой JSON, и вместо «HTTP 400: {"error":{"message":"HTTP 400:
  {\"error…» теперь видно `InvalidParameter: The parameter resolution is invalid`.
- Тесты: `test/video-test.mjs` (26 проверок) и `test/media-test.mjs` (37 проверок —
  все четыре поставщика на одном мок-сервере).

## [0.1.6] — 2026-09-23

### Fixed

- **OpenCode Zen и Go больше не отвечают 400 «Request is missing x-opencode-session».**
  Шлюз просит клиента присылать стабильный id разговора в `x-opencode-session` — по нему
  он держит один разговор на одном бэкенде и попадает в прогретый там кэш префикса — и
  без заголовка отказывается маршрутизировать запрос. Заголовок объявляется в реестре
  (`ProviderMode.sessionHeader`) и едет на каждом запросе к обоим режимам, включая
  пробу ключа при логине. Значение — хеш, а не локальный id сессии: он несёт в себе
  локальную дату, и вендору её знать незачем. Запросы без явного id (субагент, компакт,
  генератор заголовка) различаются по собственному префиксу промпта — ровно по тому,
  что шлюз и кэширует. Тесты в `test/provider-test.mjs` (8 проверок).
- `User-Agent` стал `trcode/<версия>` вместо безверсионного `trcode-cli`: Go просит
  клиента называть себя своим именем, а версия в нём — единственный способ для хоста
  отличить трафик одного релиза от другого.

## [0.1.5] — 2026-09-05

### Added

- **`/goal` — a persistent objective the agent keeps working toward** (по образцу Qoder
  CLI). `/goal <objective> [--turns <n>]` задаёт цель, и после каждого хода пользователя
  агент сам берёт следующий: цель повторяется вербатимом в промпте каждого goal-хода,
  модель объявляет завершение тегом `<goal-complete>`. Цель хранится в session-файле и
  переживает resume; встроенный лимит 25 ходов ставит её на паузу автоматически (`--turns`
  заменяет лимит, `/goal resume` выдаёт новый бюджет). Esc на goal-ходе — пауза, а не
  пропуск раунда; упавший ход тоже ставит паузу вместо вечного ретрая. Модуль
  `src/session/goal.ts`, команды `status | pause | resume | clear`.
- `src/session/goal.ts` — состояние цели (`Goal`, turnGate/spendTurn/completeGoal,
  goalPrompt/goalLine) и тесты `test/goal-test.mjs` (24 проверки) и
  `test/goal-live-test.mjs` (17 проверок, живой REPL на сценарном SSE-сервере).

### Fixed

- Модель сессии больше не подменяется при старте/фоновом обновлении каталога: если
  каталог пришёл без листинга нужного провайдера (фетч упал/таймаут), `reconcileModel()`
  теперь не трогает модель, а фолбэк предпочитает модель того же хоста — раньше сессия
  уходила на чужой хост и каждый ход умирал с 503 «No available channel».
  Тест `test/model-switch-test.mjs` (9 проверок).


### Added

- **Meta Model API** (`meta`, also `muse`) — the Muse line straight from the vendor:
  `https://api.meta.ai/v1` with a key from dev.meta.ai, requests on `/responses` (the
  dialect Meta documents for agent work, and the one Zen and Go already route these models
  to), the key-gated `GET /v1/models` as both catalog and login check, and
  `muse-spark-1.2` / `-contributor` / `1.1` as the published fallback at their real 1M
  windows. Prices are carried in the client — $1.25/$4.25 per 1M with $0.15 cached input,
  and a tenth of that for the contributor SKU, whose prompts may be used to improve Meta
  products — so `/cost` states the difference before the model is chosen. `muse-image` is
  marked as an endpoint this client does not speak rather than offered and failed on.
  There is no subscription mode: Meta's plans (Everyday / High / Power Usage) are scoped
  to the Muse Code CLI by its own documentation, and any key on the same account is billed
  pay-as-you-go — the same reason Claude Pro/Max is absent.
- `muse-*` now reads as a Meta model everywhere it is served (Meta, Zen, Go, OpenRouter),
  with the 1M window known without a catalog.

- **Favorites** — a star on any model (`/fav`, or the button in every chooser), kept in
  `favoriteModels`. The Favorites tab comes first in each panel and spans every connected
  host, so picking a starred model switches provider along with it; `favoritesAllProviders:
  false` narrows the tab to what the provider in use serves, and `/settings` carries the
  switch. `/fav` edits the whole set at once — Space marks, Enter saves, Clear all is its
  own button rather than an accidental Enter.
- **The model chooser is organised by provider**, not by modality: one tab per connected
  host with the session's first, lab sections inside each, and the provider column shown
  only where a list actually spans several hosts.
- **A `/swarm` roster you choose** — bare `/swarm` opens the panel, `/swarm models` picks
  who runs (`swarmModels`), and ★ pins the member that merges the answers
  (`swarmMainModel`). Nothing chosen keeps the old automatic pick: the session's model
  plus one model per other vendor.
- **`/subagents` is two modes rather than a list that can be wiped** (`subagentMode`):
  the session's own model, or the list you chose. Switching to the session's model keeps
  the list, so coming back costs one keystroke; `/subagents session` and `/subagents list`
  say it from the command line. `/orchestrate` shows that same shortlist to its planner —
  size and price included — and the plan on screen names the model each step will run on.
- **A loop guard in the agent loop**: the same tool call repeated verbatim is answered in
  the tool's own voice instead of being run a fourth time, and the turn is given up at the
  sixth. A model whose host refuses image input is now told so in the tool result — one
  real session had spent 158 consecutive steps re-reading the same PNG into a history that
  never showed it.

### Fixed

- The image fallback now works on every protocol. After a host refuses image content the
  pixels are stripped in `buildBodyFor`, before the dialect is chosen, so Anthropic
  Messages and Responses degrade to text like OpenAI chat did instead of resending the
  same images and earning the same 400 again.
- Self-update unpacks with the Windows system `tar` (`System32\tar.exe`, bsdtar) rather
  than whatever `PATH` offers first: a Git-for-Windows install puts GNU tar ahead of it,
  and GNU tar reads a `C:\...` archive path as `host:path` and fails on the user's own disk.
- The favorites editor no longer drops stars it cannot currently see. It preselects the
  saved set rather than the catalog-filtered one, so a provider that is logged out or
  still loading does not lose its favorites when Enter writes the set back.
- Modality tags are split on whitespace, not on the letter `s` — `/[,s]+/` turned "Speech"
  into "peech" and lost the modality.
- A failed orchestration step is named in the prompt of the steps that depend on it,
  instead of silently arriving as an empty context they build on regardless.
- The tool-result size cap no longer re-cuts a stub it already wrote, which fired the trim
  notice every turn on a history that never changed.
- The model count in the `/model` subtitle is read when the panel draws, so a catalog that
  lands behind the panel no longer leaves a stale number on screen.

## [0.1.3] — 2026-08-26

### Added

- **Self-update from GitHub Releases** (`src/update.ts`): `trc update [--check]` and
  `/update` download the newest release tarball, unpack it with the system `tar` and swap
  `dist` in place, keeping the old build until the new one lands. A passive startup check
  (`updateCheck: true`, at most one GET every six hours, off with
  `TRCODE_NO_UPDATE_CHECK`) only prints a note under the version in the header — nothing
  is ever applied by itself.
- **`/settings`** — a sectioned picker for the toggleable preferences: what the status
  line shows (`statusFields`: model, tokens, steps, time, speed), whether UI mockups
  match themselves automatically (`uilibAuto`, gates the auto-injection in
  `App.autoLoadDesign`), whether release checks run at all (`updateCheck`).
- **The main model of `/brain`** — "Make main" in the panel picker pins which panel member
  writes the final answer (`brainMainModel`, empty = the session's model).
- **Picker options** — `onOpen` lets the caller repaint an open panel (the model catalog
  re-fetches itself past the cache), `groupGap` puts a blank line before every section
  heading.
- New suites: `stat-test.mjs` (17 checks) and `update-test.mjs` (23 checks against a mock
  of the GitHub API and a fake tgz).

### Fixed

- The auto-retry after a connection drop no longer requires an empty buffer: a step that
  died mid-answer is resent too (up to three attempts). The partial text stays on the
  screen as a cut-off block; the resent step answers in a fresh one, and only that
  complete answer reaches the history — nothing half-said is ever sent back.
- `/stat` periods: the first usage row was cloned into the accumulator before being added,
  doubling the whole spend on every tab, and old sessions were filtered by their aggregate
  `lastUsed`, pulling everything into "Today". Daily buckets now carry each model's real
  per-day share, and the period filter slices them before the fold.
- A killed process tree could hang the shell tool forever: `taskkill` is fire-and-forget,
  and a surviving grandchild — a gradle daemon's java.exe — kept the stdout pipe open.
  After a kill the tool settles with what it captured after ten seconds instead of waiting
  for a `close` that never comes.
- Header repaints mid-session (model switch, an update notice) printed the startup logo
  again; they now reprint the fields alone in a compact box.

### Changed

- Provider lists read alphabetically: the registry, the hosts in `trc models`, the model
  catalog and the pickers. Pinned vendors lead where order carries meaning.
- `test/run-all.mjs` picks a free port per run and SIGKILLs a timed-out suite's whole
  tree, so two checkouts can test at once and an orphaned mock server no longer holds the
  port.

## [0.1.2] — 2026-08-25

### Added

- **`/trace [n]`** — the request projection log. What actually goes out differs from the
  stored history: trim shortens old results, skills splice in mid-turn. Every request
  appends one line to `<session-id>.proj.jsonl` — system prompt, tool schemas, history
  after trim, injections, what trim saved, the provider's cached-token count.
- **Tool presets** — `/preset minimal` (and `trc --preset minimal`) shrinks the session to
  `shell` + `edit` with a matching short prompt; `/preset standard` restores everything.
- **`run_code`** (opt-in: `"codeMode": true`) — the model writes one JavaScript program
  whose SDK calls (`sdk.fs.*`, `sdk.shell`, `sdk.web.*`) run in a child process; only the
  return value enters the conversation. Paths stay inside the project, shell and web
  confirm through the broker, writes are snapshotted for `/rewind`.
- **`/fork [turn]`** — branch the session at a past turn without undoing anything; also
  offered as "Fork here instead" in the `/rewind` menu.
- **`read_image`** — put a picture (PNG/JPEG/GIF/WebP/BMP, ≤1.6 MB) in front of a vision
  model as real image content; hosts that refuse images are remembered and get text.

## [0.1.1] — 2026-08-25

### Added

- xAI and Z.AI providers, `/stat` — a spend table with period tabs.
- The turn bar keeps its frame while the model thinks.

## [0.1.0] — 2026-08-23

First tagged release: multi-provider routing (TokenRouter, Kimi, Anthropic, OpenRouter,
OpenCode Zen, OpenCode Go, Alibaba Cloud), OAuth device flow, sessions with compaction
and checkpoints, skills, subagents, `/brain`, `/orchestrate`, `/swarm`, Orca support.
