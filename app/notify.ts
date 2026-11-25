// Notifications: a system notification, with a sound, each time Claude starts waiting on you (a
// question in a reply, a permission, an AskUserQuestion card). This file decides when one goes and
// builds what posts it: the terminal's own sequence, a Windows toast (from WSL too), osascript on
// macOS, or notify-send and a sound on Linux. app/main.ts runs what it builds.
//
// Windows Terminal: a click on the toast opens the very tab that asked. The toast launches a
// clued-focus: link; a small per-user handler (HKCU\Software\Classes\clued-focus, running
// %LOCALAPPDATA%\clued\focus.ps1) finds the tab by its title through UI Automation, selects it and
// brings its window to the front. The tab's title ends with an invisible tag (zero-width characters
// made from WT_SESSION), so two clued tabs on the same folder are told apart. The handler is set up
// with the first toast and removed with /notify uninstall.

import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'

/** on: unless you are at this very tab right now (see shouldNotify); always: every time; off: never. */
export type Notify = 'on' | 'always' | 'off'
export const NOTIFY_MODES: Notify[] = ['on', 'always', 'off']

/** A key press or click in the app this recent, with the tab focused, means you are looking at it. */
export const ACTIVE_MS = 15_000

/**
 * Whether a new wait notifies. With `on`, it does unless this tab has focus and you typed or clicked
 * in it within `activeMs`. Typing proves you are here, as keys and clicks reach the app only while its
 * tab has the keyboard; focus alone does not (the app starts out counting itself focused, and a
 * terminal that never reports focus, or a window you sit in front of while reading something else,
 * would silence every notification).
 */
export function shouldNotify(mode: Notify, focused: boolean, lastInputAt: number, now: number, activeMs = ACTIVE_MS): boolean {
  if (mode === 'off') return false
  if (mode === 'always') return true
  return !(focused && now - lastInputAt < activeMs)
}

/** Remembers each wait it was told about, so each notifies once: `reply:<part>`, `ask:<id>`, `perm:<id>`. */
export class Waits {
  private seen = new Set<string>()
  /** True the first time `key` is seen. */
  isNew(key: string): boolean {
    if (this.seen.has(key)) return false
    this.seen.add(key)
    return true
  }
}

/** Where the notification goes. */
export type Target = 'kitty' | 'osc9' | 'windows' | 'mac' | 'linux'

export function targetOf(env: NodeJS.ProcessEnv, platform: NodeJS.Platform, isWsl: boolean): Target {
  if (env.KITTY_WINDOW_ID) return 'kitty'
  if (env.TERM_PROGRAM === 'iTerm.app' || env.TERM_PROGRAM === 'WezTerm' || env.TERM_PROGRAM === 'ghostty') return 'osc9'
  if (isWsl || platform === 'win32') return 'windows'
  if (platform === 'darwin') return 'mac'
  return 'linux'
}

const flat = (s: string) => s.replace(/[\x00-\x1f\x7f]/g, ' ')

/**
 * The terminal's own notification: kitty's OSC 99 (it plays the system's notification sound), or
 * OSC 9 (iTerm2, WezTerm, Ghostty post it through the system, whose settings for that terminal decide
 * the sound), followed by a bell, which these terminals ring (or show) as they are set to.
 */
export function oscNotification(target: 'kitty' | 'osc9', title: string, body: string): string {
  const text = flat(`${title}: ${body}`)
  return target === 'kitty' ? `\x1b]99;;${text}\x1b\\\x07` : `\x1b]9;${text}\x07\x07`
}

export type Cmd = { cmd: string; args: string[] }

/** macOS: Notification Center, with the Glass sound. */
export function macCommand(title: string, body: string): Cmd {
  return {
    cmd: 'osascript',
    args: ['-e', 'on run argv', '-e', 'display notification (item 2 of argv) with title (item 1 of argv) sound name "Glass"', '-e', 'end run', title, body],
  }
}

export const LINUX_SOUND = '/usr/share/sounds/freedesktop/stereo/message-new-instant.oga'

/**
 * Linux: notify-send shows it (it plays no sound itself), then a sound: the freedesktop
 * message-new-instant one through canberra-gtk-play, or paplay when that isn't there. Each sound is
 * tried after the one before failed; with neither there, there is no sound.
 */
export function linuxCommands(title: string, body: string, exists: (p: string) => boolean = existsSync): { show: Cmd; sounds: Cmd[] } {
  return {
    show: { cmd: 'notify-send', args: ['-a', 'clued', title, body] },
    sounds: [
      { cmd: 'canberra-gtk-play', args: ['-i', 'message-new-instant', '-d', 'clued'] },
      ...(exists(LINUX_SOUND) ? [{ cmd: 'paplay', args: [LINUX_SOUND] }] : []),
    ],
  }
}

// ---- Windows ------------------------------------------------------------------------------------

/** Windows PowerShell's own app id: its toasts play sound and stay in the Action Center. */
export const AUMID = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe'
export const SCHEME = 'clued-focus'
export const SOUND = 'ms-winsoundevent:Notification.Default'
const ZERO = '\u200b' // zero-width space
const ONE = '\u2060' // word joiner

/** This tab's id: 4 hex digits from WT_SESSION (Windows Terminal's id for the pane, kept across /reload). */
export function tabId(session: string): string {
  return createHash('sha1').update(session).digest('hex').slice(0, 4)
}

/** The invisible tag the tab's title ends with: the id's 16 bits as zero-width characters. */
export function tabTag(id: string): string {
  return [...parseInt(id, 16).toString(2).padStart(16, '0')].map(b => (b === '1' ? ONE : ZERO)).join('')
}

/** The link a click on the toast opens: the handler finds the tab by its id, else by the folder. */
export function focusUri(id: string, where: string): string {
  return `${SCHEME}:?id=${id}&where=${encodeURIComponent(where)}`
}

const xml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;')

/** The toast: title and body, the default notification sound, and, with `launch`, the link a click opens. */
export function toastXml(title: string, body: string, launch?: string): string {
  const open = launch ? ` activationType="protocol" launch="${xml(launch)}"` : ''
  return (
    `<toast${open}><visual><binding template="ToastGeneric"><text>${xml(flat(title))}</text><text>${xml(flat(body))}</text></binding></visual>` +
    `<audio src="${SOUND}"/></toast>`
  )
}

/**
 * The click handler, run as `focus.ps1 <clued-focus: link>`: selects the Windows Terminal tab whose
 * title has the link's tag (else the one for the link's folder, a waiting one first) and brings its
 * window to the front, or just the last used Windows Terminal window when no tab matches. -Check only
 * prints what it found. ASCII only, so Windows PowerShell reads it right whatever the file's encoding.
 */
export const FOCUS_PS = String.raw`param([string]$Uri, [switch]$Check)
# clued: a click on its notification opens the Windows Terminal tab that sent it. Remove with /notify uninstall.
$ErrorActionPreference = 'Stop'
$q = @{}
if ($Uri -match '\?(.*)$') {
  foreach ($p in ($Matches[1] -split '&')) {
    $kv = $p -split '=', 2
    if ($kv.Count -eq 2) { $q[$kv[0]] = [Uri]::UnescapeDataString($kv[1]) }
  }
}
$id = [string]$q['id']; $where = [string]$q['where']
if ($id -notmatch '^[0-9a-f]{4}$') { $id = '' }
if ($where.Length -gt 200) { $where = '' }
$tag = ''
if ($id) { $tag = -join ([Convert]::ToString([Convert]::ToInt32($id, 16), 2).PadLeft(16, '0').ToCharArray() | ForEach-Object { if ($_ -eq '1') { [char]0x2060 } else { [char]0x200B } }) }
$end = 'clued ' + [char]0xB7 + ' ' + $where
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
$A = [Windows.Automation.AutomationElement]
$isWt = New-Object Windows.Automation.PropertyCondition($A::ClassNameProperty, 'CASCADIA_HOSTING_WINDOW_CLASS')
$isTab = New-Object Windows.Automation.PropertyCondition($A::ControlTypeProperty, [Windows.Automation.ControlType]::TabItem)
$windows = @($A::RootElement.FindAll([Windows.Automation.TreeScope]::Children, $isWt))
$best = $null; $bestWin = $null; $rank = 0
foreach ($w in $windows) {
  foreach ($t in $w.FindAll([Windows.Automation.TreeScope]::Descendants, $isTab)) {
    $name = [string]$t.Current.Name
    $plain = $name -replace '[\u200B\u2060]', ''
    $r = 0
    if ($tag -and $name.Contains($tag)) { $r = 3 }
    elseif ($where -and $plain.EndsWith($end) -and $plain.StartsWith([string][char]0x270B)) { $r = 2 }
    elseif ($where -and $plain.EndsWith($end)) { $r = 1 }
    if ($r -gt $rank) { $rank = $r; $best = $t; $bestWin = $w }
  }
}
if (-not $bestWin -and $windows.Count) { $bestWin = $windows[0] }
if ($Check) { if ($bestWin) { "rank=$rank window=$($bestWin.Current.NativeWindowHandle)" } else { 'none' }; exit }
if (-not $bestWin) { exit }
try {
  $wp = $bestWin.GetCurrentPattern([Windows.Automation.WindowPattern]::Pattern)
  if ($wp.Current.WindowVisualState -eq [Windows.Automation.WindowVisualState]::Minimized) { $wp.SetWindowVisualState([Windows.Automation.WindowVisualState]::Normal) }
} catch {}
try { $bestWin.SetFocus() } catch {}
Add-Type -Namespace Clued -Name Win -MemberDefinition '[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);'
[void][Clued.Win]::SetForegroundWindow([IntPtr]$bestWin.Current.NativeWindowHandle)
if ($best) { try { $best.GetCurrentPattern([Windows.Automation.SelectionItemPattern]::Pattern).Select() } catch {} }
`

/** The handler's version: the registry keeps it, so a changed handler is written again. */
export const FOCUS_VERSION = createHash('sha1').update(FOCUS_PS).digest('hex').slice(0, 8)

const b64 = (t: string) => Buffer.from(t, 'utf8').toString('base64')
const KEY = `HKCU:\\Software\\Classes\\${SCHEME}`

/**
 * Sets up the click handler when it isn't there yet (or is an older one): writes focus.ps1 to
 * %LOCALAPPDATA%\clued and registers the clued-focus: scheme for this user only. It runs headless
 * (conhost --headless), so no console window, nor a Windows Terminal tab, opens on a click.
 */
export function installScript(): string {
  return [
    `$k='${KEY}'; $f=Join-Path $env:LOCALAPPDATA 'clued\\focus.ps1'`,
    `if ((Get-ItemProperty -Path $k -Name CluedVersion -ErrorAction SilentlyContinue).CluedVersion -ne '${FOCUS_VERSION}' -or -not (Test-Path $f)) {`,
    `New-Item -ItemType Directory -Force -Path (Split-Path $f) > $null`,
    `[IO.File]::WriteAllText($f, [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64(FOCUS_PS)}')))`,
    `New-Item -Path "$k\\shell\\open\\command" -Force > $null`,
    `Set-ItemProperty -Path $k -Name '(default)' -Value 'URL:clued focus'`,
    `Set-ItemProperty -Path $k -Name 'URL Protocol' -Value ''`,
    `Set-ItemProperty -Path "$k\\shell\\open\\command" -Name '(default)' -Value ('"' + $env:SystemRoot + '\\System32\\conhost.exe" --headless "' + $PSHOME + '\\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + $f + '" "%1"')`,
    `Set-ItemProperty -Path $k -Name CluedVersion -Value '${FOCUS_VERSION}' }`,
  ].join('; ')
}

/** /notify uninstall: removes the scheme and focus.ps1 (and its folder, once empty). */
export function uninstallScript(): string {
  return [
    `Remove-Item -Path '${KEY}' -Recurse -Force -ErrorAction SilentlyContinue`,
    `$d=Join-Path $env:LOCALAPPDATA 'clued'; Remove-Item -Path (Join-Path $d 'focus.ps1') -Force -ErrorAction SilentlyContinue`,
    `if ((Test-Path $d) -and -not (Get-ChildItem $d)) { Remove-Item $d }`,
  ].join('; ')
}

/** The PowerShell that shows the toast; with `launch`, it sets up the click handler first. */
export function toastScript(title: string, body: string, launch?: string): string {
  return [
    ...(launch ? [`try { ${installScript()} } catch {}`] : []),
    '[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null',
    '[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] > $null',
    `$d=New-Object Windows.Data.Xml.Dom.XmlDocument; $d.LoadXml([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64(toastXml(title, body, launch))}')))`,
    `[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('${AUMID}').Show([Windows.UI.Notifications.ToastNotification]::new($d))`,
  ].join('; ')
}
