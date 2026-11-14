import { createHash } from 'node:crypto'
import { join } from 'node:path'
import type { CurrentSkin, DefaultSkin, SkinResult } from '../shared/types'
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

async function request(method: 'PUT' | 'DELETE', nickname: string, body?: Uint8Array): Promise<SkinResult> {
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
      headers: { ...headers, 'Content-Type': 'image/png' },
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

export function uploadSkin(nickname: string, png: Uint8Array): Promise<SkinResult> {
  if (png.byteLength > MAX_BYTES) return Promise.resolve({ ok: false, error: 'Файл скина слишком большой (больше 64 КБ).' })
  return request('PUT', nickname, png)
}

export const resetSkin = (nickname: string) => request('DELETE', nickname)

async function fetchPng(url: string): Promise<Response> {
  return fetch(url, { headers: { 'Cache-Control': 'no-cache' }, signal: AbortSignal.timeout(10_000) })
}

const asDataUrl = async (response: Response) =>
  `data:image/png;base64,${Buffer.from(await response.arrayBuffer()).toString('base64')}`

/**
 * Скин, который сейчас стоит у игрока в игре, как data URL, чтобы окно могло его нарисовать: загруженный из лаунчера
 * или поставленный командой /skin на сервере. null — своего скина нет или нет связи.
 */
export async function currentSkin(nickname: string): Promise<CurrentSkin | null> {
  const nick = encodeURIComponent(nickname)
  try {
    const response = await fetchPng(`${SKIN_SITE}/api/skin/current?nick=${nick}&t=${Date.now()}`)
    if (response.ok) {
      return { src: await asDataUrl(response), fromServer: response.headers.get('X-Lumorrix-Skin-Source') === 'server' }
    }
    if (response.status === 404) return null
  } catch {
    // ниже попробуем просто файл с сайта
  }
  // Сайт не смог спросить игровой сервер: показываем скин, загруженный из лаунчера.
  try {
    const response = await fetchPng(`${SKIN_SITE}/skins/${nick}.png?t=${Date.now()}`)
    return response.ok ? { src: await asDataUrl(response), fromServer: false } : null
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

/** Стандартный скин игрока из файлов игры. null — игра ещё не установлена. */
export async function defaultSkin(nickname: string): Promise<DefaultSkin | null> {
  const index = defaultSkinIndex(nickname)
  const [file, name] = DEFAULT_SKINS[index % 9]
  const model = index < 9 ? 'slim' : 'wide'
  const jar = join(paths.minecraft, 'versions', MC_VERSION, `${MC_VERSION}.jar`)
  const png = await readZipEntry(jar, `assets/minecraft/textures/entity/player/${model}/${file}.png`).catch(() => null)
  return png ? { src: `data:image/png;base64,${png.toString('base64')}`, name } : null
}

/** Скин лицензии Minecraft с таким же ником. В игре он показывается, если на нашем сайте своего скина нет. */
export async function licensedSkin(nickname: string): Promise<DefaultSkin | null> {
  try {
    const signal = AbortSignal.timeout(8_000)
    const profile = await fetch(`https://api.mojang.com/users/profiles/minecraft/${encodeURIComponent(nickname)}`, { signal })
    if (profile.status !== 200) return null
    const { id } = (await profile.json()) as { id?: string }
    if (!id) return null
    const session = await fetch(`https://sessionserver.mojang.com/session/minecraft/profile/${id}`, { signal })
    if (!session.ok) return null
    const data = (await session.json()) as { properties?: { name: string; value: string }[] }
    const packed = data.properties?.find((property) => property.name === 'textures')?.value
    if (!packed) return null
    const textures = JSON.parse(Buffer.from(packed, 'base64').toString('utf8')) as { textures?: { SKIN?: { url?: string } } }
    const url = textures.textures?.SKIN?.url
    if (!url || !/^https?:\/\/textures\.minecraft\.net\//.test(url)) return null
    const png = await fetch(url.replace(/^http:/, 'https:'), { signal })
    if (!png.ok) return null
    return { src: `data:image/png;base64,${Buffer.from(await png.arrayBuffer()).toString('base64')}`, name: 'лицензия Minecraft' }
  } catch {
    return null
  }
}
