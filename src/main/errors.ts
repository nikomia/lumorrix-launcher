/** Ошибка, понятная игроку: что случилось и что можно сделать. Стектрейсы остаются в логе. */
export class UserError extends Error {
  constructor(
    public readonly title: string,
    message: string,
    public readonly options: { canPlayOld?: boolean; cause?: unknown } = {},
  ) {
    super(message)
    this.name = 'UserError'
  }
}

/** Игрок нажал «Отменить». Это не ошибка: сообщение показывать не нужно. */
export class Cancelled extends Error {
  constructor() {
    super('Отменено')
    this.name = 'Cancelled'
  }
}

export const NETWORK_HINT ='Проверьте интернет и попробуйте ещё раз.'
