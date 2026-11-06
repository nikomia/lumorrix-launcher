import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zipOf } from './zip'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { listMods, refreshManifest, setModsEnabled } from '../src/main/pack/modlist'
import { syncPack } from '../src/main/pack/sync'


const modJar = (id: string, name: string, requires: string[] = []) =>
  zipOf({
    'META-INF/neoforge.mods.toml':
      `[[mods]]\nmodId = "${id}"\ndisplayName = "${name}"\ndescription = "Описание ${name}"\n` +
      requires.map((dep) => `[[dependencies.${id}]]\nmodId = "${dep}"\ntype = "required"\n`).join(''),
  })

const sha1 = (data: Buffer) => createHash('sha1').update(data).digest('hex')

const files = [
  { path: 'mods/sodium.jar', data: modJar('sodium', 'Sodium'), mode: 'client', id: 'sodium' },
  { path: 'mods/extra.jar', data: modJar('sodium_extra', 'Sodium Extra', ['sodium']), mode: 'client', id: 'sodium_extra' },
  { path: 'mods/server.jar', data: modJar('server_mod', 'Серверный мод'), mode: 'sync', id: '' },
]

let server: Server
let base = ''
let work = ''
let requests: string[] = []

beforeAll(async () => {
  const manifest = [
    'format=1',
    'version=v1',
    'files=files/',
    ...files.map((file) => `F\t${sha1(file.data)}\t${file.data.length}\t${file.mode}\t${file.path}`),
    ...files.filter((file) => file.id).map((file) => `C\t${file.path}\t${file.id}`),
  ].join('\n')
  server = createServer((request, response) => {
    const path = new URL(request.url ?? '/', 'http://x').pathname
    if (path === '/manifest.txt') return void response.end(manifest)
    requests.push(path)
    const file = files.find((item) => `/files/${sha1(item.data)}` === path)
    if (!file) return void response.writeHead(404).end()
    response.end(file.data)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/manifest.txt`
})

afterAll(() => {
  server.close()
})

beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), 'lumorrix-preview-'))
  mkdirSync(join(work, 'game', 'mods'), { recursive: true })
  requests = []
})

afterEach(() => {
  rmSync(work, { recursive: true, force: true })
})

const paths = () => ({
  game: join(work, 'game'),
  manifest: join(work, 'manifest.txt'),
  meta: join(work, 'meta.json'),
  blobs: join(work, 'tmp'),
})

const preview = async (disabled = new Set<string>()) => {
  const p = paths()
  await refreshManifest(base, p.manifest)
  return listMods(p.game, base, p.manifest, p.meta, { blobDir: p.blobs, disabled })
}

describe('моды до установки', () => {
  it('показывает названия клиентских модов и не качает серверные', async () => {
    const mods = await preview()
    expect(mods.map((mod) => mod.name)).toEqual(['Sodium', 'Sodium Extra'])
    expect(mods[0].description).toBe('Описание Sodium')
    expect(mods[1].requires).toEqual(['sodium'])
    expect(mods.every((mod) => mod.enabled)).toBe(true)
    const serverBlob = `/files/${sha1(files[2].data)}`
    expect(requests).not.toContain(serverBlob)
    expect(existsSync(join(paths().game, 'mods', 'sodium.jar'))).toBe(false)
  })

  it('второй раз не качает, потому что описания уже сохранены', async () => {
    await preview()
    requests = []
    await preview()
    expect(requests).toEqual([])
  })

  it('установка берёт уже скачанное и учитывает выбор, сделанный до неё', async () => {
    const p = paths()
    const disabled = new Set<string>()
    await preview(disabled)
    await setModsEnabled(p.game, base, p.manifest, disabled, ['extra.jar'], false)
    expect(disabled.has('sodium_extra')).toBe(true)
    expect((await preview(disabled)).find((mod) => mod.file === 'extra.jar')?.enabled).toBe(false)

    requests = []
    await syncPack({ gameDir: p.game, tmpDir: p.blobs, manifestUrl: base, manifestCache: p.manifest, disabled })
    // Повторно скачан только серверный мод.
    expect(requests).toEqual([`/files/${sha1(files[2].data)}`])
    expect(existsSync(join(p.game, 'mods', 'sodium.jar'))).toBe(true)
    expect(existsSync(join(p.game, 'mods', 'extra.jar.disabled'))).toBe(true)
    expect(existsSync(join(p.game, 'mods', 'extra.jar'))).toBe(false)

    const after = await listMods(p.game, base, p.manifest, p.meta)
    expect(after.map((mod) => [mod.name, mod.enabled])).toEqual([
      ['Sodium', true],
      ['Sodium Extra', false],
    ])
  })

  it('знает зависимости, которых нет в описании модов', async () => {
    const p = paths()
    writeFileSync(join(p.game, 'mods', 'gpu.jar'), modJar('gpu_booster', 'GPU Booster'))
    writeFileSync(join(p.game, 'mods', 'iris.jar'), modJar('iris', 'Iris'))
    writeFileSync(join(p.game, 'mods', 'patcher.jar'), modJar('derenderpatcher', 'Patcher'))
    const mods = await preview()
    expect(mods.find((mod) => mod.file === 'gpu.jar')?.requires).toEqual(['toadlib'])
    expect(mods.find((mod) => mod.file === 'iris.jar')?.requires).toEqual(['sodium'])
    expect(mods.find((mod) => mod.file === 'patcher.jar')?.requires).toEqual(['sodium'])
  })

  it('свой мод игрока показывается рядом с модами сборки', async () => {
    const p = paths()
    writeFileSync(join(p.game, 'mods', 'mine.jar'), modJar('mine', 'Мой мод'))
    const mods = await preview()
    expect(mods.find((mod) => mod.file === 'mine.jar')?.kind).toBe('user')
    expect(mods.length).toBe(3)
  })
})
