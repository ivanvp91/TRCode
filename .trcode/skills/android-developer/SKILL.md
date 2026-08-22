---
name: android-developer
description: Build an Android app through the full cycle from zero — project setup, Compose UI, app logic and state, networking with a backend (auth, errors, offline), local storage, testing, and a release build. Use for any Android/Kotlin app work, from a new app to adding screens or wiring an API.
description_ru: Создать Android-приложение полным циклом с нуля — настройка проекта, UI на Compose, логика и состояние, работа с backend-сервером (авторизация, ошибки, офлайн), локальное хранилище, тесты и релизная сборка. Для любой работы над Android/Kotlin приложением — от нового приложения до новых экранов и подключения API.
triggers: android, андроид, kotlin, котлин, jetpack compose, compose, android приложение, приложение для android, мобильное приложение, mobile app, apk, gradle, viewmodel, retrofit, ktor, room, hilt, google play, play market, плей маркет, android studio, эмулятор, emulator, coroutines, корутины
---

# Android developer: full cycle from zero

## 0. Scope the app before the project
One exchange to pin down: what the app does (3–5 core screens, named), who the backend is (existing API with docs / to be designed / none — local-only), min SDK (default 26+), and whether Play Store release is the goal or a working APK is enough. Then name the screens and the data each one shows — that list drives everything below.

## 1. Project setup: boring and standard wins
- Kotlin + Jetpack Compose + Material 3, Gradle Kotlin DSL with a version catalog (`libs.versions.toml`). Single module until the app has 5+ features; premature modularization is scope creep.
- Standard package layout: `ui/` (screens, theme), `data/` (repositories, network, db), `domain/` (models, use cases only when logic outgrows ViewModels), `di/`.
- Dependencies by default: Hilt (DI), Retrofit + kotlinx.serialization or Ktor client, Room, DataStore (settings), Coil (images), Navigation Compose. Add nothing speculative.
- Verify the empty app builds and runs before writing features — toolchain problems found late cost days.

## 2. Architecture: one pattern everywhere
Unidirectional data flow, the same shape on every screen:
- **Screen** (Composable) renders a `UiState` and sends events up; it holds no logic and no data fetching.
- **ViewModel** owns a `StateFlow<UiState>`; `UiState` is a data class or sealed interface with explicit `Loading / Content / Error` — an error state carries a retry action, not just a message.
- **Repository** is the only source of data for ViewModels; it decides between network and cache. UI never touches Retrofit or Room directly.
- State survives rotation for free via ViewModel; anything that must survive process death goes in `SavedStateHandle`.

## 3. UI on Compose
- Theme first: colors/typography/spacing in one `Theme.kt` from Material 3 tokens, light + dark from day one — retrofitting dark theme is misery.
- Stateless composables: state hoisted to the ViewModel, previews (`@Preview`) for every screen in both themes with fake data.
- Lists are `LazyColumn` with stable `key`s; images via Coil with placeholder and error drawables.
- Every screen designs its four states, not one: loading (skeleton or indicator), content, empty ("nothing here yet" + the action), error (message + Retry). Follow the ui-design skill's rules when it is loaded; otherwise keep to Material 3 defaults rather than inventing a design language.

## 4. Talking to the backend
- Define the API surface first: endpoints, request/response DTOs, auth scheme. DTOs are separate from domain models — map at the repository boundary, so a backend rename doesn't ripple through the UI.
- All calls are `suspend` functions from coroutines; never block the main thread; `Dispatchers.IO` lives in the repository/data layer, not in ViewModels.
- **Errors are a type, not an exception**: wrap calls into a `Result`-like sealed type (`Success / HttpError(code) / NetworkError`) in the repository. 401 triggers token refresh or logout, 4xx shows the server's message, 5xx and timeouts show Retry.
- Auth: tokens in `EncryptedSharedPreferences`/DataStore (never SharedPreferences plaintext, never hardcoded), attached via an interceptor; refresh handled once in an Authenticator, not per-call.
- If the backend doesn't exist yet, design the JSON contract in the answer and build against a fake repository first — the app is testable before the server is ready.

## 5. Local data and offline
- Room for anything shown as a list the user will reopen; DataStore for flags and settings.
- Default pattern where offline matters: **database is the source of truth** — UI observes Room via Flow, network refreshes the database, pull-to-refresh forces it. State the sync policy explicitly (on open? periodic? push?).
- Show stale data with a "last updated" mark rather than a spinner over a blank screen.

## 6. Quality gates
- Unit-test ViewModels (state transitions per event) and repositories (mapping, error wrapping) with fake data sources — no mocking framework needed for interfaces.
- One happy-path UI test per critical flow if the project has UI tests at all; do not build a test pyramid for a prototype.
- Before calling any step done: `./gradlew assembleDebug` compiles clean and the app runs on an emulator/device through the changed flow.

## 7. Build order: runnable at every step
1. Empty app with theme + navigation skeleton between placeholder screens — builds and runs.
2. First screen fully vertical: UI → ViewModel → repository with fake data. All four UI states visible.
3. Real backend wired for that screen (or the fake contract, if no server yet); auth flow if required.
4. Remaining screens repeat the pattern.
5. Local cache/offline where the scope demands it.
6. Polish: app icon, splash, empty/error copy, back behaviour, R8/proguard for release, signed build.
Each step ends with the app running; never two broken layers at once.

## What not to do
- No XML layouts, LiveData, AsyncTask, or God-Activities in new code — Compose + ViewModel + Flow.
- No premature multi-module, no use-case classes that only forward a repository call, no abstractions for a single implementation.
- Never ship secrets in code or `BuildConfig` for a public app; never trust client-side validation alone.
- Do not swallow exceptions into empty catches or `Log.d` — every failure reaches the UI as a state.
- Do not claim it works without a compile and a run.

## Answer format
1. The screen list + data map and the confirmed stack (one short block, before building).
2. Per build step: what was added, the code, and how to run/verify it (gradle command, what to tap).
3. The API contract (endpoints + DTOs) whenever backend work is involved.
4. Known cut corners and what the next step would be.
