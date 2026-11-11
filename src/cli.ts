#!/usr/bin/env node
// `video-context <file>`: process a video and print where the results are.

import { cpSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { parseArgs, type ParseArgsConfig } from 'node:util'

import { doctor, ENGINES, MODELS, type Engine, type ModelName } from './deps.js'
import { readLabels, writeLabels } from './labels.js'
import { loadVideo, processVideo } from './process.js'
import { formatTime } from './time.js'

const USAGE = `Usage: video-context <video> [options]
       video-context --doctor
       video-context ui [--open]   The local page (same as video-context-ui)
       video-context mcp           The MCP server (same as video-context-mcp)

Transcribes the video on this machine (whisper.cpp or mlx-whisper) and extracts key frames (ffmpeg).

Options:
  -l, --language <code>  Spoken language, e.g. es, en (default: auto)
  -m, --model <name>     Whisper model: ${MODELS.join(', ')} (default: small)
  -e, --engine <name>    ${ENGINES.join(' or ')} (default: mlx when installed, else whisper.cpp)
  -o, --out <dir>        Also copy the results to this folder
  -n, --name <name>      A name to call it by (instead of the file name)
  -f, --folder <folder>  File it in a folder, e.g. "Posgrado/Clases"
  -t, --tag <tag>        Tag it (repeat for several tags)
      --no-ocr           Do not read the text on screen (OCR needs tesseract)
      --keep-duplicates  Keep near-identical frames
      --force            Process again even if it was processed before
      --doctor           Check the setup: which tools are installed, and how to install the rest
  -h, --help             Show this help

Results: transcript.md (readable, with times), transcript.srt, transcript.json,
frames/ (named by their time) and manifest.json.`

/** The arguments, or the usage with what is wrong (not a stack trace) for an unknown option. */
function parse<T extends ParseArgsConfig>(config: T): ReturnType<typeof parseArgs<T>> {
  try {
    return parseArgs(config)
  } catch (error) {
    // Node's message goes on about "--" for positionals: its first sentence says it.
    console.error(`${String((error as Error).message).split('. ')[0]}.\n\n${USAGE}`)
    process.exit(1)
  }
}

async function processCommand(): Promise<void> {
  const { values, positionals } = parse({
    allowPositionals: true,
    options: {
      language: { type: 'string', short: 'l' },
      model: { type: 'string', short: 'm' },
      engine: { type: 'string', short: 'e' },
      doctor: { type: 'boolean' },
      out: { type: 'string', short: 'o' },
      name: { type: 'string', short: 'n' },
      folder: { type: 'string', short: 'f' },
      tag: { type: 'string', short: 't', multiple: true },
      force: { type: 'boolean' },
      'no-ocr': { type: 'boolean' },
      'keep-duplicates': { type: 'boolean' },
      help: { type: 'boolean', short: 'h' }
    }
  })

  if (values.doctor) {
    const { ok, lines } = doctor()
    console.log(lines.join('\n'))
    process.exit(ok ? 0 : 1)
  }
  if (values.help || positionals.length !== 1) {
    console.log(USAGE)
    process.exit(values.help ? 0 : 1)
  }
  if (values.model && !(MODELS as readonly string[]).includes(values.model)) {
    console.error(`Unknown model "${values.model}". Use one of: ${MODELS.join(', ')}.`)
    process.exit(1)
  }

  if (values.engine && !(ENGINES as readonly string[]).includes(values.engine)) {
    console.error(`Unknown engine "${values.engine}". Use one of: ${ENGINES.join(', ')}.`)
    process.exit(1)
  }

  const file = positionals[0]
  let last = ''
  try {
    const processed = await processVideo(file, {
      language: values.language,
      model: values.model as ModelName | undefined,
      engine: values.engine as Engine | undefined,
      force: values.force,
      ocr: !values['no-ocr'],
      dedupeThreshold: values['keep-duplicates'] ? -1 : undefined,
      onProgress: (p) => {
        if (p.message === last) return
        last = p.message
        process.stderr.write(`${p.message}\n`)
      }
    })
    const { dir } = processed
    // Name, folder and tags: kept apart from the results (labels.json), the tags added to any it has.
    if (values.name || values.folder || values.tag?.length) {
      const before = readLabels(dir)
      writeLabels(dir, { title: values.name ?? before.title, folder: values.folder ?? before.folder, tags: [...before.tags, ...(values.tag ?? [])] })
    }
    const manifest = loadVideo(processed.manifest.id)?.manifest ?? processed.manifest
    let target = dir
    if (values.out) {
      target = resolve(values.out)
      cpSync(dir, target, { recursive: true })
    }
    console.log(`"${manifest.title}" — ${formatTime(manifest.duration)}, ${manifest.segments} segments, ${manifest.frames.length} frames`)
    console.log(`Transcript: ${join(target, 'transcript.md')}`)
    console.log(`Frames:     ${join(target, 'frames')}`)
    console.log(`Video id:   ${manifest.id}`)
    if (manifest.folder || manifest.tags?.length) console.log(`Filed:      ${[manifest.folder, ...(manifest.tags ?? []).map((t) => `#${t}`)].filter(Boolean).join(' · ')}`)
    if (manifest.droppedFrames) console.log(`Dropped ${manifest.droppedFrames} near-duplicate frames.`)
    if (manifest.ocr && 'skipped' in manifest.ocr) console.log(`Text on screen not read: ${manifest.ocr.skipped}.`)
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(existsSync(file) ? 2 : 1)
  }
}

// `npx @lalohao/video-context video-context-ui` (without `-p`) runs this command with the
// other's name as its first argument: run that one. `ui` and `mcp` say the same, shorter.
const COMMANDS: Record<string, string> = { ui: './ui.js', 'video-context-ui': './ui.js', mcp: './mcp.js', 'video-context-mcp': './mcp.js' }
const command = process.argv[2]
if (command && COMMANDS[command] && !existsSync(command)) {
  process.argv.splice(2, 1)
  await import(COMMANDS[command])
} else {
  await processCommand()
}
