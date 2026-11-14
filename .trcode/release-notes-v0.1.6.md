# TRCode v0.1.6

## Fixed

- **OpenCode Zen and Go no longer answer 400 "Request is missing x-opencode-session".**
  The gateway asks the client to send a stable conversation id in `x-opencode-session` —
  it keeps one conversation on one backend by that id and hits the prefix cache warmed
  there — and without the header it refuses to route the request. The header is declared
  in the registry (`ProviderMode.sessionHeader`) and travels on every request to both
  modes, including the key probe at login. The value is a hash, not a local session id:
  it carries the local date, and the vendor has no need to know it. Requests without an
  explicit id (subagent, compaction, title generator) are told apart by their own prompt
  prefix — exactly what the gateway caches. Tests in `test/provider-test.mjs` (8 checks,
  190 total).
- `User-Agent` is now `trcode/<version>` instead of the versionless `trcode-cli`: Go asks
  the client to name itself, and the version in it is the only way for the host to tell
  the traffic of one release from another.

## Install

```sh
npm install -g trcode-0.1.6.tgz
```
