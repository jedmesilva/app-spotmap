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
  Alert,
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

const FOG_FILL_COLOR = "rgba(13, 17, 27, 0.90)";

// Grid cell size in degrees.
// ~0.000009° ≈ 1m at equator — each meter the user walks gets its own cell.
const CELL_SIZE_DEG = 0.000009;

// Visual reveal radius around each revealed cell center (meters).
// Small radius = tight trail, exactly where the user walked.
const REVEAL_RADIUS_METERS = 6;

// Sliding window cap — with 1m cells, 15000 cells ≈ 15km of trail.
const MAX_CELLS = 15000;

const STORAGE_KEY = "@fog_map_cells_v3";

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

// ─── Grid helpers ─────────────────────────────────────────────────────────────

/**
 * Snap a GPS coordinate to the nearest cell center.
 * Returns a stable string ID and the center lat/lng of that cell.
 */
function getCellRecord(lat: number, lng: number): CellRecord {
  const cellLat = Math.round(lat / CELL_SIZE_DEG) * CELL_SIZE_DEG;
  const cellLng = Math.round(lng / CELL_SIZE_DEG) * CELL_SIZE_DEG;
  const id = `${cellLat.toFixed(7)}_${cellLng.toFixed(7)}`;
  return { id, lat: cellLat, lng: cellLng };
}

// ─── Geo helpers ──────────────────────────────────────────────────────────────

function haversine(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371000;
  const φ1 = (lat1 * Math.PI) / 180;
  const φ2 = (lat2 * Math.PI) / 180;
  const Δφ = ((lat2 - lat1) * Math.PI) / 180;
  const Δλ = ((lng2 - lng1) * Math.PI) / 180;
  const a = Math.sin(Δφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function mercatorX(lng: number): number {
  return (lng + 180) / 360;
}
function mercatorY(lat: number): number {
  const rad = (lat * Math.PI) / 180;
  return (1 - Math.log(Math.tan(Math.PI / 4 + rad / 2)) / Math.PI) / 2;
}

function buildUserGeoJSON(coord: LngLat) {
  return {
    type: "FeatureCollection" as const,
    features: [{
      type: "Feature" as const,
      properties: {},
      geometry: { type: "Point" as const, coordinates: coord },
    }],
  };
}

function formatDistance(meters: number): string {
  if (meters < 1000) return `${Math.round(meters)} m`;
  return `${(meters / 1000).toFixed(2)} km`;
}

function formatArea(numCells: number): string {
  const areaM2 = numCells * Math.PI * REVEAL_RADIUS_METERS ** 2;
  if (areaM2 < 10000) return `${Math.round(areaM2)} m²`;
  return `${(areaM2 / 1_000_000).toFixed(4)} km²`;
}

// ─── Map config ───────────────────────────────────────────────────────────────

const MAP_STYLE = "https://tiles.openfreemap.org/styles/liberty";
const isWeb = (Platform.OS as string) === "web";

let ML: typeof import("@maplibre/maplibre-react-native") | null = null;
if (!isWeb) {
  try {
    ML = require("@maplibre/maplibre-react-native");
  } catch {
    ML = null;
  }
}

// ─── Component ───────────────────────────────────────────────────────────────

export default function MapScreen() {
  const insets = useSafeAreaInsets();
  const { width: screenW, height: screenH } = useWindowDimensions();

  const [permStatus, setPermStatus] = useState<"loading" | "denied" | "granted">("loading");
  const [userLocation, setUserLocation] = useState<LngLat | null>(null);

  // Ordered list of revealed cells (for sliding window + rendering)
  const [cells, setCells] = useState<CellRecord[]>([]);
  // Fast dedup lookup — kept in sync with cells array
  const cellSetRef = useRef<Set<string>>(new Set());

  const [totalDistance, setTotalDistance] = useState(0);
  const [isTracking, setIsTracking] = useState(true);
  const [cameraState, setCameraState] = useState<CameraState>({ lng: 0, lat: 0, zoom: 15, heading: 0 });

  const lastPosRef = useRef<{ lat: number; lng: number } | null>(null);
  const subscriptionRef = useRef<Location.LocationSubscription | null>(null);
  const cameraRef = useRef<import("@maplibre/maplibre-react-native").CameraRef | null>(null);
  const initialCenterSet = useRef(false);

  // ── Persistence ────────────────────────────────────────────────────────────

  useEffect(() => {
    AsyncStorage.getItem(STORAGE_KEY).then((raw) => {
      if (!raw) return;
      try {
        const saved: CellRecord[] = JSON.parse(raw);
        setCells(saved);
        cellSetRef.current = new Set(saved.map((c) => c.id));
      } catch { /* ignore corrupt data */ }
    });
  }, []);

  useEffect(() => {
    if (cells.length > 0) {
      AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(cells)).catch(() => {});
    }
  }, [cells]);

  // ── GPS → grid cell revelation ─────────────────────────────────────────────

  const addPoint = useCallback((lat: number, lng: number) => {
    // Distance tracking on every GPS event
    if (lastPosRef.current) {
      const d = haversine(lastPosRef.current.lat, lastPosRef.current.lng, lat, lng);
      if (d > 0) setTotalDistance((prev) => prev + d);
    }
    lastPosRef.current = { lat, lng };

    // Snap to grid cell — same location always gives same ID
    const cell = getCellRecord(lat, lng);
    if (cellSetRef.current.has(cell.id)) return; // already revealed, nothing to do

    cellSetRef.current.add(cell.id);
    setCells((prev) => {
      if (prev.length >= MAX_CELLS) {
        // Sliding window: drop oldest cell
        const removed = prev[0];
        cellSetRef.current.delete(removed.id);
        return [...prev.slice(1), cell];
      }
      return [...prev, cell];
    });
  }, []);

  // ── Location tracking ──────────────────────────────────────────────────────

  const startTracking = useCallback(async () => {
    subscriptionRef.current?.remove();
    subscriptionRef.current = null;
    try {
      const sub = await Location.watchPositionAsync(
        { accuracy: Location.Accuracy.BestForNavigation, distanceInterval: 1, timeInterval: 500 },
        (loc) => {
          const { latitude: lat, longitude: lng } = loc.coords;
          setUserLocation([lng, lat]);
          addPoint(lat, lng);
          if (!initialCenterSet.current && cameraRef.current) {
            initialCenterSet.current = true;
            cameraRef.current.flyTo({ center: [lng, lat], zoom: 17, duration: 800 });
          }
        }
      );
      subscriptionRef.current = sub;
    } catch {
      setPermStatus("denied");
    }
  }, [addPoint]);

  const stopTracking = useCallback(() => {
    subscriptionRef.current?.remove();
    subscriptionRef.current = null;
  }, []);

  useEffect(() => {
    if (isWeb) { setPermStatus("granted"); return; }
    (async () => {
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status !== "granted") { setPermStatus("denied"); return; }
      setPermStatus("granted");
      startTracking();
    })();
    return () => subscriptionRef.current?.remove();
  }, []);

  useEffect(() => {
    if (isWeb) return;
    if (permStatus !== "granted") return;
    if (isTracking) startTracking(); else stopTracking();
  }, [isTracking]);

  // ── Camera tracking ────────────────────────────────────────────────────────

  const handleRegionChange = useCallback((e: any) => {
    if (!e?.geometry?.coordinates) return;
    const [lng, lat] = e.geometry.coordinates;
    setCameraState({
      lng,
      lat,
      zoom: e.properties?.zoomLevel ?? 15,
      heading: e.properties?.heading ?? 0,
    });
  }, []);

  // ── Fog circles in screen space ────────────────────────────────────────────

  const fogCircles = useMemo(() => {
    if (cells.length === 0) return [];

    const { lng: cLng, lat: cLat, zoom, heading } = cameraState;
    const scale = Math.pow(2, zoom) * 256;
    const cx = mercatorX(cLng) * scale;
    const cy = mercatorY(cLat) * scale;

    const metersPerPixel =
      (2 * Math.PI * 6378137 * Math.cos((cLat * Math.PI) / 180)) / scale;
    const r = REVEAL_RADIUS_METERS / metersPerPixel;

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

      const rx = dx * cosB + dy * sinB;
      const ry = -dx * sinB + dy * cosB;

      const sx = screenW / 2 + rx;
      const sy = screenH / 2 + ry;

      if (sx + r < -margin || sx - r > screenW + margin) continue;
      if (sy + r < -margin || sy - r > screenH + margin) continue;

      result.push({ x: sx, y: sy, r });
    }

    return result;
  }, [cells, cameraState, screenW, screenH]);

  // ── Actions ────────────────────────────────────────────────────────────────

  const handleReset = useCallback(() => {
    Alert.alert(
      "Apagar progresso",
      "Isso vai remover todo o mapa revelado. Tem certeza?",
      [
        { text: "Cancelar", style: "cancel" },
        {
          text: "Apagar",
          style: "destructive",
          onPress: async () => {
            setCells([]);
            cellSetRef.current = new Set();
            setTotalDistance(0);
            lastPosRef.current = null;
            await AsyncStorage.removeItem(STORAGE_KEY);
            Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
          },
        },
      ]
    );
  }, []);

  const handleCenter = useCallback(() => {
    if (!userLocation || !cameraRef.current) return;
    cameraRef.current.flyTo({ center: userLocation, zoom: 17, duration: 600 });
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
  }, [userLocation]);

  // ── Render: permission states ──────────────────────────────────────────────

  if (permStatus === "loading") {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" color={colors.light.primary} />
      </View>
    );
  }

  if (permStatus === "denied") {
    return (
      <View style={[styles.center, { paddingHorizontal: 32 }]}>
        <View style={styles.iconCircle}>
          <Feather name="map-pin" size={36} color={colors.light.primary} />
        </View>
        <Text style={styles.permTitle}>Localização Necessária</Text>
        <Text style={styles.permText}>
          Este app precisa da sua localização para revelar o mapa enquanto você explora.
        </Text>
        <TouchableOpacity
          style={styles.btn}
          onPress={async () => {
            const { status } = await Location.requestForegroundPermissionsAsync();
            if (status === "granted") { setPermStatus("granted"); startTracking(); }
          }}
        >
          <Text style={styles.btnText}>Permitir localização</Text>
        </TouchableOpacity>
      </View>
    );
  }

  if (isWeb || !ML) {
    return (
      <View style={[styles.center, { paddingHorizontal: 32 }]}>
        <View style={styles.iconCircle}>
          <Feather name="smartphone" size={36} color={colors.light.primary} />
        </View>
        <Text style={styles.permTitle}>Use no celular</Text>
        <Text style={styles.permText}>
          Este app usa MapLibre com GPS de alta precisão. Escaneie o QR code no Expo Go para testar no seu dispositivo.
        </Text>
      </View>
    );
  }

  // ── Render: main map ───────────────────────────────────────────────────────

  const { Map, Camera, GeoJSONSource, Layer } = ML;
  const userData = userLocation ? buildUserGeoJSON(userLocation) : null;
  const topOffset = insets.top + 12;
  const bottomOffset = insets.bottom + 20;

  return (
    <View style={styles.container}>
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

        {userData && (
          <GeoJSONSource id="user-source" data={userData}>
            <Layer
              id="user-ring"
              type="circle"
              source="user-source"
              style={{ circleRadius: 18, circleColor: "rgba(34, 211, 238, 0.22)", circleStrokeWidth: 0 }}
            />
            <Layer
              id="user-dot"
              type="circle"
              source="user-source"
              style={{
                circleRadius: 7,
                circleColor: colors.light.primary,
                circleStrokeWidth: 2.5,
                circleStrokeColor: "#ffffff",
              }}
            />
          </GeoJSONSource>
        )}
      </Map>

      {/* SVG fog mask with soft radial gradient edges */}
      <View style={StyleSheet.absoluteFill} pointerEvents="none">
        <Svg width={screenW} height={screenH}>
          <Defs>
            {/*
              Single shared radial gradient — objectBoundingBox makes it
              scale automatically to each circle's own bounding box.
              Center (black, opaque) = revealed.
              Edge (black, transparent) = fog fades back in smoothly.
            */}
            <RadialGradient
              id="reveal-grad"
              cx="50%"
              cy="50%"
              r="50%"
              fx="50%"
              fy="50%"
              gradientUnits="objectBoundingBox"
            >
              <Stop offset="0%"   stopColor="black" stopOpacity="1" />
              <Stop offset="80%"  stopColor="black" stopOpacity="1" />
              <Stop offset="100%" stopColor="black" stopOpacity="0" />
            </RadialGradient>

            <Mask id="fog-mask">
              <Rect x="0" y="0" width={screenW} height={screenH} fill="white" />
              {fogCircles.map((c, i) => (
                <Circle
                  key={i}
                  cx={c.x}
                  cy={c.y}
                  r={c.r}
                  fill="url(#reveal-grad)"
                />
              ))}
            </Mask>
          </Defs>

          <Rect
            x="0"
            y="0"
            width={screenW}
            height={screenH}
            fill={FOG_FILL_COLOR}
            mask="url(#fog-mask)"
          />
        </Svg>
      </View>

      {/* HUD */}
      <View style={[styles.topHud, { top: topOffset }]}>
        <View style={styles.hudCard}>
          <Feather name="navigation" size={13} color={colors.light.primary} />
          <Text style={styles.hudLabel}>Distância</Text>
          <Text style={styles.hudValue}>{formatDistance(totalDistance)}</Text>
        </View>
        <View style={styles.hudCard}>
          <Feather name="eye" size={13} color={colors.light.primary} />
          <Text style={styles.hudLabel}>Revelado</Text>
          <Text style={styles.hudValue}>{formatArea(cells.length)}</Text>
        </View>
        <View style={styles.hudCard}>
          <Feather name="map-pin" size={13} color={colors.light.primary} />
          <Text style={styles.hudLabel}>Pontos</Text>
          <Text style={styles.hudValue}>{cells.length}</Text>
        </View>
      </View>

      {/* Controls */}
      <View style={[styles.rightCol, { bottom: bottomOffset }]}>
        <TouchableOpacity style={styles.fab} onPress={handleCenter}>
          <Feather name="crosshair" size={22} color={colors.light.primary} />
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.fab, !isTracking && styles.fabInactive]}
          onPress={() => {
            setIsTracking((t) => !t);
            Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
          }}
        >
          <Feather
            name={isTracking ? "pause" : "play"}
            size={20}
            color={isTracking ? colors.light.primary : colors.light.mutedForeground}
          />
        </TouchableOpacity>
        <TouchableOpacity style={styles.fab} onPress={handleReset}>
          <Feather name="trash-2" size={20} color={colors.light.destructive} />
        </TouchableOpacity>
      </View>

      {/* Status badge */}
      <View style={[styles.statusBadge, { bottom: bottomOffset }]}>
        <View style={[styles.statusDot, { backgroundColor: isTracking ? "#22c55e" : colors.light.mutedForeground }]} />
        <Text style={styles.statusText}>{isTracking ? "Rastreando" : "Pausado"}</Text>
      </View>
    </View>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.light.background },
  map: { flex: 1 },
  center: {
    flex: 1,
    backgroundColor: colors.light.background,
    alignItems: "center",
    justifyContent: "center",
  },
  iconCircle: {
    width: 80,
    height: 80,
    borderRadius: 40,
    backgroundColor: colors.light.card,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 20,
    borderWidth: 1,
    borderColor: colors.light.border,
  },
  permTitle: {
    fontSize: 22,
    fontWeight: "700" as const,
    color: colors.light.foreground,
    marginBottom: 10,
    textAlign: "center",
  },
  permText: {
    fontSize: 15,
    color: colors.light.mutedForeground,
    textAlign: "center",
    lineHeight: 22,
    marginBottom: 28,
  },
  btn: {
    backgroundColor: colors.light.primary,
    borderRadius: colors.radius,
    paddingVertical: 14,
    paddingHorizontal: 32,
  },
  btnText: {
    color: colors.light.primaryForeground,
    fontWeight: "600" as const,
    fontSize: 16,
  },
  topHud: {
    position: "absolute",
    left: 12,
    right: 12,
    flexDirection: "row",
    gap: 8,
  },
  hudCard: {
    flex: 1,
    alignItems: "center",
    backgroundColor: "rgba(13, 17, 27, 0.88)",
    borderRadius: 10,
    paddingVertical: 8,
    paddingHorizontal: 4,
    borderWidth: 1,
    borderColor: colors.light.border,
    gap: 3,
  },
  hudLabel: {
    fontSize: 10,
    color: colors.light.mutedForeground,
    letterSpacing: 0.4,
    textTransform: "uppercase" as const,
  },
  hudValue: {
    fontSize: 13,
    fontWeight: "700" as const,
    color: colors.light.primary,
  },
  rightCol: {
    position: "absolute",
    right: 14,
    gap: 10,
    alignItems: "center",
  },
  fab: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: "rgba(13, 17, 27, 0.90)",
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderColor: colors.light.border,
  },
  fabInactive: { borderColor: colors.light.muted },
  statusBadge: {
    position: "absolute",
    left: 14,
    flexDirection: "row" as const,
    alignItems: "center",
    backgroundColor: "rgba(13, 17, 27, 0.88)",
    borderRadius: 20,
    paddingVertical: 8,
    paddingHorizontal: 14,
    borderWidth: 1,
    borderColor: colors.light.border,
    gap: 6,
  },
  statusDot: { width: 8, height: 8, borderRadius: 4 },
  statusText: {
    fontSize: 13,
    color: colors.light.foreground,
    fontWeight: "500" as const,
  },
});
