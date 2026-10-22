# How it works

```
video.mp4 ──ffprobe──▶ duration
          ──ffmpeg───▶ audio.wav (16 kHz mono) ──whisper.cpp──▶ timestamped segments
          ──ffmpeg───▶ key frames + 9×8 thumbnails ──dHash──▶ near-duplicates dropped
                                                     ──tesseract──▶ text on screen (optional)
```

1. **Audio and transcript.** The audio track is extracted at 16 kHz mono and transcribed
   by whisper.cpp's `whisper-cli` with its JSON output, which gives every segment a start
   and an end time. Blank markers (`[BLANK_AUDIO]`) are dropped.
2. **Key frames.** One ffmpeg pass selects a frame at every scene change (`scene > 0.25`)
   and at least one every 60 seconds, and writes, for each, a JPEG (at most 1280 px wide)
   and a 9×8 grayscale thumbnail. Frames are named by their second (`00754s-00012.jpg`).
3. **Near-duplicates.** A 64-bit difference hash (dHash) of each thumbnail is compared with
   the last kept frame: within 4 bits, the frame adds nothing and is dropped. A slide that
   stays on screen for a minute is kept once.
4. **Text on screen.** When `tesseract` is installed, each kept frame is read, four at a time,
   in the video's language (when its language data is installed) plus English. The text is
   cleaned (no blank or symbol-only lines) and stored with the frame.
5. **Cache.** Everything goes to `~/.cache/video-context/videos/<id>/`, where the id is a hash
   of the file's absolute path, size and modification time: the same file is processed once.
   `manifest.json` is written last, so a folder with a manifest is a finished one.

6. **Speakers.** When a recording file (`<name>.json`, see the README) sits next to the
   video, each transcript segment is labelled with the speaker whose turns overlap it the
   most, and the Markdown starts a new paragraph at every change of speaker.

Whisper and the frames/OCR run in parallel; for an hour of video on a modern CPU, expect
a few minutes with the `small` model.

## Files

| File | Content |
| --- | --- |
| `transcript.md` | The transcript in paragraphs of about 45 s, each starting with its time — for reading. |
| `transcript.srt` | Subtitles. |
| `transcript.json` | `[{ "start": 12.4, "end": 15.1, "text": "…", "speaker": "Ana" }]` — seconds; `speaker` only with a recording file. |
| `frames/*.jpg` | The key frames, named by their second. |
| `manifest.json` | Title, duration, language, model, frames (`file`, `time`, `text`), dropped duplicates, OCR info, and `recording` (URL, start time, speakers) when there is a recording file. |

## Choosing a model

| Model | Size | Notes |
| --- | --- | --- |
| `tiny`, `base` | 75–142 MB | Fast; fine for clear English speech. |
| `small` (default) | 465 MB | Good balance; good for Spanish and other languages. |
| `medium` | 1.5 GB | More accurate, slower. |
| `large-v3-turbo` | 1.6 GB | Close to `large-v3`, much faster. |
| `large-v3` | 2.9 GB | Most accurate, slowest. |

Pass the language (`--language es`) when you know it: detection on the first seconds can
be wrong when a video starts with music or silence.
