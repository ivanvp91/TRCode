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

The interface and replies are in English by default. Use `/lang` inside TRCode to change the language.

## 3. Connect a provider and choose a model

A provider is the service that gives you access to models. You only need one connected provider. Each service uses its own credentials.

Inside TRCode, enter:

```text
/provider
```

Select a service with the arrow keys and press **Enter**. If it is not connected, TRCode starts the login process: paste an API key or choose account sign-in where available. For browser sign-in, follow the terminal prompts.

| Provider | Name in commands | How to connect |
|---|---|---|
| TokenRouter | `tokenrouter` | API key |
| Kimi | `kimi` | Kimi Code subscription or Moonshot API key |
| Anthropic / Claude | `claude` | Anthropic API key |
| OpenAI | `openai` | ChatGPT sign-in or OpenAI API key |
| Google Gemini | `gemini` | Google AI Studio API key¹ |
| Meta / Muse | `meta` | Meta Model API key |
| OpenRouter | `openrouter` | API key |
| OpenCode Zen | `opencode` | API key |
| OpenCode Go | `opencode-go` | API key for your Go subscription |
| Alibaba Cloud / Qwen | `alibabacloud` | API key; select the matching server |
| xAI / Grok | `xai` | SuperGrok subscription or xAI API key |
| Z.AI / GLM | `zai` | Platform or Coding Plan key; select the matching server |

¹ Google account sign-in is also available, with a warning about its risks. See the [provider reference](docs/providers.md) for details.

For TokenRouter, run `/login tokenrouter` first to save your key, then select it in `/provider`.

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
| Continue or branch a conversation | `/resume` to reopen a session, `/fork` to branch it |
| Undo the agent's changes | `/rewind` to choose a restore point; see [what it can restore](docs/usage.md#undoing-a-turn) |
| Track costs and context | `/cost` for token usage and cost when prices are known, `/context` for context usage, `/compact` to summarize history |
| Work with multiple agents | `/orchestrate` to split a task into steps, `/swarm` to have several models investigate it |
| Compare model perspectives | `/brain <question>` to get a combined answer that accounts for different views |
| Keep working toward a goal | `/goal <task>` to continue automatically; `/goal pause` to pause |
| Set project rules and memory | Add an `AGENTS.md` with instructions; `/memory` manages memory across sessions |
| Add skills and external tools | `/skills` for reusable task instructions, `/mcp` for connected MCP tools |
| Generate images, video and audio | `/image`, `/video`, `/audio` to choose generation models on supported providers; paid generation asks for confirmation by default |

Use `/help` for the full command list, or type `/` to find a command by name.

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
