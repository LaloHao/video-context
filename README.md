# video-context

Turn a video into context an AI agent can use. Everything runs on your machine:

- a **timestamped transcript** with [whisper.cpp](https://github.com/ggml-org/whisper.cpp),
- **key frames** at scene changes (and at least one a minute) with [ffmpeg](https://ffmpeg.org),
- an **MCP server** so an agent (Claude Code, or any MCP client) can process a video,
  read the transcript by time range, search it, and look at the frames as images.

A recorded meeting, a training session or a walkthrough becomes something an agent
can study: *"watch this video and tell me how to do the task"*.

## Requirements

- Node.js 20+
- `ffmpeg` and `ffprobe` on your PATH (`sudo apt install ffmpeg`, `brew install ffmpeg`)
- whisper.cpp's `whisper-cli` on your PATH (`brew install whisper-cpp`, or build it from
  the repository)

The whisper model is downloaded the first time (about 465 MB for `small`) into
`~/.cache/video-context/models`.

## Command line

```bash
npx video-context ./meeting.mp4 --language es
```

```
"meeting" — 1:03:14, 1012 segments, 216 frames
Transcript: ~/.cache/video-context/videos/<id>/transcript.md
Frames:     ~/.cache/video-context/videos/<id>/frames
```

Each video is processed once (cached by path, size and modification time).
Results: `transcript.md` (paragraphs with their time), `transcript.srt`,
`transcript.json`, `frames/` (files named by their second) and `manifest.json`.

Options: `--language <code>` (default auto), `--model tiny|base|small|medium|large-v3-turbo|large-v3`
(default `small`), `--out <dir>` to copy the results, `--force` to process again.

## MCP server

Add it to Claude Code:

```bash
claude mcp add video-context -- npx -y -p video-context video-context-mcp
```

or to any MCP client config:

```json
{ "mcpServers": { "video-context": { "command": "npx", "args": ["-y", "-p", "video-context", "video-context-mcp"] } } }
```

| Tool | What it does |
| --- | --- |
| `process_video` | Starts processing a local file in the background and returns its id (long videos take minutes). |
| `video_status` | Progress, or where the results are once ready. |
| `list_videos` | Videos already processed. |
| `get_transcript` | The transcript as `[m:ss] text` lines, optionally a time range. |
| `search_transcript` | Where something is said: matching passages with their time (accents and case aside). |
| `get_frames` | Key frames as images: around a time, or spread over a range. |
| `list_frames` | The time of every key frame. |

Then ask, for example: *"Process ~/Downloads/training.mp4 (Spanish) and write the
steps it explains for configuring payments, with the minute of each step."*

## Environment variables

| Variable | Default |
| --- | --- |
| `VIDEO_CONTEXT_HOME` | `~/.cache/video-context` |
| `VIDEO_CONTEXT_MODEL` | a ggml model file to use instead of downloading one |
| `VIDEO_CONTEXT_WHISPER` / `VIDEO_CONTEXT_FFMPEG` / `VIDEO_CONTEXT_FFPROBE` | the binaries, when they are not on PATH |

## Privacy

The video and its audio never leave your machine. Only what the agent reads through
the tools (transcript text and the frames it asks for) goes to the model.

## Development

```bash
pnpm install
pnpm check                                            # typecheck + tests
VIDEO_CONTEXT_MODEL=/path/ggml-small.bin pnpm test    # also the end-to-end test
```

## License

MIT
