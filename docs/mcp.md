# Using the MCP server

`video-context-mcp` speaks MCP over stdio. It exposes seven tools; an agent typically
calls them in this order:

1. **`process_video`** `{ path, language?, model?, force? }` — starts processing in the
   background and returns the video id at once (MCP clients time out on long calls).
   A video processed before is ready immediately.
2. **`video_status`** `{ videoId }` — progress (`Transcribing… 42%`, `Reading text on screen… 80/200`)
   or, once ready, a summary and the path of `transcript.md`.
3. **`search_transcript`** `{ videoId, query, limit? }` — where something is **said** and
   where it is **shown on screen**, each with its time:

   ```
   Said:
   [4:12–4:31] … and now we close the paragraph tag …

   On screen:
   [4:20] <p>This is my first paragraph</p>
   ```
4. **`get_transcript`** `{ videoId, from?, to? }` — the transcript as `[m:ss] text` lines,
   for a range (`"12:30"`, `"1:02:00"` or seconds). Long ranges stop at ~40 000 characters
   and say where to continue.
5. **`get_frames`** `{ videoId, at? | from?, to?, limit? }` — up to 8 key frames as images,
   each with the text read on it. `at` gives the frames closest to a time; `from`/`to`
   spreads them over a range.
6. **`list_videos`**, **`list_frames`** — what is processed, and when each frame is.

## Claude Code

```bash
claude mcp add video-context -- npx -y -p video-context video-context-mcp
```

Prompts that work well:

- *Process ~/Downloads/onboarding.mp4 (English). Summarize it as a numbered checklist with
  the minute of each step.*
- *In that video, find where they configure the payment webhook and show me the screen.*
- *Watch ~/talks/design-review.mkv and list every decision and who made it, with times.*
- *The ticket says "do what the recording explains". Process ~/rec.mp4 (Spanish), extract the
  API calls shown on screen (method, URL, body) and write them as a table.*

## Other clients

Any MCP client that runs stdio servers can use it:

```json
{
  "mcpServers": {
    "video-context": { "command": "npx", "args": ["-y", "-p", "video-context", "video-context-mcp"] }
  }
}
```

From a local checkout, use `"command": "node", "args": ["/path/to/video-context/dist/mcp.js"]`.

## Privacy

The tools never upload the video. Only what the agent reads through them (transcript
text, frame images and their text) reaches the model.
