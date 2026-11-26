// JSON with comments (JSONC), as Windows Terminal's settings.json may be: // and /* */ comments, and
// trailing commas. Parsed with each value's place in the text, so one value can be set by changing
// only its own characters: every comment, blank line and indent elsewhere stays as it was.

export type Node =
  | { type: 'object'; start: number; end: number; members: Member[] }
  | { type: 'array'; start: number; end: number; items: Node[] }
  | { type: 'string'; start: number; end: number; value: string }
  | { type: 'other'; start: number; end: number; value: unknown }

/** A key and its value; `keyStart`: where the key's opening quote is. */
export type Member = { key: string; keyStart: number; value: Node }

/** What went wrong, and on which line (from 1). */
export class JsoncError extends Error {
  line: number
  constructor(message: string, line: number) {
    super(`${message} (line ${line})`)
    this.line = line
  }
}

/** Parses JSONC; throws a JsoncError for anything else. */
export function parse(text: string): Node {
  let i = 0
  const lineAt = (p: number) => text.slice(0, p).split('\n').length
  const fail = (what: string): never => {
    throw new JsoncError(what, lineAt(i))
  }
  const skip = () => {
    for (;;) {
      while (i < text.length && /\s/.test(text[i]!)) i++
      if (text.startsWith('//', i)) {
        const nl = text.indexOf('\n', i)
        i = nl < 0 ? text.length : nl + 1
      } else if (text.startsWith('/*', i)) {
        const close = text.indexOf('*/', i + 2)
        if (close < 0) fail('a /* comment that never ends')
        i = close + 2
      } else return
    }
  }
  const str = (): { value: string; start: number; end: number } => {
    const start = i
    i++
    let value = ''
    for (;;) {
      if (i >= text.length) fail('a string that never ends')
      const ch = text[i]!
      if (ch === '"') break
      if (ch === '\n') fail('a line break inside a string')
      if (ch === '\\') {
        const e = text[i + 1]
        const simple: Record<string, string> = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' }
        if (e && e in simple) {
          value += simple[e]
          i += 2
        } else if (e === 'u' && /^[0-9a-fA-F]{4}$/.test(text.slice(i + 2, i + 6))) {
          value += String.fromCharCode(parseInt(text.slice(i + 2, i + 6), 16))
          i += 6
        } else fail('a bad escape in a string')
        continue
      }
      value += ch
      i++
    }
    i++
    return { value, start, end: i }
  }
  const value = (): Node => {
    skip()
    const start = i
    const ch = text[i]
    if (ch === '{') {
      i++
      const members: Member[] = []
      for (;;) {
        skip()
        if (text[i] === '}') break
        if (text[i] !== '"') fail('expected a key in quotes')
        const k = str()
        skip()
        if (text[i] !== ':') fail('expected : after a key')
        i++
        members.push({ key: k.value, keyStart: k.start, value: value() })
        skip()
        if (text[i] === ',') i++
        else if (text[i] !== '}') fail('expected , or }')
      }
      i++
      return { type: 'object', start, end: i, members }
    }
    if (ch === '[') {
      i++
      const items: Node[] = []
      for (;;) {
        skip()
        if (text[i] === ']') break
        items.push(value())
        skip()
        if (text[i] === ',') i++
        else if (text[i] !== ']') fail('expected , or ]')
      }
      i++
      return { type: 'array', start, end: i, items }
    }
    if (ch === '"') return { type: 'string', ...str() }
    const m = /^(?:true|false|null|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(text.slice(i, i + 64))
    if (!m) return fail(i >= text.length ? 'the file ends too soon' : `unexpected “${text[i]}”`)
    i += m[0].length
    return { type: 'other', start, end: i, value: JSON.parse(m[0]) }
  }
  // A byte order mark may lead the file.
  if (text.charCodeAt(0) === 0xfeff) i = 1
  const root = value()
  skip()
  if (i < text.length) fail('more after the end')
  return root
}

/** The value at `path` (object keys, array indexes), if there is one. */
export function find(node: Node | undefined, path: (string | number)[]): Node | undefined {
  for (const p of path) {
    if (!node) return undefined
    if (typeof p === 'number') node = node.type === 'array' ? node.items[p] : undefined
    else node = node.type === 'object' ? node.members.findLast(m => m.key === p)?.value : undefined
  }
  return node
}

/** A string value at `path`, or undefined. */
export function findString(node: Node | undefined, path: (string | number)[]): string | undefined {
  const n = find(node, path)
  return n?.type === 'string' ? n.value : undefined
}

/** The whitespace a line starts with, for the line `at` is on. */
function indentAt(text: string, at: number): string {
  const from = text.lastIndexOf('\n', at - 1) + 1
  return /^[ \t]*/.exec(text.slice(from))![0]
}

/**
 * Sets the string at `path` (object keys, from the object `at`, given by its own path from the root),
 * making the objects on the way that aren't there. Only the value's characters change, or, for a new
 * key, the text inserted before the object's first member, indented as the file is. Throws when a key
 * on the way holds something other than an object.
 */
export function setString(text: string, path: string[], value: string, base: (string | number)[] = []): string {
  const root = parse(text)
  const eol = text.includes('\r\n') ? '\r\n' : '\n'
  const unit = /\n([ \t]+)\S/.exec(text)?.[1] ?? '    '
  let obj = find(root, base)
  if (obj?.type !== 'object') throw new Error(`${base.join('.') || 'the file'} is not an object`)
  for (let k = 0; k < path.length; k++) {
    const key = path[k]!
    const member: Member | undefined = obj.members.findLast(m => m.key === key)
    if (member && k === path.length - 1) {
      if (member.value.type !== 'string' && member.value.type !== 'other') throw new Error(`${[...base, ...path].join('.')} is not a string`)
      return text.slice(0, member.value.start) + JSON.stringify(value) + text.slice(member.value.end)
    }
    if (member) {
      if (member.value.type !== 'object') throw new Error(`${[...base, ...path.slice(0, k + 1)].join('.')} is not an object`)
      obj = member.value
      continue
    }
    return insert(text, obj, path.slice(k), value, eol, unit)
  }
  /* c8 ignore next */
  return text
}

/** `"a": {"b": "v"}` for the keys left, laid out over lines at `indent`, or on one line. */
function nested(keys: string[], value: string, indent: string, eol: string, unit: string, oneLine: boolean): string {
  const [k, ...rest] = keys
  if (!rest.length) return `${JSON.stringify(k)}: ${JSON.stringify(value)}`
  if (oneLine) return `${JSON.stringify(k)}: { ${nested(rest, value, '', eol, unit, true)} }`
  return `${JSON.stringify(k)}: {${eol}${indent}${unit}${nested(rest, value, indent + unit, eol, unit, false)}${eol}${indent}}`
}

function insert(text: string, obj: Extract<Node, { type: 'object' }>, keys: string[], value: string, eol: string, unit: string): string {
  const first = obj.members[0]
  if (first) {
    // Laid out over lines: the new key goes on a line of its own, before the first one; else on the same line.
    const multi = text.slice(obj.start, first.keyStart).includes('\n')
    const ind = indentAt(text, first.keyStart)
    const add = multi ? `${nested(keys, value, ind, eol, unit, false)},${eol}${ind}` : `${nested(keys, value, '', eol, unit, true)}, `
    return text.slice(0, first.keyStart) + add + text.slice(first.keyStart)
  }
  const ind = indentAt(text, obj.start)
  const inner = text.slice(obj.start + 1, obj.end - 1)
  const body = `${eol}${ind}${unit}${nested(keys, value, ind + unit, eol, unit, false)}`
  // An empty object's comments stay, after the new key.
  return text.slice(0, obj.start + 1) + (inner.trim() ? body + inner : `${body}${eol}${ind}`) + text.slice(obj.end - 1)
}
