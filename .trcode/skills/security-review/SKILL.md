---
name: security-review
description: Review code or changes for security vulnerabilities — injections, XSS, auth/session flaws, secrets in code, SSRF, path traversal, insecure dependencies — with severity ranking and concrete fixes. Use for "проверь безопасность", security audits, or before releasing anything that faces the internet.
description_ru: Проверка кода или изменений на уязвимости — инъекции, XSS, ошибки авторизации и сессий, секреты в коде, SSRF, path traversal, небезопасные зависимости — с ранжированием по серьёзности и конкретными исправлениями. Для «проверь безопасность», аудитов и перед выпуском всего, что смотрит в интернет.
triggers: безопасность, security, уязвимость, уязвимости, vulnerability, xss, sql injection, sql-инъекция, инъекция, csrf, ssrf, секреты, secrets, утечка данных, аудит безопасности, security review, security audit, pentest, пентест, эксплойт, exploit, авторизация, oauth, jwt, path traversal, cve
---

# Security review

## 0. Scope and threat model first
State what is being reviewed (diff, file, whole app), what it exposes (internet-facing? authenticated? handles money/PII?), and who the attacker is (anonymous user, logged-in user, insider). A local CLI tool and a public payment form get different depth — say which level applies.

## 1. Hunt in priority order
Work down this list against the actual code, not from memory of it:
- **Injection**: SQL/NoSQL built by string concatenation (fix: parameterized queries, always), shell commands with user input (fix: no shell, argument arrays), template injection, `eval`-family.
- **XSS**: user content rendered without escaping (innerHTML, v-html, dangerouslySetInnerHTML, unescaped PHP echo); fix at output with context-aware escaping, CSP as the second layer.
- **AuthZ over AuthN**: every endpoint/action checked — not just "is logged in" but "may THIS user touch THIS object" (IDOR is the most common real-world hole). Look for object IDs taken from request without ownership checks.
- **Secrets**: keys/tokens/passwords in code, configs committed to git, logs printing credentials; check git history if a secret is found (rotation, not just deletion).
- **Session/tokens**: cookies without HttpOnly/Secure/SameSite, JWT with `alg:none` or no expiry check, tokens in URLs, missing CSRF protection on state-changing endpoints.
- **File and network**: path traversal on user-supplied paths, unrestricted upload (type/size/storage location/execution), SSRF on user-supplied URLs (allowlist, block internal ranges).
- **Crypto and transport**: homemade crypto, MD5/SHA1 for passwords (fix: bcrypt/argon2), disabled TLS verification.
- **Dependencies**: known-vulnerable versions where a lockfile is present; flag, don't guess CVE numbers.

## 2. Verify before reporting
For each candidate finding, trace the actual data path: where does the input enter, is it sanitized on the way, is the sink reachable? A parameterized query is not an injection even if it looks scary. Report only what survives the trace; label anything unverifiable as "requires runtime check" — never present suspicion as fact.

## 3. Severity honestly
- **Critical**: remotely exploitable by an anonymous user, or leaks secrets/money/PII at scale.
- **High**: exploitable by an authenticated user, or critical but behind a precondition.
- **Medium**: needs unusual conditions, or defense-in-depth gap (missing header, weak config).
- **Low**: hygiene (verbose errors, outdated but unexploited dependency).
No inflation: a missing security header on an internal tool is Low, not Critical.

## What not to do
- Do not write working exploits for third-party systems or advise attacking anything the user doesn't own; reviewing and fixing the user's own code is the job.
- Do not dump a generic OWASP checklist — every finding cites file:line and the actual code.
- Do not "fix" by adding validation in one place while the sink stays reachable from another path.
- Do not claim "the code is secure" — the honest close is "no issues found in the reviewed scope at these classes".

## Answer format
Findings ranked Critical→Low, each: file:line, the vulnerable flow in one sentence, proof it's reachable, the concrete fix (code). Then: what was out of scope or unverifiable. If nothing found — the classes checked and the scope, explicitly.
