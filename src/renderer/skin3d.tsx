import type { ComponentChildren } from 'preact'
import { useEffect, useRef, useState } from 'preact/hooks'
import type { SkinModel } from '../shared/types'
import { isSlim, loadImage } from './skin'

/**
 * Персонаж Minecraft в 3D из кубов на CSS: без WebGL, потому что в лаунчере отключено аппаратное ускорение.
 * Части тела висят на суставах (шея, плечи, бёдра), поэтому двигаются, как в игре: ходьба, бег, взмах рукой.
 * Крутится сам, мышкой можно повернуть.
 */

/** Размер одного пикселя скина на экране. */
const S = 8

export type SkinAnimation = 'idle' | 'walk' | 'run' | 'wave' | 'sneak' | 'dance'

export const ANIMATIONS: [SkinAnimation, string][] = [
  ['idle', 'Стоит'],
  ['walk', 'Идёт'],
  ['run', 'Бежит'],
  ['wave', 'Машет'],
  ['sneak', 'Крадётся'],
  ['dance', 'Танцует'],
]

interface Box {
  /** Начало развёртки куба на текстуре скина. */
  u: number
  v: number
  w: number
  h: number
  d: number
  /** Центр куба относительно сустава; ось Y смотрит вниз. */
  x?: number
  y: number
  /** На сколько пикселей второй слой (шапка, куртка) больше основного. */
  inflate?: number
  /** Левые рука и нога старых скинов 64×32 — зеркало правых. */
  mirror?: boolean
}

/** Освещение граней, как в игре: верх светлее всего, бока и спина темнее, низ темнее всего. */
type Light = 'top' | 'bottom' | 'side' | 'front'

function Face(props: { src: string; texH: number; w: number; h: number; u: number; v: number; transform: string; mirror?: boolean; light: Light }) {
  const { src, texH, w, h, u, v, transform, mirror, light } = props
  return (
    <div
      class={`sk-face sk-${light}${mirror ? ' sk-face-mirror' : ''}`}
      style={{
        width: `${w * S}px`,
        height: `${h * S}px`,
        marginLeft: `${(-w * S) / 2}px`,
        marginTop: `${(-h * S) / 2}px`,
        backgroundImage: `url(${src})`,
        backgroundSize: `${64 * S}px ${texH * S}px`,
        backgroundPosition: `${-u * S}px ${-v * S}px`,
        transform,
      }}
    />
  )
}

function Cube({ box, src, texH }: { box: Box; src: string; texH: number }) {
  const { u, v, w, h, d, x = 0, y, inflate = 0, mirror } = box
  const scale = inflate ? ` scale3d(${(w + 2 * inflate) / w}, ${(h + 2 * inflate) / h}, ${(d + 2 * inflate) / d})` : ''
  const common = { src, texH, mirror }
  return (
    <div class="sk-box" style={{ transform: `translate3d(${x * S}px, ${y * S}px, 0)${scale}${mirror ? ' scaleX(-1)' : ''}` }}>
      {/* Развёртка куба Minecraft: верх и низ сверху, под ними правый бок, перед, левый бок и спина. */}
      <Face {...common} light="top" w={w} h={d} u={u + d} v={v} transform={`rotateX(90deg) translateZ(${(h * S) / 2}px)`} />
      <Face {...common} light="bottom" w={w} h={d} u={u + d + w} v={v} transform={`rotateX(-90deg) translateZ(${(h * S) / 2}px)`} />
      <Face {...common} light="side" w={d} h={h} u={u} v={v + d} transform={`rotateY(-90deg) translateZ(${(w * S) / 2}px)`} />
      <Face {...common} light="front" w={w} h={h} u={u + d} v={v + d} transform={`translateZ(${(d * S) / 2}px)`} />
      <Face {...common} light="side" w={d} h={h} u={u + d + w} v={v + d} transform={`rotateY(90deg) translateZ(${(w * S) / 2}px)`} />
      <Face {...common} light="side" w={w} h={h} u={u + 2 * d + w} v={v + d} transform={`rotateY(180deg) translateZ(${(d * S) / 2}px)`} />
    </div>
  )
}

type Part = 'upper' | 'head' | 'armR' | 'armL' | 'legR' | 'legL'
const PARTS: Part[] = ['upper', 'head', 'armR', 'armL', 'legR', 'legL']

/** Повороты частей тела в градусах; legZ и drop — сдвиги в пикселях скина. */
interface Pose {
  /** Туловище с головой и руками, наклон вокруг бёдер. */
  upperX: number
  upperY: number
  headX: number
  headY: number
  headZ: number
  armRX: number
  armRZ: number
  armLX: number
  armLZ: number
  legRX: number
  legRZ: number
  legLX: number
  legLZ: number
  /** Ноги назад, когда персонаж крадётся. */
  legZ: number
  /** Всё тело ниже на столько (минус — выше). */
  drop: number
}

const ZERO: Pose = {
  upperX: 0, upperY: 0, headX: 0, headY: 0, headZ: 0, armRX: 0, armRZ: 0, armLX: 0, armLZ: 0,
  legRX: 0, legRZ: 0, legLX: 0, legLZ: 0, legZ: 0, drop: 0,
}
const KEYS = Object.keys(ZERO) as (keyof Pose)[]
const DEG = 180 / Math.PI

/**
 * Поза в момент t (секунды). Ходьба и бег — по формулам игры (HumanoidModel): ноги качаются на ±1,4·сила рад,
 * руки — на ±сила рад, в противофазе к ногам. Правые рука и нога скина на экране слева.
 */
function pose(animation: SkinAnimation, t: number): Pose {
  // Дыхание, как у игрока, который стоит: руки чуть отходят от тела и покачиваются.
  const breathZ = (Math.cos(t * 1.8) * 0.05 + 0.05) * DEG
  const breathX = Math.sin(t * 1.34) * 0.05 * DEG
  const p: Pose = { ...ZERO, headY: Math.sin(t * 0.6) * 12, armRX: breathX, armRZ: breathZ, armLX: -breathX, armLZ: -breathZ }
  if (animation === 'walk' || animation === 'run') {
    const run = animation === 'run'
    const phase = t * (run ? 11 : 6.5)
    const amount = run ? 0.9 : 0.55
    const leg = Math.cos(phase) * 1.4 * amount * DEG
    const arm = Math.cos(phase + Math.PI) * amount * DEG
    p.legRX = leg
    p.legLX = -leg
    p.armRX += arm
    p.armLX -= arm
    p.headY = 0
    p.headX = run ? 6 : 0
    p.upperX = run ? -6 : 0
    // Шаг приподнимает тело: выше всего оно, когда ноги рядом.
    p.drop = -Math.abs(Math.sin(phase)) * (run ? 0.9 : 0.35)
  } else if (animation === 'wave') {
    p.armRZ = 150 + Math.sin(t * 9) * 22
    p.armRX = 0
    p.headZ = -Math.sin(t * 9) * 3 - 4
    p.headY = -10
  } else if (animation === 'sneak') {
    // Как присед в игре: туловище наклонено на 0,5 рад, руки чуть вперёд, голова смотрит прямо и по сторонам.
    p.upperX = -28.6
    p.headX = 22
    p.headY = Math.sin(t * 1.2) * 18
    p.armRX += 23
    p.armLX += 23
    p.legZ = -2.6
    p.drop = 1.6
  } else if (animation === 'dance') {
    const phase = t * 6.4
    const beat = Math.sin(phase)
    p.drop = -Math.abs(beat) * 1.1
    p.upperY = Math.sin(phase / 2) * 14
    p.headY = -Math.sin(phase / 2) * 10
    p.headZ = beat * 7
    p.armRZ = 70 + 65 * beat
    p.armLZ = -(70 - 65 * beat)
    p.armRX = 0
    p.armLX = 0
    p.legRZ = 6 + 6 * beat
    p.legLZ = -6 + 6 * beat
  }
  return p
}

/** Плечо на 5 пикселей от середины тела, бедро — на 1,95, как в игре. */
function partTransform(part: Part, p: Pose): string {
  switch (part) {
    case 'upper':
      return `translate3d(0, ${6 * S}px, 0) rotateY(${p.upperY}deg) rotateX(${p.upperX}deg)`
    case 'head':
      return `translate3d(0, ${-12 * S}px, 0) rotateY(${p.headY}deg) rotateX(${p.headX}deg) rotateZ(${p.headZ}deg)`
    case 'armR':
      return `translate3d(${-5 * S}px, ${-10 * S}px, 0) rotateZ(${p.armRZ}deg) rotateX(${p.armRX}deg)`
    case 'armL':
      return `translate3d(${5 * S}px, ${-10 * S}px, 0) rotateZ(${p.armLZ}deg) rotateX(${p.armLX}deg)`
    case 'legR':
      return `translate3d(${-1.95 * S}px, ${6 * S}px, ${p.legZ * S}px) rotateZ(${p.legRZ}deg) rotateX(${p.legRX}deg)`
    case 'legL':
      return `translate3d(${1.95 * S}px, ${6 * S}px, ${p.legZ * S}px) rotateZ(${p.legLZ}deg) rotateX(${p.legLX}deg)`
  }
}

/** Кубы частей тела относительно их суставов. */
function boxes(modern: boolean, arm: number): Record<Part, Box[]> {
  // Центр руки шириной 4 (у тонких 3) на 1 (0,5) пиксель дальше от тела, чем плечо.
  const armShift = arm / 2 - 1
  const layer = (box: Box) => (modern ? [box] : [])
  return {
    upper: [
      { u: 16, v: 16, w: 8, h: 12, d: 4, y: -6 },
      ...layer({ u: 16, v: 32, w: 8, h: 12, d: 4, y: -6, inflate: 0.25 }),
    ],
    head: [
      { u: 0, v: 0, w: 8, h: 8, d: 8, y: -4 },
      { u: 32, v: 0, w: 8, h: 8, d: 8, y: -4, inflate: 0.5 },
    ],
    armR: [
      { u: 40, v: 16, w: arm, h: 12, d: 4, x: -armShift, y: 4 },
      ...layer({ u: 40, v: 32, w: arm, h: 12, d: 4, x: -armShift, y: 4, inflate: 0.25 }),
    ],
    armL: modern
      ? [
          { u: 32, v: 48, w: arm, h: 12, d: 4, x: armShift, y: 4 },
          { u: 48, v: 48, w: arm, h: 12, d: 4, x: armShift, y: 4, inflate: 0.25 },
        ]
      : [{ u: 40, v: 16, w: arm, h: 12, d: 4, x: armShift, y: 4, mirror: true }],
    legR: [
      { u: 0, v: 16, w: 4, h: 12, d: 4, x: -0.05, y: 6 },
      ...layer({ u: 0, v: 32, w: 4, h: 12, d: 4, x: -0.05, y: 6, inflate: 0.25 }),
    ],
    legL: modern
      ? [
          { u: 16, v: 48, w: 4, h: 12, d: 4, x: 0.05, y: 6 },
          { u: 0, v: 48, w: 4, h: 12, d: 4, x: 0.05, y: 6, inflate: 0.25 },
        ]
      : [{ u: 0, v: 16, w: 4, h: 12, d: 4, x: 0.05, y: 6, mirror: true }],
  }
}

/** Скорость самостоятельного поворота, градусов в секунду. */
const SPIN = 22

export function Skin3D(props: { src: string; model?: SkinModel; animation?: SkinAnimation; spin?: boolean }) {
  const { src, animation = 'idle', spin = true } = props
  const [shape, setShape] = useState<{ modern: boolean; arm: number } | null>(null)
  const model = useRef<HTMLDivElement>(null)
  const parts = useRef<Partial<Record<Part, HTMLDivElement | null>>>({})
  const angle = useRef(-25)
  const drag = useRef<{ x: number; start: number } | null>(null)
  const idleUntil = useRef(0)
  const wanted = useRef({ animation, spin })
  wanted.current = { animation, spin }

  useEffect(() => {
    let alive = true
    void loadImage(src).then(
      (image) => {
        if (!alive) return
        const modern = image.height === 64
        const slim = modern && (props.model ? props.model === 'slim' : isSlim(image))
        setShape({ modern, arm: slim ? 3 : 4 })
      },
      () => alive && setShape(null),
    )
    return () => {
      alive = false
    }
  }, [src, props.model])

  useEffect(() => {
    if (!shape) return
    const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches
    const current = pose('idle', 0)
    let frame = 0
    let last = performance.now()
    const tick = (now: number) => {
      const dt = Math.min((now - last) / 1000, 0.1)
      last = now
      const { animation: anim, spin: turn } = wanted.current
      if (turn && !reduce && !drag.current && now > idleUntil.current) angle.current = (angle.current + SPIN * dt) % 360
      // Новая анимация не дёргает персонажа, а плавно перетекает из прошлой позы.
      const target = reduce && anim === 'idle' ? pose('idle', 0) : pose(anim, now / 1000)
      const k = Math.min(1, dt * 9)
      for (const key of KEYS) current[key] += (target[key] - current[key]) * k
      for (const part of PARTS) {
        const element = parts.current[part]
        if (element) element.style.transform = partTransform(part, current)
      }
      if (model.current) {
        model.current.style.transform = `translateY(${(current.drop - 2) * S}px) rotateX(-12deg) rotateY(${angle.current}deg)`
      }
      frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [shape])

  if (!shape) return <div class="sk-stage" />
  const texH = shape.modern ? 64 : 32
  const cubes = boxes(shape.modern, shape.arm)
  const group = (part: Part, children?: ComponentChildren) => (
    <div
      class="sk-box"
      ref={(element) => {
        parts.current[part] = element
      }}
    >
      {cubes[part].map((box, i) => (
        <Cube key={i} box={box} src={src} texH={texH} />
      ))}
      {children}
    </div>
  )
  return (
    <div
      class="sk-stage"
      title="Поверните мышкой"
      onPointerDown={(event) => {
        drag.current = { x: event.clientX, start: angle.current }
        event.currentTarget.setPointerCapture(event.pointerId)
      }}
      onPointerMove={(event) => {
        if (drag.current) angle.current = drag.current.start + (event.clientX - drag.current.x) * 0.6
      }}
      onPointerUp={() => {
        drag.current = null
        idleUntil.current = performance.now() + 2500
      }}
    >
      <div class="sk-model" ref={model} key={`${src}-${shape.arm}`}>
        <div class="sk-shadow" />
        {group('upper', [group('head'), group('armR'), group('armL')])}
        {group('legR')}
        {group('legL')}
      </div>
    </div>
  )
}
