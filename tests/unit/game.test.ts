import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { again, bestOf, boardSize, GAME_NAME, gameBanner, gameLines, keyDir, MIN_COLS, MIN_ROWS, newGame, pauseFor, resize, steer, step, togglePause } from '../../app/game.ts'
import type { Game } from '../../app/game.ts'
import { lineCells } from '../../app/text.ts'
import type { Line } from '../../app/text.ts'

const text = (l: Line) => l.map(s => s.text).join('')
const all = (ls: Line[]) => ls.map(text).join('\n')
/** A game already flying right, its spark out of the way (bottom right corner). */
const flying = (w = 12, h = 8): Game => {
  const g = newGame(w, h, 0, 42)
  g.spark = { x: w - 1, y: h - 1 }
  g.state = 'playing'
  return g
}

describe('Comet: moving', () => {
  test('a new game: three cells flying right from the middle, a spark somewhere free, not started', () => {
    const g = newGame(12, 8, 7, 1)
    assert.deepEqual(g.body, [{ x: 6, y: 4 }, { x: 5, y: 4 }, { x: 4, y: 4 }])
    assert.equal(g.dir, 'right')
    assert.equal(g.state, 'ready')
    assert.equal(g.best, 7)
    assert.ok(g.spark && !g.body.some(p => p.x === g.spark!.x && p.y === g.spark!.y))
    // Steps do nothing before it starts.
    assert.equal(step(g), 'ready')
    assert.equal(g.body[0]!.x, 6)
  })

  test('the same seed lays the same sparks', () => {
    assert.deepEqual(newGame(20, 10, 0, 99).spark, newGame(20, 10, 0, 99).spark)
  })

  test('each step moves the head a cell, the tail following; the sky wraps round at its edges', () => {
    const g = flying()
    step(g)
    assert.deepEqual(g.body, [{ x: 7, y: 4 }, { x: 6, y: 4 }, { x: 5, y: 4 }])
    for (let i = 0; i < 5; i++) step(g)
    assert.deepEqual(g.body[0], { x: 0, y: 4 }, 'out on the right, in on the left')
    steer(g, 'up')
    for (let i = 0; i < 5; i++) step(g)
    assert.deepEqual(g.body[0], { x: 0, y: 7 }, 'out at the top, in at the bottom')
    assert.equal(g.body.length, 3)
  })

  test('steering: a turn waits for the next step; straight back is ignored; at most two turns queue', () => {
    const g = flying()
    steer(g, 'left')
    assert.deepEqual(g.turns, [], 'back into the tail')
    steer(g, 'right')
    assert.deepEqual(g.turns, [], 'already going right')
    steer(g, 'up')
    steer(g, 'down')
    assert.deepEqual(g.turns, ['up'], 'down is straight back from up')
    steer(g, 'left')
    steer(g, 'down')
    assert.deepEqual(g.turns, ['up', 'left'])
    step(g)
    assert.equal(g.dir, 'up')
    assert.deepEqual(g.body[0], { x: 6, y: 3 })
    step(g)
    assert.equal(g.dir, 'left')
    assert.deepEqual(g.body[0], { x: 5, y: 3 })
  })

  test('the first arrow starts it; a paused or ended game takes no steering', () => {
    const g = newGame(12, 8, 0, 3)
    steer(g, 'down')
    assert.equal(g.state, 'playing')
    assert.deepEqual(g.turns, ['down'])
    g.turns = []
    togglePause(g)
    steer(g, 'up')
    assert.deepEqual(g.turns, [])
    g.state = 'over'
    steer(g, 'up')
    assert.deepEqual(g.turns, [])
  })
})

describe('Comet: growing and scoring', () => {
  test('a spark: a point, two more cells of tail over the next steps, and a new spark elsewhere', () => {
    const g = flying()
    g.spark = { x: 7, y: 4 }
    step(g)
    assert.equal(g.score, 1)
    assert.equal(g.sparks, 1)
    assert.equal(g.body.length, 3)
    assert.ok(g.spark && !(g.spark.x === 7 && g.spark.y === 4))
    g.spark = { x: 0, y: 0 }
    step(g)
    step(g)
    step(g)
    assert.equal(g.body.length, 5)
    assert.equal(g.grow, 0)
    assert.equal(bestOf(g), 1, 'the best counts this run')
    assert.equal(g.best, 0, 'best stays the one from before the run')
  })

  test('each fifth spark lights a star: five points if reached in time, gone after 60 steps', () => {
    const g = flying(20, 10)
    g.sparks = 4
    g.spark = { x: 11, y: 5 }
    step(g)
    assert.ok(g.star)
    assert.equal(g.star.ttl, 60)
    // Caught: the star moved in front of the head.
    g.star.at = { x: 12, y: 5 }
    step(g)
    assert.equal(g.score, 6)
    assert.equal(g.star, null)
    // Missed: it goes after its time.
    g.sparks = 9
    g.spark = { x: 13, y: 5 }
    step(g)
    const star = g.star as Game['star']
    assert.ok(star)
    star.at = { x: 0, y: 0 }
    star.ttl = 2
    g.spark = { x: 0, y: 9 }
    step(g)
    assert.ok(g.star)
    step(g)
    assert.equal(g.star, null)
  })

  test('flying into its own tail ends the run; flying into the cell the tail just left does not', () => {
    const g = flying()
    g.body = [{ x: 5, y: 4 }, { x: 5, y: 5 }, { x: 4, y: 5 }, { x: 4, y: 4 }]
    g.dir = 'up'
    // Left, into (4,4): the tail's end, which moves away this step.
    steer(g, 'left')
    assert.equal(step(g), 'playing')
    // A growing tail stays put: the same move breaks it up.
    const h = flying()
    h.body = [{ x: 5, y: 4 }, { x: 5, y: 5 }, { x: 4, y: 5 }, { x: 4, y: 4 }]
    h.dir = 'up'
    h.grow = 1
    h.score = 9
    steer(h, 'left')
    assert.equal(step(h), 'over')
    assert.equal(h.body[0]!.x, 5, 'it stops where it was')
    assert.equal(step(h), 'over', 'no steps after')
    assert.equal(bestOf(h), 9)
  })

  test('a sky with no room left for a spark: the run ends, the sky full', () => {
    const g = newGame(4, 1, 0, 5)
    g.state = 'playing'
    g.body = [{ x: 1, y: 0 }, { x: 0, y: 0 }]
    g.spark = { x: 2, y: 0 }
    g.grow = 1
    step(g)
    assert.equal(g.body.length, 3)
    assert.deepEqual(g.spark, { x: 3, y: 0 })
    step(g)
    assert.equal(g.state, 'over')
    assert.equal(g.spark, null)
    assert.match(all(gameLines(g, 40, 14)), /The sky is full at 2 · a new best/)
  })
})

describe('Comet: pausing', () => {
  test('Space pauses and plays on; after a run, Space starts a new one with the best kept', () => {
    let g = flying()
    togglePause(g)
    assert.equal(g.state, 'paused')
    step(g)
    assert.deepEqual(g.body[0], { x: 6, y: 4 }, 'no steps while paused')
    togglePause(g)
    assert.equal(g.state, 'playing')
    g.score = 4
    g.state = 'over'
    g = togglePause(g)
    assert.equal(g.state, 'playing')
    assert.equal(g.score, 0)
    assert.equal(g.best, 4)
    assert.equal(again(g).best, 4)
  })

  test('the app pausing it: a note saying why, cleared when you play on', () => {
    const g = flying()
    pauseFor(g, 'Claude answered: Esc back to the chat')
    assert.equal(g.state, 'paused')
    const s = all(gameLines(g, 40, 14))
    assert.match(s, /Claude answered: Esc back to the chat\n +Space to play on$/m)
    assert.doesNotMatch(s, /Paused/)
    togglePause(g)
    assert.equal(g.note, '')
    // A run already over keeps its state, with the note on it.
    g.state = 'over'
    pauseFor(g, 'Claude asks you something: Esc back to the chat')
    assert.equal(g.state, 'over')
    assert.match(all(gameLines(g, 70, 14)), /Claude asks you something: Esc back to the chat\n +The comet broke up at 0 · Space or Enter to fly again$/m)
  })
})

describe('Comet: the window', () => {
  test('boardSize: two terminal cells a game cell, room for the frame and two lines; capped; null when too small', () => {
    assert.deepEqual(boardSize(30, 12), { w: 14, h: 8 })
    assert.deepEqual(boardSize(200, 60), { w: 32, h: 18 })
    assert.deepEqual(boardSize(MIN_COLS, MIN_ROWS), { w: 10, h: 6 })
    assert.equal(boardSize(MIN_COLS - 1, 40), null)
    assert.equal(boardSize(80, MIN_ROWS - 1), null)
  })

  test('a smaller sky: what is outside wraps in, the tail cut where it would cross itself, the spark moved in', () => {
    const g = flying(20, 10)
    g.body = [{ x: 15, y: 2 }, { x: 14, y: 2 }, { x: 13, y: 2 }, { x: 3, y: 2 }]
    g.spark = { x: 18, y: 9 }
    g.star = { at: { x: 19, y: 0 }, ttl: 9 }
    g.grow = 500
    resize(g, 10, 6)
    // 15→5, 14→4, 13→3, then (3,2) again: cut there.
    assert.deepEqual(g.body, [{ x: 5, y: 2 }, { x: 4, y: 2 }, { x: 3, y: 2 }])
    assert.ok(g.spark && g.spark.x < 10 && g.spark.y < 6)
    assert.equal(g.star, null)
    assert.equal(g.grow, 57, 'never more than the sky holds')
    // Larger again: everything still fits, so it stays.
    const before = structuredClone(g)
    resize(g, 30, 12)
    assert.deepEqual(g.body, before.body)
    assert.deepEqual(g.spark, before.spark)
    // The same size: nothing changes.
    resize(g, 30, 12)
    assert.deepEqual(g.body, before.body)
  })

  test('a spark under the wrapped tail moves; a star still inside stays', () => {
    const g = flying(20, 10)
    g.body = [{ x: 12, y: 1 }, { x: 11, y: 1 }]
    g.spark = { x: 2, y: 1 }
    g.star = { at: { x: 4, y: 4 }, ttl: 9 }
    resize(g, 10, 6)
    assert.ok(!(g.spark!.x === 2 && g.spark!.y === 1))
    assert.deepEqual(g.star, { at: { x: 4, y: 4 }, ttl: 9 })
  })
})

describe('Comet: drawing', () => {
  test('the sky framed and centred, exactly the rows asked for, no line wider than the chat', () => {
    const cols = 60
    const rows = 20
    const size = boardSize(cols, rows)!
    const g = newGame(size.w, size.h, 0, 11)
    const ls = gameLines(g, cols, rows)
    assert.equal(ls.length, rows)
    for (const l of ls) assert.ok(lineCells(l) <= cols, text(l))
    const s = all(ls)
    assert.match(s, /╭─+╮/)
    assert.match(s, /██▓▓▒▒|▒▒▓▓██/)
    assert.match(s, /✦/)
    assert.match(s, /Arrows or WASD to fly, Space to start/)
    assert.match(s, /←↑↓→ or WASD steer · Space pause · Esc back to the chat/)
    const top = ls.find(l => text(l).includes('╭'))!
    const pad = text(top).indexOf('╭')
    assert.ok(Math.abs(pad - (cols - (size.w * 2 + 2) - pad)) <= 1, 'centred')
  })

  test('the tail fades to its end; a broken-up comet is red; a star shows while it lasts', () => {
    const g = flying(20, 10)
    g.body = Array.from({ length: 9 }, (_, i) => ({ x: 15 - i, y: 5 }))
    g.star = { at: { x: 2, y: 2 }, ttl: 25 }
    let s = all(gameLines(g, 70, 14))
    assert.match(s, / ░░░░▒▒▒▒▒▒▓▓▓▓▓▓██ /)
    assert.match(s, /★ worth 5 for 3 s/)
    g.state = 'over'
    g.score = 3
    const ls = gameLines(g, 70, 14)
    const head = ls.flat().find(sp => sp.text === '██')!
    assert.equal(head.style?.fg, 203)
    s = all(ls)
    assert.match(s, /The comet broke up at 3 · a new best · Space or Enter to fly again/)
    g.best = 5
    assert.doesNotMatch(all(gameLines(g, 70, 14)), /a new best/)
  })

  test('paused by Space: says so', () => {
    const g = flying()
    togglePause(g)
    assert.match(all(gameLines(g, 40, 14)), /Paused · Space to play on/)
  })

  test('too small, or no game yet: one line asking for a bigger window', () => {
    const g = flying()
    const ls = gameLines(g, 20, 14)
    assert.equal(ls.length, 14)
    assert.equal(ls.filter(l => text(l).trim()).length, 1)
    assert.match(all(ls), /^Make the window big…$/m)
    for (const l of ls) assert.ok(lineCells(l) <= 20)
    assert.match(all(gameLines(g, 160, MIN_ROWS - 1)), new RegExp(`Make the window bigger to play ${GAME_NAME}: it needs ${MIN_COLS} columns and ${MIN_ROWS} rows here\\. Esc back to the chat\\.`))
    // A sky bigger than the window (before the app resizes it): the same line.
    assert.match(all(gameLines(flying(30, 12), 40, 30)), /Make the window bigger/)
    assert.match(all(gameLines(null, 80, 30)), /Make the window bigger/)
    assert.deepEqual(gameLines(null, 80, 0), [])
  })

  test('the banner: the name, the score and the best (this run counted)', () => {
    const g = flying()
    g.best = 3
    g.score = 5
    assert.equal(text(gameBanner(g)), ' ✦ Comet   score 5  best 5')
    assert.equal(text(gameBanner(null)), ' ✦ Comet   score 0  best 0')
  })

  test('keyDir: the arrows and WASD, either case; anything else steers nowhere', () => {
    assert.deepEqual(['\x1b[A', 'w', 'W', '\x1b[B', 's', 'S', '\x1b[D', 'a', 'A', '\x1b[C', 'd', 'D'].map(keyDir), ['up', 'up', 'up', 'down', 'down', 'down', 'left', 'left', 'left', 'right', 'right', 'right'])
    assert.equal(keyDir('x'), undefined)
    assert.equal(keyDir('\x1b[1;3A'), undefined)
  })
})
