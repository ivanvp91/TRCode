---
name: git-workflow
description: Git discipline — commits, branches, merges, rebases, resolving conflicts, cleaning history, undoing mistakes safely. Use for "закоммить", "смерджи", conflict resolution, "как откатить", and any git operation beyond a trivial status check.
description_ru: Работа с git — коммиты, ветки, слияния, ребейзы, разрешение конфликтов, чистка истории, безопасная отмена ошибок. Для «закоммить», «смерджи», конфликтов, «как откатить» и любых git-операций сложнее простого статуса.
triggers: git, коммит, commit, закоммить, ветка, ветку, branch, merge, мердж, слияние, rebase, ребейз, конфликт слияния, merge conflict, push, запушь, откатить, revert, reset, cherry-pick, stash, gitignore, история коммитов, git log, амменд, amend
---

# Git workflow

## 1. Look before any operation
`git status` + `git log --oneline -10` before acting — know the branch, what's staged, what's untracked, and whether the working tree is clean. Never operate on assumptions about state; half of git disasters start with "I thought I was on another branch".

## 2. Commits
- One logical change per commit; unrelated fixes go in separate commits even when found together. Stage selectively (`git add -p` / by file), don't blanket `git add .` when the tree has strays.
- Message: an imperative summary line ≤ 72 chars that says WHY-or-WHAT at the change level ("Fix stale cache on model switch"), not a file list; body only when the summary can't carry the reason. Match the язык и стиль существующей истории репозитория.
- Never commit: secrets, build artifacts, editor junk — check what's staged; fix `.gitignore` when strays keep appearing.
- Amend only unpushed commits; after a push, a new commit or revert — history that left the machine belongs to others too.

## 3. Branches and merging
- Feature work on a branch off the default; branch names say the thing (`fix-login-retry`, not `patch2`).
- Sync with the default branch by the repo's convention (look at history: merge-commits or linear rebase flow) — don't impose a different style.
- Rebase only local/unshared branches; never rebase shared history without the user explicitly deciding to force-push, and then `--force-with-lease`, never bare `--force`.

## 4. Conflicts
Resolve by understanding both sides, not by picking one blindly: read what each branch was trying to do; the resolution often takes both. After resolving — build/tests before concluding the merge. Never silently drop the other side's change; if both changed the same logic differently, that's a question for the user, not a coin flip.

## 5. Undo safely — the ladder
From least to most destructive; use the lowest rung that works:
1. Uncommitted mess → `git stash` (recoverable) beats `checkout --` (gone).
2. Bad last commit, unpushed → `commit --amend` or `reset --soft HEAD~1`.
3. Bad commit, pushed → `git revert` (new inverse commit) — history stays true.
4. Lost work → `git reflog` finds almost everything for ~90 days; check it before declaring loss.
Destructive commands (`reset --hard`, `clean -f`, force-push) — only with the user's explicit go-ahead, after saying what exactly will be lost.

## What not to do
- No `git add . && git commit -m "fixes"` batches burying five changes in one blob.
- No force-push to shared branches; no rewriting pushed history without explicit agreement.
- No committing on the user's behalf when they didn't ask — finish the code, offer the commit.
- No resolving a conflict by discarding a side without reading it.
- Don't touch `git config`, hooks, or credentials without being asked.

## Answer format
For operations: the commands run and the resulting state (`status`/`log` proof). For commits: the message used. For conflicts: which sides said what and how the resolution combines them. For undo: what was recovered and what (if anything) is unrecoverable.
