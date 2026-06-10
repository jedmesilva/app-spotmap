# Fog of War Map

App mobile de exploração onde o usuário anda pelo mundo real e vai revelando o mapa por onde passa — como o "fog of war" de jogos de estratégia.

## Run & Operate

- `pnpm --filter @workspace/fog-map run dev` — run the Expo app (port dynamic)
- `pnpm --filter @workspace/api-server run dev` — run the API server (port 5000)
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- Mobile: Expo SDK 54 + Expo Router 6 (file-based routing)
- Map: `@maplibre/maplibre-react-native` v11 (named exports: `Map`, `Camera`, `GeoJSONSource`, `Layer`)
- Tiles: OpenFreeMap liberty style (free, no API key required)
- GPS: `expo-location` with `Accuracy.BestForNavigation`
- Storage: `@react-native-async-storage/async-storage`
- API: Express 5 (shared backend)
- DB: PostgreSQL + Drizzle ORM

## Where things live

- `artifacts/fog-map/` — Expo mobile app
- `artifacts/fog-map/app/(tabs)/index.tsx` — main map screen (fog of war logic)
- `artifacts/fog-map/constants/colors.ts` — dark explorer theme tokens
- `artifacts/api-server/` — Express API server
- `lib/api-spec/openapi.yaml` — API contract (source of truth)

## Architecture decisions

- **MapLibre v11 API**: Named exports (`Map`, `Camera`, `GeoJSONSource`, `Layer`), not the old default-export style. No `setAccessToken` in v11.
- **Fog via GeoJSON Polygon holes**: World bounding polygon as outer ring (CCW), revealed circles as inner rings / holes (CW). Updates in real time as GPS changes.
- **No Mapbox token needed**: Uses OpenFreeMap tiles (`https://tiles.openfreemap.org/styles/liberty`), free and open-source.
- **Requires development build**: `@maplibre/maplibre-react-native` is a native module, not Expo Go compatible. Must use a custom development build or Expo Launch.
- **GPS sampling**: Every 8 meters (`distanceInterval: 8`), using `BestForNavigation` accuracy for ~1m precision.

## Product

- Full-screen map with dark fog overlay that gets cut away as the user physically walks around
- Reveals 50m radius circles around every GPS sample point
- Stats HUD: distance traveled, area revealed, number of points
- Pause/resume tracking, reset progress (with confirmation)
- Center-on-user button
- All progress persisted to AsyncStorage

## User preferences

_Populate as you build — explicit user instructions worth remembering across sessions._

## Gotchas

- MapLibre v11 prop names: `logo={false}`, `attribution={false}`, `compass` (not logoEnabled/attributionEnabled/compassEnabled)
- Camera ref type: `CameraRef` from `@maplibre/maplibre-react-native`; use `flyTo({ center, zoom, duration })`
- On web/Expo Go preview the app shows a fallback message — native build required for map to render
- GeoJSON polygon winding: outer ring CCW, holes CW (RFC 7946)
