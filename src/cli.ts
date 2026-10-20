#!/usr/bin/env node
// `video-context <file>`: process a video and print where the results are.

import { cpSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'

import { MODELS, type ModelName } from './deps.js'
import { processVideo } from './process.js'
import { formatTime } from './time.js'

const USAGE = `Usage: video-context <video> [options]

Transcribes the video on this machine (whisper.cpp) and extracts key frames (ffmpeg).

Options:
  -l, --language <code>  Spoken language, e.g. es, en (default: auto)
  -m, --model <name>     Whisper model: ${MODELS.join(', ')} (default: small)
  -o, --out <dir>        Also copy the results to this folder
      --force            Process again even if it was processed before
  -h, --help             Show this help

Results: transcript.md (readable, with times), transcript.srt, transcript.json,
frames/ (named by their time) and manifest.json.`

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    language: { type: 'string', short: 'l' },
    model: { type: 'string', short: 'm' },
    out: { type: 'string', short: 'o' },
    force: { type: 'boolean' },
    help: { type: 'boolean', short: 'h' }
  }
})

if (values.help || positionals.length !== 1) {
  console.log(USAGE)
  process.exit(values.help ? 0 : 1)
}
if (values.model && !(MODELS as readonly string[]).includes(values.model)) {
  console.error(`Unknown model "${values.model}". Use one of: ${MODELS.join(', ')}.`)
  process.exit(1)
}

const file = positionals[0]
let last = ''
try {
  const { dir, manifest } = await processVideo(file, {
    language: values.language,
    model: values.model as ModelName | undefined,
    force: values.force,
    onProgress: (p) => {
      if (p.message === last) return
      last = p.message
      process.stderr.write(`${p.message}\n`)
    }
  })
  let target = dir
  if (values.out) {
    target = resolve(values.out)
    cpSync(dir, target, { recursive: true })
  }
  console.log(`"${manifest.title}" — ${formatTime(manifest.duration)}, ${manifest.segments} segments, ${manifest.frames.length} frames`)
  console.log(`Transcript: ${join(target, 'transcript.md')}`)
  console.log(`Frames:     ${join(target, 'frames')}`)
  console.log(`Video id:   ${manifest.id}`)
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(existsSync(file) ? 2 : 1)
}
