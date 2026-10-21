---
name: dispatching-parallel-agents
description: Split a large or multi-part task across parallel subagents (task tool / orchestrator) — when to fan out, how to write self-contained assignments, how to merge results. Use for "распараллель задачу", "use subagents", big sweeps (many files, many pages, many hypotheses), independent research angles, or anything that would mean many sequential similar steps.
description_ru: Разбить крупную или многочастную задачу между параллельными субагентами (task tool / orchestrator) — когда стоит фанануть, как писать самодостаточные задания, как сводить результаты. Для «распараллель задачу», «use subagents», больших обходов (много файлов, страниц, гипотез), независимых исследовательских углов и всего, что разворачивается в много однотипных последовательных шагов.
triggers: распараллель, параллельно, parallel, subagents, субагенты, use agents, fan out, несколько агентов, разбей по агентам, делегируй, delegate, orchestrator, оркестратор, swarm, рой, одновременно проверь, many files, весь проект проверить, обойди все
---

# Dispatching parallel agents

## 1. Fan out only when it pays
Parallel subagents are for work that is (a) decomposable into independent chunks and (b) heavy enough that sequential doing wastes time or context — a sweep over many files, N candidate hypotheses to check, independent research angles, per-module reviews. A task one grep or one read answers does not get agents. Context is the real currency: each subagent returns only its conclusion, keeping the bulky intermediate reading out of the main thread — that benefit survives even when the work itself is not that heavy.

## 2. Split along independence lines
Cut the work so chunks share nothing mutable: per directory/module, per file group, per hypothesis, per source topic. Two agents editing one file, or one agent's input being another's output, is not parallelism — that is a race. Sequential dependencies become waves: wave 1 the independent chunks, wave 2 the chunks that needed wave 1's findings. If almost everything depends on almost everything else, do it yourself.

## 3. Write each assignment self-contained
The subagent sees nothing of this conversation. Every prompt carries:
- The **goal** and the **exact return format** ("a list of `path:line` with a one-line reason each", "facts with source URLs") — a report format is not a nicety, it is what makes merging possible.
- Where to look: paths, patterns, commands known to work — and the repo's conventions it must follow.
- The boundaries: what not to touch, what is out of scope, "do not modify files" for read-only reconnaissance.
- Enough context to judge relevance (what the overall task is), but not the whole story — bulk belongs in the return format, not the prompt.

Emit all agents of a wave in one message — they run concurrently.

## 4. Merge with judgment, not by concatenation
Treat returns as claims, not truth: spot-check load-bearing findings before acting on them (a `grep` for the claimed `path:line`, running the one command that matters). Reconcile overlaps explicitly; where agents disagree, say so and resolve it — do not average. The user sees one synthesis: findings per area, then the conclusions and next actions, not N stapled reports.

## 5. Cost discipline
Agents per wave: as many as there are genuinely independent chunks, usually 2–5. Sequential rounds when a round's findings change the next round's questions — otherwise one wave. If a subagent's half of the work turns out trivial, doing the other half yourself is fine; the plan serves the task.

## What not to do
- Do not delegate the decision — subagents gather and report; choices and edits to the shared plan stay with you.
- Do not send an assignment that says "look at the code and tell me stuff" — a vague prompt returns vague prose.
- Do not have two agents write to the same files; merge file edits yourself from their reports.
- Do not hide a wrong merge: if two returns contradict, the answer names the conflict, not a compromise sentence.

## Answer format
The split (what went to how many agents, in how many waves) → the merged findings per area → the conclusions and proposed next actions, flagging anything unverified.
