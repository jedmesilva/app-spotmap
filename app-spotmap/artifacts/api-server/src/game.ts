import { WebSocket } from "ws";

// ─── Collectible generation (deterministic, seeded by grid position) ──────────

const GRID = 0.005; // ~500m per grid cell

export interface Collectible {
  id: string;
  lat: number;
  lng: number;
  type: "common" | "rare";
}

function fnv1a(values: number[]): number {
  let h = 2166136261;
  for (const v of values) {
    const bytes = [v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >> 24) & 0xff];
    for (const b of bytes) {
      h ^= b;
      h = Math.imul(h, 16777619) >>> 0;
    }
  }
  return h / 4294967295;
}

function seededRandom(la: number, lo: number): number {
  return fnv1a([Math.round(la * 10000), Math.round(lo * 10000)]);
}

/** Returns all collectibles within ~3km of the given position */
export function getCollectiblesNear(lat: number, lng: number): Collectible[] {
  const radius = 0.03; // ~3km
  const items: Collectible[] = [];

  const latStart = Math.floor((lat - radius) / GRID) * GRID;
  const lngStart = Math.floor((lng - radius) / GRID) * GRID;
  const latEnd = Math.ceil((lat + radius) / GRID) * GRID;
  const lngEnd = Math.ceil((lng + radius) / GRID) * GRID;

  for (let la = latStart; la <= latEnd; la = +(la + GRID).toFixed(6)) {
    for (let lo = lngStart; lo <= lngEnd; lo = +(lo + GRID).toFixed(6)) {
      const h = seededRandom(la, lo);
      if (h >= 0.25) continue; // 25% density

      const jLat = (seededRandom(la + 1, lo) - 0.5) * GRID * 0.7;
      const jLng = (seededRandom(la, lo + 1) - 0.5) * GRID * 0.7;

      items.push({
        id: `c_${la.toFixed(4)}_${lo.toFixed(4)}`,
        lat: +(la + jLat).toFixed(6),
        lng: +(lo + jLng).toFixed(6),
        type: h < 0.04 ? "rare" : "common",
      });
    }
  }

  return items;
}

// ─── Player state ──────────────────────────────────────────────────────────────

export interface Player {
  userId: string;
  lat: number;
  lng: number;
  ws: WebSocket;
}

export const players = new Map<string, Player>();

/** Items that have been collected globally (itemId → userId) */
export const collectedItems = new Map<string, string>();

export function playerList(excludeUserId?: string) {
  const result: { userId: string; lat: number; lng: number }[] = [];
  for (const p of players.values()) {
    if (p.userId !== excludeUserId) {
      result.push({ userId: p.userId, lat: p.lat, lng: p.lng });
    }
  }
  return result;
}

export function broadcast(data: object, excludeUserId?: string) {
  const msg = JSON.stringify(data);
  for (const p of players.values()) {
    if (p.userId !== excludeUserId && p.ws.readyState === WebSocket.OPEN) {
      p.ws.send(msg);
    }
  }
}

export function broadcastAll(data: object) {
  broadcast(data, undefined);
}
