import { execFile } from 'node:child_process'
import { createHash, createPrivateKey, createPublicKey, sign, type KeyObject } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { promisify } from 'node:util'

/**
 * Ключ этого компьютера — тот же, которым мод авторизации входит на сервер (ru.lumorrix.auth.DeviceKey).
 * Он получается из hwid: закрытый ключ Ed25519 = SHA-256("lumorrix-device-v1|" + hwid). Сервер хранит публичные ключи
 * одобренных устройств аккаунта, поэтому сайт может проверить, что запрос пришёл с одобренного компьютера.
 * Сбор hwid повторяет мод один в один: если он разойдётся, сервер не узнает компьютер.
 */
const run = promisify(execFile)
const SALT = 'lumorrix-device-v1|'
const PKCS8_ED25519 = Buffer.from('302e020100300506032b657004220420', 'hex')
const JUNK = ['TO BE FILLED', 'DEFAULT STRING', 'NONE', 'NOT APPLICABLE', 'SYSTEM SERIAL']

function addIfReal(list: string[], raw: string | undefined): void {
  const value = (raw ?? '').trim()
  const upper = value.toUpperCase()
  if (value.length < 4 || JUNK.some((junk) => upper.includes(junk)) || /^[0F-]+$/.test(upper)) return
  list.push(value)
}

async function output(file: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await run(file, args, { timeout: 15_000, windowsHide: true, encoding: 'utf8' })
    return stdout
  } catch (error) {
    const stdout = (error as { stdout?: string }).stdout
    if (typeof stdout === 'string') return stdout
    throw error
  }
}

export async function hwid(): Promise<string> {
  const parts: string[] = []
  if (process.platform === 'win32') {
    const text = await output('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      '$p=Get-CimInstance Win32_ComputerSystemProduct; $b=Get-CimInstance Win32_BaseBoard; Write-Output $p.UUID; Write-Output $b.SerialNumber; Write-Output $b.Product',
    ])
    for (const line of text.split(/\r?\n/)) addIfReal(parts, line)
    if (parts.length === 0) {
      const reg = await output('reg.exe', ['query', 'HKLM\\SOFTWARE\\Microsoft\\Cryptography', '/v', 'MachineGuid'])
      for (const line of reg.split(/\r?\n/)) {
        if (line.includes('MachineGuid')) addIfReal(parts, line.substring(line.lastIndexOf(' ') + 1))
      }
    }
  } else if (process.platform === 'darwin') {
    const text = await output('ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice'])
    for (const line of text.split('\n')) {
      if (line.includes('IOPlatformUUID') || line.includes('IOPlatformSerialNumber')) {
        addIfReal(parts, line.substring(line.indexOf('=') + 1).replaceAll('"', ''))
      }
    }
  } else {
    for (const file of ['/etc/machine-id', '/var/lib/dbus/machine-id', '/sys/class/dmi/id/product_uuid']) {
      try {
        addIfReal(parts, await readFile(file, 'utf8'))
      } catch {
        // нет файла или нет прав — мод тоже его пропускает
      }
    }
  }
  if (parts.length === 0) throw new Error('Не удалось определить компьютер')
  return parts.join('|')
}

let keyPromise: Promise<KeyObject> | null = null

function privateKey(): Promise<KeyObject> {
  keyPromise ??= hwid().then((id) => {
    const seed = createHash('sha256').update(SALT + id, 'utf8').digest()
    return createPrivateKey({ key: Buffer.concat([PKCS8_ED25519, seed]), format: 'der', type: 'pkcs8' })
  })
  keyPromise.catch(() => {
    keyPromise = null
  })
  return keyPromise
}

/** Публичный ключ этого компьютера (base64 X.509), как его хранит сервер. */
export async function devicePublicKey(): Promise<string> {
  return createPublicKey(await privateKey()).export({ format: 'der', type: 'spki' }).toString('base64')
}

/** Подпись Ed25519 ключом этого компьютера, base64. */
export async function deviceSign(message: string): Promise<string> {
  return sign(null, Buffer.from(message, 'utf8'), await privateKey()).toString('base64')
}
