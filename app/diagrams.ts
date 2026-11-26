// Images other programs make for the chat, in the background, cached by content under
// ~/.clued/cache/: Mermaid diagrams drawn by mmdc (@mermaid-js/mermaid-cli), and JPEG, GIF, WebP and
// SVG files turned into PNG (for the kitty protocol and Sixel, which clued draws from PNG) by a tool
// already on the machine: sips on macOS, ImageMagick, ffmpeg, or rsvg-convert for SVG. Nothing is
// installed or downloaded; without a tool, the image stays a link.

import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { accessSync, constants, existsSync, mkdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { delimiter, join } from 'node:path'

/** Where a render is: drawn (its PNG), on its way, failed (why), or no tool to make it. */
export type Render = { state: 'ready'; png: string } | { state: 'drawing' } | { state: 'failed'; error: string } | { state: 'missing' }

/** Runs a program; calls back with its error (undefined when it succeeded). */
export type Run = (cmd: string, args: string[], done: (err?: string) => void) => void

/** The first of `names` on PATH, as a full path. */
export function onPath(names: readonly string[], path = process.env.PATH ?? ''): string | undefined {
  for (const name of names)
    for (const dir of path.split(delimiter).filter(Boolean)) {
      const p = join(dir, name)
      try {
        accessSync(p, constants.X_OK)
        if (statSync(p).isFile()) return p
      } catch {}
    }
  return undefined
}

const runDefault: Run = (cmd, args, done) => {
  execFile(cmd, args, { timeout: 60_000, maxBuffer: 4 << 20 }, (err, _out, errOut) => {
    if (!err) return done()
    const why = String(errOut || err.message).split('\n').map(l => l.trim()).find(l => /error|fail|cannot|can't|not/i.test(l)) ?? err.message.split('\n')[0]!
    done(why.slice(0, 200))
  })
}

/**
 * The look diagrams are drawn in, on a clear background: dark boxes with rounded corners and teal
 * edges (clued's cyan), soft blue curved arrows, and Lato or another clean sans-serif font.
 */
export const MERMAID_CONFIG = {
  theme: 'base',
  fontFamily: 'Lato, "Segoe UI", "Helvetica Neue", "DejaVu Sans", sans-serif',
  flowchart: { curve: 'basis', padding: 18, nodeSpacing: 40, rankSpacing: 55 },
  themeVariables: {
    darkMode: true, background: 'transparent', fontSize: '17px',
    primaryColor: '#16232c', primaryBorderColor: '#4fc3d0', primaryTextColor: '#e8eef2', lineColor: '#6f8fa8',
    secondaryColor: '#1d1830', tertiaryColor: '#1b2620', edgeLabelBackground: 'transparent',
    clusterBkg: '#141b22', clusterBorder: '#33505f',
  },
}
/** What the config can't say: rounded boxes, and arrow labels with no box behind them. */
export const MERMAID_CSS = '.node rect,.node polygon{rx:10px;ry:10px} .edgeLabel,.edgeLabel p,.labelBkg{background-color:transparent !important;color:#9fb3c3} .edgeLabel rect{opacity:0}'
const MERMAID_ARGS = ['-b', 'transparent', '-s', '2', '-q']
/** Everything that changes how a diagram looks, so a new look draws diagrams anew rather than reusing old ones. */
const MERMAID_LOOK = JSON.stringify(MERMAID_CONFIG) + '\0' + MERMAID_CSS + '\0' + MERMAID_ARGS.join(' ')

export class Renders {
  private known = new Map<string, Render>()
  private queue: (() => void)[] = []
  private busy = false
  private tools = new Map<string, string | undefined>()

  private dir: string
  private onDone: () => void
  private opts: { run?: Run; path?: string; platform?: string }

  constructor(dir: string, onDone: () => void, opts: { run?: Run; path?: string; platform?: string } = {}) {
    this.dir = dir
    this.onDone = onDone
    this.opts = opts
  }

  private tool(names: readonly string[]): string | undefined {
    const key = names.join(',')
    if (!this.tools.has(key)) this.tools.set(key, onPath(names, this.opts.path))
    return this.tools.get(key)
  }

  /** Whether mmdc is on PATH. */
  get hasMermaid() {
    return !!this.tool(['mmdc'])
  }

  /** One job at a time: each mmdc starts a browser. */
  private enqueue(job: (next: () => void) => void) {
    this.queue.push(() => job(() => {
      this.busy = false
      this.pump()
    }))
    this.pump()
  }

  private pump() {
    if (this.busy) return
    const next = this.queue.shift()
    if (!next) return
    this.busy = true
    next()
  }

  private finish(key: string, out: string, err?: string) {
    this.known.set(key, err || !existsSync(out) ? { state: 'failed', error: err || 'it made no image' } : { state: 'ready', png: out })
    this.onDone()
  }

  /** A Mermaid diagram as a PNG: drawn once per source, then from the cache. */
  diagram(code: string): Render {
    const hash = createHash('sha256').update(MERMAID_LOOK + '\0' + code).digest('hex').slice(0, 32)
    const out = join(this.dir, 'mermaid', `${hash}.png`)
    const key = `m:${hash}`
    const known = this.known.get(key)
    if (known) return known
    if (existsSync(out)) return this.remember(key, { state: 'ready', png: out })
    const mmdc = this.tool(['mmdc'])
    if (!mmdc) return { state: 'missing' }
    this.known.set(key, { state: 'drawing' })
    this.enqueue(next => {
      try {
        mkdirSync(join(this.dir, 'mermaid'), { recursive: true })
        const src = join(this.dir, 'mermaid', `${hash}.mmd`)
        const tmp = join(this.dir, 'mermaid', `${hash}.tmp.png`)
        writeFileSync(src, code)
        const look = ['-c', join(this.dir, 'mermaid', 'theme.json'), '-C', join(this.dir, 'mermaid', 'theme.css')]
        writeFileSync(look[1]!, JSON.stringify(MERMAID_CONFIG))
        writeFileSync(look[3]!, MERMAID_CSS)
        const done = (err?: string) => {
          rmSync(src, { force: true })
          if (!err && existsSync(tmp)) renameSync(tmp, out)
          this.finish(key, out, err)
          next()
        }
        const run = this.opts.run ?? runDefault
        run(mmdc, ['-i', src, '-o', tmp, ...look, ...MERMAID_ARGS], err => {
          // Chrome's sandbox can't start in some Linux setups (as root, or AppArmor's limits): once more without it.
          if (!err || !/sandbox/i.test(err)) return done(err)
          const cfg = join(this.dir, 'mermaid', 'no-sandbox.json')
          writeFileSync(cfg, JSON.stringify({ args: ['--no-sandbox'] }))
          run(mmdc, ['-i', src, '-o', tmp, '-p', cfg, ...look, ...MERMAID_ARGS], done)
        })
      } catch (e) {
        this.finish(key, out, (e as Error).message)
        next()
      }
    })
    return { state: 'drawing' }
  }

  /** A JPEG, GIF, WebP or SVG file as a PNG, by the first tool there is for it. */
  convert(path: string): Render {
    let st
    try {
      st = statSync(path)
    } catch {
      return { state: 'failed', error: 'no such file' }
    }
    const hash = createHash('sha256').update(`${path}\0${st.size}\0${st.mtimeMs}`).digest('hex').slice(0, 32)
    const out = join(this.dir, 'images', `${hash}.png`)
    const key = `c:${hash}`
    const known = this.known.get(key)
    if (known) return known
    if (existsSync(out)) return this.remember(key, { state: 'ready', png: out })
    const isSvg = /\.svg$/i.test(path)
    const mac = (this.opts.platform ?? process.platform) === 'darwin'
    const tool = this.tool(isSvg ? ['rsvg-convert', 'magick', 'convert'] : [...(mac ? ['sips'] : []), 'magick', 'convert', 'ffmpeg'])
    if (!tool) return { state: 'missing' }
    this.known.set(key, { state: 'drawing' })
    this.enqueue(next => {
      mkdirSync(join(this.dir, 'images'), { recursive: true })
      const tmp = join(this.dir, 'images', `${hash}.tmp.png`)
      const name = tool.split(/[\\/]/).pop()!
      const args = name === 'sips' ? ['-s', 'format', 'png', path, '--out', tmp]
        : name === 'rsvg-convert' ? ['-w', '1600', '--keep-aspect-ratio', '-o', tmp, path]
        : name === 'ffmpeg' ? ['-v', 'error', '-y', '-i', path, '-frames:v', '1', tmp]
        : [isSvg ? '-density' : '-strip', ...(isSvg ? ['192'] : []), `${path}[0]`, tmp]
      ;(this.opts.run ?? runDefault)(tool, args, err => {
        if (!err && existsSync(tmp)) renameSync(tmp, out)
        this.finish(key, out, err)
        next()
      })
    })
    return { state: 'drawing' }
  }

  private remember(key: string, r: Render): Render {
    this.known.set(key, r)
    return r
  }
}

