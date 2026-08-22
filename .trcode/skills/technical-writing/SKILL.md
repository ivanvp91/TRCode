---
name: technical-writing
description: Write or rework documentation — README, quickstart, API reference, changelog, migration guide, docstrings, release notes. Use whenever the deliverable is prose about how something works rather than the code itself.
description_ru: Написать или переработать документацию — README, быстрый старт, справочник API, changelog, гайд по миграции, докстринги, заметки к релизу. Всегда, когда результат — текст о том, как что-то работает, а не сам код.
triggers: документация, доки, docs, documentation, readme, ридми, changelog, чейнджлог, release notes, гайд, guide, tutorial, туториал, docstring, api reference, migration guide, опиши как работает
---

# Technical writing

## 1. Fix the reader and the job
One sentence before writing: *who* is reading and *what they must be able to do afterwards*. A quickstart for a newcomer and a reference for an integrator are different documents; merging them ruins both.

## 2. Get the facts from the code, not from the old docs
Read the actual entry point, flags, defaults, and error messages. Run the command you are about to document. Every example you publish must be one you have executed — wrong examples destroy trust faster than missing ones.

## 3. Structure that works
- **Opening**: what this is and what problem it solves — two sentences, no marketing.
- **Install / setup**: the shortest path that ends in something working.
- **First success**: one copy-pasteable example with its real output.
- **Then** the details: options, configuration, edge cases, reference tables.
- **Troubleshooting**: the three failures people actually hit.

Put the common case first and the completeness last. Headings should be scannable — a reader who reads only headings should still find their section.

## 4. Sentence-level rules
- Present tense, active voice, second person: "run `x`", not "the command may be run".
- Concrete over abstract: exact flag names, exact paths, exact versions.
- One idea per sentence; cut every "simply", "just", "of course", "powerful", "seamless".
- Tables for options; prose for reasoning; numbered lists only for ordered steps.
- Code blocks with a language tag, and separate the command from its output.

## 5. Changelogs and release notes
Group by **Added / Changed / Fixed / Removed**. Each line is what the user notices, not the commit subject. Breaking changes go first with the migration in the same bullet.

## What not to do
- Do not document intentions or roadmap as if shipped.
- Do not paste generated help text and call it a guide.
- Do not explain the code line by line — explain the decisions and the usage.
- Do not leave TODOs in published docs.

## Answer format
The document itself, in Markdown, ready to commit. Then a short list of claims you could not verify from the code, so the user can confirm or correct them.
