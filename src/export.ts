// A processed video as one ZIP file, to hand to someone who then needs no
// processing: the video, its transcript (JSON, Markdown, SRT), key frames,
// chapters and notes, and index.html — the web page with the data inside, that
// opens from the folder without a server. video-context-ui imports it back.

import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs'
import { basename, extname, join, posix } from 'node:path'

import { homeDir } from './deps.js'
import { readChapters, readNotes, type Chapter, type Note } from './library.js'
import { loadVideo, videoDir, videoId, type Manifest } from './process.js'
import { formatTime } from './time.js'
import { toMarkdown, toSrt, type Segment } from './transcript.js'
import { extractZipEntry, listZip, readZipEntry, type ZipEntry, type ZipInput } from './zip.js'

export const EXPORT_SCHEMA = 'video-context-export/1'

/** video-context.json: what the archive is. */
export interface ExportInfo {
  schema: typeof EXPORT_SCHEMA
  exportedAt: string
  id: string
  title: string
  /** The video's file in the archive, or null when it was not there to include. */
  video: string | null
  /** The name of the file it was made from. */
  originalName: string
}

/** What index.html carries, to work without a server. */
export interface ExportData extends ExportInfo {
  manifest: Manifest
  segments: Segment[]
  chapters: Chapter[]
  notes: Note[]
}

const escapeHtml = (text: string): string => text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)

/** A file or folder name from a title. */
export function safeName(title: string): string {
  return title.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '_').replace(/\s+/g, ' ').trim().slice(0, 100) || 'video'
}

const README = (title: string, duration: number): string => `${title} (${formatTime(duration)})
Exported from video-context (https://github.com/LaloHao/video-context).

- Open index.html in a browser: the video with its transcript, key frames,
  chapters and notes. Nothing to install, no server.
- transcript.md / .srt / .json: the transcript with its times.
- To add it to video-context without processing it again: open
  video-context-ui, "+ New video", and drop this ZIP file.
`

/** The archive of a processed video: its name, and its entries (inside one folder). `page` is the web page's HTML. */
export function exportArchive(id: string, page: string): { name: string; entries: ZipInput[] } {
  const video = loadVideo(id)
  if (!video) throw new Error('No such video.')
  const m = video.manifest
  const folder = safeName(m.title)
  const hasVideo = existsSync(m.source)
  const videoName = hasVideo ? `video${extname(m.source).toLowerCase() || '.mp4'}` : null
  const chapters = readChapters(video.dir)
  const notes = readNotes(video.dir)
  const info: ExportInfo = { schema: EXPORT_SCHEMA, exportedAt: new Date().toISOString(), id, title: m.title, video: videoName, originalName: basename(m.source) }
  const manifest: Manifest = { ...m, source: videoName ?? basename(m.source) }
  const data: ExportData = { ...info, manifest, segments: video.segments, chapters, notes }
  // Inside a <script>: nothing in the data may close it.
  const json = JSON.stringify(data).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029')
  // Marked as exported in the HTML itself, so that what needs the server is hidden even before (or without) the script.
  const html = page
    .replace('<html lang="en">', '<html lang="en" class="static">')
    .replace('<span id="videoTitle"></span>', `<span id="videoTitle">${escapeHtml(m.title)}</span>`)
    .replace('<title>video-context</title>', `<title>${escapeHtml(m.title)} — video-context</title>`)
    .replace('<!-- video-context:export -->', `<script>window.VIDEO_CONTEXT_EXPORT = ${json}</script>`)
  const at = (name: string): string => posix.join(folder, name)
  const entries: ZipInput[] = [
    { name: at('index.html'), data: html },
    { name: at('video-context.json'), data: JSON.stringify(info, null, 2) },
    { name: at('manifest.json'), data: JSON.stringify(manifest, null, 2) },
    { name: at('transcript.json'), data: JSON.stringify(video.segments) },
    { name: at('transcript.md'), data: toMarkdown(video.segments, m.title) },
    { name: at('transcript.srt'), data: toSrt(video.segments) },
    { name: at('chapters.json'), data: JSON.stringify(chapters, null, 2) },
    { name: at('notes.json'), data: JSON.stringify(notes, null, 2) },
    { name: at('README.txt'), data: README(m.title, m.duration) },
    ...m.frames.filter((f) => existsSync(join(video.dir, f.file))).map((f) => ({ name: at(f.file), file: join(video.dir, f.file) }))
  ]
  if (videoName) entries.push({ name: at(videoName), file: m.source })
  return { name: `${folder}.zip`, entries }
}

/** A frame's file inside an export, checked: frames/<name>.jpg and nothing else (no "..", no absolute path). */
const FRAME = /^frames\/[\w.-]+\.jpe?g$/i

/**
 * Add an exported video to this machine's videos, without processing it: the
 * video goes to ~/.cache/video-context/imports, and its results where processing
 * would have put them, so the same file is never processed again.
 */
export async function importArchive(file: string): Promise<{ id: string; title: string; already: boolean }> {
  const entries = listZip(file)
  // The export's folder: where its video-context.json is (an archive made again by hand may add folders).
  const marker = entries
    .filter((e) => posix.basename(e.name) === 'video-context.json' && !e.name.startsWith('__MACOSX/'))
    .sort((a, b) => a.name.length - b.name.length)[0]
  if (!marker) throw new Error('This ZIP file is not a video-context export (it has no video-context.json).')
  const prefix = posix.dirname(marker.name) === '.' ? '' : `${posix.dirname(marker.name)}/`
  const byName = new Map(entries.map((e) => [e.name, e]))
  const entry = (name: string): ZipEntry | undefined => byName.get(prefix + name)
  const json = <T>(name: string): T => {
    const e = entry(name)
    if (!e) throw new Error(`The export has no ${name}.`)
    return JSON.parse(readZipEntry(file, e).toString('utf8')) as T
  }

  const info = json<ExportInfo>('video-context.json')
  if (typeof info.schema !== 'string' || !info.schema.startsWith('video-context-export/')) throw new Error('This ZIP file is not a video-context export.')
  if (info.schema !== EXPORT_SCHEMA) throw new Error(`This export is in a newer format (${info.schema}): update video-context to import it.`)
  const manifest = json<Manifest>('manifest.json')
  const segments = json<Segment[]>('transcript.json')
  const chapters = entry('chapters.json') ? json<Chapter[]>('chapters.json') : []
  const notes = entry('notes.json') ? json<Note[]>('notes.json') : []

  // The video, extracted once into its own folder.
  const target = join(homeDir(), 'imports', `${safeName(info.title)}-${String(info.id).replace(/[^0-9a-f]/g, '').slice(0, 8)}`)
  mkdirSync(target, { recursive: true })
  const videoName = info.video && /^video\.[a-z0-9]+$/i.test(info.video) ? info.video : null
  const videoEntry = videoName ? entry(videoName) : undefined
  // Without the video, the source names a file that is not there: the page says so.
  const source = join(target, videoEntry ? videoName! : basename(String(manifest.source)))
  if (videoEntry && !(existsSync(source) && statSync(source).size === videoEntry.size)) await extractZipEntry(file, videoEntry, source)

  // Its id is that of the file where it is now (as processing would name it); without the video, the exported id.
  const id = videoEntry ? videoId(source) : /^[0-9a-f]{16}$/.test(info.id) ? info.id : null
  if (!id) throw new Error('The export has no video and no valid id.')
  if (loadVideo(id)) return { id, title: info.title, already: true }

  const dir = videoDir(id)
  mkdirSync(join(dir, 'frames'), { recursive: true })
  const frames = manifest.frames.filter((f) => FRAME.test(f.file) && entry(f.file))
  for (const f of frames) await extractZipEntry(file, entry(f.file)!, join(dir, f.file))
  writeFileSync(join(dir, 'transcript.json'), JSON.stringify(segments))
  writeFileSync(join(dir, 'transcript.md'), entry('transcript.md') ? readZipEntry(file, entry('transcript.md')!) : toMarkdown(segments, info.title))
  writeFileSync(join(dir, 'transcript.srt'), entry('transcript.srt') ? readZipEntry(file, entry('transcript.srt')!) : toSrt(segments))
  writeFileSync(join(dir, 'chapters.json'), JSON.stringify(chapters, null, 2))
  writeFileSync(join(dir, 'notes.json'), JSON.stringify(notes, null, 2))
  const imported: Manifest = { ...manifest, id, source, frames, importedFrom: { id: info.id, exportedAt: info.exportedAt, originalName: info.originalName } }
  // Last, as processing does: a folder with a manifest is a finished one.
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(imported, null, 2))
  return { id, title: info.title, already: false }
}
