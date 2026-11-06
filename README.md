# Лаунчер Lumorrix

Лаунчер сервера Lumorrix для Windows: ставит сборку в пару кликов и позволяет включать и выключать клиентские моды.
Игрок вводит только ник. Пароль и привязка устройства по-прежнему обрабатываются в игре модом авторизации.

## Для игрока

1. Запустить `Lumorrix-Setup-<версия>.exe`.
2. Ввести ник и нажать «Играть». Всё остальное лаунчер скачает сам.

Свой мод можно просто положить в папку модов (кнопка на вкладке «Моды»). Лаунчер такие файлы не удаляет.

Всё лежит в одной папке `%APPDATA%\.lumorrix-launcher`:

| Папка | Что там |
| --- | --- |
| `app` | сам лаунчер |
| `game` | папка игры: моды, конфиги, настройки |
| `minecraft` | версии, библиотеки и ассеты Minecraft |
| `runtime` | Java |
| `data`, `logs`, `tmp` | служебные файлы |

## Скачать и проверить

Скачать: [lumorrix.ru/launcher](https://lumorrix.ru/launcher). Весь исходный код лаунчера лежит здесь, его можно прочитать.

Версия 0.1.0: [отчёт VirusTotal](https://www.virustotal.com/gui/file/91bf16480149460981cedce0e23090266d8e0c434d58600bb67dad9ccac470ad), на 7 ноября 2026 сработало 0 антивирусов из 67.

SHA-256 установщика:

```
91bf16480149460981cedce0e23090266d8e0c434d58600bb67dad9ccac470ad
```

Проверить свой файл в PowerShell, хеш должен совпасть:

```powershell
Get-FileHash .\Lumorrix-Setup.exe -Algorithm SHA256
```

## Сборка

Нужен Node.js 24+. Установщик появится в папке `dist`:

```sh
npm install
npm run dist
```

## Как это связано с модом

Лаунчер сам ставит и обновляет сборку, а мод `lumorrix-updater` при запуске из него файлы не трогает.
В других лаунчерах мод обновляет сборку сам.

## Лицензия

Все права защищены, условия в файле [LICENSE](LICENSE). Код опубликован только для просмотра и проверки: изменять и распространять его нельзя.
Это не лицензия открытого кода.

## Благодарности

- Шрифт [Golos Text](https://github.com/googlefonts/golos-ui), лицензия SIL OFL 1.1 (`src/renderer/assets/golos-OFL.txt`).
- Иконки [Lucide](https://lucide.dev), лицензия ISC.
- Интерфейс переработан по методике [unslop](https://github.com/heydamir/unslop) Дамира Соколовского (@heydamir), CC BY 4.0.

## Чужие материалы

Условия из `LICENSE` на эти файлы не распространяются, права на них принадлежат авторам:

| Файл в `src/renderer/assets` | Источник |
| --- | --- |
| `preset-custom.jpg` | панорама из мода Create, Create Team |
| `preset-quality.jpg` | галерея [Fresh Animations](https://modrinth.com/resourcepack/fresh-animations), автор FreshLX |
| `icon-discord.svg` | логотип Discord из [Simple Icons](https://simpleicons.org) |

Если вы автор и хотите, чтобы файл убрали, напишите в Discord сервера.
