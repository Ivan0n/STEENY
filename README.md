# STEENY Desktop

Кроссплатформенный Electron-клиент музыкального сервиса STEENY.

Клиент открывает существующий веб-интерфейс backend и добавляет нативные
возможности: системный трей, управление окном, постоянную сессию, открытие
ссылок в браузере, Discord Rich Presence и реакцию интерфейса на питание от
батареи.

## Требования

- Node.js 22.12 или новее
- запущенный STEENY backend

## Запуск

```bash
npm install
npm start
```

По умолчанию используется `http://127.0.0.1:5000`. Другой адрес можно указать
переменной окружения:

```bash
STEENY_URL=https://music.example.com npm start
```

Для запуска с открытыми DevTools:

```bash
npm run dev
```

## Проверка и сборка

```bash
npm run check
npm run pack
```

Готовые дистрибутивы создаются в `dist/`:

```bash
npm run dist:linux
npm run dist:win
```

Windows-сборку рекомендуется запускать на Windows или в CI с Windows runner.
На Linux можно запустить AppImage напрямую или установить `.deb`:

```bash
chmod +x dist/STEENY-*-linux-*.AppImage
./dist/STEENY-*-linux-*.AppImage

sudo apt install ./dist/STEENY-*-linux-*.deb
```

## Безопасность

- Node.js не доступен коду страницы (`nodeIntegration: false`).
- Интерфейс получает только ограниченный API через изолированный preload.
- Главное окно может переходить только на origin, заданный в `STEENY_URL`.
- Внешние HTTP/HTTPS-ссылки открываются системным браузером.
- Разрешение media выдаётся только локальному интерфейсу и только для аудио.

Сессия и cookies хранятся в отдельном постоянном Electron-профиле `steeny`.

## Старый клиент

Предыдущая реализация на PyQt сохранена в `legacy/` только для истории и
аварийного отката. Основной клиент запускается командами npm.
