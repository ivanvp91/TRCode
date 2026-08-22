---
name: servers
description: Unix system administration of the user's own servers — a health summary, diagnostics, services, disks, memory, logs, restarts, deploys. Always goes in over ssh using ~/.ssh/config as the host list; never probes "from the outside" (SSL, ping, curl) instead of logging in. Use for "состояние сервера", "сводка по серверу", "что с продом", "сервер тормозит", and any administration task on their machines. Not for code in this repository.
description_ru: Администрирование своих серверов пользователя как Unix-администратор — сводка по состоянию, диагностика, сервисы, диски, память, логи, перезапуски, деплой. Всегда заходить по ssh, список хостов — ~/.ssh/config; никогда не проверять «снаружи» (SSL, ping, curl) вместо авторизации. Для «состояние сервера», «сводка по серверу», «что с продом», «сервер тормозит» и любых задач администрирования.
triggers: сервер, серверы, серверов, сервере, сервера, server, servers, ssh, хост, хосты, host, vps, прод, продакшн, production, деплой, deploy, задеплой, uptime, аптайм, нагрузка, load average, диск кончился, disk full, df -h, логи сервера, systemctl, nginx, докер на сервере, docker ps, зайди на, состояние сервера, сводка по серверу, проверка сервера, health check, сисадмин, sysadmin, администрирование, сервер тормозит, сервер упал, память на сервере, место на диске, journalctl, перезапусти сервис
---

# Unix administration of the user's servers

## 1. The list of servers is ~/.ssh/config
Asked about "my servers" or a server state check, read `~/.ssh/config` first — never ask which servers they mean before looking, and never guess hosts from the conversation. Each `Host` block is one server; a block can carry several names (`Host gw-ams-1.example.com gw-ams-1`) and any of them works with `ssh`. `Include` directives pull in more files; follow them. `~/.ssh/known_hosts` says which hosts have actually been connected to before.

Read the config, not the keys: `IdentityFile` tells you which key is used, and that is all you need. Never print, copy or cat a private key, never paste one into a command line.

## 2. Check from the inside, not from the outside
The state of the user's server is checked by logging into it. `ping`, `curl`, SSL-certificate checks, "is port 443 reachable" — these answer a different question (public reachability) and are not a substitute for `ssh`. Do not run them instead of logging in, and do not run them "just in case" before logging in.

An outside view is legitimate only when the question itself is about the outside — "the site is down for visitors", "the certificate expired", DNS — and even then it goes alongside the ssh check, with a line saying which view each fact came from.

## 3. The health summary
One ssh call per host with the commands batched — a round trip per metric is slow and noisy:

```
ssh <host> 'uptime; free -m; df -h | grep -Ev "tmpfs|loop|overlay"; systemctl --failed --no-legend | head'
```

Then add what the question actually needs, not a fixed battery: disk questions want `du -xh --max-depth=1 / | sort -h | tail`, a slow server wants `top -bn1 | head -15` and `ss -tlnp`, "is it alive" wants uptime and the failed units.

When everything is fine, report one line per host — load, worst disk %, memory, failed units — the user asked about their servers, not for `df` output. Expand only where a number is wrong.

Check hosts one after another unless asked for all at once; a broken host must not stop the others — note it and carry on.

## 4. Diagnosing a problem
Filter on the server so the answer travels, not the raw output:

- CPU/load: `uptime`, `top -bn1 | head -15`, and per-process `ps aux --sort=-%cpu | head`.
- Memory: `free -m`, `ps aux --sort=-%mem | head`; swap activity in `vmstat 1 5`.
- Disk: `df -h` and `df -i` (inodes run out too), then `du -xh --max-depth=1 <path> | sort -h | tail` on the full mount.
- Network: `ss -tlnp` for what listens, `ip -br addr` for interfaces; the service's own error page before generic checks.
- A service: `systemctl status <unit>` plus its journal (§5) before restarting anything.

State the finding with its number ("disk at 97%, /var/lib/docker holds 40G"), then one proposed action.

## 5. Logs
`journalctl -u <unit> -n 200 --no-pager` and the service's own log paths beat tailing everything. Filter on the remote side — `grep`, `--since "1 hour ago"` — and when a log is the evidence for a conclusion, quote the handful of lines that carry it, not the last 200.

## 6. Changes: state them, then do them
Everything read-only needs no permission beyond running ssh. Anything that changes the server — `systemctl restart`, editing a config, `docker compose up`, a deploy, `apt upgrade`, deleting files to free space — is stated first and done after the user agrees. Name the host in the same sentence: a restart on the wrong machine is a real outage.

Never run a destructive command through a wildcard on a remote host (`rm -rf /var/log/*`), never edit a file in place without keeping the original (`cp x x.bak` first), and prefer the service's own tooling over hand-editing state. Package upgrades get a warning when a reboot or service restart may follow.

## 7. When ssh fails
Read the error rather than retrying: `Permission denied (publickey)` is the key or the user name, `Connection timed out` is the network or the host being down, `Host key verification failed` is a changed fingerprint — say so and stop. A changed host key is a security matter and never something to work around with `StrictHostKeyChecking=no`. Falling back to external probes to "at least see if it answers" hides the very failure the user needs diagnosed.

## Answer format
1. Per host: one line of state (load, disk, memory, failed units), numbers quoted only where they deserve attention.
2. Problems found — what, since when (uptime/log timestamps), and the proposed fix, waiting for agreement before touching anything.
3. Changes made, if any — listed per host.
