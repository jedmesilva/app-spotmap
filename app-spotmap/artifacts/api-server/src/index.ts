import { createServer } from "http";
import { WebSocketServer, WebSocket } from "ws";
import app from "./app";
import { logger } from "./lib/logger";
import {
  players,
  collectedItems,
  getCollectiblesNear,
  playerList,
  broadcast,
  broadcastAll,
} from "./game";

const rawPort = process.env["PORT"];
if (!rawPort) throw new Error("PORT environment variable is required");
const port = Number(rawPort);
if (Number.isNaN(port) || port <= 0) throw new Error(`Invalid PORT: "${rawPort}"`);

const httpServer = createServer(app);

const wss = new WebSocketServer({ server: httpServer, path: "/api/ws" });

wss.on("connection", (ws: WebSocket) => {
  let userId: string | null = null;

  ws.on("message", (raw) => {
    let msg: { type: string; userId?: string; lat?: number; lng?: number; itemId?: string };
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    if (msg.type === "join" && msg.userId) {
      userId = msg.userId;
      const lat = msg.lat ?? 0;
      const lng = msg.lng ?? 0;

      players.set(userId, { userId, lat, lng, ws });
      logger.info({ userId, lat, lng }, "Player joined");

      // Send initial game state to the new player
      const nearby = getCollectiblesNear(lat, lng).filter(
        (c) => !collectedItems.has(c.id)
      );
      ws.send(
        JSON.stringify({
          type: "init",
          collectibles: nearby,
          players: playerList(userId),
        })
      );

      // Tell everyone else this player joined
      broadcast({ type: "players", players: playerList() }, userId);
    }

    if (msg.type === "position" && userId) {
      const player = players.get(userId);
      if (!player) return;
      const lat = msg.lat ?? player.lat;
      const lng = msg.lng ?? player.lng;
      player.lat = lat;
      player.lng = lng;

      // Refresh collectibles for new area
      const nearby = getCollectiblesNear(lat, lng).filter(
        (c) => !collectedItems.has(c.id)
      );
      ws.send(JSON.stringify({ type: "collectibles", collectibles: nearby }));

      // Broadcast movement to others
      broadcast({ type: "player_moved", userId, lat, lng }, userId);
    }

    if (msg.type === "collect" && userId && msg.itemId) {
      const { itemId } = msg;
      if (collectedItems.has(itemId)) return;
      collectedItems.set(itemId, userId);
      logger.info({ userId, itemId }, "Item collected");
      broadcastAll({ type: "item_collected", itemId, userId });
    }
  });

  ws.on("close", () => {
    if (userId) {
      players.delete(userId);
      logger.info({ userId }, "Player left");
      broadcast({ type: "player_left", userId });
    }
  });

  ws.on("error", (err) => {
    logger.error({ err }, "WebSocket error");
  });
});

httpServer.listen(port, (err?: Error) => {
  if (err) {
    logger.error({ err }, "Error listening");
    process.exit(1);
  }
  logger.info({ port }, "Server listening");
});
