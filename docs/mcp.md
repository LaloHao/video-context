# Using the MCP server

`video-context-mcp` speaks MCP over stdio. Every tool that takes a `videoId` also takes the
video **by name**: its name, or words of its name, folder or tags (`"posgrado clase 3"`,
accents and case aside). When words fit several videos, the tool lists them, so the agent
asks which one. An agent typically calls the tools in this order:

1. **`process_video`** `{ path, language?, model?, engine?, force?, title?, folder?, tags? }` —
   starts processing in the background and returns the video id at once (MCP clients time
   out on long calls); `title`, `folder` and `tags` file it at once. A video processed before
   is ready immediately.
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
6. **`get_screen`** `{ videoId, at }` — the exact screen at one time (`"3:15"`) or up to 8
   (`["3:05", "3:15"]`), taken from the video file, each as an image with its text (OCR). For
   what the key frames miss: code or text typed little by little, a form being filled, a
   dialog. Needs the video file where it was processed.
7. **`list_videos`** `{ folder?, tag? }` — what is processed, by folder, with tags, length,
   date and id; and the folders and tags in use. A folder includes its subfolders.
   **`list_frames`** `{ videoId }` — when each key frame is.
8. **`search_videos`** `{ query, limit?, folder?, tag? }` — the same search over every processed
   video at once (or a folder's, or a tag's): which videos say or show it, and when (*"in
   which meeting did they talk about…"*).
9. **`label_video`** `{ videoId, title?, folder?, tags?, addTags?, removeTags? }` — names a
   video, files it in a folder (`"Posgrado/Clases"`) and tags it; only what is given changes,
   and an empty `title` or `folder` removes it. Kept in `labels.json` next to the results:
   processing the video again keeps it.

With folders and tags, a prompt can be short: *"in my Posgrado videos, where did they explain
OSPF?"*, *"summarize the last class tagged #redes"*, *"put this recording in Trabajo/Dailies
and tag it #weekly"*.

## Claude Code

```bash
claude mcp add video-context -- npx -y -p @lalohao/video-context video-context-mcp
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
    "video-context": { "command": "npx", "args": ["-y", "-p", "@lalohao/video-context", "video-context-mcp"] }
  }
}
```

From a local checkout, use `"command": "node", "args": ["/path/to/video-context/dist/mcp.js"]`.

Desktop apps may not see your shell's PATH: if the server reports a missing tool that works
in your terminal, pass the tools' full paths in `env` — see
[installing](install.md#mcp-clients-started-from-the-dock-or-start-menu).

## Privacy

The tools never upload the video. Only what the agent reads through them (transcript
text, frame images and their text) reaches the model.
