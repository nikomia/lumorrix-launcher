/** Загрузка скина, определение тонких рук и голова для панели слева. */

export function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image()
    image.onload = () => resolve(image)
    image.onerror = () => reject(new Error('Не удалось открыть картинку'))
    image.src = src
  })
}

/** Тонкие руки (модель Алекс): у такого скина пустой пиксель на месте четвёртого столбца руки. */
export function isSlim(image: HTMLImageElement): boolean {
  if (image.height !== 64) return false
  const canvas = document.createElement('canvas')
  canvas.width = 64
  canvas.height = 64
  const ctx = canvas.getContext('2d')
  if (!ctx) return false
  ctx.drawImage(image, 0, 0)
  return ctx.getImageData(54, 20, 1, 1).data[3] === 0
}

/** Голова со слоем шапки, для кнопки ника в панели слева. */
export function headDataUrl(image: HTMLImageElement, size = 64): string {
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d')
  if (!ctx) return ''
  ctx.imageSmoothingEnabled = false
  ctx.drawImage(image, 8, 8, 8, 8, 0, 0, size, size)
  ctx.drawImage(image, 40, 8, 8, 8, 0, 0, size, size)
  return canvas.toDataURL('image/png')
}

/**
 * Персонаж спереди в полный рост со вторым слоем, для плиток со скинами. Картинка 16×32 пикселя скина × scale.
 * У старых скинов 64×32 левые рука и нога — зеркало правых.
 */
export function bodyDataUrl(image: HTMLImageElement, slim = isSlim(image), scale = 4): string {
  const canvas = document.createElement('canvas')
  canvas.width = 16 * scale
  canvas.height = 32 * scale
  const ctx = canvas.getContext('2d')
  if (!ctx) return ''
  ctx.imageSmoothingEnabled = false
  ctx.scale(scale, scale)
  const modern = image.height === 64
  const arm = slim && modern ? 3 : 4
  const part = (sx: number, sy: number, w: number, h: number, dx: number, dy: number, mirror = false) => {
    if (!mirror) {
      ctx.drawImage(image, sx, sy, w, h, dx, dy, w, h)
      return
    }
    ctx.save()
    ctx.translate(dx + w, dy)
    ctx.scale(-1, 1)
    ctx.drawImage(image, sx, sy, w, h, 0, 0, w, h)
    ctx.restore()
  }
  for (const base of modern ? [true, false] : [true]) {
    part(base ? 8 : 40, 8, 8, 8, 4, 0)
    // Шапка есть и у старых скинов, у них нет только второго слоя тела.
    if (!modern) part(40, 8, 8, 8, 4, 0)
    part(20, base ? 20 : 36, 8, 12, 4, 8)
    part(44, base ? 20 : 36, arm, 12, 4 - arm, 8)
    if (modern) part(base ? 36 : 52, 52, arm, 12, 12, 8)
    else part(44, 20, arm, 12, 12, 8, true)
    part(4, base ? 20 : 36, 4, 12, 4, 20)
    if (modern) part(base ? 20 : 4, 52, 4, 12, 8, 20)
    else part(4, 20, 4, 12, 8, 20, true)
  }
  return canvas.toDataURL('image/png')
}
