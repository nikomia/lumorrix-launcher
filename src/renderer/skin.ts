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
