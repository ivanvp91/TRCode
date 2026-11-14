# TRCode

An AI coding agent for your terminal. Describe a task in plain language — TRCode explores your project, edits files and runs commands to get it done.

Connect models from different providers, switch between them in the same conversation and track token usage. Works on Windows, macOS and Linux.

[Install](#1-install-trcode) · [Launch](#2-launch-in-your-project) · [Connect models](#3-connect-a-provider-and-choose-a-model) · [Features](#what-you-can-do) · [Documentation](#documentation)

## 1. Install TRCode

You need **Node.js 20.10+**, npm and Git. Run in your terminal:

```sh
git clone https://github.com/ivanvp91/TRCode.git
cd TRCode
npm install
npm run build
npm link
```

This makes both `trc` and `trcode` available as equivalent commands. Check the installation:

```sh
trc --version
```

## 2. Launch in your project

Open the folder you want to work on and start the agent:

```sh
cd path/to/your-project
trc
```

On your first launch, TRCode will tell you that no provider is connected yet. Connect one in the next step.

The interface and replies are in English by default; `/lang` switches both, and thirteen
languages are available — English, Russian, Chinese, Japanese, German, French, Spanish,
Italian, Portuguese, Ukrainian, Polish, Malay and Indonesian.

## 3. Connect a provider and choose a model

A provider is the service that gives you access to models. You only need one connected provider. Each service uses its own credentials.

Inside TRCode, enter:

```text
/provider
```

Select a service with the arrow keys and press **Enter**. If it is not connected, TRCode opens a panel: paste an API key and give it a name, or choose account sign-in where available. For browser sign-in, follow the terminal prompts.

| Provider | Name in commands | How to connect |
|---|---|---|
| TokenRouter | `tokenrouter` | API key |
| Kimi | `kimi` | Kimi Code subscription or Moonshot API key |
| Anthropic / Claude | `claude` | Anthropic API key |
| OpenAI | `openai` | Continue with ChatGPT (eligible Plus/Pro plans) or OpenAI API key |
| Google Gemini | `gemini` | Google AI Studio API key |
| Meta / Muse | `meta` | Meta Model API key |
| OpenRouter | `openrouter` | API key |
| OpenCode Zen | `opencode` | API key |
| OpenCode Go | `opencode-go` | API key for your Go subscription |
| Alibaba Cloud / Qwen | `alibabacloud` | API key; select the matching server |
| xAI / Grok | `xai` | SuperGrok subscription or xAI API key |
| Z.AI / GLM | `zai` | Platform or Coding Plan key; select the matching server |

ChatGPT sign-in registers TRCode as its own app and asks permission to use your plan. Gemini connects through the public API; see the [provider reference](docs/providers.md) for setup details.

For TokenRouter, run `/login tokenrouter` first to save your key, then select it in `/provider`.

A provider can hold several keys or logins, each with a name. `/accounts` lists them, Enter makes a row active, and the buttons add, rename and delete; `/login` on a connected provider opens the same list. The active credential is the one requests carry — switching is always manual. `trc auth status` shows how many a provider holds.

Once connected, open the model picker:

```text
/model
```

Type a name to search and press **Enter** to select a model. Use `/provider` and `/model` whenever you want to switch services or models in the same conversation. TRCode remembers the model and reasoning level for your project.

<details>
<summary>Connect from your regular terminal</summary>

Exit TRCode with `/exit`, then run the login command for your service. For example:

```sh
trc auth login --provider openrouter
trc auth status
trc -m openrouter
```

Replace `openrouter` with a name from the table. Logging into a direct provider creates a model alias with the same name. For TokenRouter, launch `trc` and choose a model with `/model`.

To disconnect a service: `trc auth logout --provider openrouter`.

</details>

## 4. Give it your first task

Enter a request at the TRCode prompt, for example:

```text
Explain how this project is organized and which file I should read first.
```

Or ask for a code change:

```text
Find out why the tests are failing, fix the cause and verify the result.
```

By default, TRCode shows a diff and asks before editing files, and shows the command before running it. Press **Esc** to stop the current task. After exiting, run `trc -c` in your project folder to continue the last session.

## What you can do

| Feature | How to use it |
|---|---|
| Work on your project | Ask it to find code, fix a bug, add a feature or run tests |
| Choose models and reasoning depth | `/model`, `/provider`, `/effort` |
| Keep several keys or accounts | `/login` adds one (with a name) and `/accounts` switches between them — Enter on a row, buttons to add, rename or delete |
| Continue or branch a conversation | `/resume` to reopen a session, `/fork` to branch it |
| Undo the agent's changes | `/rewind` to choose a restore point; see [what it can restore](docs/usage.md#undoing-a-turn) |
| Track costs and context | `/cost` for token usage and cost when prices are known, `/context` for context usage, `/compact` to summarize history |
| Work with multiple agents | `/orchestrate` to split a task into steps, `/swarm` to have several models investigate it |
| Compare model perspectives | `/brain <question>` to get a combined answer that accounts for different views |
| Keep working toward a goal | `/goal <task>` to continue automatically; `/goal pause` to pause |
| Set project rules and memory | Add an `AGENTS.md` with instructions; `/memory` manages memory across sessions |
| Automate around the agent | Hooks in `.trcode/settings.json`: run a formatter after an edit, block a command, notify you when a turn ends — `/hooks` shows what is in force |
| Decide what runs without asking | `/permissions` takes patterns as well as classes: `shell(git status:*)`, `edit(src/**)`, `read(./.env)`, `fetch(domain:github.com)` |
| Look before touching | `/plan` (or `trc --plan`): the agent explores and proposes, and no tool that changes anything is offered until you approve |
| Add your own commands | Markdown files in `.trcode/commands/` become `/name`; `$ARGUMENTS` takes what you type and `` !`cmd` `` puts a command's output into the prompt — `/commands` lists them |
| Add skills and external tools | `/skills` for reusable task instructions, `/mcp` for connected MCP tools |
| Generate images, video and audio | `/image`, `/video`, `/audio` to choose generation models on supported providers; paid generation asks for confirmation by default |

Use `/help` for the full command list, or type `/` to find a command by name.

## Hooks and your own commands

Two files connect the agent to the work around it, and both are committed with the repository:

```json
// .trcode/settings.json
{
  "hooks": {
    "PostToolUse": [{ "matcher": "edit|write", "command": "npm run lint --silent" }],
    "PreToolUse": [{ "matcher": "shell", "command": "node scripts/guard.mjs" }],
    "Stop": [{ "command": "node scripts/log-turn.mjs" }]
  },
  "notify": ["node", "scripts/toast.mjs"]
}
```

A hook is a shell command. It reads a JSON payload on stdin (`event`, `cwd`, `tool`, `args`, `output`, `sessionId`), and speaks through its exit code: `0` continues, `2` blocks the thing it was asked about and its stderr becomes the reason the model is told. Anything else is ignored, and a hook that outlives its timeout is killed rather than holding the turn.

| Event | When | Exit 2 means |
|---|---|---|
| `SessionStart` | a session opens | — |
| `UserPromptSubmit` | before a prompt is sent | the prompt is not sent |
| `PreToolUse` | before a tool call runs | the tool is not run |
| `PostToolUse` | after it ran | its output comes back with a `[hook feedback]` line |
| `Stop` | a turn ends | — |
| `PreCompact` | before the history is compacted | — |

`notify` is a command run when a turn ends, with the turn's JSON (outcome, last answer) appended as its last argument. Hooks are also read from `~/.trcode/config.json` under the same keys; a project may only add `hooks` and override `notify`, never permissions or a model.

A repository's hooks run shell commands on your machine, so they wait for a yes: trcode says at startup that the file defines hooks, `/hooks` shows exactly what they are, and `/hooks trust` enables them. Editing the file asks again.

A markdown file in `.trcode/commands/` is a command — `deploy.md` is `/deploy`, `db/migrate.md` is `/db:migrate`:

```markdown
---
description: Deploy the current branch
argument-hint: <environment>
---
Deploy $ARGUMENTS. The branch is: !`git branch --show-current`
```

The body is the prompt. `$ARGUMENTS` is what you typed after the name (appended when the body has no placeholder), and `` !`cmd` `` — or a fenced ```` ```! ```` block — is replaced by that command's output before the model sees anything.

## Rules and planning

A permission rule answers the confirmation for one call, where the class modes (`/permissions shell ask`) answer for all of them:

```sh
/permissions allow shell(git status:*)      # any git status, with arguments
/permissions deny  shell(rm -rf:*)          # refused, even under /yolo
/permissions allow edit(src/**)             # edits under src/
/permissions allow fetch(domain:github.com) # requests to one host
/permissions                                # list classes and rules, numbered
```

Rules are checked in three passes — deny, ask, allow — and the first match in a pass decides, so a specific refusal always outvotes a broad permission. A path rule is relative to the project root unless it starts with `/`; `*` stays inside one path segment and `**` crosses them; in a command, `:*` means "this prefix with any arguments".

`/plan` turns the session read-only: the tools that write, run commands or spawn agents are not offered at all, the prompt says the turn is a proposal, and when the answer arrives you choose — execute the plan, keep planning, or leave the mode. `trc --plan` starts that way.


## Useful launch commands

Run these in your regular terminal:

```sh
trc "Explain the project architecture"   # start a conversation with a task
trc -c                                  # continue the project's last session
trc -m kimi                             # start with your connected Kimi provider
trc -p "Explain what src/index.ts does"  # print an answer and exit
trc -p "Describe this project" --json    # get the answer as JSON
trc update                              # update, then restart trc
```

In `-p` mode, actions that require confirmation are automatically rejected. Use `/permissions` in an interactive session to configure permissions.

## Troubleshooting

- **`trc` command not found:** run `npm link` again in the TRCode folder and open a new terminal. You can also run `node path/to/TRCode/dist/index.js` from your project folder.
- **`401` / `Invalid API key`:** check connections with `trc auth status`. Log in again for the affected provider. For Alibaba Cloud and Z.AI, also check the selected server.
- **A model is missing:** use `/model refresh` to update the catalog, or `/model all` to browse models from other providers.

## Documentation

- [Providers](docs/providers.md) — login methods, servers and service-specific details.
- [Commands, interface and sessions](docs/usage.md) — keyboard shortcuts, history, undo and branching.
- [Models, context, costs and configuration](docs/models-and-costs.md) — settings and token accounting.
- [Tools and workflows](docs/tools-and-workflows.md) — agents, skills, MCP, goals and media generation.
- [Development and integrations](docs/development.md) — tests, source layout and Orca.

License: [MIT](LICENSE).
