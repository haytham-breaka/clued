// Code on the terminal: light syntax highlighting chosen by a file's extension or a fence's language,
// code blocks with a line-number gutter, and diffs with the changed words marked. A small tokenizer
// per family of languages, line by line, carrying what spans lines (block comments, long strings).

import { lineDiff, wordDiff } from './diff.ts'
import { charCells, cells, clipLine, lineCells } from './text.ts'
import type { Line, Span, Style } from './text.ts'

export type Lang = 'js' | 'py' | 'go' | 'sh' | 'json' | 'md' | 'css' | 'html' | 'c' | 'rust' | 'yaml' | 'sql' | 'diff'

/** Colours for code on a dark background (256-colour indices, read well in Windows Terminal and iTerm2). */
export const K = {
  /** A code block's background, its gutter's (a shade darker) and its header's (a shade lighter). */
  bg: 236,
  gutterBg: 235,
  headBg: 237,
  lineNo: 242,
  text: 252,
  keyword: 176,
  string: 114,
  comment: 244,
  number: 215,
  type: 80,
  func: 111,
  key: 117,
  tag: 204,
  attr: 221,
  heading: 75,
  /** Removed lines: dark red, with the changed words a brighter red; added lines in greens. */
  delBg: 52,
  delFg: 217,
  delWordBg: 88,
  delSign: 203,
  addBg: 22,
  addFg: 157,
  addWordBg: 28,
  addSign: 114,
  wordFg: 231,
  context: 244,
  output: 248,
  error: 210,
} as const

const words = (s: string) => new Set(s.split(' '))

const EXT: Record<string, Lang> = {
  ts: 'js', tsx: 'js', mts: 'js', cts: 'js', js: 'js', jsx: 'js', mjs: 'js', cjs: 'js', typescript: 'js', javascript: 'js', node: 'js',
  py: 'py', pyi: 'py', python: 'py', python3: 'py',
  go: 'go', golang: 'go',
  sh: 'sh', bash: 'sh', zsh: 'sh', shell: 'sh', console: 'sh', shellscript: 'sh', fish: 'sh', ksh: 'sh', env: 'sh', dockerfile: 'sh', makefile: 'sh', mk: 'sh', ps1: 'sh', powershell: 'sh',
  json: 'json', jsonc: 'json', json5: 'json', jsonl: 'json', ndjson: 'json', ipynb: 'json', lock: 'json',
  md: 'md', markdown: 'md', mdx: 'md',
  css: 'css', scss: 'css', sass: 'css', less: 'css',
  html: 'html', htm: 'html', xml: 'html', svg: 'html', vue: 'html', svelte: 'html', xhtml: 'html', plist: 'html',
  c: 'c', h: 'c', cc: 'c', cpp: 'c', cxx: 'c', hpp: 'c', hh: 'c', 'c++': 'c', java: 'c', kt: 'c', kts: 'c', kotlin: 'c', swift: 'c', cs: 'c', csharp: 'c', scala: 'c', dart: 'c', php: 'c',
  rs: 'rust', rust: 'rust',
  yaml: 'yaml', yml: 'yaml', toml: 'yaml', ini: 'yaml', cfg: 'yaml', conf: 'yaml',
  sql: 'sql', psql: 'sql', pgsql: 'sql',
  diff: 'diff', patch: 'diff',
}

/** The language of a file path (by its extension or name) or of a fence's label; undefined for plain text. */
export function langOf(pathOrLabel: string | undefined): Lang | undefined {
  if (!pathOrLabel) return undefined
  const name = pathOrLabel.split(/[\\/]/).pop()!.toLowerCase()
  if (EXT[name]) return EXT[name]
  if (/^(dockerfile|makefile|gnumakefile|\.bashrc|\.zshrc|\.profile|\.env(\..*)?)$/.test(name)) return 'sh'
  const dot = name.lastIndexOf('.')
  return dot >= 0 ? EXT[name.slice(dot + 1)] : undefined
}

// ---- Tokenizing -------------------------------------------------------------------

/** What a line leaves open for the next: a block comment, a long string, an HTML tag, a markdown fence. */
export type State = { close: string; style: Style; kind?: 'tag' | 'fence' } | undefined

type Spec = {
  kw: Set<string>
  consts?: Set<string>
  types?: Set<string>
  line?: string[]
  block?: [string, string]
  quotes: string
  /** Quotes that may run over several lines (checked before single quotes). */
  multi?: string[]
  /** Shell: $VAR, and # starts a comment only at a word's start; no escapes in '…'. */
  shell?: boolean
  /** Capitalised words are types (Go, Rust, C#, Java…). */
  caps?: boolean
  /** Words are matched without case (SQL). */
  anyCase?: boolean
}

const S = {
  text: { fg: K.text },
  keyword: { fg: K.keyword },
  string: { fg: K.string },
  comment: { fg: K.comment, italic: true },
  number: { fg: K.number },
  type: { fg: K.type },
  func: { fg: K.func },
  key: { fg: K.key },
  tag: { fg: K.tag },
  attr: { fg: K.attr },
  heading: { fg: K.heading, bold: true },
  bold: { fg: K.text, bold: true },
  italic: { fg: K.text, italic: true },
  code: { fg: K.attr },
  link: { fg: K.func, underline: true },
  bullet: { fg: K.type },
  quote: { fg: K.comment, italic: true },
} satisfies Record<string, Style>

const JS_KW = 'abstract as async await break case catch class const continue debugger declare default delete do else enum export extends finally for from function get if implements import in infer instanceof interface is keyof let namespace new of private protected public readonly return satisfies set static super switch this throw try type typeof var void while with yield'
const SPECS: Partial<Record<Lang, Spec>> = {
  js: {
    kw: words(JS_KW),
    consts: words('true false null undefined NaN Infinity'),
    types: words('string number boolean bigint symbol object unknown never any void Array Map Set Promise Record Partial Readonly Error Date RegExp JSON Math Object String Number Boolean console process'),
    line: ['//'], block: ['/*', '*/'], quotes: `"'\``, multi: ['`'], caps: true,
  },
  py: {
    kw: words('and as assert async await break class continue def del elif else except finally for from global if import in is lambda match case nonlocal not or pass raise return try while with yield self cls'),
    consts: words('True False None'),
    types: words('int float str bool bytes list dict set tuple object type print len range open super isinstance Exception'),
    line: ['#'], quotes: `"'`, multi: ['"""', "'''"], caps: true,
  },
  go: {
    kw: words('break case chan const continue default defer else fallthrough for func go goto if import interface map package range return select struct switch type var'),
    consts: words('true false nil iota'),
    types: words('bool byte complex64 complex128 error float32 float64 int int8 int16 int32 int64 rune string uint uint8 uint16 uint32 uint64 uintptr any append cap close copy delete len make new panic print println recover'),
    line: ['//'], block: ['/*', '*/'], quotes: `"'\``, multi: ['`'], caps: true,
  },
  sh: {
    kw: words('if then else elif fi for while until do done case esac in function return local export readonly declare unset shift exit break continue set source alias trap eval exec select time'),
    types: words('echo printf cd ls cat grep sed awk find xargs rm cp mv mkdir chmod chown touch git npm npx node pnpm yarn python python3 pip go make docker kubectl curl wget tar sudo test tee head tail sort uniq wc jq gh tmux ssh'),
    line: ['#'], quotes: `"'`, shell: true,
  },
  c: {
    kw: words('auto break case catch char class const constexpr continue default delete do double else enum explicit extends extern final finally float for friend fun goto if implements import inline int interface internal let long namespace new operator override package private protected public register return short signed sizeof static struct super switch template this throw throws try typedef typename union unsigned using val var virtual void volatile while when func guard is as in out ref async await yield echo function'),
    consts: words('true false null nullptr NULL nil'),
    types: words('bool string String int8_t int16_t int32_t int64_t uint8_t uint16_t uint32_t uint64_t size_t Int Double Float Bool Object List Map std'),
    line: ['//', '#'], block: ['/*', '*/'], quotes: `"'`, multi: ['"""'], caps: true,
  },
  rust: {
    kw: words('as async await break const continue crate dyn else enum extern fn for if impl in let loop match mod move mut pub ref return self Self static struct super trait type unsafe use where while'),
    consts: words('true false None Some Ok Err'),
    types: words('i8 i16 i32 i64 i128 isize u8 u16 u32 u64 u128 usize f32 f64 bool char str String Vec Option Result Box'),
    line: ['//'], block: ['/*', '*/'], quotes: '"', caps: true,
  },
  sql: {
    kw: words('select from where and or not insert into values update set delete create table index view drop alter add column primary key foreign references join left right inner outer full on as group by order having limit offset distinct union all case when then else end is null like in exists between returning with default unique constraint begin commit rollback if cascade asc desc'),
    consts: words('true false null'),
    types: words('int integer bigint smallint text varchar char boolean timestamp timestamptz date time uuid jsonb json serial numeric real float double count sum avg min max now coalesce'),
    line: ['--'], block: ['/*', '*/'], quotes: `'"`, anyCase: true,
  },
  json: { kw: new Set(), consts: words('true false null'), line: ['//'], block: ['/*', '*/'], quotes: '"' },
}

const NUMBER = /^(?:0[xX][\da-fA-F_]+|0[bB][01_]+|0[oO][0-7_]+|\d[\d_]*(?:\.\d[\d_]*)?(?:[eE][+-]?\d+)?[nfFlLuU]?|\.\d+(?:[eE][+-]?\d+)?)/
const IDENT = /^[A-Za-z_$][\w$]*/

/** Spans of one line, merging neighbours of the same style. */
class Out {
  spans: Span[] = []
  push(text: string, style: Style) {
    if (!text) return
    const last = this.spans.at(-1)
    if (last && last.style === style) last.text += text
    else this.spans.push({ text, style })
  }
}

/** Where the string opened before `from` closes with `q` (just past it), or -1. */
function closing(line: string, from: number, q: string, escapes = true): number {
  for (let k = from; k < line.length; k++) {
    if (escapes && line[k] === '\\') {
      k++
      continue
    }
    if (line.startsWith(q, k)) return k + q.length
  }
  return -1
}

/** Picks up a block comment or long string the last line left open. Returns where the line goes on. */
function carry(line: string, state: State, o: Out, escapes: boolean): { at: number; state: State } {
  if (!state) return { at: 0, state }
  const end = closing(line, 0, state.close, escapes && state.style !== S.comment)
  if (end < 0) {
    o.push(line, state.style)
    return { at: line.length, state }
  }
  o.push(line.slice(0, end), state.style)
  return { at: end, state: undefined }
}

function generic(line: string, spec: Spec, state: State): { spans: Span[]; state: State } {
  const o = new Out()
  let { at: i, state: st } = carry(line, state, o, true)
  while (i < line.length) {
    const ch = line[i]!
    const prev = i > 0 ? line[i - 1]! : ' '
    if (spec.block && line.startsWith(spec.block[0], i)) {
      const end = line.indexOf(spec.block[1], i + spec.block[0].length)
      if (end < 0) {
        o.push(line.slice(i), S.comment)
        return { spans: o.spans, state: { close: spec.block[1], style: S.comment } }
      }
      o.push(line.slice(i, end + spec.block[1].length), S.comment)
      i = end + spec.block[1].length
      continue
    }
    if (spec.line?.some(m => line.startsWith(m, i)) && (!spec.shell || /[\s;|&(]/.test(prev) || i === 0)) {
      // In C-like languages `#` starts a preprocessor line, and only at the line's start.
      const isDirective = ch === '#' && spec.line[0] !== '#'
      if (!isDirective || !line.slice(0, i).trim()) {
        o.push(line.slice(i), isDirective ? S.keyword : S.comment)
        break
      }
    }
    const long = spec.multi?.find(q => line.startsWith(q, i))
    const q = long ?? (spec.quotes.includes(ch) ? ch : undefined)
    if (q) {
      const escapes = !(spec.shell && q === "'")
      const end = closing(line, i + q.length, q, escapes)
      if (end < 0) {
        o.push(line.slice(i), S.string)
        if (long) return { spans: o.spans, state: { close: q, style: S.string } }
        break
      }
      const text = line.slice(i, end)
      // A JSON object's key: a string with a colon after it.
      const isKey = spec === SPECS.json && /^\s*:/.test(line.slice(end))
      o.push(text, isKey ? S.key : S.string)
      i = end
      continue
    }
    if (spec.shell && ch === '$') {
      const v = line.slice(i).match(/^\$(\{[^}]*\}|\w+|[@*#?$!0-9-])/)
      if (v) {
        o.push(v[0], S.key)
        i += v[0].length
        continue
      }
    }
    if (/[\d.]/.test(ch) && !/[\w$]/.test(prev)) {
      const n = line.slice(i).match(NUMBER)
      if (n) {
        o.push(n[0], S.number)
        i += n[0].length
        continue
      }
    }
    const id = line.slice(i).match(spec.shell ? /^[A-Za-z_][\w-]*/ : IDENT)
    if (id) {
      const w = id[0]
      const key = spec.anyCase ? w.toLowerCase() : w
      const after = line.slice(i + w.length)
      let style: Style = S.text
      if (spec.kw.has(key)) style = S.keyword
      else if (spec.consts?.has(key)) style = S.number
      else if (spec.types?.has(key)) style = S.type
      else if (!spec.shell && /^\s*\(/.test(after)) style = S.func
      else if (spec.caps && /^[A-Z][a-z]/.test(w)) style = S.type
      // Python and TS decorators.
      if (prev === '@') style = S.func
      o.push(w, style)
      i += w.length
      continue
    }
    o.push(ch, S.text)
    i++
  }
  return { spans: o.spans, state: st }
}

function yaml(line: string): Span[] {
  const o = new Out()
  // [section] headers (TOML, INI).
  const sec = line.match(/^(\s*)(\[[^\]]*\])(.*)$/)
  if (sec) {
    o.push(sec[1]!, S.text)
    o.push(sec[2]!, S.heading)
    o.spans.push(...generic(sec[3]!, YAML_VALUE, undefined).spans)
    return o.spans
  }
  const kv = line.match(/^(\s*(?:-\s+)?)([^\s:#'"=][^:#=]*?|"[^"]*"|'[^']*')(\s*[:=])(?=\s|$)(.*)$/)
  if (kv) {
    o.push(kv[1]!, S.bullet)
    o.push(kv[2]!, S.key)
    o.push(kv[3]!, S.text)
    o.spans.push(...generic(kv[4]!, YAML_VALUE, undefined).spans)
    return o.spans
  }
  const item = line.match(/^(\s*-\s)(.*)$/)
  if (item) {
    o.push(item[1]!, S.bullet)
    o.spans.push(...generic(item[2]!, YAML_VALUE, undefined).spans)
    return o.spans
  }
  return generic(line, YAML_VALUE, undefined).spans
}
const YAML_VALUE: Spec = { kw: new Set(), consts: words('true false null yes no on off True False ~'), line: ['#'], quotes: `"'`, shell: true }

function css(line: string, state: State): { spans: Span[]; state: State } {
  const o = new Out()
  let { at: i, state: st } = carry(line, state, o, true)
  const rest = line.slice(i)
  // A declaration (`color: red;`) or a selector line (`.a > b:hover {`).
  const decl = /^\s*(--)?[-\w]+\s*:(?!:)/.test(rest) && !/\{\s*$/.test(rest)
  while (i < line.length) {
    const ch = line[i]!
    const tail = line.slice(i)
    if (tail.startsWith('/*')) {
      const end = line.indexOf('*/', i + 2)
      if (end < 0) {
        o.push(tail, S.comment)
        return { spans: o.spans, state: { close: '*/', style: S.comment } }
      }
      o.push(line.slice(i, end + 2), S.comment)
      i = end + 2
      continue
    }
    if (tail.startsWith('//') && !/:$/.test(line.slice(0, i))) {
      o.push(tail, S.comment)
      break
    }
    if (ch === '"' || ch === "'") {
      const end = closing(line, i + 1, ch)
      const stop = end < 0 ? line.length : end
      o.push(line.slice(i, stop), S.string)
      i = stop
      continue
    }
    const at = tail.match(/^@[-\w]+/)
    if (at) {
      o.push(at[0], S.keyword)
      i += at[0].length
      continue
    }
    if (decl) {
      const prop = tail.match(/^(\s*)((?:--)?[-\w]+)(\s*:)/)
      if (prop && !line.slice(0, i).includes(':')) {
        o.push(prop[1]!, S.text)
        o.push(prop[2]!, S.key)
        o.push(prop[3]!, S.text)
        i += prop[0].length
        continue
      }
      const num = tail.match(/^(#[\da-fA-F]{3,8}\b|-?\d*\.?\d+(%|[a-z]+)?)/)
      if (num && !/[\w-]/.test(line[i - 1] ?? ' ')) {
        o.push(num[0], S.number)
        i += num[0].length
        continue
      }
      const fn = tail.match(/^[-\w]+(?=\()/)
      if (fn) {
        o.push(fn[0], S.func)
        i += fn[0].length
        continue
      }
      if (tail.startsWith('!important')) {
        o.push('!important', S.keyword)
        i += 10
        continue
      }
      const w = tail.match(/^[-\w]+/)
      if (w) {
        o.push(w[0], S.text)
        i += w[0].length
        continue
      }
    } else {
      const sel = tail.match(/^([.#]?[-\w]+|::?[-\w]+|&)/)
      if (sel) {
        o.push(sel[0], sel[0][0] === ':' ? S.func : sel[0][0] === '.' || sel[0][0] === '#' || sel[0] === '&' ? S.attr : S.tag)
        i += sel[0].length
        continue
      }
    }
    o.push(ch, S.text)
    i++
  }
  return { spans: o.spans, state: st }
}

function html(line: string, state: State): { spans: Span[]; state: State } {
  const o = new Out()
  let i = 0
  let st = state
  // Inside a comment, or inside a tag whose attributes run over lines.
  if (st?.style === S.comment) {
    const r = carry(line, st, o, false)
    i = r.at
    st = r.state
  }
  while (i < line.length) {
    if (st?.kind === 'tag') {
      const tail = line.slice(i)
      const close = tail.match(/^\s*\/?>/)
      if (close) {
        o.push(close[0], S.tag)
        i += close[0].length
        st = undefined
        continue
      }
      const attr = tail.match(/^(\s*)([^\s=/>"']+)/)
      if (attr) {
        o.push(attr[1]!, S.text)
        o.push(attr[2]!, S.attr)
        i += attr[0].length
        continue
      }
      const q = tail.match(/^(\s*=\s*)?(["'])/)
      if (q) {
        o.push(q[1] ?? '', S.text)
        const from = i + (q[1]?.length ?? 0)
        const end = closing(line, from + 1, q[2]!, false)
        const stop = end < 0 ? line.length : end
        o.push(line.slice(from, stop), S.string)
        i = stop
        continue
      }
      o.push(line[i]!, S.text)
      i++
      continue
    }
    const tail = line.slice(i)
    if (tail.startsWith('<!--')) {
      const end = line.indexOf('-->', i + 4)
      if (end < 0) {
        o.push(tail, S.comment)
        return { spans: o.spans, state: { close: '-->', style: S.comment } }
      }
      o.push(line.slice(i, end + 3), S.comment)
      i = end + 3
      continue
    }
    const open = tail.match(/^<\/?[A-Za-z!?][\w:.-]*/)
    if (open) {
      o.push(open[0], S.tag)
      i += open[0].length
      st = { close: '>', style: S.tag, kind: 'tag' }
      continue
    }
    const ent = tail.match(/^&[#\w]+;/)
    if (ent) {
      o.push(ent[0], S.number)
      i += ent[0].length
      continue
    }
    const text = tail.match(/^[^<&]+/)
    o.push(text ? text[0] : line[i]!, S.text)
    i += text ? text[0].length : 1
  }
  return { spans: o.spans, state: st }
}

function md(line: string, state: State): { spans: Span[]; state: State } {
  const fence = line.match(/^\s*(```+|~~~+)/)
  if (state?.kind === 'fence') return fence && line.trim().startsWith(state.close) ? { spans: [{ text: line, style: S.comment }], state: undefined } : { spans: [{ text: line, style: S.code }], state }
  if (fence) return { spans: [{ text: line, style: S.comment }], state: { close: fence[1]!, style: S.code, kind: 'fence' } }
  const h = line.match(/^#{1,6}\s/)
  if (h) return { spans: [{ text: line, style: S.heading }], state }
  const o = new Out()
  let rest = line
  const lead = rest.match(/^(\s*)([-*+]|\d+[.)]|>)(\s+|$)/)
  if (lead) {
    o.push(lead[1]!, S.text)
    o.push(lead[2]! + lead[3]!, lead[2] === '>' ? S.quote : S.bullet)
    rest = rest.slice(lead[0].length)
  }
  const base = lead?.[2] === '>' ? S.quote : S.text
  const re = /(`+)[^`]+?\1|\*\*[^*]+\*\*|__[^_]+__|(?<![\w*])\*[^*\s][^*]*?\*(?!\w)|\[[^\]]+\]\([^)\s]+\)|<https?:[^>]+>/g
  let at = 0
  for (const m of rest.matchAll(re)) {
    o.push(rest.slice(at, m.index), base)
    const t = m[0]
    o.push(t, t[0] === '`' ? S.code : t.startsWith('**') || t.startsWith('__') ? S.bold : t[0] === '*' ? S.italic : S.link)
    at = m.index! + t.length
  }
  o.push(rest.slice(at), base)
  return { spans: o.spans, state }
}

/** One line's spans in `lang` (plain text when undefined), and what it leaves open for the next. */
export function highlightLine(line: string, lang: Lang | undefined, state?: State): { spans: Span[]; state: State } {
  if (!lang || !line) return { spans: line ? [{ text: line, style: S.text }] : [], state: lang ? state : undefined }
  switch (lang) {
    case 'md':
      return md(line, state)
    case 'css':
      return css(line, state)
    case 'html':
      return html(line, state)
    case 'yaml':
      return { spans: yaml(line), state: undefined }
    case 'diff': {
      const style: Style = /^(\+\+\+|---) /.test(line) ? S.bold : line[0] === '+' ? { fg: K.addSign } : line[0] === '-' ? { fg: K.delSign } : line.startsWith('@@') ? S.type : { fg: K.context }
      return { spans: [{ text: line, style }], state: undefined }
    }
    default:
      return generic(line, SPECS[lang]!, state)
  }
}

/** Each line's spans, carrying open comments and strings from line to line. */
export function highlight(lines: string[], lang: Lang | undefined): Span[][] {
  let state: State
  return lines.map(l => {
    const r = highlightLine(l, lang, state)
    state = r.state
    return r.spans
  })
}

// ---- Blocks -------------------------------------------------------------------------

/** Tabs to spaces, and no terminal control codes (colours a command printed, carriage returns). */
export const clean = (s: string) =>
  s
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(\x07|\x1b\\)|\x1b[@-Z\\-_]/g, '')
    .replace(/\t/g, '  ')
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '')

/**
 * Spans cut into rows of at most `width` cells; at least one row. Code wraps rather than being cut:
 * after a space when there is one in the row's second half, otherwise anywhere. A space a row
 * breaks at is dropped, so the next row does not start with it.
 */
export function hardWrap(spans: Span[], width: number): Span[][] {
  width = Math.max(1, width)
  const text = spans.map(s => s.text).join('')
  // Where each row starts, as offsets in `text`, and how many characters it skips there.
  const cuts: { at: number; skip: number }[] = []
  let start = 0
  let w = 0
  let space = -1
  let at = 0
  for (const ch of text) {
    const c = charCells(ch)
    if (w + c > width && w > 0) {
      const cut = ch === ' ' ? { at, skip: 1 } : space >= start && cells(text.slice(start, space + 1)) > width / 2 ? { at: space + 1, skip: 0 } : { at, skip: 0 }
      cuts.push(cut)
      start = cut.at + cut.skip
      w = ch === ' ' ? 0 : cells(text.slice(start, at)) + c
      space = -1
      at += ch.length
      continue
    }
    if (ch === ' ') space = at
    w += c
    at += ch.length
  }
  const rows: Span[][] = [[]]
  let pos = 0
  let next = 0
  for (const sp of spans) {
    const end = pos + sp.text.length
    let from = pos
    while (next < cuts.length && cuts[next]!.at < end) {
      const cut = cuts[next++]!
      if (cut.at > from) rows.at(-1)!.push({ ...sp, text: sp.text.slice(from - pos, cut.at - pos) })
      rows.push([])
      from = Math.max(from, cut.at + cut.skip)
    }
    if (from < end) rows.at(-1)!.push({ ...sp, text: sp.text.slice(from - pos) })
    pos = end
  }
  return rows
}

/** One row of a block: a gutter (line number, + or −: never copied), the code, and its background. */
export type Row = { gutter: string; gutterStyle: Style; spans: Span[]; bg: number }

/** A block narrower than this widens to it, unless the space is narrower. */
const MIN_W = 40

/**
 * Rows drawn as a block `width` cells wide at most, snug to its longest line: each row's background
 * fills it, long lines wrap under a blank gutter. `head` is a header row on a lighter shade.
 */
export function block(rows: Row[], width: number, head?: { left: Span[]; right?: Span[] }): Line[] {
  const gw = Math.max(0, ...rows.map(r => cells(r.gutter)))
  const longest = Math.max(0, ...rows.map(r => r.spans.reduce((n, s) => n + cells(s.text), 0)))
  const headW = head ? [...head.left, ...(head.right ?? [])].reduce((n, s) => n + cells(s.text), 0) + 2 : 0
  const w = Math.max(1, Math.min(width, Math.max(MIN_W, gw + longest + 2, headW)))
  const cw = Math.max(1, w - gw - 1)
  const out: Line[] = []
  if (head) {
    const right = head.right ?? []
    const rightW = right.reduce((n, s) => n + cells(s.text), 0)
    // A long path is cut, so the counts stay in sight.
    const left = clipLine(head.left, Math.max(1, w - rightW - 1))
    const used = lineCells(left) + rightW
    const bg = (s: Span): Span => ({ ...s, style: { ...s.style, bg: K.headBg } })
    out.push([...left.map(bg), { text: ' '.repeat(Math.max(1, w - used)), style: { bg: K.headBg } }, ...right.map(bg)])
  }
  for (const r of rows) {
    const g = r.gutter.padStart(gw)
    hardWrap(r.spans, cw).forEach((piece, k) => {
      const used = piece.reduce((n, s) => n + cells(s.text), 0)
      out.push([
        { text: k === 0 ? g : ' '.repeat(gw), style: { ...r.gutterStyle }, noCopy: true },
        { text: ' ', style: { bg: r.bg }, noCopy: true },
        ...piece.map(s => ({ ...s, style: { ...s.style, bg: s.style?.bg ?? r.bg } })),
        { text: ' '.repeat(Math.max(0, cw - used)), style: { bg: r.bg }, noCopy: true },
      ])
    })
  }
  return out
}

const gutterOf: Style = { fg: K.lineNo, bg: K.gutterBg }

/** Code with line numbers from `first` (none when undefined), highlighted in `lang`; `mark` follows each number. */
export function codeRows(lines: string[], lang: Lang | undefined, first?: number, style: { fg?: number; bg?: number } = {}, mark = ''): Row[] {
  const spans = highlight(lines.map(clean), lang)
  return spans.map((s, i) => ({
    gutter: first != null ? ` ${first + i} ${mark}` : ' ',
    gutterStyle: { ...gutterOf, ...style },
    spans: s,
    bg: K.bg,
  }))
}

/** A Read result: Claude Code numbers each line (`  12→text`); the numbers go to the gutter. */
export function readRows(result: string, lang: Lang | undefined): Row[] {
  const lines = result.replace(/\s+$/, '').split('\n')
  const rows: Row[] = []
  let state: State
  let inReminder = false
  for (const l of lines) {
    if (/<system-reminder>/.test(l)) inReminder = true
    if (inReminder) {
      if (/<\/system-reminder>/.test(l)) inReminder = false
      continue
    }
    const m = l.match(/^\s*(\d+)(?:→|\t)(.*)$/)
    if (m) {
      const r = highlightLine(clean(m[2]!), lang, state)
      state = r.state
      rows.push({ gutter: ` ${m[1]} `, gutterStyle: gutterOf, spans: r.spans, bg: K.bg })
    } else rows.push({ gutter: ' ', gutterStyle: gutterOf, spans: [{ text: clean(l), style: { fg: K.comment, italic: true } }], bg: K.bg })
  }
  // What follows the numbered lines (a note, blank lines left by a reminder) shows as a faint note.
  while (rows.length && rows.at(-1)!.gutter === ' ' && !rows.at(-1)!.spans.some(s => s.text.trim())) rows.pop()
  return rows
}

/** A shell command after a $, then its output (red when it failed). */
export function shellRows(command: string, output: string | undefined, isError = false): Row[] {
  const rows = codeRows(command.split('\n'), 'sh').map((r, i): Row => ({ ...r, gutter: i === 0 ? ' $' : '  ', gutterStyle: { ...gutterOf, fg: K.type, bold: true } }))
  if (output) for (const l of output.replace(/\s+$/, '').split('\n')) rows.push({ gutter: '  ', gutterStyle: gutterOf, spans: [{ text: clean(l), style: { fg: isError ? K.error : K.output } }], bg: K.bg })
  return rows
}

// ---- Diffs ----------------------------------------------------------------------------

/** An edit's lines: removed in red, added in green, the words that changed brighter, context dimmed. */
export function diffRows(before: string, after: string): { rows: Row[]; added: number; removed: number } {
  const d = lineDiff(clean(before), clean(after))
  const rows: Row[] = []
  let added = 0
  let removed = 0
  const del = (spans: Span[]): Row => ({ gutter: ' -', gutterStyle: { fg: K.delSign, bg: K.delBg, bold: true }, spans, bg: K.delBg })
  const add = (spans: Span[]): Row => ({ gutter: ' +', gutterStyle: { fg: K.addSign, bg: K.addBg, bold: true }, spans, bg: K.addBg })
  for (let i = 0; i < d.length; ) {
    if (d[i]!.kind === ' ') {
      rows.push({ gutter: '  ', gutterStyle: gutterOf, spans: d[i]!.text ? [{ text: d[i]!.text, style: { fg: K.context } }] : [], bg: K.bg })
      i++
      continue
    }
    // A change: its removed lines, then its added ones; the n-th of each are a pair.
    const gone: string[] = []
    const came: string[] = []
    while (i < d.length && d[i]!.kind === '-') gone.push(d[i++]!.text)
    while (i < d.length && d[i]!.kind === '+') came.push(d[i++]!.text)
    removed += gone.length
    added += came.length
    // Each added line pairs with the removed one it most resembles, in order (a long run pairs by place).
    const pairs: ReturnType<typeof wordDiff>[] = []
    const pairOf: ReturnType<typeof wordDiff>[] = []
    const search = gone.length * came.length <= 400
    let from = 0
    for (let c = 0; c < came.length; c++) {
      let best: { g: number; w: NonNullable<ReturnType<typeof wordDiff>> } | undefined
      for (let g = search ? from : c; g < (search ? gone.length : Math.min(gone.length, c + 1)); g++) {
        const w = wordDiff(gone[g]!, came[c]!)
        if (w && (!best || w.likeness > best.w.likeness)) best = { g, w }
      }
      if (best) {
        pairs[best.g] = best.w
        pairOf[c] = best.w
        from = best.g + 1
      }
    }
    const marked = (pieces: { text: string; isChanged: boolean }[], fg: number, wordBg: number): Span[] =>
      pieces.map(p => ({ text: p.text, style: p.isChanged ? { fg: K.wordFg, bg: wordBg } : { fg } }))
    gone.forEach((g, k) => rows.push(del(pairs[k] ? marked(pairs[k]!.before, K.delFg, K.delWordBg) : g ? [{ text: g, style: { fg: K.delFg } }] : [])))
    came.forEach((c, k) => rows.push(add(pairOf[k] ? marked(pairOf[k]!.after, K.addFg, K.addWordBg) : c ? [{ text: c, style: { fg: K.addFg } }] : [])))
  }
  return { rows, added, removed }
}

/** The header of a file's change: its path, then +added −removed. */
export function diffHead(path: string, added: number, removed: number): { left: Span[]; right: Span[] } {
  return {
    left: [{ text: ` ${path}`, style: { fg: K.text, bold: true } }],
    right: [
      ...(added || !removed ? [{ text: `+${added}`, style: { fg: K.addSign, bold: true } }] : []),
      ...(added && removed ? [{ text: ' ' }] : []),
      ...(removed ? [{ text: `−${removed}`, style: { fg: K.delSign, bold: true } }] : []),
      { text: ' ' },
    ],
  }
}

/** A separator row between the hunks of a MultiEdit. */
export const hunkGap = (): Row => ({ gutter: ' ⋯', gutterStyle: gutterOf, spans: [], bg: K.gutterBg })
