---
name: deep-research
description: Multi-step research on a topic — decompose the question into sub-questions, fan out subagents to search and read the web, reconcile conflicting sources, deliver a cited report. Expensive (many web_search/fetch calls, subagents), so it never fires automatically — only when the user explicitly asks for deep research, a full investigation, or a research report on a topic.
description_ru: Многошаговое исследование темы — разложить вопрос на подвопросы, разослать субагентов искать и читать веб, свести противоречия источников, собрать отчёт со ссылками. Дорого (много web_search/fetch, субагенты), поэтому никогда не включается автоматически — только когда пользователь прямо просит глубокое исследование, полное расследование или отчёт по теме.
triggers: deep research, глубокое исследование, расследование, полное исследование, research report, исследовательский отчёт, изучи тему, investigate the topic, dig into
auto: off
---

# Deep research

## 1. Pin down the question
Restate the topic in one sentence and name what a good answer looks like: a decision to make, a comparison, a state of the art, a market overview. If the ask is broad ("research AI agents"), confirm the scope once — one clarifying question, not a questionnaire.

## 2. Decompose before searching
Break the question into 3–6 independent sub-questions whose answers compose into the final report (e.g. for "should we adopt X": what it is and who uses it · alternatives and how they compare · known costs and failure cases · current state and momentum). Write the plan as a todo list so the user sees the shape of the work.

## 3. Fan out subagents, one wave per dependency level
Sub-questions that don't depend on each other go to parallel `task` subagents in one wave; each subagent gets a self-contained assignment: its sub-question, which tools to use (`web_search` for discovery, `fetch` on the promising URLs), and the required return format — **facts with their source URLs and dates**. A wave that depends on a previous wave's output waits for it.

Cap the whole effort: up to 2 waves, ≤ 6 subagents total, ~15 fetched URLs. Hitting the cap with gaps left open is acceptable — name what was not covered.

## 4. Reconcile, don't average
Merge subagent returns into one fact base:
- Corroborated by 2+ independent sources → stated as fact.
- Single-source or contradictory → stated with attribution ("Source A claims X, Source B claims Y") and the likely reason for the split (dates, vested interest, methodology).
- Recency matters: prefer the newer source when they conflict, and say the report's "as of" date.

Never blend contradicting sources into a vague sentence that hides the disagreement — the disagreement is a finding.

## 5. Write the report
A markdown file in the project (`research/<topic>.md` or the user's preferred location), then a short summary in chat:
1. **Answer first** — the bottom line in 3–5 sentences, not "here is what I found".
2. **Findings** — per sub-question, every claim carrying its source link; primary sources quoted over aggregators.
3. **Disagreements and caveats** — what sources dispute, what could not be verified.
4. **What was not covered** — the gaps from the caps in §3.

## What not to do
- Do not run this machinery for a question one `web_search` answers — that is not deep research, just search it.
- Do not trust one source on a contested fact, and never present a fetched page's marketing claims as independent evidence.
- Do not pad the report with boilerplate ("in today's fast-paced world…") — every paragraph must carry a fact or a judgement.
- Do not invent a number, date or quote when sources lack it — write that it was not found.

## Answer format
In chat: the bottom line, then key findings as a compact bulleted summary with the 3–5 most load-bearing links, then the path to the full report file.
