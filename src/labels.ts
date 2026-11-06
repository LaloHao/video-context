// What the user calls a video and where they file it: a name (instead of the file's or
// the recording's), a folder ("Posgrado/Clases") and tags. Kept in labels.json in the
// video's folder, apart from the results, so processing it again keeps them.

import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export interface Labels {
  /** The name to show and call it by, instead of the processed title. */
  title?: string
  /** A folder, with subfolders: "Posgrado/Clases". */
  folder?: string
  tags: string[]
}

const FILE = 'labels.json'

/** A folder as written by hand, tidied: "/ Posgrado // Clases/ " → "Posgrado/Clases"; empty → undefined. */
export function cleanFolder(folder: unknown): string | undefined {
  if (typeof folder !== 'string') return undefined
  const parts = folder.split(/[\\/]+/).map((p) => p.replace(/\s+/g, ' ').trim()).filter(Boolean)
  return parts.length ? parts.join('/').slice(0, 200) : undefined
}

/** Tags tidied: trimmed, without "#", one of each (case aside), in the order given. */
export function cleanTags(tags: unknown): string[] {
  const list = Array.isArray(tags) ? tags : typeof tags === 'string' ? tags.split(',') : []
  const seen = new Set<string>()
  const out: string[] = []
  for (const tag of list) {
    if (typeof tag !== 'string') continue
    const clean = tag.replace(/^#+/, '').replace(/\s+/g, ' ').trim().slice(0, 60)
    if (clean && !seen.has(clean.toLowerCase())) {
      seen.add(clean.toLowerCase())
      out.push(clean)
    }
  }
  return out
}

export function cleanLabels(raw: unknown): Labels {
  const r = (raw ?? {}) as Record<string, unknown>
  const title = typeof r.title === 'string' && r.title.trim() ? r.title.replace(/\s+/g, ' ').trim().slice(0, 200) : undefined
  return { ...(title && { title }), ...(cleanFolder(r.folder) && { folder: cleanFolder(r.folder) }), tags: cleanTags(r.tags) }
}

export function readLabels(dir: string): Labels {
  const file = join(dir, FILE)
  if (!existsSync(file)) return { tags: [] }
  try {
    return cleanLabels(JSON.parse(readFileSync(file, 'utf8')))
  } catch {
    return { tags: [] }
  }
}

/** Saved as given (cleaned); no name, folder nor tag leaves no file. */
export function writeLabels(dir: string, labels: Partial<Labels>): Labels {
  const clean = cleanLabels(labels)
  const file = join(dir, FILE)
  if (!clean.title && !clean.folder && clean.tags.length === 0) {
    rmSync(file, { force: true })
    return clean
  }
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(clean, null, 2))
  renameSync(tmp, file)
  return clean
}

/** True when `folder` is `under` or inside it ("Posgrado/Clases" is under "posgrado"), case aside. */
export function inFolder(folder: string | undefined, under: string): boolean {
  const want = cleanFolder(under)?.toLowerCase()
  if (!want) return true
  const have = folder?.toLowerCase()
  return have === want || Boolean(have?.startsWith(`${want}/`))
}

/** True when `tags` has `tag`, case aside. */
export const hasTag = (tags: string[] | undefined, tag: string): boolean => (tags ?? []).some((t) => t.toLowerCase() === tag.replace(/^#+/, '').trim().toLowerCase())
