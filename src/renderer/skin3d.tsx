import { useEffect, useRef, useState } from 'preact/hooks'
import { isSlim, loadImage } from './skin'

/**
 * Персонаж Minecraft в 3D из кубов на CSS: без WebGL, потому что в лаунчере отключено аппаратное ускорение.
 * Крутится сам, мышкой можно повернуть.
 */

/** Размер одного пикселя скина на экране. */
const S = 10

interface Box {
  /** Начало развёртки куба на текстуре скина. */
  u: number
  v: number
  w: number
  h: number
  d: number
  /** Центр куба; ось Y смотрит вниз, центр тела — в нуле. */
  x: number
  y: number
  z?: number
  /** На сколько пикселей второй слой (шапка, куртка) больше основного. */
  inflate?: number
  /** Левые рука и нога старых скинов 64×32 — зеркало правых. */
  mirror?: boolean
}

function Face(props: { src: string; texH: number; w: number; h: number; u: number; v: number; transform: string; mirror?: boolean }) {
  const { src, texH, w, h, u, v, transform, mirror } = props
  return (
    <div
      class={mirror ? 'sk-face sk-face-mirror' : 'sk-face'}
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
  const { u, v, w, h, d, x, y, z = 0, inflate = 0, mirror } = box
  const scale = inflate ? ` scale3d(${(w + 2 * inflate) / w}, ${(h + 2 * inflate) / h}, ${(d + 2 * inflate) / d})` : ''
  const common = { src, texH, mirror }
  return (
    <div class="sk-box" style={{ transform: `translate3d(${x * S}px, ${y * S}px, ${z * S}px)${scale}${mirror ? ' scaleX(-1)' : ''}` }}>
      {/* Развёртка куба Minecraft: верх и низ сверху, под ними правый бок, перед, левый бок и спина. */}
      <Face {...common} w={w} h={d} u={u + d} v={v} transform={`rotateX(90deg) translateZ(${(h * S) / 2}px)`} />
      <Face {...common} w={w} h={d} u={u + d + w} v={v} transform={`rotateX(-90deg) translateZ(${(h * S) / 2}px)`} />
      <Face {...common} w={d} h={h} u={u} v={v + d} transform={`rotateY(-90deg) translateZ(${(w * S) / 2}px)`} />
      <Face {...common} w={w} h={h} u={u + d} v={v + d} transform={`translateZ(${(d * S) / 2}px)`} />
      <Face {...common} w={d} h={h} u={u + d + w} v={v + d} transform={`rotateY(90deg) translateZ(${(w * S) / 2}px)`} />
      <Face {...common} w={w} h={h} u={u + 2 * d + w} v={v + d} transform={`rotateY(180deg) translateZ(${(d * S) / 2}px)`} />
    </div>
  )
}

function model(modern: boolean, arm: number): Box[] {
  const armX = 4 + arm / 2
  const base: Box[] = [
    { u: 0, v: 0, w: 8, h: 8, d: 8, x: 0, y: -10 },
    { u: 16, v: 16, w: 8, h: 12, d: 4, x: 0, y: 0 },
    { u: 40, v: 16, w: arm, h: 12, d: 4, x: -armX, y: 0 },
    modern ? { u: 32, v: 48, w: arm, h: 12, d: 4, x: armX, y: 0 } : { u: 40, v: 16, w: arm, h: 12, d: 4, x: armX, y: 0, mirror: true },
    { u: 0, v: 16, w: 4, h: 12, d: 4, x: -2, y: 12 },
    modern ? { u: 16, v: 48, w: 4, h: 12, d: 4, x: 2, y: 12 } : { u: 0, v: 16, w: 4, h: 12, d: 4, x: 2, y: 12, mirror: true },
  ]
  const outer: Box[] = [{ u: 32, v: 0, w: 8, h: 8, d: 8, x: 0, y: -10, inflate: 0.5 }]
  if (modern) {
    outer.push(
      { u: 16, v: 32, w: 8, h: 12, d: 4, x: 0, y: 0, inflate: 0.25 },
      { u: 40, v: 32, w: arm, h: 12, d: 4, x: -armX, y: 0, inflate: 0.25 },
      { u: 48, v: 48, w: arm, h: 12, d: 4, x: armX, y: 0, inflate: 0.25 },
      { u: 0, v: 32, w: 4, h: 12, d: 4, x: -2, y: 12, inflate: 0.25 },
      { u: 0, v: 48, w: 4, h: 12, d: 4, x: 2, y: 12, inflate: 0.25 },
    )
  }
  return [...base, ...outer]
}

/** Скорость самостоятельного поворота, градусов в секунду. */
const SPIN = 24

export function Skin3D({ src }: { src: string }) {
  const [shape, setShape] = useState<{ modern: boolean; arm: number } | null>(null)
  const [angle, setAngle] = useState(-25)
  const drag = useRef<{ x: number; start: number } | null>(null)
  const idleUntil = useRef(0)

  useEffect(() => {
    let alive = true
    void loadImage(src).then(
      (image) => alive && setShape({ modern: image.height === 64, arm: isSlim(image) ? 3 : 4 }),
      () => alive && setShape(null),
    )
    return () => {
      alive = false
    }
  }, [src])

  useEffect(() => {
    const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches
    if (reduce) return
    let frame = 0
    let last = performance.now()
    const tick = (now: number) => {
      const dt = (now - last) / 1000
      last = now
      if (!drag.current && now > idleUntil.current) setAngle((value) => (value + SPIN * dt) % 360)
      frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [])

  if (!shape) return <div class="sk-stage" />
  const texH = shape.modern ? 64 : 32
  return (
    <div
      class="sk-stage"
      title="Поверните мышкой"
      onPointerDown={(event) => {
        drag.current = { x: event.clientX, start: angle }
        event.currentTarget.setPointerCapture(event.pointerId)
      }}
      onPointerMove={(event) => {
        if (drag.current) setAngle(drag.current.start + (event.clientX - drag.current.x) * 0.6)
      }}
      onPointerUp={() => {
        drag.current = null
        idleUntil.current = performance.now() + 2500
      }}
    >
      <div class="sk-model" style={{ transform: `translateY(${-2 * S}px) rotateX(-12deg) rotateY(${angle}deg)` }}>
        {model(shape.modern, shape.arm).map((box, i) => (
          <Cube key={i} box={box} src={src} texH={texH} />
        ))}
      </div>
    </div>
  )
}
