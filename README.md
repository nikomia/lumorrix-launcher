# Лаунчер Lumorrix

Лаунчер сервера Lumorrix для Windows, macOS и Linux: ставит сборку в пару кликов и позволяет включать и выключать клиентские моды.
Игрок вводит только ник. Пароль и привязка устройства по-прежнему обрабатываются в игре модом авторизации.

## Для игрока

1. Windows: запустить `Lumorrix-Setup-<версия>.exe`.
   macOS: распаковать `Lumorrix-<версия>-mac-<arm64 или x64>.zip` и перенести `Lumorrix.app` в «Программы».
   Сборка не подписана, поэтому при первом запуске нажать на приложение правой кнопкой → «Открыть».
   Linux: запустить `Lumorrix-<версия>-linux-x86_64.AppImage` или распаковать `.tar.gz` и запустить `lumorrix`.
2. Ввести ник и нажать «Играть». Всё остальное лаунчер скачает сам.

Свой мод можно просто положить в папку модов (кнопка на вкладке «Моды»). Лаунчер такие файлы не удаляет.

Всё лежит в одной папке: Windows — `%APPDATA%\.lumorrix-launcher`,
macOS — `~/Library/Application Support/lumorrix-launcher`, Linux — `~/.local/share/lumorrix-launcher`:

| Папка | Что там |
| --- | --- |
| `app` | сам лаунчер |
| `game` | папка игры: моды, конфиги, настройки |
| `minecraft` | версии, библиотеки и ассеты Minecraft |
| `runtime` | Java |
| `data`, `logs`, `tmp` | служебные файлы |

## Скачать и проверить

Скачать: [lumorrix.ru/launcher](https://lumorrix.ru/launcher). Весь исходный код лаунчера лежит здесь, его можно прочитать.

Версия 0.3.3: [отчёт VirusTotal](https://www.virustotal.com/gui/file/62f0133a0aaf23109f99a59a687b8f3ab4d66edd6331afe018996208935ff157), на 12 ноября 2026 сработало 0 антивирусов из 69.

SHA-256 установщика:

```
62f0133a0aaf23109f99a59a687b8f3ab4d66edd6331afe018996208935ff157
```

Проверить свой файл в PowerShell, хеш должен совпасть:

```powershell
Get-FileHash .\Lumorrix-Setup.exe -Algorithm SHA256
```

## Скины

Вкладка «Скин» загружает PNG 64×64 или 64×32 на сайт: `https://lumorrix.ru/skins/<ник>.png`. В игре скины показывает
клиентский мод CustomSkinLoader из сборки. Ник закрепляется за лаунчером, который первым поставил ему скин
(ключ лежит в `data/skin-key.txt`). Если игрок переустановил лаунчер, администратор снимает закрепление на сайте.

## Сборка

Нужен Node.js 24+. Сборки появятся в папке `dist`:

```sh
npm install
npm run dist        # Windows
npm run dist:mac    # macOS (собирать на Mac)
npm run dist:linux  # Linux
```

На Windows и Linux Java приходит с сервера вместе с клиентом. На macOS и Linux лаунчер скачивает Java 21 (Eclipse Temurin)
под систему игрока, а библиотеки с нативным кодом — с серверов Mojang.

## Фон главной

Фон — облёт мира сервера `src/renderer/assets/flyover.mp4` (видео AV1, без звука, крутится по кругу). Пока видео
не началось или в системе включено «уменьшение движения», виден `hero.webp`. Чтобы поставить другой облёт,
замените `flyover.mp4` (или положите `flyover.webm`). Если файла нет, фоном остаётся картинка.

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
