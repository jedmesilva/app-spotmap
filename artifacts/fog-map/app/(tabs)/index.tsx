import AsyncStorage from "@react-native-async-storage/async-storage";
import { Feather } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";
import * as Location from "expo-location";
import React, {
  useCallback,
  useEffect,
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
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import colors from "@/constants/colors";

const FOG_FILL_COLOR = "rgba(13, 17, 27, 0.87)";
const REVEAL_RADIUS_METERS = 50;
const MIN_SAMPLE_DISTANCE_METERS = 8;
const MAX_POINTS = 6000;
const STORAGE_KEY = "@fog_map_points_v2";

type LngLat = [number, number];

interface RevealedPoint {
  lng: number;
  lat: number;
}

function haversine(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number
): number {
  const R = 6371000;
  const φ1 = (lat1 * Math.PI) / 180;
  const φ2 = (lat2 * Math.PI) / 180;
  const Δφ = ((lat2 - lat1) * Math.PI) / 180;
  const Δλ = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(Δφ / 2) ** 2 +
    Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// CW winding = interior ring (hole) in GeoJSON RFC 7946
function makeCircleHole(
  lng: number,
  lat: number,
  radiusMeters: number,
  numPoints = 32
): LngLat[] {
  const latRadius = radiusMeters / 111320;
  const lngRadius =
    radiusMeters / (111320 * Math.cos((lat * Math.PI) / 180));
  const coords: LngLat[] = [];
  for (let i = 0; i <= numPoints; i++) {
    const angle = -(i * 2 * Math.PI) / numPoints;
    coords.push([
      lng + lngRadius * Math.cos(angle),
      lat + latRadius * Math.sin(angle),
    ]);
  }
  return coords;
}

// CCW = exterior ring
const WORLD_RING: LngLat[] = [
  [-180, -85.051129],
  [-180, 85.051129],
  [180, 85.051129],
  [180, -85.051129],
  [-180, -85.051129],
];

function buildFogGeoJSON(points: RevealedPoint[]) {
  const holes = points.map((p) =>
    makeCircleHole(p.lng, p.lat, REVEAL_RADIUS_METERS)
  );
  return {
    type: "FeatureCollection" as const,
    features: [
      {
        type: "Feature" as const,
        properties: {},
        geometry: {
          type: "Polygon" as const,
          coordinates: [WORLD_RING, ...holes],
        },
      },
    ],
  };
}

function buildUserGeoJSON(coord: LngLat) {
  return {
    type: "FeatureCollection" as const,
    features: [
      {
        type: "Feature" as const,
        properties: {},
        geometry: {
          type: "Point" as const,
          coordinates: coord,
        },
      },
    ],
  };
}

function formatDistance(meters: number): string {
  if (meters < 1000) return `${Math.round(meters)} m`;
  return `${(meters / 1000).toFixed(2)} km`;
}

function formatArea(numPoints: number): string {
  const areaM2 = numPoints * Math.PI * REVEAL_RADIUS_METERS ** 2;
  if (areaM2 < 10000) return `${Math.round(areaM2)} m²`;
  return `${(areaM2 / 1000000).toFixed(4)} km²`;
}

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

export default function MapScreen() {
  const insets = useSafeAreaInsets();
  const [permStatus, setPermStatus] = useState<
    "loading" | "denied" | "granted"
  >("loading");
  const [userLocation, setUserLocation] = useState<LngLat | null>(null);
  const [revealedPoints, setRevealedPoints] = useState<RevealedPoint[]>([]);
  const [totalDistance, setTotalDistance] = useState(0);
  const [isTracking, setIsTracking] = useState(true);
  const lastPointRef = useRef<RevealedPoint | null>(null);
  const lastPosRef = useRef<{ lat: number; lng: number } | null>(null);
  const subscriptionRef = useRef<Location.LocationSubscription | null>(null);
  const cameraRef = useRef<import("@maplibre/maplibre-react-native").CameraRef | null>(null);
  const initialCenterSet = useRef(false);

  useEffect(() => {
    AsyncStorage.getItem(STORAGE_KEY).then((raw) => {
      if (raw) {
        try {
          const pts: RevealedPoint[] = JSON.parse(raw);
          setRevealedPoints(pts);
          if (pts.length > 0) {
            lastPointRef.current = pts[pts.length - 1];
          }
        } catch { /* ignore */ }
      }
    });
  }, []);

  useEffect(() => {
    if (revealedPoints.length > 0) {
      AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(revealedPoints)).catch(() => {});
    }
  }, [revealedPoints]);

  const addPoint = useCallback((lat: number, lng: number) => {
    const last = lastPointRef.current;
    if (last && haversine(last.lat, last.lng, lat, lng) < MIN_SAMPLE_DISTANCE_METERS) return;

    const newPoint: RevealedPoint = { lat, lng };
    lastPointRef.current = newPoint;

    setRevealedPoints((prev) =>
      prev.length >= MAX_POINTS ? [...prev.slice(1), newPoint] : [...prev, newPoint]
    );

    if (lastPosRef.current) {
      const d = haversine(lastPosRef.current.lat, lastPosRef.current.lng, lat, lng);
      setTotalDistance((prev) => prev + d);
    }
    lastPosRef.current = { lat, lng };
  }, []);

  const startTracking = useCallback(async () => {
    subscriptionRef.current?.remove();
    subscriptionRef.current = null;
    try {
      const sub = await Location.watchPositionAsync(
        {
          accuracy: Location.Accuracy.BestForNavigation,
          distanceInterval: MIN_SAMPLE_DISTANCE_METERS,
          timeInterval: 1000,
        },
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
    if (isWeb) {
      setPermStatus("granted");
      return;
    }
    (async () => {
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status !== "granted") {
        setPermStatus("denied");
        return;
      }
      setPermStatus("granted");
      startTracking();
    })();
    return () => subscriptionRef.current?.remove();
  }, []);

  useEffect(() => {
    if (permStatus !== "granted") return;
    if (isTracking) startTracking();
    else stopTracking();
  }, [isTracking]);

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
            setRevealedPoints([]);
            setTotalDistance(0);
            lastPointRef.current = null;
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
          Este app precisa da sua localização para revelar o mapa enquanto você
          explora.
        </Text>
        <TouchableOpacity
          style={styles.btn}
          onPress={async () => {
            const { status } = await Location.requestForegroundPermissionsAsync();
            if (status === "granted") {
              setPermStatus("granted");
              startTracking();
            }
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
          Este app usa MapLibre com GPS de alta precisão. Escaneie o QR code no
          Expo Go para testar no seu dispositivo.
        </Text>
      </View>
    );
  }

  const { Map, Camera, GeoJSONSource, Layer } = ML;
  const fogData = buildFogGeoJSON(revealedPoints);
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
      >
        <Camera ref={cameraRef} />

        {/* Fog overlay */}
        <GeoJSONSource id="fog-source" data={fogData}>
          <Layer
            id="fog-fill"
            type="fill"
            source="fog-source"
            style={{ fillColor: FOG_FILL_COLOR, fillOpacity: 1 }}
          />
        </GeoJSONSource>

        {/* User location */}
        {userData && (
          <GeoJSONSource id="user-source" data={userData}>
            <Layer
              id="user-ring"
              type="circle"
              source="user-source"
              style={{
                circleRadius: 18,
                circleColor: "rgba(34, 211, 238, 0.22)",
                circleStrokeWidth: 0,
              }}
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

      {/* Top HUD */}
      <View style={[styles.topHud, { top: topOffset }]}>
        <View style={styles.hudCard}>
          <Feather name="navigation" size={13} color={colors.light.primary} />
          <Text style={styles.hudLabel}>Distância</Text>
          <Text style={styles.hudValue}>{formatDistance(totalDistance)}</Text>
        </View>
        <View style={styles.hudCard}>
          <Feather name="eye" size={13} color={colors.light.primary} />
          <Text style={styles.hudLabel}>Revelado</Text>
          <Text style={styles.hudValue}>{formatArea(revealedPoints.length)}</Text>
        </View>
        <View style={styles.hudCard}>
          <Feather name="map-pin" size={13} color={colors.light.primary} />
          <Text style={styles.hudLabel}>Pontos</Text>
          <Text style={styles.hudValue}>{revealedPoints.length}</Text>
        </View>
      </View>

      {/* Right controls */}
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
        <View
          style={[
            styles.statusDot,
            { backgroundColor: isTracking ? "#22c55e" : colors.light.mutedForeground },
          ]}
        />
        <Text style={styles.statusText}>
          {isTracking ? "Rastreando" : "Pausado"}
        </Text>
      </View>
    </View>
  );
}

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
  fabInactive: {
    borderColor: colors.light.muted,
  },
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
  statusDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  statusText: {
    fontSize: 13,
    color: colors.light.foreground,
    fontWeight: "500" as const,
  },
});
