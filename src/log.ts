// The web page's log: what the server did and what failed, with the details
// (a tool's error output, Claude's answer). The newest entries are kept in
// memory for the page, and every entry is appended to a file that outlives
// the server.

import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from 'node:fs'
import { dirname } from 'node:path'

export type Level = 'info' | 'warn' | 'error'

export interface LogEntry {
  seq: number
  time: number
  level: Level
  /** What it is about: queue, claude, chapters, chat, clip, server… */
  source: string
  message: string
  detail?: string
}

/** Entries kept in memory. */
const KEEP = 2000
/** The file is moved aside (`.1`) past this size. */
const MAX_FILE = 5_000_000

export class Log {
  private entries: LogEntry[] = []
  private seq = 0

  constructor(private readonly file?: string, private readonly echo = false) {}

  add(level: Level, source: string, message: string, detail?: string): LogEntry {
    const entry: LogEntry = { seq: ++this.seq, time: Date.now(), level, source, message, ...(detail?.trim() && { detail: detail.trim().slice(-20_000) }) }
    this.entries.push(entry)
    if (this.entries.length > KEEP) this.entries.splice(0, this.entries.length - KEEP)
    const line = `${new Date(entry.time).toISOString()} ${level.toUpperCase().padEnd(5)} [${source}] ${message}${entry.detail ? `\n${entry.detail.replace(/^/gm, '    ')}` : ''}\n`
    if (this.echo) (level === 'error' ? process.stderr : process.stdout).write(line)
    if (this.file) {
      try {
        mkdirSync(dirname(this.file), { recursive: true })
        if (existsSync(this.file) && statSync(this.file).size > MAX_FILE) renameSync(this.file, `${this.file}.1`)
        appendFileSync(this.file, line)
      } catch {
        /* the page keeps working without its log file */
      }
    }
    return entry
  }

  info(source: string, message: string, detail?: string): LogEntry {
    return this.add('info', source, message, detail)
  }

  warn(source: string, message: string, detail?: string): LogEntry {
    return this.add('warn', source, message, detail)
  }

  error(source: string, message: string, detail?: string): LogEntry {
    return this.add('error', source, message, detail)
  }

  /** Entries after `seq` (all when 0). */
  since(seq = 0): LogEntry[] {
    return seq <= 0 ? [...this.entries] : this.entries.filter((e) => e.seq > seq)
  }

  clear(): void {
    this.entries = []
  }
}
