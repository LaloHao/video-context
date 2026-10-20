# video-context

**Turn a video into context an AI agent can use — on your machine.**

A recorded meeting, a training session or a screencast becomes something an agent can
study: *"watch this video and tell me how to do the task"*.

- **Timestamped transcript** with [whisper.cpp](https://github.com/ggml-org/whisper.cpp).
- **Key frames** at every scene change (and at least one a minute) with
  [ffmpeg](https://ffmpeg.org); near-identical frames are dropped.
- **Text on screen** of each frame with [tesseract](https://github.com/tesseract-ocr/tesseract)
  (optional): URLs, code and field names that are shown but never said.
- An **MCP server** so an agent (Claude Code or any MCP client) can process a video, read and
  search the transcript and the screens, and look at the frames as images.

The video never leaves your computer, and no API key is needed: the agent that reads the
results does the understanding.

## Quick start

```bash
# 1. Requirements (macOS: brew install ffmpeg whisper-cpp tesseract)
sudo apt install ffmpeg tesseract-ocr        # and whisper.cpp's whisper-cli, see below

# 2. Process a video
npx video-context ./meeting.mp4 --language en

# 3. Or let your agent do it
claude mcp add video-context -- npx -y -p video-context video-context-mcp
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
| `whisper-cli` (whisper.cpp) | the transcript | `brew install whisper-cpp`, or [build it](https://github.com/ggml-org/whisper.cpp#quick-start) and put `build/bin/whisper-cli` on your PATH |
| `tesseract` | text on screen (optional) | `apt install tesseract-ocr tesseract-ocr-spa` · `brew install tesseract tesseract-lang` |

The whisper model is downloaded on first use (465 MB for `small`) into
`~/.cache/video-context/models`. Without `tesseract`, everything works except the text on screen.

## Command line

```
video-context <video> [options]

  -l, --language <code>  Spoken language, e.g. en, es (default: auto)
  -m, --model <name>     tiny, base, small, medium, large-v3-turbo, large-v3 (default: small)
  -o, --out <dir>        Also copy the results to this folder
      --no-ocr           Do not read the text on screen
      --keep-duplicates  Keep near-identical frames
      --force            Process again even if it was processed before
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
| `get_transcript` | The transcript as `[m:ss] text` lines, optionally a time range. |
| `search_transcript` | Where something is said or shown on screen, with times (accents and case aside). |
| `get_frames` | Key frames as images with their on-screen text: around a time or over a range. |
| `list_frames` | The time of every key frame. |

Claude Code: `claude mcp add video-context -- npx -y -p video-context video-context-mcp`.
Other clients and example prompts: [docs/mcp.md](docs/mcp.md).

## Environment variables

| Variable | Default |
| --- | --- |
| `VIDEO_CONTEXT_HOME` | `~/.cache/video-context` |
| `VIDEO_CONTEXT_MODEL` | a ggml model file to use instead of downloading one |
| `VIDEO_CONTEXT_WHISPER`, `VIDEO_CONTEXT_FFMPEG`, `VIDEO_CONTEXT_FFPROBE`, `VIDEO_CONTEXT_TESSERACT` | the binaries, when they are not on PATH |

## Troubleshooting

- **`Missing: whisper.cpp's whisper-cli`** — install whisper.cpp, or set `VIDEO_CONTEXT_WHISPER`
  to its binary (older builds call it `main`).
- **Wrong language or gibberish transcript** — pass `--language`; try a bigger model
  (`--model medium`).
- **Too many or too few frames** — very static videos give few frames (one a minute at least);
  `--keep-duplicates` keeps every sampled frame.
- **Text on screen is noisy** — OCR on video frames is approximate; it is meant to *find* the
  moment, then the agent looks at the frame itself with `get_frames`. Install the language data
  of the video (`tesseract-ocr-<lang>`) for better results.
- **It takes a while** — whisper is CPU-bound: an hour of video takes a few minutes with `small`
  on a recent machine; `tiny`/`base` are faster.

## Privacy

Video and audio are processed locally. Only what an agent reads through the tools — transcript
text, frame images and their text — reaches its model.

## Development

```bash
pnpm install
pnpm check                                            # typecheck + unit tests
VIDEO_CONTEXT_MODEL=/path/ggml-small.bin pnpm test    # also the end-to-end test
```

## License

MIT
