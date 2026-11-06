import { createHash } from 'node:crypto'
import { closeSync, fstatSync, openSync, readSync } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { CrashCulprit, CrashReport } from '../../shared/types'
import { readJarMeta, zipHasEntry } from '../pack/modlist'

/** Причину падения ищем так же, как старый лаунчер Slarof, но без действий с каталогом модов. */
const LOG_TAIL_BYTES = 3 * 1024 * 1024
const LOG_TAIL_LINES = 60
const MAX_CLASS_LOOKUPS = 8
const PLATFORM_PREFIXES = ['java.', 'javax.', 'jdk.', 'sun.', 'com.sun.', 'net.minecraft.', 'com.mojang.', 'net.neoforged.', 'net.minecraftforge.', 'cpw.mods.', 'org.spongepowered.', 'org.lwjgl.', 'io.netty.', 'com.google.', 'org.apache.', 'it.unimi.', 'org.slf4j.', 'com.llamalad7.', 'ru.lumorrix.']
const PLATFORM_MOD_IDS = new Set(['minecraft', 'java', 'neoforge', 'forge', 'mixinextras'])

interface Jar {
  file: string
  name: string
  ids: string[]
}

interface ModIndex {
  byId: Map<string, Jar>
  jars: Jar[]
}

interface Frame {
  className: string
  method: string
}

interface ParsedException {
  type: string
  message: string
  frames: Frame[]
}

interface Found {
  file: string
  name: string
  reason: string
}

async function newestSince(dir: string, since: number, accept: (name: string) => boolean): Promise<string | null> {
  const names = await readdir(dir).catch(() => [] as string[])
  let best: string | null = null
  let bestTime = since - 5000
  for (const name of names) {
    if (!accept(name)) continue
    const info = await stat(join(dir, name)).catch(() => null)
    if (info && info.mtimeMs >= bestTime) {
      best = join(dir, name)
      bestTime = info.mtimeMs
    }
  }
  return best
}

function readTail(file: string, bytes: number): string {
  try {
    const fd = openSync(file, 'r')
    try {
      const { size } = fstatSync(fd)
      const length = Math.min(size, bytes)
      const buffer = Buffer.alloc(length)
      readSync(fd, buffer, 0, length, size - length)
      return buffer.toString('utf8')
    } finally {
      closeSync(fd)
    }
  } catch {
    return ''
  }
}

async function buildIndex(modsDir: string): Promise<ModIndex> {
  const byId = new Map<string, Jar>()
  const jars: Jar[] = []
  const names = await readdir(modsDir).catch(() => [] as string[])
  for (const file of names.filter((name) => /\.jar$/i.test(name))) {
    const meta = await readJarMeta(join(modsDir, file), file)
    const jar = { file, name: meta.name, ids: meta.ids }
    jars.push(jar)
    for (const id of meta.ids) if (!byId.has(id)) byId.set(id, jar)
  }
  return { byId, jars }
}

function mainException(text: string): ParsedException | null {
  const lines = text.split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const match = /^(?:Caused by: )?([a-zA-Z_$][\w$]*(?:\.[\w$]+)+(?:Exception|Error|Throwable)[\w$]*)(?::\s*(.*))?$/.exec(lines[i])
    if (!match) continue
    const frames: Frame[] = []
    for (let j = i + 1; j < lines.length && frames.length < 60; j++) {
      const frame = /^\s+at (?:[\w.@+-]*\/)*([\w$.]+)\.([\w$<>]+)\(/.exec(lines[j])
      if (!frame) {
        if (/^\s*\.\.\. \d+ more/.test(lines[j]) || /^Caused by:/.test(lines[j])) continue
        break
      }
      frames.push({ className: frame[1], method: frame[2] })
    }
    if (frames.length) return { type: match[1], message: (match[2] ?? '').trim(), frames }
  }
  return null
}

function culpritsFromIds(ids: string[], index: ModIndex, reason: string): Found[] {
  const found: Found[] = []
  for (const id of ids) {
    if (PLATFORM_MOD_IDS.has(id)) continue
    const jar = index.byId.get(id)
    if (jar && !found.some((item) => item.file === jar.file)) found.push({ file: jar.file, name: jar.name, reason })
  }
  return found
}

interface LoaderProblems {
  missing: { modId: string; modName: string; depId: string; depName: string; wrongVersion: boolean }[]
  platform: { modId: string; modName: string; depId: string }[]
  conflicts: [string, string][]
  duplicates: string[]
}

function loaderProblems(text: string, index: ModIndex): LoaderProblems {
  const all: LoaderProblems['missing'] = []
  for (const m of text.matchAll(/Mod '([^']+)' \(([\w-]+)\)[^\n]*?requires [^\n]*?(?:mod|of) '([^']+)' \(([\w-]+)\)[^\n]*?(missing|wrong version)/g)) {
    all.push({ modId: m[2], modName: m[1], depId: m[4], depName: m[3], wrongVersion: m[5] === 'wrong version' })
  }
  for (const m of text.matchAll(/Mod '([^']+)' \(([\w-]+)\)[^\n]*?requires [^\n']*? of ([\w.-]+), which is (missing|wrong version)/g)) {
    all.push({ modId: m[2], modName: m[1], depId: m[3], depName: m[3], wrongVersion: m[4] === 'wrong version' })
  }
  for (const m of text.matchAll(/Mod ID: '([\w-]+)', Requested by: '([\w-]+)'/g)) {
    all.push({ modId: m[2], modName: index.byId.get(m[2])?.name ?? m[2], depId: m[1], depName: m[1], wrongVersion: false })
  }
  const conflicts: [string, string][] = []
  for (const m of text.matchAll(/Mod '([^']+)' \(([\w-]+)\)[^\n]*?is incompatible with [^\n]*?'([^']+)' \(([\w-]+)\)/g)) conflicts.push([m[2], m[4]])
  const duplicates = [...text.matchAll(/(?:Mod ID '([\w-]+)' is provided by multiple|duplicate mods?[^\n]*?'([\w-]+)')/gi)].map((m) => m[1] ?? m[2])
  return {
    missing: all.filter((item) => !PLATFORM_MOD_IDS.has(item.depId)),
    platform: all.filter((item) => PLATFORM_MOD_IDS.has(item.depId)),
    conflicts,
    duplicates,
  }
}

type Action = CrashReport['action']

const PATTERNS: { key: string; pattern: RegExp; title: string; description?: string; solution: string; action: Action }[] = [
  { key: 'debug_crash', pattern: /Manually triggered debug crash/i, title: 'Тестовый вылет (F3 + C)', description: 'Игру закрыли отладочной комбинацией клавиш', solution: 'С игрой всё в порядке, можно запускать снова', action: 'relaunch' },
  { key: 'out_of_memory', pattern: /java\.lang\.OutOfMemoryError/i, title: 'Игре не хватило памяти', solution: 'Выделите игре больше памяти в настройках', action: 'memory' },
  { key: 'java_version', pattern: /UnsupportedClassVersionError/i, title: 'Не подходит версия Java', solution: 'Проверка игровых файлов скачает нужную версию заново', action: 'repair' },
  { key: 'gpu_opengl', pattern: /Pixel format not accelerated|GLFW error (65542|65543)|WGL: The driver does not appear to support OpenGL/i, title: 'Видеокарта или драйвер не поддерживают игру', solution: 'Обновите драйвер видеокарты с сайта NVIDIA, AMD или Intel', action: 'none' },
  { key: 'corrupt_files', pattern: /ZipException|invalid LOC header/i, title: 'Повреждены файлы игры', solution: 'Проверка игровых файлов докачает повреждённые', action: 'repair' },
]

export interface AnalyzeOptions {
  gameDir: string
  /** Время запуска игры: более старые отчёты относятся к прошлым запускам. */
  since: number
  /** Можно ли игроку выключить этот файл: обязательные моды сборки выключать нельзя. */
  canDisable: (file: string) => boolean
}

export async function analyzeCrash({ gameDir, since, canDisable }: AnalyzeOptions): Promise<CrashReport> {
  const crashReport = await newestSince(join(gameDir, 'crash-reports'), since, (name) => name.endsWith('.txt'))
  const hsErr = await newestSince(gameDir, since, (name) => /^hs_err_pid\d+\.log$/.test(name))
  const logFile = join(gameDir, 'logs', 'latest.log')
  const reportText = crashReport ? readTail(crashReport, LOG_TAIL_BYTES) : ''
  const logText = readTail(logFile, LOG_TAIL_BYTES)
  const hsText = hsErr ? readTail(hsErr, 256 * 1024) : ''
  const all = `${reportText}\n${logText}\n${hsText}`
  const modsDir = join(gameDir, 'mods')
  const index = await buildIndex(modsDir)
  const exception = mainException(reportText) ?? mainException(logText)
  const description = /^Description: (.+)$/m.exec(reportText)?.[1] ?? null
  const exceptionText = exception ? `${exception.type}${exception.message ? `: ${exception.message}` : ''}` : null

  const finish = (result: { kind: string; title: string; description: string | null; solution: string; action: Action; culprits: Found[] }): CrashReport => {
    const culprits: CrashCulprit[] = result.culprits.map((item) => ({ ...item, canDisable: canDisable(item.file) }))
    let { action, solution } = result
    if (action === 'disable' && !culprits.some((item) => item.canDisable)) {
      action = 'repair'
      if (culprits.length) solution = 'Этот мод обязателен в сборке. Проверьте игровые файлы, а если не поможет, напишите в поддержку'
    }
    return { ...result, action, solution, culprits, exception: exceptionText, crashReport, logFile: crashReport ?? logFile }
  }

  // Мод не смог создаться: дальше игра падает где угодно, поэтому смотреть надо на него, а не на последнюю ошибку.
  const failedIds = [...new Set([...logText.matchAll(/Failed to create mod instance\. ModID: ([\w-]+)/g)].map((m) => m[1]))]
  const failed = culpritsFromIds(failedIds, index, 'не смог запуститься')
  if (failed.length) {
    return finish({
      kind: 'modConstruction',
      title: failed.length === 1 ? `Мод «${failed[0].name}» не смог запуститься` : 'Моды не смогли запуститься',
      description,
      solution: 'Выключите этот мод или верните мод, который ему нужен',
      action: 'disable',
      culprits: failed,
    })
  }

  const loader = loaderProblems(all, index)
  if (loader.missing.length) {
    const needed = [...new Set(loader.missing.map((item) => `«${item.depName}»`))].join(', ')
    const versions = loader.missing.every((item) => item.wrongVersion)
    return finish({
      kind: 'missingDeps',
      title: versions ? 'Модам нужны другие версии модов' : 'Модам не хватает других модов',
      description: `Нужны: ${needed}`,
      solution: 'Выключите моды, которым они нужны',
      action: 'disable',
      culprits: culpritsFromIds([...new Set(loader.missing.map((item) => item.modId))], index, 'не хватает зависимости'),
    })
  }
  if (loader.platform.length) {
    return finish({
      kind: 'wrongPlatform',
      title: 'Мод сделан под другую версию игры',
      description: [...new Set(loader.platform.map((item) => `«${item.modName}»`))].join(', '),
      solution: 'Выключите мод или поставьте его версию для Minecraft 1.21.1 и NeoForge',
      action: 'disable',
      culprits: culpritsFromIds([...new Set(loader.platform.map((item) => item.modId))], index, 'не та версия игры'),
    })
  }
  if (loader.conflicts.length) {
    return finish({
      kind: 'incompatible',
      title: 'Моды несовместимы друг с другом',
      description: loader.conflicts.map(([a, b]) => `«${index.byId.get(a)?.name ?? a}» и «${index.byId.get(b)?.name ?? b}»`).join('; '),
      solution: 'Выключите один из модов каждой пары',
      action: 'disable',
      culprits: culpritsFromIds([...new Set(loader.conflicts.map(([a]) => a))], index, 'несовместим с другим модом'),
    })
  }
  if (loader.duplicates.length) {
    const ids = new Set(loader.duplicates)
    const copies = index.jars.filter((jar) => jar.ids.some((id) => ids.has(id)))
    return finish({
      kind: 'duplicate',
      title: 'Один мод установлен дважды',
      description: [...ids].map((id) => `«${index.byId.get(id)?.name ?? id}»`).join(', '),
      solution: 'Выключите лишнюю копию',
      action: 'disable',
      culprits: copies.slice(1).map((jar) => ({ file: jar.file, name: jar.name, reason: 'вторая копия' })),
    })
  }

  const findCulprits = async (): Promise<Found[]> => {
    if (exception) {
      const looked = new Set<string>()
      for (const frame of exception.frames) {
        if (PLATFORM_PREFIXES.some((prefix) => frame.className.startsWith(prefix))) {
          // Код мода в классе игры через Mixin: handler$…$modid$…
          const injected = /^[a-z]+\$[a-z0-9]+\$([a-z0-9_]+)\$/.exec(frame.method)
          const found = injected ? culpritsFromIds([injected[1]], index, 'вылет в коде мода') : []
          if (found.length) return found
          continue
        }
        if (looked.has(frame.className) || looked.size >= MAX_CLASS_LOOKUPS) continue
        looked.add(frame.className)
        const entry = `${frame.className.replaceAll('.', '/')}.class`
        for (const jar of index.jars) {
          if (await zipHasEntry(join(modsDir, jar.file), entry)) return [{ file: jar.file, name: jar.name, reason: 'вылет в коде мода' }]
        }
      }
    }
    const mixinLines = all
      .split(/\r?\n/)
      .filter((line) => /Mixin apply for mod [\w-]+ failed|MixinApplyError|InvalidMixinException|InjectionError|Critical injection failure|MixinTransformerError/.test(line))
      .join('\n')
    const ids = [...mixinLines.matchAll(/Mixin apply for mod ([\w-]+) failed|from mod ([\w-]+)\]|([\w-]+)\.mixins\.json|mixins\.([\w-]+)\.json/g)].map((m) => m[1] ?? m[2] ?? m[3] ?? m[4])
    return culpritsFromIds([...new Set(ids)], index, 'ошибка Mixin')
  }

  // Только конец лога: безобидные ошибки из его начала подменяли бы настоящую причину.
  const context = [exceptionText ?? '', description ?? '', hsText, logText.split(/\r?\n/).slice(-LOG_TAIL_LINES).join('\n')].join('\n')
  const matched = PATTERNS.find((item) => item.pattern.test(context))
  if (matched) {
    return finish({ kind: matched.key, title: matched.title, description: matched.description ?? description, solution: matched.solution, action: matched.action, culprits: [] })
  }

  const culprits = await findCulprits()
  if (culprits.length) {
    return finish({
      kind: 'modCrash',
      title: culprits.length === 1 ? `Вылет из-за мода «${culprits[0].name}»` : 'Вылет из-за модов',
      description,
      solution: 'Выключите этот мод. Если он нужен, напишите в поддержку',
      action: 'disable',
      culprits,
    })
  }

  const signature = createHash('sha1').update(`${exception?.type ?? ''}|${description ?? ''}`).digest('hex').slice(0, 8)
  return finish({
    kind: `unknown-${signature}`,
    title: 'Игра закрылась с ошибкой',
    description,
    solution: 'Точную причину найти не удалось. Проверьте игровые файлы, а если не поможет, напишите в поддержку',
    action: 'repair',
    culprits: [],
  })
}
