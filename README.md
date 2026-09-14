# Kaizeno v2

Аниме-платформа нового поколения: **весь каталог**, **прямой HLS с CDN без прокси**,
**гео-гейт** («запрещённые» тайтлы доступны только при выходе из РФ) и **мгновенный рендер**
даже при недоступном источнике.

> Полностью пересоздан с нуля (greenfield): новый движок, новый дизайн, никакой копии
> старого проекта. HLS-прокси больше нет — из-за него старый сайт давал 403 и ~16s на сегмент.

## Стек

- **Next.js 16** (App Router, RSC, Turbopack, Server Actions) + React 19 + TypeScript
- **Tailwind CSS v4** (`@theme`-токены, тёмная тема + акцент «электрик-лайм»)
- **Prisma 7 + PostgreSQL 17** (портативный, в `.infra/`) — только user-data
- **hls.js** — воспроизведение напрямую с CDN AniLiberty
- Источник: **AniLiberty** (`aniliberty.top/api/v1`)

## Установка и запуск (локально, Windows)

```powershell
npm install

# 1. Поднять локальный Postgres (портативные бинарники в .infra/, данные в .infra/pgdata)
npm run db:setup      # initdb (если нет) + start + migrate + seed
# или по шагам: npm run db:init; npm run db:start; npx prisma migrate dev; npx prisma generate; npx prisma db seed

# 2. Запустить сайт
npm run dev           # разработка, http://localhost:3000
# или прод:
npm run build
npm start             # http://localhost:3000

# 3. Остановить БД (когда не нужна)
npm run db:stop       # status: npm run db:status
```

Требования: **Node 20+**, **PowerShell** (скрипты БД написаны на PS), интернет для AniLiberty
и шрифтов. Если порт 5433 занят — смените порт в `scripts/*.ps1`, `.env` и `src/lib/db/prisma.ts`.

## Конфигурация (`.env`)

| Переменная | По умолчанию | Назначение |
|---|---|---|
| `DATABASE_URL` | `postgresql://postgres@localhost:5433/kaizeno` | Строка подключения Postgres |
| `ANILIBRIA_BASE_URL` | `https://aniliberty.top/api/v1` | Базовый URL источника |
| `GEO_OVERRIDE_COUNTRY` | — | Принудительная страна для гео-гейта (dev и self-host; задавайте через `.env`, т.к. переменные окружения процесса могут не дойти до `next start`) |

## Скрипты

| Команда | Действие |
|---|---|
| `npm run dev` / `build` / `start` | Next.js lifecycle |
| `npm run db:init` | `initdb` (идемпотентно, только первый раз) |
| `npm run db:start` / `db:stop` / `db:status` | Управление Postgres |
| `npm run db:setup` | init + start + migrate + seed |
| `npm run db:create` | Создать БД `kaizeno` (если не создана) |
| `npm run typecheck` | `tsc --noEmit` |

## Архитектура

```
App Router (RSC)
  ├── Каталог  /catalog        — search + genres + pagination
  ├── Тайтл    /title/[id]     — hero + эпизоды + плеер (geo-gate)
  ├── Избранное /favorites     — закладки по deviceId-cookie
  └── Главная  /                — «Продолжить просмотр» + «Избранное» + «Новинки»

Данные
  ├── AniLiberty (mem TTL → disk cache → upstream, stale-while-revalidate)
  ├── PostgreSQL (Prisma 7 + driver adapter): favorites, progress, restricted, settings
  └── Geo-гейт (IP → ipwho.is/ipinfo.io → region RU|WORLD)

Плеер
  └── hls.js client (ssr:false) — источники {1080,720,480}p напрямую с CDN,
      resume (последняя позиция) и троттлинг сохранения прогресса (15s)
```

### Data layer (`src/lib/anilibria*.{ts…}`)

Слои по ключу: in-memory TTL → disk `.cache/` (atomic) → upstream под single-flight + семафор.
TTL: каталог mem 10m / disk 6h; релиз mem 1h / disk 24h; latest mem 5m / disk 1h.
Любой сбой upstream проваливается в stale-кэш, иначе — типизированная ошибка с `error.tsx`
(кнопка «Повторить»). **Страницы не падают от недоступности источника.**

### Geo-гейт (`src/lib/geo/`)

- `getRegion()` — `React.cache`, override-порядок: заголовок `x-kaizeno-geo` (dev) →
  `GEO_OVERRIDE_COUNTRY` → IP→страна (ipwho.is, резерв ipinfo.io) → **fail-closed RU**.
- Тайтл restricted, если `is_blocked_by_geo || age_rating.is_adult || RestrictedTitle(id)`.
- RU + restricted → бейдж «Недоступно в вашем регионе» и блок плеера с пояснением про VPN
  (страна выхода ≠ РФ). Не-RU → полный доступ. Локальный список запрещённых
  поддерживается вручную в `src/lib/restricted/banned-list.json` (сидится в БД,
  при выключенной БД работает JSON-фолбэк).

### Favorites + progress (M7)

- Анонимный идентификатор — cookie `kaizeno_device` (httpOnly, 13 месяцев).
  Чтение в RSC (`readDeviceId`), создание только в Server Actions (`ensureDeviceId`);
  это Next-16 правило: модификация cookies разрешена лишь в Server Functions.
- Серверные действия в `src/actions/`: `toggleFavorite`, `getFavorites`,
  `saveProgress` (upsert), `getProgress`, `getResumeList`. БД вне пути рендера:
  всё fail-soft (недоступный Postgres → пустые списки, никогда 500).
- Resume: плеер прыгает на сохранённую позицию эпизода, прогресс пишется раз в 15s.

## Производительность

- **Прямой HLS**: никакого серверного прокси — hls.js тянет m3u8 и сегменты с
  `cache-rfn.libria.fun` напрямую (CORS разрешён). Первый m3u8 приходит в RSC-пейлоаде.
- **Холодный старт**: `npm start` отдаёт первый каталог/тайтл за ~1s (БД и API не в пути);
  старый сайт грелся на 57s.
- **Кэши**: трёхуровневый (mem/disk/упstream) с stale-while-revalidate; диск кэширует
  только успешные ответы, никогда не блокирует рендер.

## Ограничения

- Поиск/жанры/пагинация зависят от AniLiberty: если источник лежит — каталог отдаст
  последний свежий кэш, а неизвестные тайтлы будут недоступны (но сайт работает).
- Флаг `f[is_blocked_by_geo]` не фильтруется на стороне API — гейт считается per-title
  при рендере (union с локальным списком).
- Favorites и прогресс живут в локальном Postgres — при выключенной БД кнопки молчат,
  страницы не падают.

## Дорожная карта (что дальше)

- [ ] Авторизация (вместо анонимного cookie)
- [ ] Продвинутый VPN-детект (ASN/тип подключения по ipwho.is `connection`)
- [ ] Синхронизация прогресса между устройствами
- [ ] Экспорт/импорт списка избранного