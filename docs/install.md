# Installing

video-context needs **Node.js 20+**, **ffmpeg** and one **whisper engine**. `tesseract` is
optional (it reads the text on screen). Nothing is bundled: the tools are found on your
`PATH`, or through [environment variables](#when-a-tool-is-not-on-path).

When you are done, check the setup:

```bash
npx -p @lalohao/video-context video-context --doctor
```

```
Required
  ✓ ffmpeg: ffmpeg
  ✓ ffprobe: ffprobe

Transcription (one of them)
  ✗ whisper.cpp (whisper-cli): `brew install whisper-cpp`
  ✓ mlx-whisper (mlx_whisper): mlx_whisper

Optional
  ✓ tesseract (text on screen): tesseract

Ready: videos are transcribed with mlx (mlx_whisper).
```

## Which whisper engine

| Engine | Runs on | Install | Model |
| --- | --- | --- | --- |
| **mlx-whisper** | macOS on Apple silicon (M1 and later), on the GPU | `uv tool install mlx-whisper` | Downloaded by mlx-whisper to the Hugging Face cache (`~/.cache/huggingface`) |
| **whisper.cpp** | macOS, Linux, Windows; CPU, or GPU when built for it | per system, below | Downloaded by video-context to `~/.cache/video-context/models` |

Both give the same kind of transcript. When both are installed, **mlx-whisper is used**; pick one
with `--engine whisper.cpp` / `--engine mlx`, or `VIDEO_CONTEXT_ENGINE`. On a Mac with Apple
silicon, mlx-whisper is usually the faster choice, most of all with the bigger models.

## macOS

```bash
brew install ffmpeg tesseract tesseract-lang
```

Then a whisper engine:

- **Apple silicon (M1 and later) — mlx-whisper:**

  ```bash
  brew install uv
  uv tool install mlx-whisper
  ```

  This puts `mlx_whisper` in `~/.local/bin` (run `uv tool update-shell` once if that folder is
  not on your PATH). `pipx install mlx-whisper` works too.

- **Any Mac — whisper.cpp** (uses Metal on Apple silicon):

  ```bash
  brew install whisper-cpp
  ```

## Linux

**Debian / Ubuntu**

```bash
sudo apt install ffmpeg tesseract-ocr tesseract-ocr-spa   # -spa: Spanish OCR; add the languages you need
```

**Fedora**

```bash
sudo dnf install ffmpeg-free tesseract tesseract-langpack-spa
```

**Arch**

```bash
sudo pacman -S ffmpeg tesseract tesseract-data-eng tesseract-data-spa
```

Then whisper.cpp. Distributions rarely package it (Arch has `whisper.cpp` in the AUR; Nix has
`whisper-cpp`), so build it — it takes a minute and needs `git`, `cmake` and a C++ compiler
(`sudo apt install git cmake build-essential`):

```bash
git clone --depth 1 https://github.com/ggml-org/whisper.cpp
cd whisper.cpp
cmake -B build -DBUILD_SHARED_LIBS=OFF        # NVIDIA GPU: add -DGGML_CUDA=1
cmake --build build -j --config Release
sudo install build/bin/whisper-cli /usr/local/bin/
```

`-DBUILD_SHARED_LIBS=OFF` makes a `whisper-cli` that works on its own once copied. To leave it
where it was built, skip the last line and set
`VIDEO_CONTEXT_WHISPER=/path/to/whisper.cpp/build/bin/whisper-cli` instead.

## Windows

In PowerShell:

```powershell
winget install OpenJS.NodeJS.LTS
winget install Gyan.FFmpeg
winget install UB-Mannheim.TesseractOCR      # optional
```

For whisper.cpp, download `whisper-bin-x64.zip` from the
[whisper.cpp releases](https://github.com/ggml-org/whisper.cpp/releases), unzip it (for example
to `C:\tools\whisper`) and either add that folder to your PATH or point video-context to it:

```powershell
setx VIDEO_CONTEXT_WHISPER "C:\tools\whisper\whisper-cli.exe"
```

Open a new terminal afterwards (`winget` and `setx` change the PATH and variables for new
terminals only). WSL works too: follow the Linux steps inside it.

## When a tool is not on PATH

| Variable | What |
| --- | --- |
| `VIDEO_CONTEXT_FFMPEG`, `VIDEO_CONTEXT_FFPROBE` | ffmpeg and ffprobe |
| `VIDEO_CONTEXT_WHISPER` | whisper.cpp's `whisper-cli` (older builds call it `main`) |
| `VIDEO_CONTEXT_MLX_WHISPER` | `mlx_whisper` |
| `VIDEO_CONTEXT_TESSERACT` | tesseract |
| `VIDEO_CONTEXT_ENGINE` | `whisper.cpp` or `mlx`, when both are installed |
| `VIDEO_CONTEXT_MODEL` | a ggml model file for whisper.cpp, instead of downloading one |
| `VIDEO_CONTEXT_MLX_MODEL` | a folder or Hugging Face repo for mlx-whisper, instead of the `mlx-community` one |
| `VIDEO_CONTEXT_HOME` | where results and models go (default `~/.cache/video-context`) |

### MCP clients started from the Dock or Start menu

A desktop app (Claude Desktop, an editor) may not see the PATH of your shell, so a tool that
works in the terminal can be "missing" for the MCP server. Give the server the full paths in
its `env` — find them with `which ffmpeg mlx_whisper whisper-cli` (`where` on Windows):

```json
{
  "mcpServers": {
    "video-context": {
      "command": "npx",
      "args": ["-y", "-p", "@lalohao/video-context", "video-context-mcp"],
      "env": {
        "VIDEO_CONTEXT_FFMPEG": "/opt/homebrew/bin/ffmpeg",
        "VIDEO_CONTEXT_FFPROBE": "/opt/homebrew/bin/ffprobe",
        "VIDEO_CONTEXT_MLX_WHISPER": "/Users/you/.local/bin/mlx_whisper"
      }
    }
  }
}
```

If `npx` itself is not found, use its full path as `command` too.

## Models

The first video downloads the model: 465 MB for the default `small` with whisper.cpp, a
similar size for mlx-whisper. See [choosing a model](how-it-works.md#choosing-a-model).
