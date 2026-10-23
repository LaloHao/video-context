// End to end on a generated 8-second video: the real ffmpeg and whisper
// engine, and the real MCP server over stdio. Skipped unless the tools are
// installed and, for whisper.cpp, a model is available (set
// VIDEO_CONTEXT_MODEL to a ggml model file; mlx_whisper downloads its own).

import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { findTools } from '../src/deps.js'
import { findTesseract } from '../src/ocr.js'

const model = process.env.VIDEO_CONTEXT_MODEL
const tools = findTools()
const ready = !('missing' in tools) && (tools.engine === 'mlx' || Boolean(model && existsSync(model))) && existsSync('dist/mcp.js')
/** A font for drawtext and tesseract: then the second scene carries text to read. */
const FONT = '/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf'
const ocr = existsSync(FONT) && findTesseract() !== null

describe.skipIf(!ready)('end to end', () => {
  let home: string
  let video: string

  beforeAll(() => {
    home = mkdtempSync(join(tmpdir(), 'video-context-'))
    video = join(home, 'sample.mp4')
    // Two scenes (a color change at 4 s) and a tone: enough for frames and a (near empty) transcript.
    execFileSync('ffmpeg', [
      '-v', 'error', '-y',
      '-f', 'lavfi', '-i', ocr
        ? `color=c=blue:s=640x240:d=4,drawtext=fontfile=${FONT}:text='POST /api/v1/referencias/CreaReferencia':fontsize=22:fontcolor=white:x=20:y=100`
        : // Without a font, a box: two plain colors have the same dHash and one would be dropped.
          'color=c=blue:s=640x240:d=4,drawbox=x=0:y=0:w=320:h=240:color=white:t=fill',
      '-f', 'lavfi', '-i', 'color=c=red:s=640x240:d=4',
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=8',
      '-filter_complex', '[1:v][0:v]concat=n=2:v=1:a=0[v]',
      '-map', '[v]', '-map', '2:a', '-shortest', video
    ])
  })
  afterAll(() => rmSync(home, { recursive: true, force: true }))

  it('processes through the MCP server and serves the frames as images', async () => {
    const child = spawn(process.execPath, ['dist/mcp.js'], { env: { ...process.env, VIDEO_CONTEXT_HOME: home }, stdio: ['pipe', 'pipe', 'inherit'] })
    let buffer = ''
    const waiting = new Map<number, (value: { result?: { content: { type: string; text?: string }[] } }) => void>()
    child.stdout.on('data', (chunk: Buffer) => {
      buffer += chunk.toString()
      let nl: number
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl)
        buffer = buffer.slice(nl + 1)
        const msg = JSON.parse(line) as { id?: number }
        if (msg.id !== undefined) waiting.get(msg.id)?.(msg as never)
      }
    })
    let next = 1
    const call = (method: string, params: unknown): Promise<{ result?: { content: { type: string; text?: string }[]; tools?: { name: string }[] } }> =>
      new Promise((resolve) => {
        const id = next++
        waiting.set(id, resolve as never)
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
      })
    try {
      await call('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } })
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`)
      const tools = await call('tools/list', {})
      expect(tools.result?.tools?.map((t) => t.name).sort()).toEqual(
        ['get_frames', 'get_transcript', 'list_frames', 'list_videos', 'process_video', 'search_transcript', 'video_status'].sort()
      )
      const started = await call('tools/call', { name: 'process_video', arguments: { path: video, language: 'en' } })
      const id = /video ([0-9a-f]{16})/.exec(started.result!.content[0].text!)![1]
      let status = ''
      for (let i = 0; i < 120 && !status.includes('is ready'); i++) {
        await new Promise((r) => setTimeout(r, 500))
        status = (await call('tools/call', { name: 'video_status', arguments: { videoId: id } })).result!.content[0].text!
      }
      expect(status).toContain('is ready')
      expect(status).toContain('0:08 long')
      const transcriptFile = /Transcript \(Markdown, with times\): (.+)$/m.exec(status)![1]
      expect(readFileSync(transcriptFile, 'utf8')).toContain('# sample')
      const frames = await call('tools/call', { name: 'get_frames', arguments: { videoId: id, from: '0', to: '8' } })
      const images = frames.result!.content.filter((c) => c.type === 'image')
      // The first frame and the scene change at 4 s.
      expect(images.length).toBeGreaterThanOrEqual(2)
      if (ocr) {
        const found = await call('tools/call', { name: 'search_transcript', arguments: { videoId: id, query: 'CreaReferencia' } })
        expect(found.result!.content[0].text).toMatch(/On screen:\n\[0:0[45]\] .*CreaReferencia/)
      }
    } finally {
      child.kill()
    }
  }, 120_000)
})
