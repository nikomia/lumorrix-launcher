import { Check, RotateCcw, Search, Upload, X } from 'lucide-preact'
import { useEffect, useMemo, useRef, useState } from 'preact/hooks'
import type { CurrentSkin, DefaultSkin, SkinItem, SkinModel } from '../shared/types'
import { bodyDataUrl, isSlim, loadImage } from './skin'
import { ANIMATIONS, Skin3D, type SkinAnimation } from './skin3d'

const api = window.lumorrix

type Source = 'history' | 'standard' | 'nick'

/** Скин, который сейчас показан на персонаже и ещё не поставлен. */
interface Picked {
  src: string
  name: string
  model: SkinModel
  /** Можно ли выбрать руки: у старых скинов 64×32 руки всегда обычные. */
  modern: boolean
}

const checkSkinSize = (image: HTMLImageElement) =>
  image.width === 64 && (image.height === 64 || image.height === 32)
    ? null
    : `Скин должен быть 64×64 или 64×32 пикселя, а этот ${image.width}×${image.height}.`

/** Отпечаток пикселей: один и тот же скин, пережатый сервером, узнаётся как тот же. */
function pixelKey(image: HTMLImageElement): string {
  const canvas = document.createElement('canvas')
  canvas.width = image.width
  canvas.height = image.height
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) return ''
  ctx.drawImage(image, 0, 0)
  const data = ctx.getImageData(0, 0, image.width, image.height).data
  let hash = 0x811c9dc5
  for (let i = 0; i < data.length; i += 4) {
    const value = data[i + 3] === 0 ? 0 : (data[i] << 24) ^ (data[i + 1] << 16) ^ (data[i + 2] << 8) ^ data[i + 3]
    hash = Math.imul(hash ^ value, 0x01000193)
  }
  return `${image.width}x${image.height}:${(hash >>> 0).toString(36)}`
}

/** Байты PNG из data URL. Через fetch нельзя: политика безопасности окна не пускает его к data:. */
function dataUrlBytes(src: string): Uint8Array {
  const base64 = src.slice(src.indexOf(',') + 1)
  return Uint8Array.from(atob(base64), (char) => char.charCodeAt(0))
}

interface Thumb {
  body: string
  key: string
  slim: boolean
  modern: boolean
}

const thumbs = new Map<string, Promise<Thumb>>()
function thumb(src: string, model?: SkinModel): Promise<Thumb> {
  const id = `${model ?? ''}|${src}`
  let found = thumbs.get(id)
  if (!found) {
    found = loadImage(src).then((image) => {
      const modern = image.height === 64
      const slim = modern && (model ? model === 'slim' : isSlim(image))
      return { body: bodyDataUrl(image, slim), key: pixelKey(image), slim, modern }
    })
    if (thumbs.size > 300) thumbs.clear()
    thumbs.set(id, found)
  }
  return found
}

function useThumb(src: string | null, model?: SkinModel): Thumb | null {
  const [value, setValue] = useState<Thumb | null>(null)
  useEffect(() => {
    setValue(null)
    if (!src) return
    let alive = true
    void thumb(src, model).then((result) => alive && setValue(result), () => undefined)
    return () => {
      alive = false
    }
  }, [src, model])
  return value
}

const dateFormat = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long' })

function SkinTile(props: { item: SkinItem; picked: boolean; current: boolean; currentKey: string | null; onPick: (item: SkinItem, thumb: Thumb) => void; onRemove?: () => void }) {
  const { item } = props
  const view = useThumb(item.src, item.model)
  const inGame = props.current || (view !== null && props.currentKey === view.key)
  return (
    <div class={props.picked ? 'sk-tile sk-tile-on' : 'sk-tile'}>
      <button class="sk-tile-btn" disabled={!view} aria-pressed={props.picked} onClick={() => view && props.onPick(item, view)}>
        <span class="sk-tile-pic">{view && <img src={view.body} alt="" draggable={false} />}</span>
        <span class="sk-tile-name">{item.name}</span>
        <span class="sk-tile-sub">
          {inGame ? 'Сейчас в игре' : item.addedAt ? dateFormat.format(item.addedAt) : item.model === 'slim' ? 'Тонкие руки' : item.model ? 'Обычные руки' : ''}
        </span>
      </button>
      {inGame && (
        <span class="sk-tile-mark" title="Сейчас в игре">
          <Check size={14} strokeWidth={3} />
        </span>
      )}
      {props.onRemove && !inGame && (
        <button class="sk-tile-remove" title="Убрать из истории" aria-label="Убрать из истории" onClick={props.onRemove}>
          <X size={14} strokeWidth={2.5} />
        </button>
      )}
    </div>
  )
}

/** Вкладка «Скин»: персонаж в 3D, история скинов, стандартные скины Minecraft и скины лицензии по нику. */
export function SkinPage({ skin, standard, onSkin }: { skin: CurrentSkin | null; standard: DefaultSkin | null; onSkin: (skin: CurrentSkin | null) => void }) {
  const input = useRef<HTMLInputElement>(null)
  const [source, setSource] = useState<Source>('history')
  const [history, setHistory] = useState<SkinItem[] | null>(null)
  const [standards, setStandards] = useState<SkinItem[] | null>(null)
  const [picked, setPicked] = useState<Picked | null>(null)
  const [animation, setAnimation] = useState<SkinAnimation>('idle')
  const [busy, setBusy] = useState(false)
  const [dragging, setDragging] = useState(false)
  const [message, setMessage] = useState<{ bad: boolean; text: string } | null>(null)
  const [query, setQuery] = useState('')
  const [found, setFound] = useState<SkinItem[]>([])
  const [searching, setSearching] = useState(false)
  const [notFound, setNotFound] = useState<string | null>(null)

  const inGameSrc = skin?.src ?? standard?.src ?? null
  const inGame = useThumb(inGameSrc)
  const shown = picked?.src ?? inGameSrc

  const reloadHistory = () => void api.getSkinHistory().then(setHistory)
  // История пополняется, когда лаунчер узнаёт скин в игре, поэтому перечитываем её при смене скина.
  useEffect(reloadHistory, [skin?.src])
  useEffect(() => {
    if (source === 'standard' && !standards) void api.getStandardSkins().then(setStandards)
  }, [source])

  const pick = (item: SkinItem, view: Thumb) => {
    setMessage(null)
    // Скин, который и так стоит в игре, примерять незачем: возвращаем персонажа к нему.
    if (view.key === inGame?.key) {
      setPicked(null)
      return
    }
    setPicked({ src: item.src, name: item.name, model: view.slim ? 'slim' : 'wide', modern: view.modern })
  }

  const openFile = async (file: File | undefined) => {
    if (!file) return
    setMessage(null)
    try {
      const url = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => resolve(String(reader.result))
        reader.onerror = () => reject(reader.error)
        reader.readAsDataURL(file)
      })
      const image = await loadImage(url)
      const problem = checkSkinSize(image)
      if (problem) {
        setMessage({ bad: true, text: problem })
        return
      }
      const name = file.name.replace(/\.png$/i, '').slice(0, 40) || 'Скин из файла'
      setPicked({ src: url, name, model: isSlim(image) ? 'slim' : 'wide', modern: image.height === 64 })
    } catch {
      setMessage({ bad: true, text: 'Это не картинка PNG.' })
    } finally {
      if (input.current) input.current.value = ''
    }
  }

  const apply = async () => {
    if (!picked) return
    setBusy(true)
    setMessage(null)
    try {
      const bytes = dataUrlBytes(picked.src)
      const result = await api.uploadSkin(bytes, picked.modern ? picked.model : 'wide', picked.name)
      if (result.ok) {
        setPicked(null)
        onSkin(await api.getSkin())
        reloadHistory()
        setMessage({ bad: false, text: 'Скин поставлен. В игре он появится примерно через минуту, перезаходить не нужно.' })
      } else {
        setMessage({ bad: true, text: result.error })
      }
    } catch {
      setMessage({ bad: true, text: 'Не удалось прочитать скин.' })
    } finally {
      setBusy(false)
    }
  }

  const reset = async () => {
    setBusy(true)
    setMessage(null)
    const result = await api.resetSkin()
    setBusy(false)
    if (result.ok) {
      const current = await api.getSkin()
      onSkin(current)
      setMessage({ bad: false, text: current ? 'Убрали скин из лаунчера. В игре снова скин, поставленный командой /skin.' : 'Вернули стандартный скин.' })
    } else {
      setMessage({ bad: true, text: result.error })
    }
  }

  const search = async (event: Event) => {
    event.preventDefault()
    if (searching) return
    const nick = query.trim()
    if (!/^[A-Za-z0-9_]{1,16}$/.test(nick)) {
      setNotFound('Ник — до 16 латинских букв, цифр и «_».')
      return
    }
    setSearching(true)
    setNotFound(null)
    const item = await api.findSkin(nick)
    setSearching(false)
    if (item === 'busy') {
      setNotFound('Mojang сейчас не отвечает: слишком много запросов. Попробуйте через минуту.')
      return
    }
    if (!item) {
      setNotFound(`У ника ${nick} нет лицензии Minecraft или своего скина.`)
      return
    }
    setFound((list) => [item, ...list.filter((other) => other.id !== item.id)].slice(0, 24))
    const view = await thumb(item.src, item.model)
    pick(item, view)
  }

  const caption = picked
    ? picked.name
    : skin?.fromServer
      ? 'Поставлен командой /skin'
      : skin
        ? 'Ваш скин'
        : standard?.name === 'лицензия Minecraft'
          ? 'Скин лицензии Minecraft'
          : standard
            ? `Стандартный: ${standard.name}`
            : 'Стандартный скин'

  const list = source === 'history' ? history : source === 'standard' ? standards : found
  const counts = useMemo(() => ({ history: history?.length ?? 0 }), [history])

  return (
    <div
      class={dragging ? 'page skin-page skin-drop' : 'page skin-page'}
      onDragOver={(event) => {
        if (event.dataTransfer?.types.includes('Files')) {
          event.preventDefault()
          setDragging(true)
        }
      }}
      onDragLeave={(event) => {
        if (event.currentTarget === event.target) setDragging(false)
      }}
      onDrop={(event) => {
        event.preventDefault()
        setDragging(false)
        void openFile(event.dataTransfer?.files[0])
      }}
    >
      <header class="page-head">
        <h1>Скин</h1>
      </header>
      <div class="skin-layout">
        <section class="skin-stage">
          <div class="skin-caption">
            <div class="skin-caption-text">
              <span class="skin-caption-label">{picked ? 'Примерка' : 'Сейчас в игре'}</span>
              <span class="skin-caption-name">{caption}</span>
            </div>
            {!picked && skin && !skin.fromServer && (
              <button class="btn-quiet skin-reset" disabled={busy} title="Убрать свой скин и вернуть стандартный" onClick={() => void reset()}>
                <RotateCcw size={16} strokeWidth={2.5} />
                {busy ? 'Сбрасываем…' : 'Сбросить'}
              </button>
            )}
          </div>
          {shown ? <Skin3D src={shown} model={picked?.modern ? picked.model : undefined} animation={animation} /> : <p class="skin-empty">Появится после установки игры</p>}
          <div class="segments skin-anims" role="radiogroup" aria-label="Анимация">
            {ANIMATIONS.map(([id, label]) => (
              <button key={id} class={id === animation ? 'segment segment-on' : 'segment'} role="radio" aria-checked={id === animation} onClick={() => setAnimation(id)}>
                {label}
              </button>
            ))}
          </div>
          {picked && (
            <div class="skin-try">
              {picked.modern && (
                <div class="segments skin-arms" role="radiogroup" aria-label="Руки">
                  {(['wide', 'slim'] as const).map((model) => (
                    <button key={model} class={picked.model === model ? 'segment segment-on' : 'segment'} role="radio" aria-checked={picked.model === model} disabled={busy} onClick={() => setPicked({ ...picked, model })}>
                      {model === 'wide' ? 'Обычные руки' : 'Тонкие руки'}
                    </button>
                  ))}
                </div>
              )}
              <div class="skin-try-row">
                <button class="btn btn-update" disabled={busy} onClick={() => void apply()}>
                  <Check size={18} strokeWidth={2.5} />
                  {busy ? 'Ставим…' : 'Поставить скин'}
                </button>
                <button class="btn" disabled={busy} onClick={() => setPicked(null)}>
                  Отмена
                </button>
              </div>
            </div>
          )}
        </section>
        <section class="skin-side">
          <input ref={input} type="file" accept="image/png" hidden onChange={(event) => void openFile(event.currentTarget.files?.[0])} />
          <div class="skin-bar">
            <div class="segments" role="tablist">
              {(
                [
                  ['history', counts.history ? `Мои скины · ${counts.history}` : 'Мои скины'],
                  ['standard', 'Стандартные'],
                  ['nick', 'По нику'],
                ] as [Source, string][]
              ).map(([id, label]) => (
                <button key={id} class={id === source ? 'segment segment-on' : 'segment'} role="tab" aria-selected={id === source} onClick={() => setSource(id)}>
                  {label}
                </button>
              ))}
            </div>
            <button class="btn btn-update" disabled={busy} title="Или перетащите файл на окно" onClick={() => input.current?.click()}>
              <Upload size={18} strokeWidth={2.5} />
              Загрузить PNG
            </button>
          </div>
          {message ? (
            <p class={message.bad ? 'help help-bad' : 'help skin-ok'}>{message.text}</p>
          ) : (
            <p class="help">
              {picked
                ? 'Так скин будет выглядеть в игре. Его увидят все игроки на сервере.'
                : 'Нажмите на скин, чтобы примерить. Свой файл PNG 64×64 можно просто перетащить на окно.'}
            </p>
          )}
          {source === 'nick' && (
            <form class="toolbar" onSubmit={(event) => void search(event)}>
              <input
                class="input toolbar-search"
                placeholder="Ник игрока с лицензией"
                aria-label="Ник игрока"
                value={query}
                maxLength={16}
                spellcheck={false}
                onInput={(event) => setQuery(event.currentTarget.value)}
              />
              <button class="btn" type="submit" disabled={searching || !query.trim()}>
                <Search size={18} strokeWidth={2.5} />
                {searching ? 'Ищем…' : 'Найти'}
              </button>
            </form>
          )}
          {source === 'nick' && notFound && <p class="help help-bad">{notFound}</p>}
          <div class="skin-scroll">
            {list === null ? (
              <p class="help">Загружаем…</p>
            ) : list.length === 0 ? (
              <p class="help skin-none">
                {source === 'history'
                  ? 'Здесь появятся скины, которые вы ставили. К любому можно вернуться в один клик.'
                  : source === 'standard'
                    ? 'Стандартные скины появятся после установки игры.'
                    : 'Найдите любого игрока с лицензией Minecraft и примерьте его скин.'}
              </p>
            ) : (
              <div class="sk-grid">
                {list.map((item) => (
                  <SkinTile
                    key={item.id}
                    item={item}
                    picked={picked?.src === item.src}
                    current={false}
                    currentKey={inGame?.key ?? null}
                    onPick={pick}
                    onRemove={
                      source === 'history'
                        ? () => {
                            void api.forgetSkin(item.id).then(reloadHistory)
                          }
                        : undefined
                    }
                  />
                ))}
              </div>
            )}
          </div>
        </section>
      </div>
      {dragging && (
        <div class="skin-drop-hint">
          <Upload size={28} strokeWidth={2} />
          Отпустите файл, чтобы примерить скин
        </div>
      )}
    </div>
  )
}
