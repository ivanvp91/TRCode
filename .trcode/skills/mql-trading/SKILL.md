---
name: mql-trading
description: Write or debug MQL4/MQL5 code — expert advisors, indicators, scripts — and design the trading logic behind them: entries, exits, position sizing, risk rules, backtesting. Use when the task mentions MetaTrader, an EA, an indicator, or a trading strategy.
description_ru: Написать или отладить код на MQL4/MQL5 — советники, индикаторы, скрипты — и спроектировать торговую логику: входы, выходы, размер позиции, риск-правила, бэктест. Используй, когда речь о MetaTrader, советнике, индикаторе или торговой стратегии.
triggers: mql, mql4, mql5, metatrader, метатрейдер, советник, expert advisor, торговая стратегия, trading strategy, бэктест, backtest, стоп-лосс, stop loss, тейк-профит, take profit, OnTick, iCustom
---

# MQL4/MQL5 coding and trading logic

## 0. Pin down the target first
MQL4 and MQL5 are different languages pretending to be the same one. Before writing a line, establish:
- **MQL4 or MQL5?** Ask if not stated; look at the file extension folder (`MQL4/Experts` vs `MQL5/Experts`) or API calls (`OrderSend` with 11 args and `OrderSelect` loops → MQL4; `CTrade`, `PositionSelect`, `MqlTradeRequest` → MQL5).
- **Netting or hedging account** (MQL5 only) — position logic differs completely.
- **What kind of program**: EA (`OnTick`), indicator (`OnCalculate`), script (`OnStart`), service. Never mix trade calls into an indicator — indicators cannot trade.

## 1. Strategy before code
When asked for a strategy or an EA "that makes money", first write the rules in plain language and get them confirmed:
- Entry condition (signal + filter), exit condition (SL, TP, trailing, signal-based), and what happens when both fire at once.
- Timeframe and symbol assumptions; whether it acts on the open of a new bar or every tick. Default to **new-bar logic** — tick-level logic is rarely intended and untestable in "open prices only" mode.
- Position sizing: fixed lot, percent risk (`lot = risk_money / (SL_points * tick_value)`), or martingale-style. If the user asks for martingale/grid without stop rules, warn once about ruin risk, then implement what they asked.
- One trade per signal or pyramiding; max open positions; magic number to isolate this EA's trades.

## 2. MQL correctness rules (where EAs actually break)
- **New-bar detection**: compare `iTime(_Symbol, _Period, 0)` against a stored value. Do not use `Volume[0] == 1`.
- **Indicator values**: in MQL5, create handles in `OnInit`, check for `INVALID_HANDLE`, use `CopyBuffer` and check its return. In MQL4, call `iMA(...)` etc. directly but never with shift 0 for signals — use closed bars (shift 1+) to avoid repainting entries.
- **Order/position mismatch**: in MQL4 loop `OrdersTotal()` **downwards** when closing/modifying. In MQL5 loop `PositionsTotal()` and select by ticket; remember pending orders and positions are separate worlds.
- **Prices and normalization**: normalize with `_Digits`; respect `SYMBOL_TRADE_STOPS_LEVEL` and `SYMBOL_TRADE_FREEZE_LEVEL` before placing SL/TP; account for 3/5-digit brokers when the user says "pips" (1 pip = 10 points there).
- **Check every trade call's return value** and log `GetLastError()` / `MqlTradeResult.retcode`. Handle requotes and `TRADE_RETCODE_REQUOTE`/`ERR_REQUOTE` with a bounded retry, not an infinite loop.
- **Sizing**: clamp lots to `SYMBOL_VOLUME_MIN/MAX/STEP`; check `AccountFreeMargin`/`OrderCalcMargin` before sending.
- **State**: EAs restart (recompile, terminal restart, VPS reboot). Recover state from open positions filtered by magic number, not from global variables alone.
- Make every tunable an `input`; give sane defaults; comment units (points vs pips vs price).

## 3. Backtest honestly
- Say which mode the logic supports: "Every tick" needed for tick logic and trailing; "Open prices only" acceptable only for pure new-bar EAs.
- Warn about the classic frauds: using shift-0 indicator values (repainting), `Close[0]` in decisions, taking profit inside the same bar the entry happened (bar interpolation lies), optimizing 20 parameters on 6 months of data.
- Recommend: model spread and slippage above zero, walk-forward split (optimize on one period, validate on the next), and reporting max drawdown and trade count — not just profit.

## 4. Deliverable shape
- One complete compilable `.mq4`/`.mq5` file unless the user has an include structure; put strategy rules in a header comment.
- State where to put it (`MQL5/Experts/...`), that it must be compiled in MetaEditor (F7), and any inputs the user must set (magic, risk %, symbol assumptions).
- If the MetaTrader MCP tools are available in the session, they can be used to check symbols, prices, and account state against the real terminal — but never place live orders unless the user explicitly asks.

## What not to do
- Do not promise profitability or invent backtest numbers.
- Do not silently convert between MQL4 and MQL5 idioms — the result compiles in neither.
- Do not hardcode a symbol, digits, or point value when `_Symbol`/`_Digits`/`_Point` exist.
- Do not add trailing stops, breakeven, or news filters the user did not ask for; offer them as options at the end.

## Answer format
- The strategy rules as implemented, in 3–6 plain-language bullets (so the user can spot a misunderstanding).
- The full code, then compile/run instructions.
- Known limitations: what the backtest mode can and cannot validate, and which inputs most need optimization.
