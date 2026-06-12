import AsyncStorage from "@react-native-async-storage/async-storage";
import { Feather } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";
import * as Location from "expo-location";
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  ActivityIndicator,
  Platform,
  StyleSheet,
  Text,
  TouchableOpacity,
  useWindowDimensions,
  View,
} from "react-native";
import Svg, { Circle, Defs, Mask, RadialGradient, Rect, Stop } from "react-native-svg";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import colors from "@/constants/colors";

// ─── Constants ───────────────────────────────────────────────────────────────

const FOG_COLOR = "rgba(13, 17, 27, 0.92)";

// ~1m grid cells for meter-by-meter revelation
const CELL_SIZE_DEG = 0.000009;
const REVEAL_RADIUS_METERS = 6;
const MAX_CELLS = 15000;
const CELLS_KEY = "@fog_cells_v3";
const USER_ID_KEY = "@user_id";

// Collectible collection radius in meters
const COLLECT_RADIUS_METERS = 10;

// Send GPS to server at most every 3 seconds
const WS_POSITION_INTERVAL_MS = 3000;

// ─── Types ───────────────────────────────────────────────────────────────────

type LngLat = [number, number];

interface CameraState {
  lng: number;
  lat: number;
  zoom: number;
  heading: number;
}

interface CellRecord {
  id: string;
  lat: number;
  lng: number;
}

interface Collectible {
  id: string;
  lat: number;
  lng: number;
  type: "common" | "rare";
}

interface OtherPlayer {
  userId: string;
  lat: number;
  lng: number;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function getCellRecord(lat: number, lng: number): CellRecord {
  const cLat = Math.round(lat / CELL_SIZE_DEG) * CELL_SIZE_DEG;
  const cLng = Math.round(lng / CELL_SIZE_DEG) * CELL_SIZE_DEG;
  return { id: `${cLat.toFixed(7)}_${cLng.toFixed(7)}`, lat: cLat, lng: cLng };
}

function haversine(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371000;
  const φ1 = (lat1 * Math.PI) / 180;
  const φ2 = (lat2 * Math.PI) / 180;
  const Δφ = ((lat2 - lat1) * Math.PI) / 180;
  const Δλ = ((lng2 - lng1) * Math.PI) / 180;
  const a = Math.sin(Δφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function mercatorX(lng: number) { return (lng + 180) / 360; }
function mercatorY(lat: number) {
  const r = (lat * Math.PI) / 180;
  return (1 - Math.log(Math.tan(Math.PI / 4 + r / 2)) / Math.PI) / 2;
}

function makeGeoJSON(features: object[]) {
  return { type: "FeatureCollection" as const, features };
}

function pointFeature(lng: number, lat: number, props: object = {}) {
  return { type: "Feature" as const, properties: props, geometry: { type: "Point" as const, coordinates: [lng, lat] } };
}

// ─── Map bootstrap ────────────────────────────────────────────────────────────

const MAP_STYLE = "https://tiles.openfreemap.org/styles/liberty";
const isWeb = (Platform.OS as string) === "web";

let ML: typeof import("@maplibre/maplibre-react-native") | null = null;
if (!isWeb) {
  try { ML = require("@maplibre/maplibre-react-native"); } catch { ML = null; }
}

// ─── Component ───────────────────────────────────────────────────────────────

export default function MapScreen() {
  const insets = useSafeAreaInsets();
  const { width: screenW, height: screenH } = useWindowDimensions();

  // ── Auth / identity ─────────────────────────────────────────────────────────
  const [userId, setUserId] = useState<string | null>(null);
  const userIdRef = useRef<string | null>(null);

  // ── GPS ─────────────────────────────────────────────────────────────────────
  const [permStatus, setPermStatus] = useState<"loading" | "denied" | "granted">("loading");
  const [userLocation, setUserLocation] = useState<LngLat | null>(null);
  const userLocationRef = useRef<LngLat | null>(null);
  const subRef = useRef<Location.LocationSubscription | null>(null);
  const cameraRef = useRef<import("@maplibre/maplibre-react-native").CameraRef | null>(null);
  const initialCentered = useRef(false);

  // ── Fog cells ───────────────────────────────────────────────────────────────
  const [cells, setCells] = useState<CellRecord[]>([]);
  const cellSetRef = useRef<Set<string>>(new Set());

  // ── Multiplayer ─────────────────────────────────────────────────────────────
  const [otherPlayers, setOtherPlayers] = useState<OtherPlayer[]>([]);

  // ── Collectibles ────────────────────────────────────────────────────────────
  const [collectibles, setCollectibles] = useState<Collectible[]>([]);
  const collectiblesRef = useRef<Collectible[]>([]);
  const [collectedIds, setCollectedIds] = useState<Set<string>>(new Set());
  const collectedIdsRef = useRef<Set<string>>(new Set());

  // ── Camera ──────────────────────────────────────────────────────────────────
  const [cameraState, setCameraState] = useState<CameraState>({ lng: 0, lat: 0, zoom: 15, heading: 0 });

  // ── WebSocket ───────────────────────────────────────────────────────────────
  const wsRef = useRef<WebSocket | null>(null);
  const wsReconnectRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastWsSendRef = useRef<number>(0);

  // Sync collectibles/collected to refs so addPoint closure is always fresh
  useEffect(() => { collectiblesRef.current = collectibles; }, [collectibles]);
  useEffect(() => { collectedIdsRef.current = collectedIds; }, [collectedIds]);

  // ── WebSocket connection ─────────────────────────────────────────────────────

  const connectWS = useCallback((uid: string) => {
    const domain = process.env.EXPO_PUBLIC_DOMAIN;
    if (!domain) return;
    if (wsRef.current?.readyState === WebSocket.OPEN) return;

    const ws = new WebSocket(`wss://${domain}/api/ws`);
    wsRef.current = ws;

    ws.onopen = () => {
      const loc = userLocationRef.current;
      ws.send(JSON.stringify({
        type: "join",
        userId: uid,
        lat: loc?.[1] ?? 0,
        lng: loc?.[0] ?? 0,
      }));
    };

    ws.onmessage = (e) => {
      let msg: any;
      try { msg = JSON.parse(e.data as string); } catch { return; }

      if (msg.type === "init") {
        setOtherPlayers((msg.players as OtherPlayer[]).filter((p) => p.userId !== uid));
        setCollectibles(msg.collectibles as Collectible[]);
      }
      if (msg.type === "collectibles") {
        setCollectibles(msg.collectibles as Collectible[]);
      }
      if (msg.type === "players") {
        setOtherPlayers((msg.players as OtherPlayer[]).filter((p) => p.userId !== uid));
      }
      if (msg.type === "player_moved") {
        setOtherPlayers((prev) => {
          const idx = prev.findIndex((p) => p.userId === msg.userId);
          const updated = { userId: msg.userId, lat: msg.lat, lng: msg.lng };
          if (idx === -1) return [...prev, updated];
          const next = [...prev];
          next[idx] = updated;
          return next;
        });
      }
      if (msg.type === "player_left") {
        setOtherPlayers((prev) => prev.filter((p) => p.userId !== msg.userId));
      }
      if (msg.type === "item_collected") {
        setCollectedIds((prev) => new Set([...prev, msg.itemId as string]));
      }
    };

    ws.onclose = () => {
      wsReconnectRef.current = setTimeout(() => connectWS(uid), 4000);
    };
  }, []);

  // ── userId init ─────────────────────────────────────────────────────────────

  useEffect(() => {
    AsyncStorage.getItem(USER_ID_KEY).then((stored) => {
      const uid = stored ?? `u_${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
      if (!stored) AsyncStorage.setItem(USER_ID_KEY, uid);
      userIdRef.current = uid;
      setUserId(uid);
      connectWS(uid);
    });
    return () => {
      wsRef.current?.close();
      if (wsReconnectRef.current) clearTimeout(wsReconnectRef.current);
    };
  }, [connectWS]);

  // ── Fog persistence ─────────────────────────────────────────────────────────

  useEffect(() => {
    AsyncStorage.getItem(CELLS_KEY).then((raw) => {
      if (!raw) return;
      try {
        const saved: CellRecord[] = JSON.parse(raw);
        setCells(saved);
        cellSetRef.current = new Set(saved.map((c) => c.id));
      } catch { /* ignore */ }
    });
  }, []);

  useEffect(() => {
    if (cells.length > 0) {
      AsyncStorage.setItem(CELLS_KEY, JSON.stringify(cells)).catch(() => {});
    }
  }, [cells]);

  // ── Core GPS handler ─────────────────────────────────────────────────────────

  const addPoint = useCallback((lat: number, lng: number) => {
    // Reveal fog cell
    const cell = getCellRecord(lat, lng);
    if (!cellSetRef.current.has(cell.id)) {
      cellSetRef.current.add(cell.id);
      setCells((prev) => {
        if (prev.length >= MAX_CELLS) {
          cellSetRef.current.delete(prev[0].id);
          return [...prev.slice(1), cell];
        }
        return [...prev, cell];
      });
    }

    // Auto-collect nearby items
    const nearby = collectiblesRef.current.filter(
      (c) => !collectedIdsRef.current.has(c.id) && haversine(lat, lng, c.lat, c.lng) < COLLECT_RADIUS_METERS
    );
    if (nearby.length > 0) {
      for (const item of nearby) {
        collectedIdsRef.current.add(item.id);
        if (wsRef.current?.readyState === WebSocket.OPEN) {
          wsRef.current.send(JSON.stringify({ type: "collect", userId: userIdRef.current, itemId: item.id }));
        }
      }
      setCollectedIds(new Set(collectedIdsRef.current));
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    }

    // Throttled position broadcast
    const now = Date.now();
    if (wsRef.current?.readyState === WebSocket.OPEN && now - lastWsSendRef.current > WS_POSITION_INTERVAL_MS) {
      wsRef.current.send(JSON.stringify({ type: "position", userId: userIdRef.current, lat, lng }));
      lastWsSendRef.current = now;
    }
  }, []);

  // ── GPS tracking ────────────────────────────────────────────────────────────

  useEffect(() => {
    if (isWeb) { setPermStatus("granted"); return; }
    (async () => {
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status !== "granted") { setPermStatus("denied"); return; }
      setPermStatus("granted");
      subRef.current = await Location.watchPositionAsync(
        { accuracy: Location.Accuracy.BestForNavigation, distanceInterval: 1, timeInterval: 500 },
        ({ coords }) => {
          const { latitude: lat, longitude: lng } = coords;
          const loc: LngLat = [lng, lat];
          userLocationRef.current = loc;
          setUserLocation(loc);
          addPoint(lat, lng);
          if (!initialCentered.current && cameraRef.current) {
            initialCentered.current = true;
            cameraRef.current.flyTo({ center: loc, zoom: 17, duration: 800 });
          }
        }
      );
    })();
    return () => subRef.current?.remove();
  }, [addPoint]);

  // ── Camera sync ──────────────────────────────────────────────────────────────

  const handleRegionChange = useCallback((e: any) => {
    if (!e?.geometry?.coordinates) return;
    const [lng, lat] = e.geometry.coordinates;
    setCameraState({ lng, lat, zoom: e.properties?.zoomLevel ?? 15, heading: e.properties?.heading ?? 0 });
  }, []);

  // ── Center on user ───────────────────────────────────────────────────────────

  const handleCenter = useCallback(() => {
    if (!userLocationRef.current || !cameraRef.current) return;
    cameraRef.current.flyTo({ center: userLocationRef.current, zoom: 17, duration: 500 });
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
  }, []);

  // ── Fog circles (screen space) ───────────────────────────────────────────────

  const fogCircles = useMemo(() => {
    if (cells.length === 0) return [];
    const { lng: cLng, lat: cLat, zoom, heading } = cameraState;
    const scale = Math.pow(2, zoom) * 256;
    const cx = mercatorX(cLng) * scale;
    const cy = mercatorY(cLat) * scale;
    const metersPerPx = (2 * Math.PI * 6378137 * Math.cos((cLat * Math.PI) / 180)) / scale;
    const r = REVEAL_RADIUS_METERS / metersPerPx;
    const bearingRad = (heading * Math.PI) / 180;
    const cosB = Math.cos(bearingRad);
    const sinB = Math.sin(bearingRad);
    const margin = r * 2;
    const result: { x: number; y: number; r: number }[] = [];
    for (const cell of cells) {
      const px = mercatorX(cell.lng) * scale;
      const py = mercatorY(cell.lat) * scale;
      const dx = px - cx;
      const dy = py - cy;
      const sx = screenW / 2 + dx * cosB + dy * sinB;
      const sy = screenH / 2 - dx * sinB + dy * cosB;
      if (sx + r < -margin || sx - r > screenW + margin) continue;
      if (sy + r < -margin || sy - r > screenH + margin) continue;
      result.push({ x: sx, y: sy, r });
    }
    return result;
  }, [cells, cameraState, screenW, screenH]);

  // ── GeoJSON for map layers ───────────────────────────────────────────────────

  const userGeoJSON = useMemo(
    () => userLocation ? makeGeoJSON([pointFeature(userLocation[0], userLocation[1])]) : makeGeoJSON([]),
    [userLocation]
  );

  const playersGeoJSON = useMemo(
    () => makeGeoJSON(otherPlayers.map((p) => pointFeature(p.lng, p.lat, { userId: p.userId }))),
    [otherPlayers]
  );

  const collectiblesGeoJSON = useMemo(
    () => makeGeoJSON(
      collectibles
        .filter((c) => !collectedIds.has(c.id))
        .map((c) => pointFeature(c.lng, c.lat, { id: c.id, type: c.type }))
    ),
    [collectibles, collectedIds]
  );

  // ── Render: permission states ────────────────────────────────────────────────

  if (permStatus === "loading") {
    return <View style={styles.center}><ActivityIndicator size="large" color={colors.light.primary} /></View>;
  }

  if (permStatus === "denied") {
    return (
      <View style={[styles.center, { paddingHorizontal: 32 }]}>
        <Feather name="map-pin" size={40} color={colors.light.primary} style={{ marginBottom: 20 }} />
        <Text style={styles.titleText}>Localização necessária</Text>
        <Text style={styles.bodyText}>Este app precisa da sua localização para revelar o mapa enquanto você explora.</Text>
        <TouchableOpacity
          style={styles.btn}
          onPress={async () => {
            const { status } = await Location.requestForegroundPermissionsAsync();
            if (status === "granted") setPermStatus("granted");
          }}
        >
          <Text style={styles.btnText}>Permitir</Text>
        </TouchableOpacity>
      </View>
    );
  }

  if (isWeb || !ML) {
    return (
      <View style={[styles.center, { paddingHorizontal: 32 }]}>
        <Feather name="smartphone" size={40} color={colors.light.primary} style={{ marginBottom: 20 }} />
        <Text style={styles.titleText}>Use no celular</Text>
        <Text style={styles.bodyText}>Escaneie o QR code no Expo Go para explorar o mundo.</Text>
      </View>
    );
  }

  // ── Render: map ──────────────────────────────────────────────────────────────

  const { Map, Camera, GeoJSONSource, Layer } = ML;

  return (
    <View style={styles.container}>

      {/* ── Map ── */}
      <Map
        style={styles.map}
        mapStyle={MAP_STYLE}
        logo={false}
        attribution={false}
        compass
        onRegionIsChanging={handleRegionChange}
        onRegionDidChange={handleRegionChange}
      >
        <Camera ref={cameraRef} />

        {/* Current user */}
        <GeoJSONSource id="user-src" data={userGeoJSON}>
          <Layer id="user-pulse" type="circle" source="user-src"
            style={{ circleRadius: 18, circleColor: "rgba(34,211,238,0.18)", circleStrokeWidth: 0 }} />
          <Layer id="user-dot" type="circle" source="user-src"
            style={{ circleRadius: 7, circleColor: colors.light.primary, circleStrokeWidth: 2.5, circleStrokeColor: "#fff" }} />
        </GeoJSONSource>

        {/* Other players */}
        <GeoJSONSource id="players-src" data={playersGeoJSON}>
          <Layer id="players-dot" type="circle" source="players-src"
            style={{ circleRadius: 6, circleColor: "#a78bfa", circleStrokeWidth: 2, circleStrokeColor: "#fff" }} />
        </GeoJSONSource>

        {/* Collectibles */}
        <GeoJSONSource id="items-src" data={collectiblesGeoJSON}>
          <Layer id="items-rare" type="circle" source="items-src"
            filter={["==", ["get", "type"], "rare"]}
            style={{ circleRadius: 8, circleColor: "#f97316", circleStrokeWidth: 2, circleStrokeColor: "#fff" }} />
          <Layer id="items-common" type="circle" source="items-src"
            filter={["==", ["get", "type"], "common"]}
            style={{ circleRadius: 6, circleColor: "#facc15", circleStrokeWidth: 1.5, circleStrokeColor: "#fff" }} />
        </GeoJSONSource>
      </Map>

      {/* ── Fog SVG overlay ── */}
      <View style={StyleSheet.absoluteFill} pointerEvents="none">
        <Svg width={screenW} height={screenH}>
          <Defs>
            <RadialGradient id="rg" cx="50%" cy="50%" r="50%" gradientUnits="objectBoundingBox">
              <Stop offset="0%"   stopColor="black" stopOpacity="1" />
              <Stop offset="80%"  stopColor="black" stopOpacity="1" />
              <Stop offset="100%" stopColor="black" stopOpacity="0" />
            </RadialGradient>
            <Mask id="fog-mask">
              <Rect x="0" y="0" width={screenW} height={screenH} fill="white" />
              {fogCircles.map((c, i) => (
                <Circle key={i} cx={c.x} cy={c.y} r={c.r} fill="url(#rg)" />
              ))}
            </Mask>
          </Defs>
          <Rect x="0" y="0" width={screenW} height={screenH} fill={FOG_COLOR} mask="url(#fog-mask)" />
        </Svg>
      </View>

      {/* ── Center FAB ── */}
      <TouchableOpacity
        style={[styles.fab, { bottom: insets.bottom + 20, right: 16 }]}
        onPress={handleCenter}
      >
        <Feather name="crosshair" size={22} color={colors.light.primary} />
      </TouchableOpacity>

    </View>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#0d111b" },
  map: { flex: 1 },
  center: { flex: 1, backgroundColor: "#0d111b", alignItems: "center", justifyContent: "center" },
  titleText: { fontSize: 22, fontWeight: "700" as const, color: "#f8fafc", marginBottom: 10, textAlign: "center" },
  bodyText: { fontSize: 15, color: "#94a3b8", textAlign: "center", lineHeight: 22, marginBottom: 28 },
  btn: { backgroundColor: colors.light.primary, borderRadius: 12, paddingVertical: 14, paddingHorizontal: 32 },
  btnText: { color: "#fff", fontWeight: "600" as const, fontSize: 16 },
  fab: {
    position: "absolute",
    width: 50, height: 50, borderRadius: 25,
    backgroundColor: "rgba(13,17,27,0.92)",
    alignItems: "center", justifyContent: "center",
    borderWidth: 1, borderColor: "rgba(255,255,255,0.12)",
  },
});
