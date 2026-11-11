import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { Cancelled, UserError } from '../src/main/errors'
import { cancelActive, ensureFreeSpace, finishCancelable, startCancelable } from '../src/main/net'
import { safeTarget, syncPack } from '../src/main/pack/sync'

const sha1 = (data: string) => createHash('sha1').update(data).digest('hex')

/** Файлы сборки на тестовом сервере: путь → содержимое и режим. */
interface PackFile {
  path: string
  data: string
  mode: string
  modId?: string
}

let pack: PackFile[] = []
let version = 'v1'
let corrupt = false
let online = true
let blobRequests = 0
let server: Server
let base = ''
let game = ''
let work = ''

function manifestText(): string {
  const lines = ['format=1', `version=${version}`, 'files=files/', 'sync-dir=mods']
  for (const file of pack) lines.push(`F\t${sha1(file.data)}\t${file.data.length}\t${file.mode}\t${file.path}`)
  for (const file of pack) if (file.modId) lines.push(`C\t${file.path}\t${file.modId}`)
  return `${lines.join('\n')}\n`
}

beforeAll(async () => {
  server = createServer((request, response) => {
    if (!online) return void response.writeHead(503).end()
    const url = new URL(request.url ?? '/', 'http://x')
    if (url.pathname === '/manifest.txt') return void response.end(manifestText())
    const file = pack.find((item) => `/files/${sha1(item.data)}` === url.pathname)
    if (!file) return void response.writeHead(404).end()
    blobRequests++
    response.end(corrupt ? `${file.data.slice(1)}x` : file.data)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterAll(() => {
  server.close()
})

beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), 'lumorrix-sync-'))
  game = join(work, 'game')
  mkdirSync(join(game, 'mods'), { recursive: true })
  pack = []
  version = 'v1'
  corrupt = false
  online = true
  blobRequests = 0
})

afterEach(() => {
  rmSync(work, { recursive: true, force: true })
})

const run = (disabled = new Set<string>(), rehash = false) =>
  syncPack({
    gameDir: game,
    tmpDir: join(work, 'tmp'),
    manifestUrl: `${base}/manifest.txt`,
    manifestCache: join(work, 'manifest.txt'),
    disabled,
    rehash,
  })

const inGame = (rel: string) => join(game, rel)
const read = (rel: string) => readFileSync(inGame(rel), 'utf8')
const version_txt = 'config/lumorrix/updater/version.txt'

describe('синхронизация сборки', () => {
  it('ставит сборку и пишет версию', async () => {
    pack = [
      { path: 'mods/server.jar', data: 'server', mode: 'sync' },
      { path: 'config/a.toml', data: 'cfg', mode: 'config' },
    ]
    const result = await run()
    expect(result.downloaded).toBe(2)
    expect(read('mods/server.jar')).toBe('server')
    expect(read(version_txt).trim()).toBe('v1')
    expect(existsSync(join(work, 'tmp'))).toBe(false)
  })

  it('повторный запуск ничего не качает', async () => {
    pack = [{ path: 'mods/server.jar', data: 'server', mode: 'sync' }]
    await run()
    blobRequests = 0
    const result = await run()
    expect(result.downloaded).toBe(0)
    expect(blobRequests).toBe(0)
  })

  it('не трогает свои моды игрока и удаляет старые файлы сборки', async () => {
    pack = [{ path: 'mods/old.jar', data: 'old', mode: 'sync' }]
    await run()
    writeFileSync(inGame('mods/personal.jar'), 'mine')
    writeFileSync(inGame('mods/personal2.jar.disabled'), 'mine2')
    pack = [{ path: 'mods/new.jar', data: 'new', mode: 'sync' }]
    version = 'v2'
    const result = await run()
    expect(result.removed).toBe(1)
    expect(existsSync(inGame('mods/old.jar'))).toBe(false)
    expect(read('mods/new.jar')).toBe('new')
    expect(read('mods/personal.jar')).toBe('mine')
    expect(read('mods/personal2.jar.disabled')).toBe('mine2')
  })

  it('не перезаписывает конфиг, который игрок изменил', async () => {
    pack = [
      { path: 'config/mine.toml', data: 'v1', mode: 'config' },
      { path: 'config/other.toml', data: 'v1-other', mode: 'config' },
    ]
    await run()
    writeFileSync(inGame('config/mine.toml'), 'мои настройки')
    pack = [
      { path: 'config/mine.toml', data: 'v2', mode: 'config' },
      { path: 'config/other.toml', data: 'v2-other', mode: 'config' },
    ]
    await run()
    expect(read('config/mine.toml')).toBe('мои настройки')
    expect(read('config/other.toml')).toBe('v2-other')
  })

  it('режим once кладёт файл один раз, даже если игрок его удалил', async () => {
    pack = [{ path: 'servers.dat', data: 'servers', mode: 'once' }]
    await run()
    rmSync(inGame('servers.dat'))
    await run()
    expect(existsSync(inGame('servers.dat'))).toBe(false)
  })

  it('выключенный мод остаётся выключенным, в том числе в новой версии', async () => {
    pack = [{ path: 'mods/sodium-1.jar', data: 'one', mode: 'client', modId: 'sodium' }]
    const disabled = new Set(['sodium'])
    await run(disabled)
    expect(read('mods/sodium-1.jar.disabled')).toBe('one')
    expect(existsSync(inGame('mods/sodium-1.jar'))).toBe(false)

    pack = [{ path: 'mods/sodium-2.jar', data: 'two', mode: 'client', modId: 'sodium' }]
    await run(disabled)
    expect(read('mods/sodium-2.jar.disabled')).toBe('two')
    expect(existsSync(inGame('mods/sodium-1.jar.disabled'))).toBe(false)
    expect(existsSync(inGame('mods/sodium-2.jar'))).toBe(false)
  })

  it('учитывает мод, переименованный игроком вручную', async () => {
    pack = [{ path: 'mods/map.jar', data: 'map', mode: 'client', modId: 'map' }]
    await run()
    const disabled = new Set<string>()
    writeFileSync(inGame('mods/map.jar.disabled'), 'map')
    rmSync(inGame('mods/map.jar'))
    blobRequests = 0
    await run(disabled)
    expect(disabled.has('map')).toBe(true)
    expect(blobRequests).toBe(0)
    expect(existsSync(inGame('mods/map.jar'))).toBe(false)
  })

  it('при битом хеше ничего не применяет и не меняет версию', async () => {
    pack = [{ path: 'mods/a.jar', data: 'first', mode: 'sync' }]
    await run()
    pack = [{ path: 'mods/a.jar', data: 'second', mode: 'sync' }]
    version = 'v2'
    corrupt = true
    await expect(run()).rejects.toBeInstanceOf(UserError)
    expect(read('mods/a.jar')).toBe('first')
    expect(read(version_txt).trim()).toBe('v1')
  }, 30_000)

  it('без сервера сообщает об этом и разрешает играть со старой версией', async () => {
    pack = [{ path: 'mods/a.jar', data: 'first', mode: 'sync' }]
    await run()
    online = false
    const error = await run().catch((e) => e)
    expect(error).toBeInstanceOf(UserError)
    expect(error.options.canPlayOld).toBe(true)
    expect(read('mods/a.jar')).toBe('first')
  }, 30_000)

  it('продолжает после обрыва: проверенный файл не качается заново', async () => {
    pack = [{ path: 'mods/a.jar', data: 'ready', mode: 'sync' }]
    mkdirSync(join(work, 'tmp'), { recursive: true })
    writeFileSync(join(work, 'tmp', sha1('ready')), 'ready')
    await run()
    expect(blobRequests).toBe(0)
    expect(read('mods/a.jar')).toBe('ready')
  })

  it('отмена останавливает загрузку, не меняя установленное', async () => {
    pack = [{ path: 'mods/a.jar', data: 'first', mode: 'sync' }]
    await run()
    pack = [{ path: 'mods/a.jar', data: 'second', mode: 'sync' }]
    version = 'v2'
    blobRequests = 0
    startCancelable()
    try {
      const error = await syncPack({
        gameDir: game,
        tmpDir: join(work, 'tmp'),
        manifestUrl: `${base}/manifest.txt`,
        manifestCache: join(work, 'manifest.txt'),
        disabled: new Set(),
        onProgress: (progress) => {
          if (progress.phase === 'downloading') cancelActive()
        },
      }).catch((e) => e)
      expect(error).toBeInstanceOf(Cancelled)
    } finally {
      finishCancelable()
    }
    expect(blobRequests).toBe(0)
    expect(read('mods/a.jar')).toBe('first')
    expect(read(version_txt).trim()).toBe('v1')
    // После отмены обычная установка снова работает.
    await run()
    expect(read('mods/a.jar')).toBe('second')
  })

  describe('раздача клиента', () => {
    const client = () =>
      syncPack({
        gameDir: game,
        tmpDir: join(work, 'tmp'),
        manifestUrl: `${base}/manifest.txt`,
        manifestCache: join(work, 'client', 'manifest.txt'),
        stateDir: join(work, 'client'),
        disabled: new Set(),
      })

    it('хранит состояние отдельно от сборки', async () => {
      pack = [{ path: 'minecraft/libraries/a.jar', data: 'lib', mode: 'sync' }]
      await client()
      expect(read('minecraft/libraries/a.jar')).toBe('lib')
      expect(readFileSync(join(work, 'client', 'version.txt'), 'utf8').trim()).toBe('v1')
      expect(existsSync(inGame(version_txt))).toBe(false)
      expect(existsSync(inGame('options.txt'))).toBe(false)
    })

    it('заменяет файл того же размера, если он изменился на сервере', async () => {
      pack = [{ path: 'minecraft/assets/a', data: 'aaa', mode: 'sync' }]
      await client()
      pack = [{ path: 'minecraft/assets/a', data: 'bbb', mode: 'sync' }]
      version = 'v2'
      await client()
      expect(read('minecraft/assets/a')).toBe('bbb')
    })

    it('удаляет библиотеку, которую убрали с сервера', async () => {
      pack = [{ path: 'minecraft/libraries/old.jar', data: 'old', mode: 'sync' }]
      await client()
      pack = [{ path: 'minecraft/libraries/new.jar', data: 'new', mode: 'sync' }]
      version = 'v2'
      await client()
      expect(existsSync(inGame('minecraft/libraries/old.jar'))).toBe(false)
    })
  })

  it('при нехватке места говорит, сколько нужно', async () => {
    const error = await ensureFreeSpace(work, Number.MAX_SAFE_INTEGER).catch((e) => e)
    expect(error).toBeInstanceOf(UserError)
    expect(error.title).toBe('Не хватает места на диске')
  })

  it('не выходит за пределы папки игры', () => {
    expect(safeTarget(game, '../evil.jar')).toBeNull()
    expect(safeTarget(game, 'C:/evil.jar')).toBeNull()
    expect(safeTarget(game, '/evil.jar')).toBeNull()
    expect(safeTarget(game, 'config/lumorrix/updater/state.tsv')).toBeNull()
    expect(safeTarget(game, 'mods/ok.jar')).toBe(inGame('mods/ok.jar'))
  })
})
