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
const CELL_SIZE_DEG = 0.000009; // ~1m grid cells
const REVEAL_RADIUS_METERS = 6;
const MAX_CELLS = 15000;
const CELLS_KEY = "@fog_cells_v3";
const USER_ID_KEY = "@user_id";
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

function mercatorX(lng: number) { return (lng + 180) / 360; }
function mercatorY(lat: number) {
  const r = (lat * Math.PI) / 180;
  return (1 - Math.log(Math.tan(Math.PI / 4 + r / 2)) / Math.PI) / 2;
}

function makeGeoJSON(features: object[]) {
  return { type: "FeatureCollection" as const, features };
}

function pointFeature(lng: number, lat: number, props: object = {}) {
  return {
    type: "Feature" as const,
    properties: props,
    geometry: { type: "Point" as const, coordinates: [lng, lat] },
  };
}

// ─── Map setup ────────────────────────────────────────────────────────────────

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

  // ── User identity ────────────────────────────────────────────────────────────
  const userIdRef = useRef<string | null>(null);

  // ── GPS ──────────────────────────────────────────────────────────────────────
  const [permStatus, setPermStatus] = useState<"loading" | "denied" | "granted">("loading");
  const [userLocation, setUserLocation] = useState<LngLat | null>(null);
  const userLocationRef = useRef<LngLat | null>(null);
  const subRef = useRef<Location.LocationSubscription | null>(null);
  const cameraRef = useRef<import("@maplibre/maplibre-react-native").CameraRef | null>(null);

  // ── Fog cells ────────────────────────────────────────────────────────────────
  const [cells, setCells] = useState<CellRecord[]>([]);
  const cellSetRef = useRef<Set<string>>(new Set());

  // ── Camera state (for fog projection) ───────────────────────────────────────
  const [cameraState, setCameraState] = useState<CameraState>({ lng: 0, lat: 0, zoom: 17, heading: 0 });

  // ── Multiplayer ──────────────────────────────────────────────────────────────
  const [otherPlayers, setOtherPlayers] = useState<OtherPlayer[]>([]);

  // ── WebSocket ────────────────────────────────────────────────────────────────
  const wsRef = useRef<WebSocket | null>(null);
  const wsReconnectRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastWsSendRef = useRef<number>(0);

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
      }
      if (msg.type === "players") {
        setOtherPlayers((msg.players as OtherPlayer[]).filter((p) => p.userId !== uid));
      }
      if (msg.type === "player_moved") {
        setOtherPlayers((prev) => {
          const updated = { userId: msg.userId, lat: msg.lat, lng: msg.lng };
          const idx = prev.findIndex((p) => p.userId === msg.userId);
          if (idx === -1) return [...prev, updated];
          const next = [...prev];
          next[idx] = updated;
          return next;
        });
      }
      if (msg.type === "player_left") {
        setOtherPlayers((prev) => prev.filter((p) => p.userId !== msg.userId));
      }
    };

    ws.onclose = () => {
      wsReconnectRef.current = setTimeout(() => connectWS(uid), 4000);
    };
  }, []);

  // ── Init: userId + WebSocket ─────────────────────────────────────────────────
  useEffect(() => {
    AsyncStorage.getItem(USER_ID_KEY).then((stored) => {
      const uid = stored ?? `u_${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
      if (!stored) AsyncStorage.setItem(USER_ID_KEY, uid);
      userIdRef.current = uid;
      connectWS(uid);
    });
    return () => {
      wsRef.current?.close();
      if (wsReconnectRef.current) clearTimeout(wsReconnectRef.current);
    };
  }, [connectWS]);

  // ── Fog persistence ───────────────────────────────────────────────────────────
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

  // ── Core: reveal fog + broadcast position ─────────────────────────────────────
  const addPoint = useCallback((lat: number, lng: number) => {
    // Reveal new cell
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

    // Throttled WS position broadcast
    const now = Date.now();
    if (wsRef.current?.readyState === WebSocket.OPEN && now - lastWsSendRef.current > WS_POSITION_INTERVAL_MS) {
      wsRef.current.send(JSON.stringify({ type: "position", userId: userIdRef.current, lat, lng }));
      lastWsSendRef.current = now;
    }
  }, []);

  // ── GPS tracking ─────────────────────────────────────────────────────────────
  useEffect(() => {
    if (isWeb) { setPermStatus("granted"); return; }
    (async () => {
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status !== "granted") { setPermStatus("denied"); return; }
      setPermStatus("granted");

      subRef.current = await Location.watchPositionAsync(
        { accuracy: Location.Accuracy.BestForNavigation, distanceInterval: 1, timeInterval: 500 },
        ({ coords }) => {
          const loc: LngLat = [coords.longitude, coords.latitude];
          userLocationRef.current = loc;
          setUserLocation(loc);
          addPoint(coords.latitude, coords.longitude);

          // Keep camera following the user
          cameraRef.current?.flyTo({ center: loc, zoom: 17, duration: 300 });
        }
      );
    })();
    return () => subRef.current?.remove();
  }, [addPoint]);

  // ── Camera region change (for fog projection) ────────────────────────────────
  const handleRegionChange = useCallback((e: any) => {
    if (!e?.geometry?.coordinates) return;
    const [lng, lat] = e.geometry.coordinates;
    setCameraState({
      lng,
      lat,
      zoom: e.properties?.zoomLevel ?? 17,
      heading: e.properties?.heading ?? 0,
    });
  }, []);

  // ── Center button ─────────────────────────────────────────────────────────────
  const handleCenter = useCallback(() => {
    const loc = userLocationRef.current;
    if (!loc || !cameraRef.current) return;
    cameraRef.current.flyTo({ center: loc, zoom: 17, duration: 500 });
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
  }, []);

  // ── Fog circles (screen-space projection) ─────────────────────────────────────
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

  // ── GeoJSON ──────────────────────────────────────────────────────────────────
  const userGeoJSON = useMemo(
    () => userLocation ? makeGeoJSON([pointFeature(userLocation[0], userLocation[1])]) : makeGeoJSON([]),
    [userLocation]
  );

  const playersGeoJSON = useMemo(
    () => makeGeoJSON(otherPlayers.map((p) => pointFeature(p.lng, p.lat, { userId: p.userId }))),
    [otherPlayers]
  );

  // ── Permission states ─────────────────────────────────────────────────────────

  if (permStatus === "loading") {
    return <View style={styles.center}><ActivityIndicator size="large" color={colors.light.primary} /></View>;
  }

  if (permStatus === "denied") {
    return (
      <View style={[styles.center, { paddingHorizontal: 32 }]}>
        <Feather name="map-pin" size={40} color={colors.light.primary} style={{ marginBottom: 20 }} />
        <Text style={styles.titleText}>Localização necessária</Text>
        <Text style={styles.bodyText}>
          Este app precisa da sua localização para revelar o mapa enquanto você explora.
        </Text>
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

  // ── Map ───────────────────────────────────────────────────────────────────────

  const { Map, Camera, GeoJSONSource, Layer } = ML;

  return (
    <View style={styles.container}>

      {/* Map */}
      <Map
        style={styles.map}
        mapStyle={MAP_STYLE}
        logo={false}
        attribution={false}
        onRegionIsChanging={handleRegionChange}
        onRegionDidChange={handleRegionChange}
      >
        <Camera ref={cameraRef} />

        {/* Current user dot */}
        <GeoJSONSource id="user-src" data={userGeoJSON}>
          <Layer id="user-pulse" type="circle" source="user-src"
            style={{ circleRadius: 20, circleColor: "rgba(34,211,238,0.15)", circleStrokeWidth: 0 }} />
          <Layer id="user-dot" type="circle" source="user-src"
            style={{ circleRadius: 7, circleColor: colors.light.primary, circleStrokeWidth: 2.5, circleStrokeColor: "#ffffff" }} />
        </GeoJSONSource>

        {/* Other players */}
        <GeoJSONSource id="players-src" data={playersGeoJSON}>
          <Layer id="players-dot" type="circle" source="players-src"
            style={{ circleRadius: 6, circleColor: "#a78bfa", circleStrokeWidth: 2, circleStrokeColor: "#ffffff" }} />
        </GeoJSONSource>
      </Map>

      {/* Fog SVG overlay */}
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

      {/* Center FAB — único botão */}
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
