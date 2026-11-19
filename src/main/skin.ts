import { createHash } from 'node:crypto'
import { join } from 'node:path'
import type { CurrentSkin, DefaultSkin, SkinItem, SkinModel, SkinResult } from '../shared/types'
import { devicePublicKey, deviceSign } from './devicekey'
import { MC_VERSION } from './game/install'
import { offlineUuid } from './game/version'
import { log } from './log'
import { readZipEntry } from './pack/modlist'
import { paths } from './paths'

/**
 * Лаунчер отправляет скин на наш сайт, сайт подписывает его и ставит на игровом сервере, так что его видят все игроки.
 * Скин можно поменять и в игре командой /skin: тогда действует тот, что поменяли последним.
 * Менять скин ника можно только с компьютера, который сервер уже одобрил для этого аккаунта: лаунчер подписывает
 * запрос тем же ключом компьютера, которым мод авторизации входит на сервер (см. devicekey.ts).
 */
const SKIN_SITE = process.env.LUMORRIX_SKIN_SITE ?? 'https://lumorrix.ru'
const MAX_BYTES = 64 * 1024
const NO_NETWORK = 'Нет связи с сайтом. Проверьте интернет и попробуйте ещё раз.'

/** Заголовки с подписью запроса ключом этого компьютера. Строку подписи сайт собирает так же (skin_api.py). */
async function signedHeaders(method: 'PUT' | 'DELETE', nickname: string, body?: Uint8Array): Promise<Record<string, string>> {
  const time = String(Math.floor(Date.now() / 1000))
  const digest = createHash('sha256').update(body ?? new Uint8Array()).digest('hex')
  const message = `lumorrix-skin-v1|${method.toLowerCase()}|${nickname.toLowerCase()}|${time}|${digest}`
  return {
    'X-Lumorrix-Nick': nickname,
    'X-Lumorrix-Device': await devicePublicKey(),
    'X-Lumorrix-Time': time,
    'X-Lumorrix-Signature': await deviceSign(message),
  }
}

async function request(method: 'PUT' | 'DELETE', nickname: string, body?: Uint8Array, model?: SkinModel): Promise<SkinResult> {
  let headers: Record<string, string>
  try {
    headers = await signedHeaders(method, nickname, body)
  } catch (error) {
    log('Не удалось получить ключ компьютера', error)
    return { ok: false, error: 'Не удалось определить компьютер. Попробуйте ещё раз.' }
  }
  try {
    const response = await fetch(`${SKIN_SITE}/api/skin`, {
      method,
      // Модель рук сайт передаёт MineSkin, иначе тонкие руки в игре станут обычными.
      headers: { ...headers, 'Content-Type': 'image/png', ...(model ? { 'X-Lumorrix-Variant': model === 'slim' ? 'slim' : 'classic' } : {}) },
      body: body ? Buffer.from(body) : undefined,
      signal: AbortSignal.timeout(20_000),
    })
    if (response.ok) return { ok: true }
    const data = (await response.json().catch(() => ({}))) as { error?: string }
    return { ok: false, error: data.error ?? `Сайт ответил ошибкой ${response.status}. Попробуйте позже.` }
  } catch (error) {
    log('Скин не отправился', error)
    return { ok: false, error: NO_NETWORK }
  }
}

export function uploadSkin(nickname: string, png: Uint8Array, model?: SkinModel): Promise<SkinResult> {
  if (png.byteLength > MAX_BYTES) return Promise.resolve({ ok: false, error: 'Файл скина слишком большой (больше 64 КБ).' })
  return request('PUT', nickname, png, model)
}

export const resetSkin = (nickname: string) => request('DELETE', nickname)

async function fetchPng(url: string): Promise<Response> {
  return fetch(url, { headers: { 'Cache-Control': 'no-cache' }, signal: AbortSignal.timeout(10_000) })
}

const dataUrl = (png: Uint8Array) => `data:image/png;base64,${Buffer.from(png).toString('base64')}`

/**
 * Скин, который сейчас стоит у игрока в игре, как data URL, чтобы окно могло его нарисовать: загруженный из лаунчера
 * или поставленный командой /skin на сервере. null — своего скина нет или нет связи.
 */
export async function currentSkin(nickname: string): Promise<(CurrentSkin & { png: Uint8Array }) | null> {
  const nick = encodeURIComponent(nickname)
  try {
    const response = await fetchPng(`${SKIN_SITE}/api/skin/current?nick=${nick}&t=${Date.now()}`)
    if (response.ok) {
      const png = new Uint8Array(await response.arrayBuffer())
      return { src: dataUrl(png), png, fromServer: response.headers.get('X-Lumorrix-Skin-Source') === 'server' }
    }
    if (response.status === 404) return null
  } catch {
    // ниже попробуем просто файл с сайта
  }
  // Сайт не смог спросить игровой сервер: показываем скин, загруженный из лаунчера.
  try {
    const response = await fetchPng(`${SKIN_SITE}/skins/${nick}.png?t=${Date.now()}`)
    if (!response.ok) return null
    const png = new Uint8Array(await response.arrayBuffer())
    return { src: dataUrl(png), png, fromServer: false }
  } catch {
    return null
  }
}

/** Стандартные скины в порядке игры (DefaultPlayerSkin): сначала девять с тонкими руками, потом девять обычных. */
const DEFAULT_SKINS: [file: string, name: string][] = [
  ['alex', 'Алекс'],
  ['ari', 'Ари'],
  ['efe', 'Эфе'],
  ['kai', 'Кай'],
  ['makena', 'Макена'],
  ['noor', 'Нур'],
  ['steve', 'Стив'],
  ['sunny', 'Санни'],
  ['zuri', 'Зури'],
]

/** Номер стандартного скина: как в игре, floorMod(UUID.hashCode(), 18). UUID на сервере без лицензии считается из ника. */
export function defaultSkinIndex(nickname: string): number {
  const hex = offlineUuid(nickname).replaceAll('-', '')
  const hilo = BigInt.asIntN(64, BigInt(`0x${hex.slice(0, 16)}`)) ^ BigInt.asIntN(64, BigInt(`0x${hex.slice(16)}`))
  const hash = Number(BigInt.asIntN(32, hilo >> 32n)) ^ Number(BigInt.asIntN(32, hilo))
  return ((hash % 18) + 18) % 18
}

const GAME_JAR = () => join(paths.minecraft, 'versions', MC_VERSION, `${MC_VERSION}.jar`)
const standardPng = (file: string, model: SkinModel) =>
  readZipEntry(GAME_JAR(), `assets/minecraft/textures/entity/player/${model}/${file}.png`).catch(() => null)

/** Стандартный скин игрока из файлов игры. null — игра ещё не установлена. */
export async function defaultSkin(nickname: string): Promise<DefaultSkin | null> {
  const index = defaultSkinIndex(nickname)
  const [file, name] = DEFAULT_SKINS[index % 9]
  const png = await standardPng(file, index < 9 ? 'slim' : 'wide')
  return png ? { src: dataUrl(png), name } : null
}

/** Все 18 стандартных скинов Minecraft: каждый с тонкими и с обычными руками. Пусто, пока игра не установлена. */
export async function standardSkins(): Promise<SkinItem[]> {
  const items: SkinItem[] = []
  for (const model of ['wide', 'slim'] as const) {
    for (const [file, name] of DEFAULT_SKINS) {
      const png = await standardPng(file, model)
      if (png) items.push({ id: `std-${model}-${file}`, src: dataUrl(png), name, model })
    }
  }
  return items
}

/** Скин лицензии Minecraft с таким же ником. В игре он показывается, если на нашем сайте своего скина нет. */
export async function licensedSkin(nickname: string): Promise<DefaultSkin | null> {
  const found = await skinByNick(nickname).catch(() => null)
  return found ? { src: found.src, name: 'лицензия Minecraft' } : null
}

const NICK = /^[A-Za-z0-9_]{1,16}$/

/** Mojang не ответил (часто — слишком много запросов подряд), а не «ника нет». */
export class MojangBusy extends Error {}

/**
 * UUID лицензионного аккаунта по нику; null — такого ника нет. У Mojang два адреса с отдельными лимитами запросов:
 * если первый отвечает «слишком часто» (429), спрашиваем второй.
 */
async function profileId(nickname: string, signal: AbortSignal): Promise<string | null> {
  const nick = encodeURIComponent(nickname)
  let busy = false
  for (const url of [`https://api.mojang.com/users/profiles/minecraft/${nick}`, `https://api.minecraftservices.com/minecraft/profile/lookup/name/${nick}`]) {
    try {
      const response = await fetch(url, { signal })
      if (response.status === 200) return ((await response.json()) as { id?: string }).id ?? null
      if (response.status === 404 || response.status === 204) return null
      busy = true
    } catch {
      busy = true
    }
  }
  if (busy) throw new MojangBusy()
  return null
}

/** Скин лицензионного аккаунта Minecraft с этим ником. null — такого аккаунта нет. MojangBusy — Mojang не ответил. */
export async function skinByNick(nickname: string): Promise<SkinItem | null> {
  if (!NICK.test(nickname)) return null
  const signal = AbortSignal.timeout(10_000)
  const id = await profileId(nickname, signal)
  if (!id) return null
  try {
    const session = await fetch(`https://sessionserver.mojang.com/session/minecraft/profile/${id}`, { signal })
    if (!session.ok) throw new MojangBusy()
    const data = (await session.json()) as { name?: string; properties?: { name: string; value: string }[] }
    const packed = data.properties?.find((property) => property.name === 'textures')?.value
    if (!packed) return null
    const textures = JSON.parse(Buffer.from(packed, 'base64').toString('utf8')) as {
      textures?: { SKIN?: { url?: string; metadata?: { model?: string } } }
    }
    const url = textures.textures?.SKIN?.url
    if (!url || !/^https?:\/\/textures\.minecraft\.net\//.test(url)) return null
    const png = await fetch(url.replace(/^http:/, 'https:'), { signal })
    if (!png.ok) throw new MojangBusy()
    const model: SkinModel = textures.textures?.SKIN?.metadata?.model === 'slim' ? 'slim' : 'wide'
    return { id: `nick-${id}`, src: dataUrl(new Uint8Array(await png.arrayBuffer())), name: data.name ?? nickname, model }
  } catch (error) {
    if (error instanceof SyntaxError) return null
    throw new MojangBusy()
  }
}
