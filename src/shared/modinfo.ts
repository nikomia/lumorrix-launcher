/** Группы и описания клиентских модов по-русски. Новый мод без записи покажет описание из самого мода. */
export const GROUPS = ['Графика', 'Производительность', 'Удобство', 'Анимации', 'Другие'] as const
export type Group = (typeof GROUPS)[number] | 'Исправления'

interface ModText {
  group: Group
  text: string
}

const MODS: Record<string, ModText> = {
  iris: { group: 'Графика', text: 'Шейдеры: красивый свет, тени и вода' },
  lambdynlights: { group: 'Графика', text: 'Факел в руке освещает всё вокруг' },
  betterbiomeblend: { group: 'Графика', text: 'Плавные переходы цвета между биомами' },
  entity_texture_features: { group: 'Графика', text: 'Особые текстуры существ из ресурспаков' },

  sodium: { group: 'Производительность', text: 'Больше кадров и меньше подвисаний' },
  sodium_extra: { group: 'Производительность', text: 'Больше настроек для Sodium' },
  reeses_sodium_options: { group: 'Производительность', text: 'Удобные настройки Sodium' },
  entityculling: { group: 'Производительность', text: 'Не рисует существ и блоки, которых не видно' },
  moreculling: { group: 'Производительность', text: 'Не рисует скрытые части блоков' },
  c2me: { group: 'Производительность', text: 'Ускоряет работу с чанками' },
  badoptimizations: { group: 'Производительность', text: 'Общие оптимизации игры' },
  gpu_booster: { group: 'Производительность', text: 'Ускорение через OpenGL 4' },

  xaerominimap: { group: 'Удобство', text: 'Миникарта в углу экрана' },
  mousetweaks: { group: 'Удобство', text: 'Удобное перекладывание предметов мышью' },
  inventorysorter: { group: 'Удобство', text: 'Сортировка инвентаря' },
  controlling: { group: 'Удобство', text: 'Поиск по настройкам управления' },
  betteradvancements: { group: 'Удобство', text: 'Улучшенный экран достижений' },
  chat_heads: { group: 'Удобство', text: 'Головы игроков рядом с их сообщениями в чате' },
  cwb: { group: 'Удобство', text: 'Полноэкранный режим без рамок' },

  punchy: { group: 'Анимации', text: 'Анимации рук от первого лица' },
  touch_n_motion: { group: 'Анимации', text: 'Живые анимации персонажа' },
  entity_model_features: { group: 'Анимации', text: 'Особые модели и анимации существ' },

  // Исправления всегда включены и в списке не показываются.
  derenderpatcher: { group: 'Исправления', text: '' },
  modelfix: { group: 'Исправления', text: '' },
  apotheosis_tooltip_fix: { group: 'Исправления', text: '' },
}

export const modText = (id: string): ModText | undefined => (Object.hasOwn(MODS, id) ? MODS[id] : undefined)
export const modGroup = (id: string): Group => modText(id)?.group ?? 'Другие'
