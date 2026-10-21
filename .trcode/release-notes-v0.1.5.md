# TRCode v0.1.5

## Added

- **`/goal` — a persistent objective the agent keeps working toward** (по образцу Qoder
  CLI). `/goal <objective> [--turns <n>]` задаёт цель, и после каждого хода пользователя
  агент сам берёт следующий:

  ```
  /goal make npm test green          # set it; the agent continues after each of your turns
  /goal rewrite docs --turns 10      # with an explicit budget
  /goal                              # status: the mark, the objective, turns spent
  /goal pause                        # stop the automatic continuation (Esc does the same)
  /goal resume                       # continue; a spent budget is granted anew
  /goal clear                        # remove it
  ```

  Цель повторяется вербатимом в промпте каждого goal-хода (*assess the state, do the next
  concrete step, verify the result*), и только модель объявляет завершение — тегом
  `<goal-complete>` в конце ответа. Цель хранится в session-файле и переживает restart и
  `-c`/`--resume`; метка цели (◉ active, ◎ paused, ✓ complete) живёт в статусной строке.
  Всё, что вы печатаете между goal-ходами, проходит первым — вопрос, правка, `/goal pause`
  во время хода срабатывают, а не ждут раунда. **Esc ставит цель на паузу**, а не пропускает
  раунд; упавший на сети ход тоже ставит паузу — безнадзорный цикл не должен вечно ретраить
  в мёртвый хост. Без `--turns` действует встроенный лимит **25 ходов** — пауза
  объявляется один раз, `/goal resume` выдаёт новый бюджет. Новый модуль
  `src/session/goal.ts`; тесты `test/goal-test.mjs` (24) и `test/goal-live-test.mjs` (17,
  живой REPL на сценарном SSE-сервере).

## Fixed

- Модель сессии больше не подменяется при старте или фоновом обновлении каталога: если
  каталог пришёл без листинга нужного провайдера (фетч упал или таймаут), модель не
  трогается, а фолбэк предпочитает модель того же хоста. Раньше сессия уходила на чужой
  хост, и каждый ход умирал с 503 «No available channel». Тест `test/model-switch-test.mjs`
  (9 проверок).

## Numbers

- 59 test suites, all green (was 56 in v0.1.4).
- Full changelog: [CHANGELOG.md](CHANGELOG.md).
