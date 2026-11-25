// The images you send with a message: `[image N]` in its text stands for the Nth one. A click on that
// marker opens the image in the system's image viewer, so you can see what you sent.

import { C } from './text.ts'
import type { Span, Style } from './text.ts'

/** Shown as a link: blue and underlined, as links in the app are. */
export const IMAGE_LINK: Style = { fg: C.blue, underline: true }

/**
 * `text` as spans, each `[image N]` in it a link to that image when `click(N)` gives its action (an
 * image the app has no record of stays plain text). The rest keeps `style` and `action`.
 */
export function imageSpans(text: string, click: ((n: number) => (() => void) | undefined) | undefined, style?: Style, action?: () => void): Span[] {
  const plain = (t: string): Span => ({ text: t, ...(style ? { style } : {}), ...(action ? { action } : {}) })
  if (!click || !text.includes('[image ')) return [plain(text)]
  const out: Span[] = []
  let at = 0
  for (const m of text.matchAll(/\[image (\d+)\]/g)) {
    const go = click(Number(m[1]))
    if (!go) continue
    if (m.index > at) out.push(plain(text.slice(at, m.index)))
    out.push({ text: m[0], style: { ...style, ...IMAGE_LINK }, action: go })
    at = m.index + m[0].length
  }
  if (at < text.length || !out.length) out.push(plain(text.slice(at)))
  return out
}

/**
 * The command that opens a file in the system's viewer: on WSL (and Windows) PowerShell's Start-Process
 * with the file's Windows path (`winPath`, from `wslpath -w`), `open` on macOS, `xdg-open` elsewhere.
 */
export function openerFor(path: string, platform: string, isWsl: boolean, winPath?: string): [string, string[]] {
  if (isWsl || platform === 'win32') {
    const p = (isWsl ? winPath : undefined) ?? path
    return [isWsl ? 'powershell.exe' : 'powershell', ['-NoProfile', '-Command', `Start-Process -FilePath '${p.replace(/'/g, "''")}'`]]
  }
  if (platform === 'darwin') return ['open', [path]]
  return ['xdg-open', [path]]
}
