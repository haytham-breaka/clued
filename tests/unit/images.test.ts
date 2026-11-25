import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { IMAGE_LINK, imageSpans, openerFor } from '../../app/images.ts'

describe('imageSpans', () => {
  const go = () => {}
  const click = (n: number) => (n <= 2 ? go : undefined)

  test('each [image N] the app has a file for is a link; the rest keeps its style and action', () => {
    const open = () => {}
    const spans = imageSpans('[image 1] and [image 2] then [image 3]', click, { dim: true }, open)
    assert.deepEqual(spans.map(s => s.text), ['[image 1]', ' and ', '[image 2]', ' then [image 3]'])
    assert.deepEqual(spans[0]!.style, { dim: true, ...IMAGE_LINK })
    assert.equal(spans[0]!.action, go)
    assert.deepEqual(spans[1]!.style, { dim: true })
    assert.equal(spans[1]!.action, open)
    assert.equal(spans[3]!.action, open)
  })

  test('text without a known image is one plain span', () => {
    assert.deepEqual(imageSpans('no images here', click), [{ text: 'no images here' }])
    assert.deepEqual(imageSpans('[image 1] here', undefined), [{ text: '[image 1] here' }])
    assert.deepEqual(imageSpans('[image 9]', click), [{ text: '[image 9]' }])
    assert.deepEqual(imageSpans('[image 1]', click).map(s => s.text), ['[image 1]'])
  })
})

describe('openerFor', () => {
  test('WSL: PowerShell Start-Process with the Windows path, single quotes doubled', () => {
    assert.deepEqual(openerFor("/tmp/it's.png", 'linux', true, "\\\\wsl.localhost\\U\\tmp\\it's.png"), ['powershell.exe', ['-NoProfile', '-Command', "Start-Process -FilePath '\\\\wsl.localhost\\U\\tmp\\it''s.png'"]])
    // No Windows path to be had: the path as it is.
    assert.deepEqual(openerFor('/tmp/a.png', 'linux', true), ['powershell.exe', ['-NoProfile', '-Command', "Start-Process -FilePath '/tmp/a.png'"]])
  })
  test('Windows, macOS, Linux', () => {
    assert.deepEqual(openerFor('C:\\a.png', 'win32', false), ['powershell', ['-NoProfile', '-Command', "Start-Process -FilePath 'C:\\a.png'"]])
    assert.deepEqual(openerFor('/tmp/a.png', 'darwin', false), ['open', ['/tmp/a.png']])
    assert.deepEqual(openerFor('/tmp/a.png', 'linux', false), ['xdg-open', ['/tmp/a.png']])
  })
})
