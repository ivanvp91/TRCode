# TRCode v0.1.7 — images, video and sound

## Added

- **Images, video and sound straight from the chat.** Media models are wired in as tools:
  the chat model writes the prompt itself and calls `generate_image`, `generate_video` or
  `generate_audio`, and the file is saved in the project folder. Every generation is paid
  and asks for confirmation; Esc interrupts the wait.
- **`/image`, `/audio`, `/video model`** — model selection in the same panel as `/model`:
  provider tabs, search, a capabilities line (aspect ratios, resolutions, durations,
  price per second) in place of context and price. The model can be named up front:
  `/image seedream`, `/audio off`. Until a model is chosen, the tool is not in the chat.
- **`/video` — video mode**: every message becomes an order for a clip. The prompt model
  (any text model) looks at the attachments, writes a shot description with a
  second-by-second storyboard and calls the video model; that model's allowed values go
  into its prompt. `/video off` restores the previous model; after a restart the mode is
  off.
- **Providers:**

  | | Images | Video | Audio |
  |---|---|---|---|
  | OpenRouter | 55 models, `/images` | 30 models, `/videos` | gpt-audio, Lyria |
  | TokenRouter | `image-generation` | `video-generation` | `audio-chat` |
  | xAI (API key) | grok-imagine, edit from a source image | grok-imagine-video | — |
  | Z.AI | glm-image, cogview | cogvideox-3 | — |

- **Audio**: speech is read verbatim in the chosen voice and delivery, music follows a
  brief; the format is detected from the bytes, and raw PCM is saved as WAV.
- Provider errors are shown in the provider's own words — OpenRouter's nested JSON is
  unwrapped down to `InvalidParameter: …`.

## Install

```sh
npm install -g trcode-0.1.7.tgz
```
