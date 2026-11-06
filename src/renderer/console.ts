import type { LauncherApi } from '../shared/types'
import './styles.css'
import './console.css'

/** Консоль с живым логом игры. Логика фильтров и раскраски перенесена из лаунчера Slarof. */
const api = (window as unknown as { lumorrix: LauncherApi }).lumorrix

const logEl = document.getElementById('log') as HTMLElement
const searchEl = document.getElementById('search') as HTMLInputElement
const linesEl = document.getElementById('lines') as HTMLElement
const followEl = document.getElementById('follow') as HTMLElement
const copyEl = document.getElementById('copy') as HTMLElement
const clearEl = document.getElementById('clear') as HTMLElement
const levelsEl = document.getElementById('levels') as HTMLElement

type Level = 'info' | 'warn' | 'error' | 'debug'
const LEVELS: Level[] = ['info', 'warn', 'error', 'debug']
const FILTER_KEY = 'lumorrix:consoleFilter'
const MAX_ROWS = 20_000

/** [19:45:41.342] [main/INFO] [LumorrixUpdater/]: текст */
const LOG_LINE = /^\[([\d:.]+)\]\s*\[([^\]]+)\/(\w+)\]\s*(\[[^\]]*\])?:?\s*(.*)$/

let follow = true
let query = ''
let lastLevel: Level = 'info'
let pending = ''
const counts: Record<Level, number> = { info: 0, warn: 0, error: 0, debug: 0 }
/** Выбранные фильтры: показываем только их. Ничего не выбрано — показываем всё. */
const selected = new Set<Level>()
const isShown = (level: Level) => selected.size === 0 || selected.has(level)

try {
  const saved = JSON.parse(localStorage.getItem(FILTER_KEY) ?? 'null')
  if (Array.isArray(saved)) {
    for (const level of saved) if (LEVELS.includes(level)) selected.add(level)
  }
} catch {
  // Хранилище может быть недоступно: тогда фильтры просто не выбраны.
}

function levelOf(name: string): Level {
  const value = name.toLowerCase()
  if (value === 'warn' || value === 'warning') return 'warn'
  if (value === 'error' || value === 'fatal' || value === 'critical') return 'error'
  if (value === 'debug' || value === 'trace') return 'debug'
  return 'info'
}

function span(className: string, text: string): HTMLElement {
  const el = document.createElement('span')
  el.className = className
  el.textContent = text
  return el
}

function renderLine(line: string): void {
  const row = document.createElement('div')
  row.className = 'log-line'
  const match = LOG_LINE.exec(line)
  let level = lastLevel
  if (match) {
    const [, time, thread, name, source, message] = match
    level = levelOf(name)
    row.append(span('log-time', `[${time}] `), span('log-thread', `[${thread}/${name}] `))
    if (source) row.append(span('log-source', `${source} `))
    row.append(span(`log-text log-${level}`, message))
  } else {
    // Строки стектрейса продолжают уровень сообщения, к которому относятся.
    row.append(span(`log-text log-${level}`, line))
  }
  lastLevel = level
  if (level === 'warn' || level === 'error') row.classList.add(`row-${level}`)
  row.dataset.level = level
  counts[level]++
  if (query && !row.textContent?.toLowerCase().includes(query)) row.hidden = true
  logEl.append(row)
  while (logEl.childElementCount > MAX_ROWS) {
    const old = logEl.firstElementChild as HTMLElement
    counts[old.dataset.level as Level]--
    old.remove()
  }
}

function paint(): void {
  const total = logEl.childElementCount
  const tens = total % 100
  const units = total % 10
  const word = tens >= 11 && tens <= 14 ? 'строк' : units === 1 ? 'строка' : units >= 2 && units <= 4 ? 'строки' : 'строк'
  linesEl.textContent = `${total} ${word}`
  for (const chip of levelsEl.querySelectorAll<HTMLElement>('.level')) {
    const level = chip.dataset.level as Level
    chip.classList.toggle('level-on', selected.has(level))
    chip.setAttribute('aria-pressed', String(selected.has(level)))
    const count = chip.querySelector('b')
    if (count) count.textContent = String(counts[level])
  }
  for (const level of LEVELS) logEl.classList.toggle(`hide-${level}`, !isShown(level))
}

function toBottom(): void {
  logEl.scrollTop = logEl.scrollHeight
}

function setFollow(value: boolean): void {
  follow = value
  followEl.classList.toggle('console-on', value)
  followEl.setAttribute('aria-pressed', String(value))
  if (value) toBottom()
}

function addText(text: string): void {
  pending += text
  const lines = pending.split('\n')
  pending = lines.pop() ?? ''
  // Без удаления \r не сработает $ в регулярном выражении.
  for (const line of lines) renderLine(line.replace(/\r$/, ''))
  paint()
  if (follow) toBottom()
}

function reset(): void {
  logEl.textContent = ''
  pending = ''
  lastLevel = 'info'
  for (const level of LEVELS) counts[level] = 0
  paint()
}

logEl.addEventListener('scroll', () => {
  const atBottom = logEl.scrollHeight - logEl.scrollTop - logEl.clientHeight < 24
  if (atBottom !== follow) setFollow(atBottom)
})

followEl.addEventListener('click', () => setFollow(!follow))

searchEl.addEventListener('input', () => {
  query = searchEl.value.trim().toLowerCase()
  for (const row of logEl.children) (row as HTMLElement).hidden = !!query && !row.textContent?.toLowerCase().includes(query)
  if (follow) toBottom()
})

levelsEl.addEventListener('click', (event) => {
  const chip = (event.target as HTMLElement).closest<HTMLElement>('.level')
  if (!chip) return
  const level = chip.dataset.level as Level
  if (selected.has(level)) selected.delete(level)
  else selected.add(level)
  try {
    localStorage.setItem(FILTER_KEY, JSON.stringify([...selected]))
  } catch {
    // Выбор просто не сохранится до следующего открытия.
  }
  paint()
  if (follow) toBottom()
})

let copyTimer: ReturnType<typeof setTimeout> | undefined
copyEl.addEventListener('click', async () => {
  const text = [...logEl.children]
    .filter((row) => !(row as HTMLElement).hidden && isShown((row as HTMLElement).dataset.level as Level))
    .map((row) => row.textContent)
    .join('\n')
  try {
    await navigator.clipboard.writeText(text)
    copyEl.textContent = 'Скопировано'
  } catch {
    copyEl.textContent = 'Не удалось'
  }
  clearTimeout(copyTimer)
  copyTimer = setTimeout(() => {
    copyEl.textContent = 'Копировать'
  }, 1500)
})

clearEl.addEventListener('click', reset)

paint()
void api.consoleTail().then((tail) => {
  addText(tail)
  api.onConsole(addText)
  api.onConsoleClear(() => {
    reset()
    setFollow(true)
  })
})
