import { Check, House, Puzzle, RefreshCw, Settings as SettingsIcon, X } from 'lucide-preact'
import type { ComponentChildren } from 'preact'
import { render } from 'preact'
import { useRef, useEffect, useMemo, useState } from 'preact/hooks'
import { GROUPS, modGroup, modText } from '../shared/modinfo'
import type { CrashReport, JvmPreset, LauncherApi, LinkName, ModView, Preset, ServerStatus, SettingsView, Status, UpdateStatus } from '../shared/types'
import hero from './assets/hero.webp'
import iconDiscord from './assets/icon-discord.svg'
import iconRules from './assets/icon-rules.svg'
import iconWiki from './assets/icon-wiki.svg'
import logo from './assets/logo.png'
import mark from './assets/mark.png'
import presetCustom from './assets/preset-custom.jpg'
import presetPerformance from './assets/preset-performance.jpg'
import presetQuality from './assets/preset-quality.jpg'
import './styles.css'

declare global {
  interface Window {
    lumorrix: LauncherApi
  }
}

const api = window.lumorrix
const NICKNAME = /^[A-Za-z0-9_]{3,16}$/
const ICON = { size: 22, strokeWidth: 2.5 }

type Tab = 'play' | 'mods'

const isBusy = (status: Status) => status.state === 'working' || status.state === 'playing'

function Scene() {
  return <div class="scene" style={{ backgroundImage: `url(${hero})` }} />
}

const NICKNAME_HINT = 'От 3 до 16 символов: латинские буквы, цифры и _'

function NicknameForm(props: { onSave: (nickname: string) => void }) {
  const [value, setValue] = useState('')
  const valid = NICKNAME.test(value)
  const wrong = !!value && !valid
  return (
    <form
      class="nick-card"
      onSubmit={(event) => {
        event.preventDefault()
        if (valid) props.onSave(value)
      }}
    >
      <img class="nick-logo" src={logo} alt="Lumorrix" />
      <label class="field-label" for="nickname">
        Ваш ник
      </label>
      <input
        id="nickname"
        class="input"
        value={value}
        maxLength={16}
        autoFocus
        spellcheck={false}
        onInput={(event) => setValue(event.currentTarget.value)}
      />
      {wrong && <p class="help help-bad">{NICKNAME_HINT}</p>}
      <div class="nick-actions">
        <button class="btn-play" disabled={!valid}>
          Продолжить
        </button>
      </div>
    </form>
  )
}

/** Маленькое окно рядом с головой: Esc или клик мимо закрывают его без сохранения. */
function NicknamePopover(props: { initial: string; onSave: (nickname: string) => void; onCancel: () => void }) {
  const [value, setValue] = useState(props.initial)
  const valid = NICKNAME.test(value)
  const wrong = !!value && !valid
  const input = useRef<HTMLInputElement>(null)
  useEffect(() => {
    const field = input.current
    field?.focus()
    field?.setSelectionRange(field.value.length, field.value.length)
  }, [])
  return (
    <>
      <div class="nick-pop-back" onMouseDown={props.onCancel} />
      <form
        class="nick-pop"
        aria-label="Смена ника"
        onSubmit={(event) => {
          event.preventDefault()
          if (valid) props.onSave(value)
        }}
        onKeyDown={(event) => {
          if (event.key === 'Escape') props.onCancel()
        }}
      >
        <div class="nick-pop-row">
          <input
            ref={input}
            class="input"
            aria-label="Ник"
            value={value}
            maxLength={16}
            spellcheck={false}
            onInput={(event) => setValue(event.currentTarget.value)}
          />
          <button class="btn" disabled={!valid}>
            Сохранить
          </button>
        </div>
        {wrong && <p class="help help-bad">{NICKNAME_HINT}</p>}
      </form>
    </>
  )
}

/** Голова игрока по нику. Без интернета или при ошибке сервиса показываем первую букву ника. */
function PlayerHead(props: { nickname: string; disabled: boolean; editing: boolean; onEdit: () => void; onSave: (nickname: string) => void; onCancel: () => void }) {
  const [failed, setFailed] = useState(false)
  useEffect(() => setFailed(false), [props.nickname])
  return (
    <div class="head-wrap">
      <button class="head" disabled={props.disabled} aria-label={`Сменить ник ${props.nickname}`} onClick={props.onEdit}>
        {failed ? (
          <span class="head-letter">{props.nickname[0].toUpperCase()}</span>
        ) : (
          <img src={`https://mc-heads.net/avatar/${encodeURIComponent(props.nickname)}/64`} alt="" onError={() => setFailed(true)} />
        )}
        {!props.editing && <span class="head-tip">{props.nickname}</span>}
      </button>
      {props.editing && <NicknamePopover initial={props.nickname} onSave={props.onSave} onCancel={props.onCancel} />}
    </div>
  )
}

function ServerOnline() {
  const [server, setServer] = useState<ServerStatus>(null)

  useEffect(() => {
    const update = () => void api.getServerStatus().then(setServer)
    update()
    // Таймер живёт вместе с окном. На время игры окно закрывается.
    const timer = setInterval(update, 60_000)
    return () => clearInterval(timer)
  }, [])

  // Пустой блок держит место, чтобы меню не сдвигалось, когда придёт ответ.
  if (!server) return <div class="online" />
  return (
    <div class={server.online ? 'online online-on' : 'online'} title={server.online ? `На сервере ${server.players} из ${server.max}` : 'Сервер недоступен'}>
      <span class="online-dot" />
      {server.online ? `${server.players}/${server.max}` : 'Нет'}
    </div>
  )
}

/** Разбор падения: главное действие, поддержка и крестик, больше ничего. */
function CrashNotice({ report, onOpenSettings }: { report: CrashReport; onOpenSettings: () => void }) {
  const [copied, setCopied] = useState(false)
  const toDisable = report.culprits.filter((item) => item.canDisable)
  return (
    <section class="notice notice-bad">
      <button class="close notice-close" aria-label="Закрыть" onClick={() => api.dismiss()}>
        <X size={20} strokeWidth={2} />
      </button>
      <h2>{report.title}</h2>
      <p>{report.solution}</p>
      <div class="row">
        {report.action === 'disable' && toDisable.length > 0 && (
          <button
            class="btn"
            onClick={async () => {
              await api.setMods(
                toDisable.map((item) => item.file),
                false,
              )
              await api.dismiss()
            }}
          >
            {toDisable.length === 1 ? `Выключить ${toDisable[0].name}` : 'Выключить эти моды'}
          </button>
        )}
        {report.action === 'memory' && (
          <button class="btn" onClick={onOpenSettings}>
            Настройки памяти
          </button>
        )}
        {report.action === 'repair' && (
          <button class="btn" onClick={() => api.repair()}>
            Проверить игровые файлы
          </button>
        )}
        {report.action === 'relaunch' && (
          <button class="btn" onClick={() => api.play()}>
            Запустить снова
          </button>
        )}
        <button
          class="btn-quiet"
          title="Скопирует отчёт и откроет Discord"
          onClick={async () => {
            await api.copyCrashReport()
            setCopied(true)
            await api.openLink('support')
          }}
        >
          {copied ? 'Отчёт скопирован, вставьте его в Discord' : 'Поддержка'}
        </button>
      </div>
    </section>
  )
}

/** Сообщение поверх картинки: ошибка, падение игры или итог проверки файлов. */
function Notice({ status, installed, onOpenSettings }: { status: Status; installed: boolean; onOpenSettings: () => void }) {
  if (status.state === 'error') {
    return (
      <section class="notice notice-bad">
        <h2>{status.title}</h2>
        <p>{status.message}</p>
        <div class="row">
          <button class="btn" onClick={() => (installed ? api.play() : api.install())}>
            Повторить
          </button>
          {status.canPlayOld && (
            <button class="btn" onClick={() => api.play({ skipUpdate: true })}>
              Играть со старой версией
            </button>
          )}
          <button class="btn-quiet" onClick={() => api.openLink('support')}>
            Поддержка
          </button>
        </div>
      </section>
    )
  }
  if (status.state === 'crashed') return <CrashNotice report={status.report} onOpenSettings={onOpenSettings} />
  if (status.state === 'done') {
    return (
      <section class="notice">
        <h2>{status.message}</h2>
        <div class="row">
          <button class="btn" onClick={() => api.dismiss()}>
            Понятно
          </button>
        </div>
      </section>
    )
  }
  return null
}

/** Прогресс установки в виде полоски опыта из Minecraft. */
function ExperienceBar({ fraction }: { fraction: number | null }) {
  return (
    <div class={fraction === null ? 'xp xp-unknown' : 'xp'}>
      <div class="xp-fill" style={fraction === null ? undefined : { transform: `scaleX(${fraction})` }} />
    </div>
  )
}

const SOCIALS: { title: string; link: LinkName; icon: ComponentChildren }[] = [
  { title: 'Вики', link: 'wiki', icon: <img src={iconWiki} alt="" /> },
  { title: 'Правила', link: 'rules', icon: <img src={iconRules} alt="" /> },
  { title: 'Discord', link: 'discord', icon: <img src={iconDiscord} alt="" /> },
]

function HomeActions({ status, installed }: { status: Status; installed: boolean }) {
  const busy = isBusy(status)
  const canCancel = status.state === 'working' && status.cancellable
  return (
    <div class="home-actions">
      {status.state === 'working' ? (
        <div class="home-progress">
          <div class="home-progress-line">
            <span>{status.title}</span>
            <span>{status.detail}</span>
          </div>
          <ExperienceBar fraction={status.fraction} />
        </div>
      ) : (
        <nav class="socials" aria-label="Ссылки">
          {SOCIALS.map((item) => (
            <button key={item.link} class="social" onClick={() => api.openLink(item.link)}>
              {item.icon}
              {item.title}
            </button>
          ))}
        </nav>
      )}
      {/* Разные key: кнопка «Отменить» не получает фокус, поэтому Enter случайно не прервёт загрузку. */}
      {canCancel ? (
        <button key="cancel" class="btn-cancel" onClick={() => api.cancel()}>
          Отменить
        </button>
      ) : busy ? (
        <button key="wait" class="btn-play" disabled>
          {status.state === 'playing' ? 'Игра запущена' : 'Подождите'}
        </button>
      ) : (
        <button key="go" class="btn-play" autoFocus onClick={() => (installed ? api.play() : api.install())}>
          {installed ? (
            'Играть'
          ) : (
            'Скачать · 2 ГБ'
          )}
        </button>
      )}
    </div>
  )
}

function HomePage({ status, settings, onOpenSettings }: { status: Status; settings: SettingsView; onOpenSettings: () => void }) {
  const installed = !!settings.packVersion
  return (
    <div class="home">
      <Scene />
      <div class="home-top">
        <img class="home-logo" src={logo} alt="Lumorrix" />
      </div>
      <div class="home-bottom">
        <Notice status={status} installed={installed} onOpenSettings={onOpenSettings} />
        <HomeActions status={status} installed={installed} />
      </div>
    </div>
  )
}

function ModRow({ mod, busy, onToggle }: { mod: ModView; busy: boolean; onToggle: (mod: ModView) => void }) {
  const description = modText(mod.id)?.text ?? mod.description
  return (
    <label class={busy ? 'mod mod-locked' : 'mod'}>
      <span class="mod-icon">{mod.icon ? <img src={mod.icon} alt="" /> : <Puzzle size={22} strokeWidth={1.5} />}</span>
      <span class="mod-text">
        <span class="mod-name">{mod.name}</span>
        {description && (
          <span class="mod-desc" title={description}>
            {description}
          </span>
        )}
      </span>
      <input type="checkbox" class="switch" checked={mod.enabled} disabled={busy} onChange={() => onToggle(mod)} />
    </label>
  )
}

const PRESETS: { id: Preset; title: string; text: string; image: string }[] = [
  { id: 'quality', title: 'Качество', text: 'Все моды', image: presetQuality },
  { id: 'performance', title: 'Производительность', text: 'Больше кадров, без шейдеров', image: presetPerformance },
  { id: 'custom', title: 'Свои', text: 'Соберите сами', image: presetCustom },
]

function ModsPage({ busy, preset, onSettings }: { busy: boolean; preset: Preset | null; onSettings: (settings: SettingsView) => void }) {
  const [mods, setMods] = useState<ModView[] | null>(null)
  const [applying, setApplying] = useState(false)
  const [choosing, setChoosing] = useState(false)
  const [failed, setFailed] = useState(false)
  const [query, setQuery] = useState('')
  const [confirm, setConfirm] = useState<{ mod: ModView; affected: ModView[] } | null>(null)

  const load = () => {
    setFailed(false)
    api.listMods().then(setMods, () => setFailed(true))
  }

  useEffect(load, [])

  const client = useMemo(() => (mods ?? []).filter((mod) => mod.kind === 'client'), [mods])
  const matches = (mod: ModView) => {
    const needle = query.trim().toLowerCase()
    return !needle || `${mod.name} ${modText(mod.id)?.text ?? mod.description}`.toLowerCase().includes(needle)
  }
  const own =(mods ?? []).filter((mod) => mod.kind === 'user' && matches(mod))
  const anyShown = own.length > 0 || client.some(matches)

  const toggle = async (mod: ModView) => {
    const enabled = !mod.enabled
    const { files } = await api.planMod(mod.file, enabled)
    if (!enabled && files.length) {
      const affected = (mods ?? []).filter((item) => files.includes(item.file))
      setConfirm({ mod, affected })
      return
    }
    // Нужные для работы моды включаем вместе с выбранным, без лишних вопросов.
    await applyMods([mod.file, ...files], enabled)
  }

  const applyMods = async (files: string[], enabled: boolean) => {
    setMods(await api.setMods(files, enabled))
    onSettings(await api.getSettings())
  }

  const choosePreset = async (next: Preset) => {
    if (applying) return
    // Текущий набор не применяем заново: это сбросило бы то, что игрок настроил вручную.
    if (next === preset) {
      setChoosing(false)
      return
    }
    setApplying(true)
    setFailed(false)
    try {
      const result = await api.setPreset(next)
      setMods(result.mods)
      onSettings(result.settings)
      setChoosing(false)
    } catch {
      setFailed(true)
    } finally {
      setApplying(false)
    }
  }

  if (!preset || choosing) {
    return (
      <div class="page">
        <header class="page-head">
          <h1>Пресеты</h1>
          {preset && (
            <button class="btn" onClick={() => setChoosing(false)}>
              Отмена
            </button>
          )}
        </header>
        <div class="presets">
          {PRESETS.map((item) => (
            <button key={item.id} class={item.id === preset ? 'preset preset-on' : 'preset'} disabled={busy || applying} aria-pressed={item.id === preset} onClick={() => choosePreset(item.id)}>
              <span class="preset-image" style={{ backgroundImage: `url(${item.image})` }} />
              {item.id === preset && (
                <span class="preset-mark" title="Выбран">
                  <Check size={18} strokeWidth={2} />
                </span>
              )}
              <span class="preset-title">{item.title}</span>
              <span class="preset-text">{item.text}</span>
            </button>
          ))}
        </div>
        {failed && <p class="help help-bad">Нет связи. Проверьте интернет</p>}
      </div>
    )
  }

  return (
    <div class="page">
      <header class="page-head">
        <h1>Моды</h1>
        {!!client.length && (
          <span class="counter">
            {client.filter((mod) => mod.enabled).length} из {client.length}
          </span>
        )}
      </header>

      <div class="toolbar">
        <input class="input toolbar-search" placeholder="Поиск" aria-label="Поиск модов" value={query} spellcheck={false} onInput={(event) => setQuery(event.currentTarget.value)} />
        <button class="btn" disabled={busy} onClick={() => setChoosing(true)}>
          Пресеты
        </button>
      </div>

      <div class="mod-scroll">
        {!mods && !failed && <p class="empty">Загрузка</p>}
        {!mods && failed && (
          <div class="empty">
            <p>Нет связи. Проверьте интернет</p>
            <button class="btn" onClick={load}>
              Повторить
            </button>
          </div>
        )}
        {mods && !anyShown && query && <p class="empty">Ничего не нашлось</p>}
        {mods &&
          GROUPS.map((group) => {
            const items = client.filter((mod) => modGroup(mod.id) === group && matches(mod))
            if (!items.length) return null
            return (
              <section class="mod-group" key={group}>
                <h2>{group}</h2>
                <div class="panel">
                  {items.map((mod) => (
                    <ModRow key={mod.file} mod={mod} busy={busy} onToggle={toggle} />
                  ))}
                </div>
              </section>
            )
          })}
        {mods && !query && (
          <section class="mod-group">
            <h2>Ваши моды</h2>
            {!!own.length && (
              <div class="panel">
                {own.map((mod) => (
                  <ModRow key={mod.file} mod={mod} busy={busy} onToggle={toggle} />
                ))}
              </div>
            )}
            <button class="btn own-add" onClick={() => api.openFolder('mods')}>
              Открыть папку модов
            </button>
          </section>
        )}
        {mods && query && !!own.length && (
          <section class="mod-group">
            <h2>Ваши моды</h2>
            <div class="panel">
              {own.map((mod) => (
                <ModRow key={mod.file} mod={mod} busy={busy} onToggle={toggle} />
              ))}
            </div>
          </section>
        )}
      </div>

      {confirm && (
        <div class="modal-back">
          <div class="modal" role="dialog" aria-modal="true">
            <h2>Выключить {confirm.mod.name}?</h2>
            <p>Также выключатся: {confirm.affected.map((mod) => mod.name).join(', ')}</p>
            <div class="row row-end">
              <button class="btn-quiet" onClick={() => setConfirm(null)}>
                Отмена
              </button>
              <button
                class="btn"
                autoFocus
                onClick={async () => {
                  const { mod, affected } = confirm
                  setConfirm(null)
                  await applyMods([mod.file, ...affected.map((item) => item.file)], false)
                }}
              >
                Выключить
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function SettingRow(props: { title: string; text?: string; children: ComponentChildren }) {
  return (
    <div class="setting">
      <div class="setting-text">
        <span class="setting-title">{props.title}</span>
        {props.text && <span class="setting-desc">{props.text}</span>}
      </div>
      <div class="row">{props.children}</div>
    </div>
  )
}

const JVM_OPTIONS: { id: JvmPreset; label: string }[] = [
  { id: 'g1', label: 'G1' },
  { id: 'zgc', label: 'ZGC' },
  { id: 'lowend', label: 'Для слабого ПК' },
]

function ToggleCell(props: { title: string; checked: boolean; disabled: boolean; onChange: () => void }) {
  return (
    <label class={props.disabled ? 'toggle-cell toggle-locked' : 'toggle-cell'}>
      <span class="setting-title">{props.title}</span>
      <input type="checkbox" class="switch" checked={props.checked} disabled={props.disabled} onChange={props.onChange} />
    </label>
  )
}

function SettingsModal(props: { settings: SettingsView; busy: boolean; onChange: (settings: SettingsView) => void; onRepair: () => void; onClose: () => void }) {
  const { settings, busy, onClose } = props
  const save = async (change: Parameters<LauncherApi['saveSettings']>[0]) => props.onChange(await api.saveSettings(change))

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div
      class="modal-back"
      role="dialog"
      aria-modal="true"
      aria-label="Настройки"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div class="settings-modal">
        <header class="settings-head">
          <h1>Настройки</h1>
          <button class="close" aria-label="Закрыть" onClick={onClose}>
            <X size={22} strokeWidth={2} />
          </button>
        </header>

        <div class="panel">
          <SettingRow title="Память">
            <div class="segments">
              {settings.ramOptions.map(({ gb, allowed }) => (
                <button
                  key={gb}
                  class={settings.ramGb === gb ? 'segment segment-on' : 'segment'}
                  disabled={!allowed || busy}
                  title={allowed ? undefined : 'В компьютере недостаточно памяти'}
                  onClick={() => save({ ramGb: gb })}
                >
                  {gb} ГБ
                </button>
              ))}
            </div>
          </SettingRow>
          <SettingRow title="Параметры Java">
            <div class="segments">
              {JVM_OPTIONS.map(({ id, label }) => (
                <button key={id} class={settings.jvmPreset === id ? 'segment segment-on' : 'segment'} disabled={busy} onClick={() => save({ jvmPreset: id })}>
                  {label}
                </button>
              ))}
            </div>
          </SettingRow>
          <div class="toggles">
            <ToggleCell title="Сразу заходить на сервер" checked={settings.autoConnect} disabled={busy} onChange={() => save({ autoConnect: !settings.autoConnect })} />
            <ToggleCell title="Закрывать лаунчер при запуске" checked={settings.closeOnLaunch} disabled={busy} onChange={() => save({ closeOnLaunch: !settings.closeOnLaunch })} />
            <ToggleCell title="Статус в Discord" checked={settings.discordStatus} disabled={busy} onChange={() => save({ discordStatus: !settings.discordStatus })} />
            <ToggleCell title="Консоль при запуске" checked={settings.consoleOnLaunch} disabled={busy} onChange={() => save({ consoleOnLaunch: !settings.consoleOnLaunch })} />
          </div>
          <SettingRow title="Проверить игровые файлы">
            <button class="btn" disabled={busy} onClick={props.onRepair}>
              Проверить
            </button>
          </SettingRow>
          <SettingRow title="Открыть">
            <button class="btn" onClick={() => api.openConsole()}>
              Консоль
            </button>
            <button class="btn" onClick={() => api.openFolder('game')}>
              Файлы сборки
            </button>
            <button class="btn" onClick={() => api.openFolder('logs')}>
              Логи сборки
            </button>
          </SettingRow>
        </div>

        <p class="version-line">
          Лаунчер {settings.launcherVersion}
          {settings.packVersion && ` · Сборка ${settings.packVersion}`}
        </p>
      </div>
    </div>
  )
}

function RailButton(props: { icon: ComponentChildren; label: string; active?: boolean; onClick: () => void }) {
  return (
    <button class={props.active ? 'rail-btn rail-btn-on' : 'rail-btn'} aria-current={props.active ? 'page' : undefined} onClick={props.onClick}>
      {props.icon}
      <span>{props.label}</span>
    </button>
  )
}

function App() {
  const [status, setStatus] = useState<Status>({ state: 'idle' })
  const [update, setUpdate] = useState<UpdateStatus>({ state: 'none' })
  const [settings, setSettings] = useState<SettingsView | null>(null)
  const [tab, setTab] = useState<Tab>('play')
  const [editingNick, setEditingNick] = useState(false)
  const [showSettings, setShowSettings] = useState(false)

  useEffect(() => {
    api.onStatus(setStatus)
    api.onUpdate(setUpdate)
    void api.getStatus().then(setStatus)
    void api.getUpdate().then(setUpdate)
    void api.getSettings().then(setSettings)
  }, [])

  // Версия сборки меняется после установки, поэтому обновляем её, когда работа закончена.
  useEffect(() => {
    if (status.state !== 'working') void api.getSettings().then(setSettings)
  }, [status.state])

  if (!settings) return <div class="drag" />

  const saveNickname = async (nickname: string) => {
    setSettings(await api.saveSettings({ nickname }))
    setEditingNick(false)
  }

  if (!settings.nickname) {
    return (
      <div class="nick-screen">
        <Scene />
        <div class="drag" />
        <NicknameForm onSave={saveNickname} />
      </div>
    )
  }

  const busy = isBusy(status)
  return (
    <div class="shell">
      <aside class="rail">
        <img class="rail-mark" src={mark} alt="" />
        <ServerOnline />
        <PlayerHead
          nickname={settings.nickname}
          disabled={busy}
          editing={editingNick}
          onEdit={() => setEditingNick(true)}
          onSave={saveNickname}
          onCancel={() => setEditingNick(false)}
        />
        <nav class="rail-nav">
          <RailButton icon={<House {...ICON} />} label="Главная" active={tab === 'play'} onClick={() => setTab('play')} />
          <RailButton icon={<Puzzle {...ICON} />} label="Моды" active={tab === 'mods'} onClick={() => setTab('mods')} />
        </nav>
        <nav class="rail-nav rail-bottom">
          {update.state === 'downloading' && <span class="rail-update">Обновление {update.percent}%</span>}
          {update.state === 'ready' && !busy && <RailButton icon={<RefreshCw {...ICON} />} label="Обновить" onClick={() => api.installUpdate()} />}
          <RailButton icon={<SettingsIcon {...ICON} />} label="Настройки" active={showSettings} onClick={() => setShowSettings(true)} />
        </nav>
      </aside>
      <main class="stage">
        <div class="drag" />
        {tab === 'play' && <HomePage status={status} settings={settings} onOpenSettings={() => setShowSettings(true)} />}
        {tab === 'mods' && <ModsPage busy={busy} preset={settings.modPreset} onSettings={setSettings} />}
      </main>
      {showSettings && (
        <SettingsModal
          settings={settings}
          busy={busy}
          onChange={setSettings}
          onClose={() => setShowSettings(false)}
          onRepair={() => {
            setShowSettings(false)
            setTab('play')
            void api.repair()
          }}
        />
      )}
    </div>
  )
}

render(<App />, document.getElementById('app') as HTMLElement)
