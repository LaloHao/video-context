# video-context

**Turn a video into context an AI agent can use — on your machine.**

A recorded meeting, a training session or a screencast becomes something an agent can
study: *"watch this video and tell me how to do the task"*.

- **Timestamped transcript** with [whisper.cpp](https://github.com/ggml-org/whisper.cpp), or
  [mlx-whisper](https://github.com/ml-explore/mlx-examples/tree/main/whisper) on the GPU of
  Apple silicon Macs.
- **Key frames** at every scene change (and at least one a minute) with
  [ffmpeg](https://ffmpeg.org); near-identical frames are dropped.
- **Text on screen** of each frame with [tesseract](https://github.com/tesseract-ocr/tesseract)
  (optional): URLs, code and field names that are shown but never said.
- An **MCP server** so an agent (Claude Code or any MCP client) can process a video, read and
  search the transcript and the screens, and look at the frames as images.

The video never leaves your computer, and no API key is needed: the agent that reads the
results does the understanding.

## Quick start

**1. Install the tools** — ffmpeg and a whisper engine (tesseract is optional):

| System | Command |
| --- | --- |
| macOS, Apple silicon | `brew install ffmpeg tesseract uv && uv tool install mlx-whisper` |
| macOS, Intel | `brew install ffmpeg tesseract whisper-cpp` |
| Debian / Ubuntu | `sudo apt install ffmpeg tesseract-ocr`, then [build whisper.cpp](docs/install.md#linux) |
| Windows | `winget install Gyan.FFmpeg`, then [whisper.cpp's release zip](docs/install.md#windows) |

Other systems, GPUs and troubleshooting: **[docs/install.md](docs/install.md)**.

**2. Check the setup**

```bash
npx -p @lalohao/video-context video-context --doctor
```

**3. Process a video**, or let your agent do it:

```bash
npx -p @lalohao/video-context video-context ./meeting.mp4 --language en
claude mcp add video-context -- npx -y -p @lalohao/video-context video-context-mcp
```

```
"meeting" — 42:10, 611 segments, 118 frames
Transcript: ~/.cache/video-context/videos/3f9c…/transcript.md
Frames:     ~/.cache/video-context/videos/3f9c…/frames
Video id:   3f9c…
Dropped 9 near-duplicate frames.
```

Then ask Claude, for example:

> Process ~/Downloads/onboarding.mp4 and write the setup steps it explains as a checklist,
> with the minute of each step. Show me the screen where they configure the webhook.

See [examples/](examples/) for a full walkthrough on a public video, and the docs for
[the MCP tools](docs/mcp.md) and [how it works](docs/how-it-works.md).

## Requirements

| Tool | Needed for | Install |
| --- | --- | --- |
| Node.js 20+ | everything | [nodejs.org](https://nodejs.org) |
| `ffmpeg`, `ffprobe` | audio and frames | `apt install ffmpeg` · `brew install ffmpeg` |
| `whisper-cli` (whisper.cpp) **or** `mlx_whisper` | the transcript | `brew install whisper-cpp`, or [build it](docs/install.md#linux) · `uv tool install mlx-whisper` (Apple silicon) |
| `tesseract` | text on screen (optional) | `apt install tesseract-ocr tesseract-ocr-spa` · `brew install tesseract tesseract-lang` |

When both engines are installed, mlx-whisper is used (`--engine` picks one). The whisper
model is downloaded on first use (465 MB for `small`): into `~/.cache/video-context/models`
for whisper.cpp, into the Hugging Face cache for mlx-whisper. Without `tesseract`, everything
works except the text on screen. Step-by-step for each system: [docs/install.md](docs/install.md).

## Command line

```
video-context <video> [options]
video-context --doctor

  -l, --language <code>  Spoken language, e.g. en, es (default: auto)
  -m, --model <name>     tiny, base, small, medium, large-v3-turbo, large-v3 (default: small)
  -e, --engine <name>    whisper.cpp or mlx (default: mlx when installed, else whisper.cpp)
  -o, --out <dir>        Also copy the results to this folder
      --no-ocr           Do not read the text on screen
      --keep-duplicates  Keep near-identical frames
      --force            Process again even if it was processed before
      --doctor           Check the setup: what is installed, and how to install the rest
```

Any file ffmpeg reads works: `.mp4`, `.mkv`, `.webm`, `.mov`, or audio only (`.mp3`, `.m4a`;
then there are no frames). Each file is processed once and cached by path, size and
modification time.

## MCP server

| Tool | What it does |
| --- | --- |
| `process_video` | Starts processing a local file in the background and returns its id. |
| `video_status` | Progress, or a summary and where the results are once ready. |
| `list_videos` | Videos already processed. |
| `get_transcript` | The transcript as `[m:ss] text` lines (`[m:ss] Name: text` with speakers), optionally a time range. |
| `search_transcript` | Where something is said or shown on screen, with times (accents and case aside). |
| `get_frames` | Key frames as images with their on-screen text: around a time or over a range. |
| `list_frames` | The time of every key frame. |
| `search_videos` | Where something is said or shown across every processed video. |

Claude Code: `claude mcp add video-context -- npx -y -p @lalohao/video-context video-context-mcp`.
Other clients and example prompts: [docs/mcp.md](docs/mcp.md).

## Web page

```bash
npx -p @lalohao/video-context video-context-ui --open
```

A page on `http://localhost:4317` to watch a processed video next to its transcript: the
current line follows the player, a click on a line or a key frame seeks there, and the search
finds words said or shown on screen, in this video or in all of them. **+ New video** adds
files (dropped on the page or by path) to a processing queue, with the language, whisper model
and engine you pick; the queue shows each step's progress, and can cancel, retry or reorder.

![The page: the video, its chapters and key frames, the transcript following the player, and Claude's answer with the frame it looked at and links to each moment](docs/images/ui-chat.png)

- **Ask Claude** through the [`claude` CLI](https://claude.com/claude-code) (your own login;
  pick the model at the top), about this video or about all your videos at once (*"in which
  meeting did they decide the deadline?"*). Claude gets the transcript and this package's MCP
  tools, so it can search and look at the frames; the frames it looked at show in the answer,
  and every time it cites (`[3:07]`, `[V2 3:07]` for another video) is a link to that moment.
- **Chapters**: Claude splits the video where the topic changes; they show on the bar under the
  player, in the transcript and in their own tab.
- **Clips**: mark a start and an end (`[` and `]`, a range in an answer, or selected
  transcript lines) and download them as MP4, or as a GIF up to 30 s.
- **Notes**: write one at the current time (`N`), bookmark it (`B`), or save an answer from the
  chat; they are kept next to the video (`notes.json`) and exported to Markdown with the
  chapters and the conversation.
- **Export**: the video as a ZIP file with its transcript, frames, chapters, notes and an
  `index.html` that opens without a server; dropped on another video-context, it is ready
  without processing it again.

The page listens only on 127.0.0.1. A tour with screenshots of each part: **[docs/ui.md](docs/ui.md)**.

## Who said what

A recorder can leave a `.json` file with the same name next to the video (`daily.webm` +
`daily.json`). When it says who was speaking when, every line of the transcript carries the
speaker's name, and `search_transcript` finds a name together with the words
(*"Ana pagos"*). Its title replaces the file name.

```json
{
  "schema": "video-context-recording/1",
  "title": "Daily",
  "recordingStartedAt": "2026-10-22T16:00:00.000Z",
  "speakers": [
    { "name": "Ana", "start": 12.4, "end": 18.9, "source": "captions" },
    { "name": "Carlos", "start": 19.1, "end": 31.0, "source": "captions" }
  ]
}
```

Times are seconds from the start of the video. Each transcript segment gets the speaker whose
turns overlap it the most (or the nearest turn within 2 s). `source` is `captions` (the
meeting's live captions) or `indicator` (a participant tile's audio-level animation, less
reliable: used only when there are no caption turns). A video processed before its `.json`
existed needs `--force`.

## Environment variables

| Variable | Default |
| --- | --- |
| `VIDEO_CONTEXT_HOME` | `~/.cache/video-context` |
| `VIDEO_CONTEXT_ENGINE` | `whisper.cpp` or `mlx` (default: mlx when installed) |
| `VIDEO_CONTEXT_MODEL` | a ggml model file for whisper.cpp, instead of downloading one |
| `VIDEO_CONTEXT_MLX_MODEL` | a folder or Hugging Face repo for mlx-whisper (default: `mlx-community/whisper-<model>…`) |
| `VIDEO_CONTEXT_WHISPER`, `VIDEO_CONTEXT_MLX_WHISPER`, `VIDEO_CONTEXT_FFMPEG`, `VIDEO_CONTEXT_FFPROBE`, `VIDEO_CONTEXT_TESSERACT` | the binaries, when they are not on PATH |

## Troubleshooting

- **`Missing: …`** — run `video-context --doctor`: it says what is installed and how to install
  the rest on your system. A tool installed somewhere else: set its variable (`VIDEO_CONTEXT_WHISPER`
  to whisper.cpp's binary, which older builds call `main`).
- **It works in the terminal but the MCP server says a tool is missing** — desktop apps may not
  see your shell's PATH: [give the server the full paths](docs/install.md#mcp-clients-started-from-the-dock-or-start-menu).
- **Wrong language or gibberish transcript** — pass `--language`; try a bigger model
  (`--model medium`).
- **Too many or too few frames** — very static videos give few frames (one a minute at least);
  `--keep-duplicates` keeps every sampled frame.
- **Text on screen is noisy** — OCR on video frames is approximate; it is meant to *find* the
  moment, then the agent looks at the frame itself with `get_frames`. Install the language data
  of the video (`tesseract-ocr-<lang>`) for better results.
- **It takes a while** — an hour of video takes a few minutes with `small` on a recent machine;
  `tiny`/`base` are faster. On a Mac with Apple silicon, mlx-whisper (on the GPU) is usually
  faster than whisper.cpp; on Linux, build whisper.cpp with CUDA for an NVIDIA GPU.
- **The first video with mlx-whisper seems stuck at 0 %** — it is downloading the model from
  Hugging Face (once).

## Privacy

Video and audio are processed locally. Only what an agent reads through the tools — transcript
text, frame images and their text — reaches its model.

## Development

```bash
pnpm install
pnpm check                                            # typecheck + unit tests
VIDEO_CONTEXT_MODEL=/path/ggml-small.bin pnpm test    # also the end-to-end test (whisper.cpp)
VIDEO_CONTEXT_ENGINE=mlx pnpm test                    # the end-to-end test with mlx-whisper
```

## License

MIT
