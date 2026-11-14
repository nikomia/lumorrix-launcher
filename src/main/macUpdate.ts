import { spawn } from 'node:child_process'
import { constants, writeFileSync } from 'node:fs'
import { access, mkdir, rm } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { app } from 'electron'
import { log } from './log'
import { downloadFile, fetchText } from './net'
import { paths } from './paths'

/**
 * Самообновление на macOS. Стандартное обновление Electron (Squirrel.Mac) ставит только подписанные
 * Apple сборки, а наша не подписана, поэтому меняем Lumorrix.app сами:
 * скачиваем архив своей архитектуры, распаковываем рядом, а после выхода лаунчера скрипт
 * подменяет старую папку приложения новой и снова его открывает.
 */

export const MAC_LATEST_URL = 'https://lumorrix.ru/launcher/mac-latest.json'

interface MacLatest {
  version: string
  files: Record<string, { url: string; sha1: string; size: number }>
}

const updateDir = join(paths.tmp, 'mac-update')
let prepared: { version: string; app: string } | null = null

export async function fetchMacLatest(): Promise<MacLatest | null> {
  try {
    const data = JSON.parse(await fetchText(`${MAC_LATEST_URL}?t=${Date.now()}`, 1)) as MacLatest
    return typeof data.version === 'string' && data.files ? data : null
  } catch (error) {
    log('Не удалось узнать последнюю версию лаунчера для macOS', error)
    return null
  }
}

/** Папка Lumorrix.app, из которой запущен лаунчер. */
function bundlePath(): string | null {
  // process.execPath = …/Lumorrix.app/Contents/MacOS/Lumorrix
  const bundle = resolve(dirname(process.execPath), '..', '..')
  return bundle.endsWith('.app') ? bundle : null
}

/**
 * Можно ли менять приложение на месте. Нельзя, если macOS запустила его из случайной папки только для чтения
 * (App Translocation — так бывает, когда приложение открыто прямо из «Загрузок» и не перенесено в «Программы»),
 * или если у игрока нет прав на папку, где оно лежит.
 */
export async function canReplaceBundle(): Promise<boolean> {
  const bundle = bundlePath()
  if (!bundle || bundle.includes('/AppTranslocation/')) return false
  return access(dirname(bundle), constants.W_OK).then(
    () => access(bundle, constants.W_OK).then(
      () => true,
      () => false,
    ),
    () => false,
  )
}

function run(cmd: string, args: string[]): Promise<void> {
  return new Promise((ok, fail) => {
    const child = spawn(cmd, args, { stdio: 'ignore' })
    child.on('error', fail)
    child.on('exit', (code) => (code === 0 ? ok() : fail(new Error(`${cmd} завершился с кодом ${code}`))))
  })
}

/** Скачивает и распаковывает новую версию. Прогресс приходит в процентах. */
export async function prepareMacUpdate(latest: MacLatest, onPercent: (percent: number) => void): Promise<boolean> {
  const file = latest.files[process.arch]
  if (!file) {
    log(`Для архитектуры ${process.arch} нет сборки ${latest.version}`)
    return false
  }
  await rm(updateDir, { recursive: true, force: true })
  await mkdir(updateDir, { recursive: true })
  const zip = join(updateDir, 'update.zip')
  let got = 0
  let lastPercent = -1
  await downloadFile(file.url, zip, {
    sha1: file.sha1,
    size: file.size,
    onBytes: (delta) => {
      got += delta
      const percent = Math.floor((got / file.size) * 100)
      if (percent !== lastPercent) onPercent((lastPercent = percent))
    },
  })
  const out = join(updateDir, 'app')
  // ditto сохраняет симлинки и права внутри .app, обычная распаковка их ломает.
  await run('/usr/bin/ditto', ['-x', '-k', zip, out])
  await rm(zip, { force: true })
  const fresh = join(out, 'Lumorrix.app')
  await access(join(fresh, 'Contents', 'MacOS', 'Lumorrix'))
  // Скачанное не браузером обычно и так без карантина, но снимаем на всякий случай.
  await run('/usr/bin/xattr', ['-dr', 'com.apple.quarantine', fresh]).catch(() => {})
  // Ad-hoc подпись нужна, чтобы на Apple Silicon приложение вообще запускалось после замены.
  await run('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', fresh]).catch((error) => log('Не удалось подписать обновление ad-hoc', error))
  prepared = { version: latest.version, app: fresh }
  return true
}

export const macUpdateReady = () => prepared !== null

/**
 * Синхронно (её вызывают и из will-quit, где асинхронное не успеет) запускает отдельный скрипт, который дождётся выхода лаунчера, заменит Lumorrix.app и (если relaunch) откроет его.
 * Сам лаунчер после этого нужно закрыть.
 */
export function applyMacUpdate(relaunch: boolean): boolean {
  const bundle = bundlePath()
  if (!prepared || !bundle) return false
  const script = join(updateDir, 'apply.sh')
  const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`
  writeFileSync(
    script,
    [
      '#!/bin/sh',
      `while kill -0 ${process.pid} 2>/dev/null; do sleep 0.3; done`,
      `OLD=${q(bundle)}`,
      `NEW=${q(prepared.app)}`,
      'BAK="$OLD.old"',
      'rm -rf "$BAK"',
      'if mv "$OLD" "$BAK" && mv "$NEW" "$OLD"; then rm -rf "$BAK"; else [ -d "$OLD" ] || mv "$BAK" "$OLD"; fi',
      relaunch ? 'open "$OLD"' : '',
      '',
    ].join('\n'),
    { mode: 0o755 },
  )
  spawn('/bin/sh', [script], { detached: true, stdio: 'ignore' }).unref()
  prepared = null
  return true
}

/** Обновление, скачанное, но не установленное кнопкой, ставится при выходе — как на Windows. */
export function installMacUpdateOnQuit(): void {
  let applied = false
  app.on('will-quit', () => {
    if (applied || !prepared) return
    applied = true
    applyMacUpdate(false)
  })
}
