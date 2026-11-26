// /setup and `clued setup`: the optional extras clued uses, each with its status, and what installing
// one does, said in full before anything happens. Nothing is ever installed without a yes.
//
//   diagrams  mmdc, from npm i -g @mermaid-js/mermaid-cli (it brings a headless Chromium, ~150 MB)
//   font      Cascadia Mono NF, for Arabic in Windows Terminal: two TTFs out of a pinned Cascadia
//             Code release, checked against their SHA-256, copied to the user's own fonts folder and
//             registered with plain reg.exe (no PowerShell, nothing encoded: antivirus kills those)
//   face      Windows Terminal's font face: Cascadia Mono NF, with Simplified Arabic Fixed (or Courier
//             New) after it for lam-alef; settings.json backed up first, comments kept
//   notify    the click handler of notifications (notify.ts sets it up; here only its status)
//   images    which image protocol this terminal gets: information only

import { execFile, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { accessSync, constants, existsSync, mkdirSync, readFileSync, rmdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { onPath } from './diagrams.ts'
import { detectProtocol } from './inline-images.ts'
import type { Protocol } from './inline-images.ts'
import { find, findString, parse, setString } from './jsonc.ts'
import type { Node } from './jsonc.ts'
import { clickHandlerState, lastLine, setupClickHandler, windowsDirs } from './notify.ts'
import type { HandlerIo, Ran, WindowsDirs } from './notify.ts'
import { C, clip, wrap } from './text.ts'
import type { Line, Span } from './text.ts'
import { entries, extract } from './zip.ts'
import type { GetRange } from './zip.ts'

export type ExtraId = 'diagrams' | 'font' | 'face' | 'notify' | 'images'
export const EXTRAS: ExtraId[] = ['diagrams', 'font', 'face', 'notify', 'images']

/** ok: there; missing: can be installed; na: not for this terminal; info: nothing to install; error: couldn't tell. */
export type State = 'ok' | 'missing' | 'na' | 'info' | 'error'
export type Status = { id: ExtraId; name: string; state: State; text: string }

export const NAMES: Record<ExtraId, string> = {
  diagrams: 'Diagrams',
  font: 'Arabic font',
  face: 'Font face',
  notify: 'Notification click',
  images: 'Inline images',
}

/** What the extras need of the system: the tests give fakes. */
export type SetupIo = HandlerIo & {
  /** A long program (npm), each line it prints given as it comes. */
  run: (cmd: string, args: string[], line: (s: string) => void) => Promise<Ran>
  /** A file's bytes, undefined when there is none. */
  bytes: (path: string) => Uint8Array | undefined
  /** Writes a file, its folder made first. */
  write: (path: string, data: string | Uint8Array) => void
  exists: (path: string) => boolean
  /** Whether this user can write in a folder. */
  writable: (dir: string) => boolean
  /** A part of a file on the web: bytes `from` to `to`. */
  range: (url: string, from: number, to: number) => Promise<Uint8Array>
  now: () => Date
}

/**
 * %LOCALAPPDATA% (notify.ts's windowsDirs), once per io: WSL's interop fails now and then when two
 * Windows programs start at once (UtilAcceptVsock), so it is asked once, and once more if that failed.
 */
const dirsOf = new WeakMap<object, Promise<WindowsDirs | string>>()
export function dirs(io: SetupIo): Promise<WindowsDirs | string> {
  let d = dirsOf.get(io)
  if (!d) dirsOf.set(io, (d = windowsDirs(io).then(r => (typeof r === 'string' ? windowsDirs(io) : r))))
  return d
}

/** Windows Terminal, from WSL: where the Arabic extras apply. */
export const inWt = (io: Pick<SetupIo, 'env' | 'isWsl'>) => !!io.env.WT_SESSION && io.isWsl

// ---- Diagrams -----------------------------------------------------------------------------

export const MERMAID_PACKAGE = '@mermaid-js/mermaid-cli'
export const NPM_ARGS = ['i', '-g', MERMAID_PACKAGE]

function diagramsStatus(io: SetupIo): Status {
  const at = onPath(['mmdc'], io.env.PATH ?? '')
  return { id: 'diagrams', name: NAMES.diagrams, state: at ? 'ok' : 'missing', text: at ? `mmdc is on PATH (${at})` : 'Diagrams in replies need mmdc: Mermaid blocks show as code' }
}

async function diagramsPlan(io: SetupIo): Promise<Plan> {
  const p = await io.exec('npm', ['prefix', '-g'])
  if (!p.ok) return { error: `npm isn't working here (${lastLine(p)}): it comes with Node` }
  const prefix = p.stdout.trim()
  // npm puts global packages in <prefix>/lib/node_modules, their commands in <prefix>/bin (on Windows, the prefix itself).
  const lib = io.exists(join(prefix, 'lib')) ? join(prefix, 'lib') : prefix
  const steps = [
    `Runs: npm ${NPM_ARGS.join(' ')}`,
    'Downloads about 150 MB: mmdc, and the headless Chromium it draws with (Puppeteer keeps it in ~/.cache/puppeteer).',
    `Writes to npm's global folder: ${prefix}`,
  ]
  const warn = io.writable(lib) ? undefined : `${lib} isn't writable by you, so npm will fail. Run sudo npm ${NPM_ARGS.join(' ')} yourself, or give npm a folder of yours first (npm config set prefix ~/.local).`
  return {
    id: 'diagrams',
    title: 'Install the diagram tool (mmdc)?',
    steps,
    ...(warn ? { warn } : {}),
    run: async say => {
      say(`npm ${NPM_ARGS.join(' ')}`)
      const r = await io.run('npm', NPM_ARGS, say)
      if (!r.ok) return { ok: false, text: `npm failed: ${lastLine(r)}` }
      const at = onPath(['mmdc'], io.env.PATH ?? '')
      if (at) return { ok: true, text: `Diagrams: mmdc is installed (${at}). The next Mermaid block is drawn.` }
      const bin = io.isWsl || !prefix.match(/^[A-Za-z]:\\/) ? join(prefix, 'bin') : prefix
      return { ok: true, text: `npm installed mmdc in ${bin}, which isn't on your PATH: add it (export PATH="${bin}:$PATH"), then /reload.` }
    },
  }
}

// ---- Cascadia Mono NF ---------------------------------------------------------------------

/**
 * The pinned release: Cascadia Code 2407.24 (github.com/microsoft/cascadia-code, 2024-11-27). The
 * zip (150,454,761 bytes, SHA-256 e67a68ee3386db63f48b9054bd196ea752bc6a4ebb4df35adce6733da50c8474)
 * is not downloaded whole: only the two Cascadia Mono NF fonts in it, by HTTP ranges, each checked
 * against its own SHA-256 below before anything is written.
 */
export const CASCADIA = {
  version: '2407.24',
  url: 'https://github.com/microsoft/cascadia-code/releases/download/v2407.24/CascadiaCode-2407.24.zip',
  zipSize: 150_454_761,
  zipSha256: 'e67a68ee3386db63f48b9054bd196ea752bc6a4ebb4df35adce6733da50c8474',
  files: [
    { entry: 'ttf/CascadiaMonoNF.ttf', file: 'CascadiaMonoNF.ttf', reg: 'Cascadia Mono NF Regular (TrueType)', packed: 1_338_542, size: 2_526_924, sha256: '5b12cbef13b6de9e773f585917783583d40d944a2578c3dae99b5e4fd913a14e' },
    { entry: 'ttf/CascadiaMonoNFItalic.ttf', file: 'CascadiaMonoNFItalic.ttf', reg: 'Cascadia Mono NF Italic (TrueType)', packed: 1_258_223, size: 2_336_432, sha256: '0d3729255ba46b06eb292f9eadaddef55a106632d3ead4d1e8ec31d44952f534' },
  ],
}

export const USER_FONTS_KEY = 'HKCU\\Software\\Microsoft\\Windows NT\\CurrentVersion\\Fonts'
export const MACHINE_FONTS_KEY = 'HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Fonts'

/** The font names a `reg.exe query` of a Fonts key lists. */
export function fontNames(out: string): string[] {
  return out.split(/\r?\n/).map(l => /^\s+(.+?)\s{4}REG_\w+\s{4}/.exec(l)?.[1]).filter((x): x is string => !!x)
}

/** The fonts installed for this user and for every user, by their registry names; a string when reg.exe couldn't run. */
export async function installedFonts(io: SetupIo): Promise<string[] | string> {
  const [user, machine] = await Promise.all([io.exec('reg.exe', ['query', USER_FONTS_KEY]), io.exec('reg.exe', ['query', MACHINE_FONTS_KEY])])
  // No per-user fonts at all: the user's key isn't there, which reg.exe calls an error.
  if (!machine.ok) return `reg.exe could not read the fonts (${lastLine(machine)})`
  return [...(user.ok ? fontNames(user.stdout) : []), ...fontNames(machine.stdout)]
}

const hasCascadia = (names: string[]) => names.some(n => /^cascadia mono nf\b/i.test(n))
const hasArabicFixed = (names: string[]) => names.some(n => /^simplified arabic fixed\b/i.test(n))

const NOT_WT = 'Only for Windows Terminal, from WSL'

async function fontStatus(io: SetupIo, fonts?: Promise<string[] | string>): Promise<Status> {
  const base = { id: 'font' as const, name: NAMES.font }
  if (!inWt(io)) return { ...base, state: 'na', text: NOT_WT }
  const names = await (fonts ?? installedFonts(io))
  if (typeof names === 'string') return { ...base, state: 'error', text: names }
  return hasCascadia(names) ? { ...base, state: 'ok', text: 'Cascadia Mono NF is installed' } : { ...base, state: 'missing', text: 'Arabic in Windows Terminal needs Cascadia Mono NF: Windows\' own Cascadia has no Arabic' }
}

const sha256 = (b: Uint8Array) => createHash('sha256').update(b).digest('hex')

export type Release = typeof CASCADIA

async function fontPlan(io: SetupIo, rel: Release = CASCADIA): Promise<Plan> {
  if (!inWt(io)) return { error: NOT_WT }
  const d = await dirs(io)
  if (typeof d === 'string') return { error: d }
  const win = `${d.local}\\Microsoft\\Windows\\Fonts`
  const here = io.isWsl ? `${d.localHere}/Microsoft/Windows/Fonts` : win
  const mb = (key: 'packed' | 'size') => (rel.files.reduce((n, f) => n + f[key], 0) / 2 ** 20).toFixed(1)
  return {
    id: 'font',
    title: 'Install Cascadia Mono NF, for your Windows user?',
    steps: [
      `Downloads about ${mb('packed')} MB from github.com/microsoft/cascadia-code, release ${rel.version}: only the 2 Cascadia Mono NF fonts (${mb('size')} MB unpacked) out of its 150 MB zip, each checked against its pinned SHA-256.`,
      `Writes ${rel.files.map(f => f.file).join(' and ')} to ${win}`,
      `Adds 2 registry values under ${USER_FONTS_KEY}, with reg.exe: ${rel.files.map(f => `“${f.reg}”`).join(' and ')}`,
      'No admin rights, nothing for other users. Restart Windows Terminal afterwards to see the font.',
    ],
    run: async say => {
      const get: GetRange = (from, to) => io.range(rel.url, from, to)
      let list
      try {
        say('Reading the release zip\'s list of files…')
        list = await entries(get, rel.zipSize)
      } catch (e) {
        return { ok: false, text: `Could not read ${rel.url}: ${(e as Error).message}` }
      }
      for (const f of rel.files) {
        const at = `${here}/${f.file}`
        const had = io.bytes(at)
        if (had && sha256(had) === f.sha256) {
          say(`${f.file} is there already.`)
        } else {
          const e = list.find(x => x.name === f.entry)
          if (!e) return { ok: false, text: `The release zip has no ${f.entry}.` }
          say(`Downloading ${f.file} (${(e.compressed / 2 ** 20).toFixed(1)} MB)…`)
          let data
          try {
            data = await extract(get, e)
          } catch (err) {
            return { ok: false, text: `Could not download ${f.file}: ${(err as Error).message}` }
          }
          if (data.length !== f.size || sha256(data) !== f.sha256) return { ok: false, text: `${f.file} isn't the pinned one (its SHA-256 is ${sha256(data)}): nothing written.` }
          try {
            io.write(at, data)
          } catch (err: any) {
            return { ok: false, text: `Could not write ${win}\\${f.file} (${err?.code ?? err})${err?.code === 'EBUSY' || err?.code === 'EPERM' ? ': close Windows Terminal\'s other windows using it, or sign out and in, then try again' : ''}.` }
          }
          say(`Wrote ${win}\\${f.file}`)
        }
        const r = await io.exec('reg.exe', ['add', USER_FONTS_KEY, '/v', f.reg, '/t', 'REG_SZ', '/d', `${win}\\${f.file}`, '/f'])
        if (!r.ok) return { ok: false, text: `reg.exe add failed (${lastLine(r)})` }
        say(`Registered “${f.reg}”`)
      }
      return { ok: true, text: 'Cascadia Mono NF is installed. Restart Windows Terminal to see it, and set it as the font face (Font face, in /setup).' }
    },
  }
}

// ---- Windows Terminal's font face --------------------------------------------------------

/** settings.json of Windows Terminal, its Preview, and the unpackaged one, under %LOCALAPPDATA%. */
export const WT_SETTINGS = [
  ['Packages', 'Microsoft.WindowsTerminal_8wekyb3d8bbwe', 'LocalState', 'settings.json'],
  ['Packages', 'Microsoft.WindowsTerminalPreview_8wekyb3d8bbwe', 'LocalState', 'settings.json'],
  ['Microsoft', 'Windows Terminal', 'settings.json'],
]

export const FACE_ARABIC = 'Cascadia Mono NF, Simplified Arabic Fixed'
export const FACE_COURIER = 'Cascadia Mono NF, Courier New'

/** Whether a font face list does Arabic: Cascadia Mono NF, and a second font after it for lam-alef. */
export const faceHasCascadia = (face: string) => /(^|,)\s*cascadia mono nf\s*(,|$)/i.test(face)
export const faceIsGood = (face: string) => faceHasCascadia(face) && face.split(',').filter(s => s.trim()).length > 1

/** Where the face is set: the profile's own (WT_PROFILE_ID), when it sets one, else the defaults. */
export type FaceAt = { base: (string | number)[]; key: string[]; face: string | undefined; where: string }

/** The face this profile is drawn with, and where to set it. */
export function faceAt(root: Node, profileId: string | undefined): FaceAt | string {
  const profiles = find(root, ['profiles'])
  if (profiles?.type === 'array') return 'its "profiles" is a list (a settings.json from before Windows Terminal 1.0): set the font face in Windows Terminal\'s Settings instead'
  if (profiles && profiles.type !== 'object') return '"profiles" is not an object'
  const own = (base: (string | number)[]): { key: string[]; face: string } | undefined => {
    const face = findString(root, [...base, 'font', 'face'])
    if (face !== undefined) return { key: ['font', 'face'], face }
    const old = findString(root, [...base, 'fontFace'])
    return old !== undefined ? { key: ['fontFace'], face: old } : undefined
  }
  const list = find(root, ['profiles', 'list'])
  if (profileId && list?.type === 'array') {
    const i = list.items.findIndex(p => findString(p, ['guid'])?.toLowerCase() === profileId.toLowerCase())
    const set = i >= 0 ? own(['profiles', 'list', i]) : undefined
    if (set) return { base: ['profiles', 'list', i], ...set, where: `the profile “${findString(list.items[i], ['name']) ?? profileId}”` }
  }
  const set = own(['profiles', 'defaults'])
  return { base: ['profiles'], key: ['defaults', ...(set?.key ?? ['font', 'face'])], face: set?.face, where: 'profiles.defaults' }
}

/** The text with the face set where `at` says. */
export function withFace(text: string, at: FaceAt, face: string): string {
  return setString(text, at.key, face, at.base)
}

/** The first settings.json there is: its Windows path and its path here. */
async function settingsFile(io: SetupIo): Promise<{ win: string; here: string } | string> {
  const d = await dirs(io)
  if (typeof d === 'string') return d
  for (const parts of WT_SETTINGS) {
    const here = io.isWsl ? [d.localHere, ...parts].join('/') : [d.local, ...parts].join('\\')
    if (io.exists(here)) return { win: [d.local, ...parts].join('\\'), here }
  }
  return `no Windows Terminal settings.json under ${d.local}`
}

type Read = { file: { win: string; here: string }; text: string; at: FaceAt } | string

async function readSettings(io: SetupIo): Promise<Read> {
  const file = await settingsFile(io)
  if (typeof file === 'string') return file
  const text = io.read(file.here)
  if (text === undefined) return `could not read ${file.win}`
  let root
  try {
    root = parse(text)
  } catch (e) {
    return `could not read ${file.win}: ${(e as Error).message}. Left it as it is`
  }
  const at = faceAt(root, io.env.WT_PROFILE_ID)
  return typeof at === 'string' ? `${file.win}: ${at}` : { file, text, at }
}

/** The face this Windows Terminal tab is drawn with ('' when its settings don't say); undefined when it couldn't tell. */
export async function wtFace(io: SetupIo): Promise<string | undefined> {
  if (!inWt(io)) return undefined
  const r = await readSettings(io)
  return typeof r === 'string' ? undefined : r.at.face ?? ''
}

async function faceStatus(io: SetupIo): Promise<Status> {
  const base = { id: 'face' as const, name: NAMES.face }
  if (!inWt(io)) return { ...base, state: 'na', text: NOT_WT }
  const r = await readSettings(io)
  if (typeof r === 'string') return { ...base, state: 'error', text: r }
  const face = r.at.face
  if (face && faceIsGood(face)) return { ...base, state: 'ok', text: `Windows Terminal draws with “${face}”` }
  return {
    ...base,
    state: 'missing',
    text: face && faceHasCascadia(face) ? `“${face}”: a second font after it makes لا join the letter before it` : `${face ? `“${face}”` : 'Windows Terminal\'s default font'} has no Arabic: the face should be Cascadia Mono NF`,
  }
}

const day = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

/** settings.json.bak-clued-<date>, or -2, -3… when that one is there already (the first copy is the one to keep). */
export function backupName(io: Pick<SetupIo, 'exists'>, here: string, now: Date): string {
  const base = `${here}.bak-clued-${day(now)}`
  if (!io.exists(base)) return base
  for (let n = 2; ; n++) if (!io.exists(`${base}-${n}`)) return `${base}-${n}`
}

async function facePlan(io: SetupIo): Promise<Plan> {
  if (!inWt(io)) return { error: NOT_WT }
  const [r, names] = await Promise.all([readSettings(io), installedFonts(io)])
  if (typeof r === 'string') return { error: r }
  const fonts = typeof names === 'string' ? [] : names
  const want = hasArabicFixed(fonts) ? FACE_ARABIC : FACE_COURIER
  const old = r.at.face
  if (old && faceIsGood(old)) return { error: `the font face is “${old}” already` }
  const backup = backupName(io, r.file.here, io.now())
  const bak = backup.split('/').pop()!
  let edited: string
  try {
    edited = withFace(r.text, r.at, want)
  } catch (e) {
    return { error: `could not set the face in ${r.file.win}: ${(e as Error).message}` }
  }
  const setting = r.at.where === 'profiles.defaults' ? `profiles.defaults.${r.at.key.slice(1).join('.')}` : `${r.at.key.join('.')} of ${r.at.where}`
  return {
    id: 'face',
    title: old ? `Replace your font face “${old}”?` : 'Set Windows Terminal\'s font face?',
    steps: [
      `Changes ${r.file.win}: ${setting} ${old ? `from “${old}” ` : ''}to “${want}”`,
      `${want.split(', ')[1]} after Cascadia draws لا so it joins the letter before it (Cascadia has no lam-alef)${want === FACE_COURIER ? '; Simplified Arabic Fixed would be better, and isn\'t installed' : ''}.`,
      `Copies settings.json to ${bak} first. Comments and the rest of the file stay as they are.`,
      'Windows Terminal picks the change up at once.',
    ],
    ...(old ? { replaces: old } : {}),
    ...(typeof names !== 'string' && !hasCascadia(fonts) ? { warn: 'Cascadia Mono NF isn\'t installed yet: install the Arabic font too, or Windows Terminal draws with its own default.' } : {}),
    run: async say => {
      // Changed since the plan was shown (Windows Terminal's own Settings, say): nothing is written.
      if (io.read(r.file.here) !== r.text) return { ok: false, text: `${r.file.win} changed since: open /setup again.` }
      try {
        io.write(backup, r.text)
        say(`Copied settings.json to ${bak}`)
        io.write(r.file.here, edited)
      } catch (err: any) {
        return { ok: false, text: `Could not write ${r.file.win} (${err?.code ?? err}).` }
      }
      say(`Set the font face to “${want}”`)
      return { ok: true, text: `Windows Terminal's font face is “${want}” (a copy of the old settings is ${bak}).` }
    },
  }
}

// ---- The notification click handler (notify.ts) and inline images -------------------------

/** What the app knows of the click handler (it sets it up itself as it starts); the CLI asks the registry. */
export type NotifyHooks = { status?: () => Status | undefined; install?: () => Promise<{ ok: boolean; text: string }> }

async function notifyStatus(io: SetupIo, hooks: NotifyHooks = {}): Promise<Status> {
  const base = { id: 'notify' as const, name: NAMES.notify }
  if (!inWt(io)) return { ...base, state: 'na', text: 'Only in Windows Terminal: elsewhere a click on a notification needs nothing set up' }
  const known = hooks.status?.()
  if (known) return known
  const s = await clickHandlerState(io)
  if ('error' in s) return { ...base, state: 'error', text: s.error }
  return s.ok ? { ...base, state: 'ok', text: `A click on a notification opens its tab (${s.at})` } : { ...base, state: 'missing', text: 'A click on a notification opens its tab once the click handler is set up' }
}

function notifyPlan(io: SetupIo, hooks: NotifyHooks = {}): Plan {
  if (!inWt(io)) return { error: 'Only in Windows Terminal' }
  return {
    id: 'notify',
    title: 'Set up the notification click handler?',
    steps: [
      'Writes %LOCALAPPDATA%\\clued\\focus.ps1, which finds the tab a notification came from.',
      'Registers the clued-focus: link for your Windows user under HKCU\\Software\\Classes\\clued-focus, with reg.exe.',
      '/notify uninstall removes both.',
    ],
    run: async () => {
      if (hooks.install) return hooks.install()
      const r = await setupClickHandler(io)
      return r.ok ? { ok: true, text: `The click handler is set up (${r.place.win}).` } : { ok: false, text: `Could not set up the click handler: ${r.error}` }
    },
  }
}

export const PROTOCOL_NAMES: Record<Protocol, string> = { iterm: 'iTerm2\'s inline images', kitty: 'the kitty graphics protocol', sixel: 'Sixel', off: 'none' }

/** Which protocol images are drawn with here, and what to do when none. `protocol`: the app's own answer, once it asked the terminal. */
export function imagesStatus(env: Record<string, string | undefined>, protocol?: Protocol): Status {
  const base = { id: 'images' as const, name: NAMES.images, state: 'info' as const }
  const p = protocol ?? detectProtocol(env)
  if (p === 'query') return { ...base, text: 'clued asks the terminal whether it draws Sixel as it starts: see /setup inside clued' }
  if (p !== 'off') return { ...base, text: `This terminal gets ${PROTOCOL_NAMES[p]}${env.CLUED_IMAGES ? ' (CLUED_IMAGES)' : ''}` }
  const why = env.CLUED_IMAGES && env.CLUED_IMAGES !== 'auto' ? 'CLUED_IMAGES turns them off' : env.TMUX || env.STY ? 'tmux and screen don\'t pass images through: run clued outside them' : 'this terminal draws none: iTerm2, WezTerm, kitty, Ghostty and Windows Terminal 1.22+ do'
  return { ...base, text: `None, so images and diagrams are links that open in your viewer: ${why}` }
}

// ---- All of them ----------------------------------------------------------------------------

/** What installing one does, said in full; `run` does it. An error: it can't be installed from here. */
export type Plan =
  | { id: ExtraId; title: string; steps: string[]; warn?: string; replaces?: string; run: (say: (line: string) => void) => Promise<{ ok: boolean; text: string }> }
  | { error: string }

export type Opts = { protocol?: Protocol; notify?: NotifyHooks; release?: Release }

/** Every extra's status. */
export async function statuses(io: SetupIo, opts: Opts = {}): Promise<Status[]> {
  const fonts = inWt(io) ? installedFonts(io) : undefined
  const [font, face] = await Promise.all([fontStatus(io, fonts), faceStatus(io)])
  // After the others: its own cmd.exe would start alongside theirs.
  return [diagramsStatus(io), font, face, await notifyStatus(io, opts.notify), imagesStatus(io.env, opts.protocol)]
}

/** What installing `id` would do. */
export async function plan(io: SetupIo, id: ExtraId, opts: Opts = {}): Promise<Plan> {
  if (id === 'diagrams') return diagramsPlan(io)
  if (id === 'font') return fontPlan(io, opts.release)
  if (id === 'face') return facePlan(io)
  if (id === 'notify') return notifyPlan(io, opts.notify)
  return { error: 'Nothing to install: it only says what this terminal can do' }
}

export const MARK: Record<State, string> = { ok: '✓', missing: '—', na: '·', info: 'ℹ', error: '⚠' }

// ---- The /setup view ----------------------------------------------------------------------

export type View = {
  at: number
  rows: Status[] | undefined
  /** Working out what one takes, before it is shown. */
  planning?: ExtraId
  confirm?: Extract<Plan, { id: ExtraId }>
  /** An install under way, or just done: what it said. */
  busy?: { id: ExtraId; lines: string[]; done?: { ok: boolean; text: string } }
}

export type ViewActions = { pick: (i: number) => void; yes: () => void; no: () => void }

/** The view's lines: the extras, then the confirmation or the install's progress. */
export function viewLines(v: View, width: number, act: ViewActions): Line[] {
  const w = Math.max(20, width)
  const L: Line[] = [[], [{ text: '  The optional extras clued uses. ↑↓ choose · Enter install · Esc back', style: { fg: C.gray } }], []]
  const nameW = Math.max(...Object.values(NAMES).map(n => n.length)) + 2
  if (!v.rows) L.push([{ text: '  ◌ checking…', style: { fg: C.gray, italic: true } }])
  v.rows?.forEach((r, i) => {
    const on = i === v.at
    const color = r.state === 'ok' ? C.green : r.state === 'missing' ? C.yellow : r.state === 'error' ? C.red : C.gray
    const pick = { action: () => act.pick(i) }
    const head: Span[] = [
      { text: on ? ' ▸ ' : '   ', style: { fg: C.cyan, bold: true }, ...pick },
      { text: `${MARK[r.state]} `, style: { fg: color, bold: true }, ...pick },
      { text: r.name.padEnd(nameW), style: { bold: on, ...(on ? { fg: C.cyan } : {}) }, ...pick },
    ]
    const room = Math.max(10, w - 5 - nameW)
    const body = wrap([{ text: r.text, style: { fg: r.state === 'na' ? C.faint : C.gray } }], room)
    body.forEach((l, k) => L.push(k ? [{ text: ' '.repeat(5 + nameW) }, ...l] : [...head, ...l]))
  })
  const say = (t: string, style: { fg: number } = { fg: C.gray }) => wrap([{ text: t, style }], w - 4).map(l => [{ text: '    ' }, ...l])
  if (v.planning) L.push([], [{ text: `  ◌ working out what ${NAMES[v.planning]} takes…`, style: { fg: C.gray, italic: true } }])
  if (v.confirm) {
    const c = v.confirm
    L.push([], [{ text: `  ${c.title}`, style: { fg: C.cyan, bold: true } }])
    for (const s of c.steps) L.push(...say(`• ${s}`, { fg: C.gray }))
    if (c.warn) L.push(...say(`⚠ ${c.warn}`, { fg: C.yellow }))
    L.push([], [
      { text: '    ' },
      { text: ` ${c.replaces ? 'Replace' : 'Install'} (y) `, style: { bg: C.green, fg: 16, bold: true }, action: act.yes },
      { text: '  ' },
      { text: ' Cancel (n) ', style: { bg: C.faint, fg: 16, bold: true }, action: act.no },
    ])
  }
  if (v.busy) {
    const b = v.busy
    L.push([], [{ text: `  ${b.done ? (b.done.ok ? '✓' : '✗') : '◌'} ${NAMES[b.id]}${b.done ? '' : ': installing…'}`, style: { fg: b.done ? (b.done.ok ? C.green : C.red) : C.cyan, bold: true } }])
    for (const l of b.lines.slice(-8)) L.push([{ text: '    ' }, { text: clip(l, w - 4), style: { fg: C.faint } }])
    if (b.done) L.push(...say(b.done.text, { fg: b.done.ok ? C.green : C.red }))
  }
  return L
}

/** ↑↓ to the next row; the rows are few, so it stops at the ends. */
export function moveAt(v: View, by: number) {
  v.at = Math.max(0, Math.min((v.rows?.length ?? 1) - 1, v.at + by))
}

// ---- The real system ----------------------------------------------------------------------

/** WSL: its own variable, or the kernel's name. */
export function detectWsl(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.WSL_DISTRO_NAME) return true
  try {
    return /microsoft/i.test(readFileSync('/proc/version', 'utf8'))
  } catch {
    return false
  }
}

export function exec(cmd: string, args: string[]): Promise<Ran> {
  return new Promise(done => {
    try {
      execFile(cmd, args, { timeout: 30_000 }, (err: any, stdout, stderr) =>
        done({ ok: !err, code: err ? (err.code ?? err.signal ?? null) : 0, stdout: String(stdout), stderr: String(stderr || (err && !Number.isInteger(err.code) ? err.message : '')) }),
      )
    } catch (err: any) {
      done({ ok: false, code: err?.code ?? null, stdout: '', stderr: String(err?.message ?? err) })
    }
  })
}

/** A program, run to its end however long it takes, its output given line by line. */
export function runLines(cmd: string, args: string[], line: (s: string) => void): Promise<Ran> {
  return new Promise(done => {
    let out = ''
    let err = ''
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    const take = (chunk: Buffer, isErr: boolean) => {
      const s = chunk.toString('utf8')
      if (isErr) err += s
      else out += s
      for (const l of s.split(/\r?\n|\r/)) if (l.trim()) line(l.trim())
    }
    child.stdout.on('data', c => take(c, false))
    child.stderr.on('data', c => take(c, true))
    child.on('error', (e: any) => done({ ok: false, code: e.code ?? null, stdout: out, stderr: err || String(e.message) }))
    child.on('close', code => done({ ok: code === 0, code, stdout: out, stderr: err }))
  })
}

/** Bytes `from` to `to` of a file on the web; a server that sends the whole file instead is an error. */
export async function httpRange(url: string, from: number, to: number): Promise<Uint8Array> {
  const r = await fetch(url, { headers: { Range: `bytes=${from}-${to}` }, signal: AbortSignal.timeout(120_000) })
  if (r.status !== 206) {
    await r.body?.cancel()
    throw new Error(`the server answered ${r.status}, not the part of the file asked for`)
  }
  return new Uint8Array(await r.arrayBuffer())
}

/** The real system. */
export function systemIo(env: NodeJS.ProcessEnv = process.env, isWsl = detectWsl(env)): SetupIo {
  return {
    exec,
    run: runLines,
    read: p => {
      try {
        return readFileSync(p, 'utf8')
      } catch {
        return undefined
      }
    },
    bytes: p => {
      try {
        return readFileSync(p)
      } catch {
        return undefined
      }
    },
    write: (p, data) => {
      mkdirSync(dirname(p), { recursive: true })
      writeFileSync(p, data)
    },
    remove: p => {
      rmSync(p, { force: true })
      try {
        rmdirSync(dirname(p))
      } catch {}
    },
    exists: existsSync,
    writable: dir => {
      try {
        accessSync(dir, constants.W_OK)
        return true
      } catch {
        return false
      }
    },
    range: httpRange,
    now: () => new Date(),
    isWsl,
    env,
  }
}
