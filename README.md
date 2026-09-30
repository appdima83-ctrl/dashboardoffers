# Статистика ProfitCash

Запуск: `cp .env.example .env`, заполнить `DASH_PASSWORD` и `SESSION_SECRET`, затем `node server.js` → http://localhost:3000

- `public/` — фронтенд (PWA). Данных в нём нет.
- `server.js` — пароль (сессия в HttpOnly-cookie, 5 попыток/мин), API, будущий прокси к Affise.
- `demo.js` — демо-данные и снимок офферов; отдаются только после входа.
- Хостинг: нужен Node-хостинг (Render, Railway, Fly.io, Cloud Run). Задайте переменные окружения из `.env.example`, `.env` не заливайте в git. Только HTTPS.
- Статический хостинг (Firebase Hosting, GitHub Pages) для защищённой версии не подходит.
- Данные запрашиваются заново при каждом открытии/обновлении страницы, кнопке «Обновить» и возврате на вкладку (>60 с).
