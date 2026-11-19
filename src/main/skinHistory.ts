import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { nativeImage } from 'electron'
import type { SkinItem, SkinModel } from '../shared/types'
import { log } from './log'
import { paths } from './paths'

/**
 * Скины, которые игрок уже ставил: PNG лежат в data/skins, список — в data/skins/history.json.
 * Один и тот же скин не повторяется: сравниваем пиксели, а не байты файла, потому что сервер возвращает скин,
 * пережатый Mojang, и байты у него уже другие.
 */
const DIR = join(paths.data, 'skins')
const LIST = join(DIR, 'history.json')
const LIMIT = 40

interface Entry {
  id: string
  name: string
  model?: SkinModel
  addedAt: number
}

/** Отпечаток пикселей скина; null — это не картинка. */
function pixelId(png: Uint8Array): string | null {
  const image = nativeImage.createFromBuffer(Buffer.from(png))
  if (image.isEmpty()) return null
  const { width, height } = image.getSize()
  const bitmap = Buffer.from(image.toBitmap())
  // У прозрачных пикселей цвет бывает любой, а видно их одинаково.
  for (let i = 0; i < bitmap.length; i += 4) if (bitmap[i + 3] === 0) bitmap.fill(0, i, i + 4)
  return createHash('sha1').update(`${width}x${height}`).update(bitmap).digest('hex').slice(0, 20)
}

async function load(): Promise<Entry[]> {
  try {
    const list = JSON.parse(await readFile(LIST, 'utf8')) as Entry[]
    return Array.isArray(list) ? list.filter((entry) => /^[0-9a-f]{20}$/.test(entry.id)) : []
  } catch {
    return []
  }
}

async function save(list: Entry[]): Promise<void> {
  await mkdir(DIR, { recursive: true })
  const tmp = `${LIST}.tmp`
  await writeFile(tmp, JSON.stringify(list, null, 1))
  await rename(tmp, LIST)
}

let queue: Promise<unknown> = Promise.resolve()
/** Запись списка по очереди, чтобы два сохранения подряд не затёрли друг друга. */
function serial<T>(work: () => Promise<T>): Promise<T> {
  const next = queue.then(work, work)
  queue = next.catch(() => undefined)
  return next
}

export async function skinHistory(): Promise<SkinItem[]> {
  const items: SkinItem[] = []
  for (const entry of await load()) {
    const png = await readFile(join(DIR, `${entry.id}.png`)).catch(() => null)
    if (png) items.push({ ...entry, src: `data:image/png;base64,${png.toString('base64')}` })
  }
  return items
}

/**
 * Добавляет скин в начало истории. Если такой уже есть, поднимает его наверх.
 * keepName — не менять подпись у уже сохранённого (например, «Стив» не превратится в «Скин из игры»).
 */
export function rememberSkin(png: Uint8Array, name: string, model?: SkinModel, keepName = false): Promise<void> {
  return serial(async () => {
    const id = pixelId(png)
    if (!id) return
    const list = await load()
    const old = list.find((entry) => entry.id === id)
    const rest = list.filter((entry) => entry.id !== id)
    const entry: Entry = {
      id,
      name: keepName && old ? old.name : name,
      model: model ?? old?.model,
      addedAt: keepName && old ? old.addedAt : Date.now(),
    }
    // Скин из игры, который уже есть в истории, не перемещаем: его просто увидели ещё раз, а не поставили.
    const next = keepName && old ? list.map((item) => (item.id === id ? entry : item)) : [entry, ...rest]
    await mkdir(DIR, { recursive: true })
    if (!old) await writeFile(join(DIR, `${id}.png`), png)
    for (const dropped of next.slice(LIMIT)) await rm(join(DIR, `${dropped.id}.png`), { force: true })
    await save(next.slice(0, LIMIT))
  }).catch((error) => log('Не удалось сохранить скин в историю', error))
}

export function forgetSkin(id: string): Promise<void> {
  if (!/^[0-9a-f]{20}$/.test(id)) return Promise.resolve()
  return serial(async () => {
    await save((await load()).filter((entry) => entry.id !== id))
    await rm(join(DIR, `${id}.png`), { force: true })
  })
}
