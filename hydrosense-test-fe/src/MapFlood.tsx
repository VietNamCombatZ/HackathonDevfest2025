import React, { useState, useCallback, useRef, useEffect } from 'react';
import { GoogleMap, useJsApiLoader, Polygon, Polyline, Marker } from '@react-google-maps/api';
import axios from 'axios';
import * as polyline from '@mapbox/polyline';

// Vite env variables
const CLOUD_RUN_URL = import.meta.env.VITE_CLOUD_RUN_URL || "http://localhost:8989";
const GOOGLE_MAPS_API_KEY = import.meta.env.VITE_GOOGLE_MAPS_API_KEY || "AIzaSyDrmU7jKJByeSSF0ngpPelT3p4kte09I7Y";

// === FIREBASE REALTIME DATABASE URL ===
const FIREBASE_DB_URL = "https://hydros-72c7c-default-rtdb.asia-southeast1.firebasedatabase.app";

console.log("🔑 API Key:", GOOGLE_MAPS_API_KEY);
console.log("🌐 Cloud URL:", CLOUD_RUN_URL);
console.log("🔥 Firebase DB:", FIREBASE_DB_URL);

const center = { lat: 16.0544, lng: 108.2022 };
const DEFAULT_START = { lat: 16.0470, lng: 108.2068 };
const DEFAULT_END = { lat: 16.0678, lng: 108.2208 };

type FloodSeverity = 'normal' | 'warning' | 'danger' | 'critical';

interface CameraData {
  cameraId: string;
  roadName: string;
  location: {
    lat: number;
    lng: number;
  };
  flood: {
    isFlooded: boolean;
    waterLevelMm: number;
  };
  updatedAt: number;
  snappedLocation?: {
    lat: number;
    lng: number;
  };
}

// === PHÂN LOẠI MỨC ĐỘ NGẬP ===
function getFloodSeverity(waterLevelMm: number): FloodSeverity {
  if (waterLevelMm > 300) return 'critical';
  if (waterLevelMm > 180) return 'danger';
  if (waterLevelMm > 130) return 'warning';
  return 'normal';
}

function isPassable(waterLevelMm: number): boolean {
  return waterLevelMm <= 180;
}

function shouldDisplayOnMap(waterLevelMm: number): boolean {
  return waterLevelMm > 130;
}

function getFloodColorByWaterLevel(waterLevelMm: number): string {
  const severity = getFloodSeverity(waterLevelMm);
  switch (severity) {
    case 'critical': return '#8B0000';
    case 'danger': return '#FF0000';
    case 'warning': return '#FFA500';
    case 'normal': return '#90EE90';
  }
}

function getFloodOpacityByWaterLevel(waterLevelMm: number): number {
  const severity = getFloodSeverity(waterLevelMm);
  switch (severity) {
    case 'critical': return 0.8;
    case 'danger': return 0.7;
    case 'warning': return 0.5;
    case 'normal': return 0.3;
  }
}

function getSeverityIcon(waterLevelMm: number): string {
  const severity = getFloodSeverity(waterLevelMm);
  switch (severity) {
    case 'critical': return '🚨';
    case 'danger': return '🔴';
    case 'warning': return '⚠️';
    case 'normal': return '🟢';
  }
}

function getSeverityText(waterLevelMm: number): string {
  const severity = getFloodSeverity(waterLevelMm);
  
  switch (severity) {
    case 'critical': return `Cực kỳ nguy hiểm (${waterLevelMm}mm) - CHẶN`;
    case 'danger': return `Nguy hiểm (${waterLevelMm}mm) - CHẶN`;
    case 'warning': return `Cảnh báo (${waterLevelMm}mm) - Cho phép đi`;
    case 'normal': return `Bình thường (${waterLevelMm}mm)`;
  }
}

// === SNAP CAMERA LÊN ĐƯỜNG GẦN NHẤT (ROADS API) ===
async function snapToNearestRoad(
  location: { lat: number; lng: number }
): Promise<{ lat: number; lng: number }> {
  try {
    console.log(`📍 Đang snap camera (${location.lat.toFixed(6)}, ${location.lng.toFixed(6)}) lên đường...`);
    
    const response = await fetch(
      `https://roads.googleapis.com/v1/snapToRoads?path=${location.lat},${location.lng}&interpolate=false&key=${GOOGLE_MAPS_API_KEY}`
    );

    if (response.ok) {
      const data = await response.json();
      if (data.snappedPoints && data.snappedPoints.length > 0) {
        const snapped = data.snappedPoints[0].location;
        const snappedLocation = { lat: snapped.latitude, lng: snapped.longitude };
        
        const distance = calculateDistance(location, snappedLocation);
        console.log(`✅ Snapped thành công! Khoảng cách: ${distance.toFixed(2)}m`);
        console.log(`   Gốc: (${location.lat.toFixed(6)}, ${location.lng.toFixed(6)})`);
        console.log(`   Snap: (${snappedLocation.lat.toFixed(6)}, ${snappedLocation.lng.toFixed(6)})`);
        
        return snappedLocation;
      }
    }

    console.warn('⚠️ Roads API không trả về kết quả, dùng tọa độ gốc');
    return location;
  } catch (error) {
    console.error('❌ Lỗi Roads API:', error);
    return location;
  }
}

// === SỬ DỤNG GOOGLE MAPS DIRECTIONS SERVICE (KHÔNG BỊ CORS) ===
async function getRoadPathFromLocation(
  location: { lat: number; lng: number },
  lengthMeters: number = 300
): Promise<google.maps.LatLngLiteral[]> {
  try {
    console.log(`🛣️ Lấy road path cho (${location.lat.toFixed(4)}, ${location.lng.toFixed(4)}) - DirectionsService`);
    
    if (typeof google === 'undefined' || !google.maps || !google.maps.DirectionsService) {
      console.error('❌ Google Maps chưa load!');
      return [location];
    }
    
    const directionsService = new google.maps.DirectionsService();
    
    let bestPath: google.maps.LatLngLiteral[] = [];
    let maxPoints = 0;
    const halfLength = lengthMeters / 2;
    
    const bearings = [0, 45, 90, 135];
    
    for (const bearing of bearings) {
      try {
        const startPoint = calculateOffset(location, bearing, -halfLength);
        const endPoint = calculateOffset(location, bearing, halfLength);
        
        const request: google.maps.DirectionsRequest = {
          origin: new google.maps.LatLng(startPoint.lat, startPoint.lng),
          destination: new google.maps.LatLng(endPoint.lat, endPoint.lng),
          travelMode: google.maps.TravelMode.DRIVING
        };
        
        const result = await new Promise<google.maps.DirectionsResult>((resolve, reject) => {
          directionsService.route(request, (result, status) => {
            if (status === google.maps.DirectionsStatus.OK && result) {
              resolve(result);
            } else {
              reject(new Error(`Directions failed: ${status}`));
            }
          });
        });
        
        if (result.routes && result.routes.length > 0) {
          const route = result.routes[0];
          const path: google.maps.LatLngLiteral[] = [];
          
          route.overview_path.forEach(point => {
            path.push({ lat: point.lat(), lng: point.lng() });
          });
          
          console.log(`✅ DirectionsService (bearing ${bearing}°): ${path.length} điểm`);
          
          if (path.length > maxPoints) {
            maxPoints = path.length;
            bestPath = path;
          }
        }
      } catch (err) {
        console.warn(`⚠️ Directions bearing ${bearing}° failed:`, err);
      }
      
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    
    if (bestPath.length > 0) {
      const filteredPath = bestPath.filter(point => {
        const distance = calculateDistance(location, point);
        return distance <= lengthMeters;
      });
      
      console.log(`✅ Đã lấy ${filteredPath.length} điểm đường thực tế`);
      return filteredPath.length > 0 ? filteredPath : [location];
    }
    
    console.warn('⚠️ Không lấy được đường từ API, dùng fallback');
    return [location];
    
  } catch (error) {
    console.error('❌ Lỗi DirectionsService:', error);
    return [location];
  }
}

// Tính khoảng cách giữa 2 điểm (Haversine)
function calculateDistance(p1: google.maps.LatLngLiteral, p2: google.maps.LatLngLiteral): number {
  const R = 6371000;
  const lat1 = p1.lat * Math.PI / 180;
  const lat2 = p2.lat * Math.PI / 180;
  const dLat = (p2.lat - p1.lat) * Math.PI / 180;
  const dLng = (p2.lng - p1.lng) * Math.PI / 180;

  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos(lat1) * Math.cos(lat2) *
            Math.sin(dLng / 2) * Math.sin(dLng / 2);
  
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

// === TẠO POLYGON TỪ ĐƯỜNG THỰC TẾ ===
function createPolygonFromRoadPath(
  roadPath: google.maps.LatLngLiteral[],
  widthMeters: number
): google.maps.LatLngLiteral[] {
  if (roadPath.length < 2) {
    console.warn('⚠️ Road path quá ngắn');
    return [];
  }

  const leftSide: google.maps.LatLngLiteral[] = [];
  const rightSide: google.maps.LatLngLiteral[] = [];
  const halfWidth = widthMeters / 2;

  for (let i = 0; i < roadPath.length; i++) {
    const current = roadPath[i];
    let bearing = 0;

    if (i === 0 && roadPath.length > 1) {
      bearing = calculateBearing(current, roadPath[i + 1]);
    } else if (i === roadPath.length - 1 && roadPath.length > 1) {
      bearing = calculateBearing(roadPath[i - 1], current);
    } else if (roadPath.length > 2) {
      const b1 = calculateBearing(roadPath[i - 1], current);
      const b2 = calculateBearing(current, roadPath[i + 1]);
      bearing = averageBearing(b1, b2);
    }

    const leftPoint = calculateOffset(current, bearing - 90, halfWidth);
    const rightPoint = calculateOffset(current, bearing + 90, halfWidth);

    leftSide.push(leftPoint);
    rightSide.unshift(rightPoint);
  }

  const polygon = [...leftSide, ...rightSide];
  console.log(`✅ Tạo polygon từ road path: ${polygon.length} điểm`);
  return polygon;
}

// Tính bearing giữa 2 điểm
function calculateBearing(p1: google.maps.LatLngLiteral, p2: google.maps.LatLngLiteral): number {
  const lat1 = p1.lat * Math.PI / 180;
  const lat2 = p2.lat * Math.PI / 180;
  const dLng = (p2.lng - p1.lng) * Math.PI / 180;
  
  const x = Math.sin(dLng) * Math.cos(lat2);
  const y = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLng);
  
  const bearing = Math.atan2(x, y) * 180 / Math.PI;
  return (bearing + 360) % 360;
}

// Trung bình bearing
function averageBearing(b1: number, b2: number): number {
  let diff = b2 - b1;
  if (diff > 180) diff -= 360;
  if (diff < -180) diff += 360;
  
  let avg = b1 + diff / 2;
  if (avg < 0) avg += 360;
  if (avg >= 360) avg -= 360;
  
  return avg;
}

// Tính điểm offset
function calculateOffset(
  point: google.maps.LatLngLiteral,
  bearing: number,
  distanceMeters: number
): google.maps.LatLngLiteral {
  const R = 6371000;
  const bearingRad = bearing * Math.PI / 180;
  const lat1 = point.lat * Math.PI / 180;
  const lng1 = point.lng * Math.PI / 180;
  
  const lat2 = Math.asin(
    Math.sin(lat1) * Math.cos(distanceMeters / R) +
    Math.cos(lat1) * Math.sin(distanceMeters / R) * Math.cos(bearingRad)
  );
  
  const lng2 = lng1 + Math.atan2(
    Math.sin(bearingRad) * Math.sin(distanceMeters / R) * Math.cos(lat1),
    Math.cos(distanceMeters / R) - Math.sin(lat1) * Math.sin(lat2)
  );
  
  return {
    lat: lat2 * 180 / Math.PI,
    lng: lng2 * 180 / Math.PI
  };
}

const libraries: ("places" | "geometry" | "drawing")[] = ["places", "geometry"];

const getContainerStyle = (selectingPoint: 'start' | 'end' | null) => ({
  width: '100%',
  height: '100vh',
  display: 'block' as const,
  cursor: selectingPoint ? 'crosshair' as const : 'default' as const
});

const MapFlood: React.FC = () => {
  const { isLoaded, loadError } = useJsApiLoader({
    id: 'google-map-script',
    googleMapsApiKey: GOOGLE_MAPS_API_KEY,
    libraries: libraries
  });

  const mapRef = useRef<google.maps.Map | null>(null);
  
  const [routePath, setRoutePath] = useState<google.maps.LatLngLiteral[]>([]);
  const [isRouting, setIsRouting] = useState(false);
  const [routeKey, setRouteKey] = useState(0);
  const [showRoute, setShowRoute] = useState(false);
  
  const [startPoint, setStartPoint] = useState<google.maps.LatLngLiteral | null>(DEFAULT_START);
  const [endPoint, setEndPoint] = useState<google.maps.LatLngLiteral>(DEFAULT_END);
  
  const [selectingPoint, setSelectingPoint] = useState<'start' | 'end' | null>(null);
  const [isGettingLocation, setIsGettingLocation] = useState(false);
  const [mapKey, setMapKey] = useState(0);

  const [firebaseCameraData, setFirebaseCameraData] = useState<CameraData[]>([]);
  const [showFirebaseFloodZones, setShowFirebaseFloodZones] = useState(true);
  const [lastUpdate, setLastUpdate] = useState(Date.now());
  const [isConnected, setIsConnected] = useState(false);

  const [roadPathsCache, setRoadPathsCache] = useState<Map<string, google.maps.LatLngLiteral[]>>(new Map());
  const [floodPolygonsCache, setFloodPolygonsCache] = useState<Map<string, google.maps.LatLngLiteral[]>>(new Map());

  // === LẤY VÀ XỬ LÝ DỮ LIỆU FIREBASE ===
  const fetchFirebaseData = async () => {
    try {
      console.log("🔥 Đang lấy dữ liệu từ Firebase...");
      const response = await fetch(`${FIREBASE_DB_URL}/cameras.json`);
      
      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }
      
      const rawData = await response.json();
      console.log("📡 Dữ liệu thô từ Firebase:", rawData);
      
      if (rawData && typeof rawData === 'object' && rawData !== null) {
        const camerasArray: CameraData[] = Object.entries(rawData)
          .map(([key, value]: [string, any]) => {
            if (!value || typeof value !== 'object') return null;
            if (!value.location || typeof value.location.lat !== 'number' || typeof value.location.lng !== 'number') return null;
            if (!value.flood || typeof value.flood.isFlooded !== 'boolean') return null;
            
            return {
              cameraId: value.cameraId || key,
              roadName: value.roadName || 'Unknown Road',
              location: { lat: value.location.lat, lng: value.location.lng },
              flood: { isFlooded: value.flood.isFlooded, waterLevelMm: value.flood.waterLevelMm || 0 },
              updatedAt: value.updatedAt || Date.now()
            } as CameraData;
          })
          .filter((camera): camera is CameraData => camera !== null);
        
        const displayableCameras = camerasArray.filter(
          camera => camera.flood.isFlooded && shouldDisplayOnMap(camera.flood.waterLevelMm)
        );
        
        console.log(`🌊 Tìm thấy ${displayableCameras.length}/${camerasArray.length} camera cần hiển thị`);
        setFirebaseCameraData(displayableCameras);
        
        await fetchRoadPathsForCameras(displayableCameras);
        
        setLastUpdate(Date.now());
        setIsConnected(true);
      } else {
        setFirebaseCameraData([]);
        setIsConnected(true);
      }
    } catch (error) {
      console.error("❌ Lỗi khi lấy dữ liệu Firebase:", error);
      setIsConnected(false);
    }
  };

  // === LẤY ROAD PATHS CHO TẤT CẢ CAMERAS (VỚI ROADS API) ===
  const fetchRoadPathsForCameras = async (cameras: CameraData[]) => {
    const newRoadPaths = new Map(roadPathsCache);
    const newPolygons = new Map(floodPolygonsCache);
    
    for (const camera of cameras) {
      const cacheKey = `${camera.cameraId}-${camera.flood.waterLevelMm}`;
      
      if (newPolygons.has(cacheKey)) {
        console.log(`📦 Sử dụng cache cho ${camera.cameraId}`);
        continue;
      }
      
      console.log(`🛣️ Xử lý ${camera.cameraId} (${camera.roadName})...`);
      
      // ⭐ BƯỚC 1: SNAP CAMERA LÊN ĐƯỜNG CHÍNH
      const snappedLocation = await snapToNearestRoad(camera.location);
      
      // Lưu vị trí đã snap vào camera data
      camera.snappedLocation = snappedLocation;
      
      // ⭐ BƯỚC 2: LẤY ROAD PATH TỪ VỊ TRÍ ĐÃ SNAP
      const floodLength = 300; // 300m xung quanh vị trí đã snap
      const roadPath = await getRoadPathFromLocation(snappedLocation, floodLength);
      
      if (roadPath.length > 1) {
        const roadWidth = Math.max(40, Math.min(100, camera.flood.waterLevelMm * 0.5));
        const polygon = createPolygonFromRoadPath(roadPath, roadWidth);
        
        if (polygon.length >= 4) {
          newRoadPaths.set(cacheKey, roadPath);
          newPolygons.set(cacheKey, polygon);
          console.log(`✅ Đã tạo polygon cho ${camera.cameraId}: ${polygon.length} điểm (từ vị trí snap)`);
        }
      }
      
      // Delay để tránh rate limit (Roads API + Directions API)
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    
    setRoadPathsCache(newRoadPaths);
    setFloodPolygonsCache(newPolygons);
  };

  useEffect(() => {
    console.log("🔥 Khởi tạo kết nối Firebase...");
    fetchFirebaseData();
    
    const interval = setInterval(() => {
      console.log("🔄 Cập nhật dữ liệu Firebase...");
      fetchFirebaseData();
    }, 30000);
    
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    setTimeout(() => handleGetCurrentLocation(), 2000);
  }, []);

  const onLoad = useCallback((map: google.maps.Map) => {
    console.log("✅ Map loaded!");
    mapRef.current = map;
  }, []);

  const onUnmount = useCallback(() => {
    mapRef.current = null;
  }, []);

  const clearRoute = useCallback(() => {
    setShowRoute(false);
    setRoutePath([]);
    setRouteKey(prev => prev + 1);
    setMapKey(prev => prev + 1);
    
    if (mapRef.current) {
      const zoom = mapRef.current.getZoom();
      if (zoom) mapRef.current.setZoom(zoom);
    }
  }, []);

  const handleMapClick = useCallback((e: google.maps.MapMouseEvent) => {
    if (!e.latLng) return;
    const pos = { lat: e.latLng.lat(), lng: e.latLng.lng() };

    if (selectingPoint === 'start') {
      clearRoute();
      setTimeout(() => setStartPoint(pos), 50);
      setSelectingPoint(null);
    } else if (selectingPoint === 'end') {
      clearRoute();
      setTimeout(() => setEndPoint(pos), 50);
      setSelectingPoint(null);
    }
  }, [selectingPoint, clearRoute]);

  const handleGetCurrentLocation = () => {
    if (!navigator.geolocation) return;
    setIsGettingLocation(true);
    
    navigator.geolocation.getCurrentPosition(
      (position) => {
        setStartPoint({ lat: position.coords.latitude, lng: position.coords.longitude });
        setIsGettingLocation(false);
      },
      () => setIsGettingLocation(false),
      { enableHighAccuracy: false, timeout: 3000, maximumAge: 60000 }
    );
  };

  // === ROUTING VỚI CHẶN TẤT CẢ VÙNG NGUY HIỂM ===
  const handleFindRoute = async () => {
    if (!startPoint) {
      alert("Vui lòng chọn điểm đầu!");
      return;
    }

    console.log("🚀 Tìm đường với Firebase flood data...");
    clearRoute();
    await new Promise(resolve => setTimeout(resolve, 200));
    setIsRouting(true);

    try {
      let response;
      let routingMethod = "normal";
      
      const blockedFloods = firebaseCameraData.filter(c => 
        c.flood.isFlooded && !isPassable(c.flood.waterLevelMm)
      );
      
      console.log(`🚫 Tìm thấy ${blockedFloods.length} vùng ngập nguy hiểm (> 180mm) cần chặn`);
      
      if (blockedFloods.length > 0 && showFirebaseFloodZones) {
        try {
          const dangerousAreas: any = {};
          let validPolygonCount = 0;
          
          for (const flood of blockedFloods) {
            const cacheKey = `${flood.cameraId}-${flood.flood.waterLevelMm}`;
            const polygon = floodPolygonsCache.get(cacheKey);
            
            if (polygon && polygon.length >= 4) {
              const closedPolygon = [...polygon, polygon[0]];
              dangerousAreas[`flood_${flood.cameraId}`] = {
                type: "Feature",
                geometry: {
                  type: "Polygon",
                  coordinates: [closedPolygon.map(p => [p.lng, p.lat])]
                }
              };
              validPolygonCount++;
              console.log(`✅ Thêm vùng chặn: ${flood.roadName} (${flood.flood.waterLevelMm}mm)`);
            }
          }
          
          if (validPolygonCount > 0) {
            console.log(`🛣️ Tìm đường tránh ${validPolygonCount} vùng nguy hiểm...`);
            
            // Tạo điều kiện tự động
            const areaConditions = Object.keys(dangerousAreas)
              .map(key => `in_${key}`)
              .join(' || ');
            
            const customModel = {
              priority: [
                {
                  if: areaConditions,
                  multiply_by: "0"
                }
              ],
              areas: dangerousAreas
            };
            
            console.log("📤 Custom model:", JSON.stringify(customModel, null, 2));
            console.log("🔍 Area conditions:", areaConditions);
            
            response = await axios.post(
              `${CLOUD_RUN_URL}/route?ch.disable=true`,
              {
                points: [[startPoint.lng, startPoint.lat], [endPoint.lng, endPoint.lat]],
                profile: 'car',
                custom_model: customModel
              },
              { timeout: 10000, headers: { 'Content-Type': 'application/json' } }
            );
            routingMethod = "avoid_danger";
            console.log(`✅ Đã tìm đường tránh ${validPolygonCount} vùng ngập nguy hiểm!`);
          }
        } catch (err: any) {
          console.error("⚠️ Custom routing failed:", err.response?.data || err.message);
          console.warn("⚠️ Fallback to normal routing");
        }
      }
      
      if (routingMethod === "normal") {
        console.log("🛣️ Tìm đường bình thường (không tránh vùng ngập)...");
        response = await axios.post(
          `${CLOUD_RUN_URL}/route?ch.disable=true`,
          {
            points: [[startPoint.lng, startPoint.lat], [endPoint.lng, endPoint.lat]],
            profile: 'car'
          },
          { timeout: 10000 }
        );
      }

      if (response && response.data.paths && response.data.paths.length > 0) {
        const decoded = polyline.decode(response.data.paths[0].points);
        const path = decoded.map((p: [number, number]) => ({ lat: p[0], lng: p[1] }));
        
        setRoutePath(path);
        setRouteKey(prev => prev + 1);
        setMapKey(prev => prev + 1);
        setTimeout(() => setShowRoute(true), 100);
        
        if (routingMethod === "avoid_danger") {
          alert(`✅ Đã tìm đường tránh ${blockedFloods.length} vùng ngập nguy hiểm!`);
        } else {
          alert("✅ Đã tìm đường!");
        }
      } else {
        alert("Không tìm thấy đường!");
      }
    } catch (error) {
      console.error("❌ Lỗi routing:", error);
      alert("Lỗi tìm đường!");
    } finally {
      setIsRouting(false);
    }
  };

  if (loadError) {
    return <div style={{ textAlign: 'center', marginTop: 50, color: 'red' }}>
      ❌ Lỗi tải Google Maps: {loadError.message}
    </div>;
  }

  if (!isLoaded) {
    return <div style={{ textAlign: 'center', marginTop: 50 }}>⏳ Đang tải bản đồ...</div>;
  }

  return (
    <div style={{ position: 'relative', width: '100%', height: '100vh' }}>
      
      {/* Control Panel */}
      <div style={{
        position: 'absolute',
        top: 20,
        left: 20,
        zIndex: 1000,
        background: 'white',
        padding: '15px',
        borderRadius: '10px',
        boxShadow: '0 4px 6px rgba(0,0,0,0.2)',
        maxWidth: '380px',
        maxHeight: '90vh',
        overflowY: 'auto'
      }}>
        <h3 style={{ margin: '0 0 10px 0', fontSize: '16px' }}>
          🔥 Firebase Real-time Flood Map
        </h3>
        
        <div style={{
          marginBottom: '10px',
          padding: '6px',
          background: isConnected ? '#E8F5E9' : '#FFEBEE',
          borderRadius: '5px',
          fontSize: '11px',
          color: isConnected ? '#2E7D32' : '#C62828',
          textAlign: 'center'
        }}>
          {isConnected ? '✅ Firebase Connected' : '❌ Disconnected'}
        </div>

        <div style={{
          marginBottom: '10px',
          padding: '8px',
          background: '#F5F5F5',
          borderRadius: '5px',
          fontSize: '10px'
        }}>
          <strong>📊 Phân cấp mức ngập:</strong>
          <div style={{ marginTop: '5px' }}>
            <div>🟢 0-130mm: Bình thường</div>
            <div>⚠️ 130-180mm: Cảnh báo (Cho phép đi)</div>
            <div>🔴 180-300mm: Nguy hiểm (CHẶN)</div>
            <div>🚨 &gt;300mm: Cực kỳ nguy hiểm (CHẶN)</div>
          </div>
        </div>

        <button 
          onClick={() => setShowFirebaseFloodZones(!showFirebaseFloodZones)}
          style={{ 
            padding: '8px 12px',
            fontSize: '13px',
            cursor: 'pointer',
            background: showFirebaseFloodZones ? '#4CAF50' : '#9E9E9E',
            color: 'white',
            border: 'none',
            borderRadius: '5px',
            width: '100%',
            marginBottom: '10px'
          }}
        >
          {showFirebaseFloodZones ? '🌊 Ẩn' : '🌊 Hiện'} Vùng Ngập ({firebaseCameraData.length})
        </button>

        <button 
          onClick={() => fetchFirebaseData()}
          style={{ 
            padding: '6px 10px',
            fontSize: '12px',
            cursor: 'pointer',
            background: '#2196F3',
            color: 'white',
            border: 'none',
            borderRadius: '5px',
            width: '100%',
            marginBottom: '10px'
          }}
        >
          🔄 Làm mới dữ liệu
        </button>

        <button 
          onClick={() => setSelectingPoint('start')}
          style={{ 
            padding: '8px 12px',
            fontSize: '14px',
            background: selectingPoint === 'start' ? '#4CAF50' : '#2196F3',
            color: 'white',
            border: 'none',
            borderRadius: '5px',
            width: '100%',
            marginBottom: '5px',
            cursor: 'pointer'
          }}
        >
          {selectingPoint === 'start' ? '📍 Click bản đồ...' : '📍 Chọn điểm ĐẦU'}
        </button>

        <button 
          onClick={handleGetCurrentLocation}
          disabled={isGettingLocation}
          style={{ 
            padding: '6px 10px',
            fontSize: '12px',
            background: isGettingLocation ? '#9E9E9E' : '#FF9800',
            color: 'white',
            border: 'none',
            borderRadius: '5px',
            width: '100%',
            marginBottom: '10px',
            cursor: isGettingLocation ? 'wait' : 'pointer'
          }}
        >
          {isGettingLocation ? "⏳ Đang lấy..." : "📱 GPS"}
        </button>

        <button 
          onClick={() => setSelectingPoint('end')}
          style={{ 
            padding: '8px 12px',
            fontSize: '14px',
            background: selectingPoint === 'end' ? '#4CAF50' : '#2196F3',
            color: 'white',
            border: 'none',
            borderRadius: '5px',
            width: '100%',
            marginBottom: '10px',
            cursor: 'pointer'
          }}
        >
          {selectingPoint === 'end' ? '📍 Click bản đồ...' : '🏁 Chọn điểm CUỐI'}
        </button>

        {(routePath.length > 0 || showRoute) && (
          <button 
            onClick={clearRoute}
            style={{ 
              padding: '8px 12px',
              fontSize: '13px',
              background: '#FF5722',
              color: 'white',
              border: 'none',
              borderRadius: '5px',
              width: '100%',
              marginBottom: '10px',
              cursor: 'pointer'
            }}
          >
            🗑️ XÓA ĐƯỜNG
          </button>
        )}

        <button 
          onClick={handleFindRoute}
          disabled={isRouting || !startPoint}
          style={{ 
            padding: '12px',
            fontSize: '14px',
            fontWeight: 'bold',
            background: (isRouting || !startPoint) ? '#9E9E9E' : '#d32f2f',
            color: 'white',
            border: 'none',
            borderRadius: '5px',
            width: '100%',
            marginBottom: '10px',
            cursor: (isRouting || !startPoint) ? 'wait' : 'pointer'
          }}
        >
          {isRouting ? "Đang tính..." : "🔥 TRÁNH NGẬP"}
        </button>

        {showFirebaseFloodZones && firebaseCameraData.length > 0 && (
          <div style={{
            marginTop: '10px',
            padding: '8px',
            background: '#f8f9fa',
            borderRadius: '5px',
            fontSize: '11px'
          }}>
            <strong>📷 Camera Flood Data:</strong>
            {firebaseCameraData.map((camera) => {
              const cacheKey = `${camera.cameraId}-${camera.flood.waterLevelMm}`;
              const hasPolygon = floodPolygonsCache.has(cacheKey);
              const isSnapped = camera.snappedLocation !== undefined;
              
              return (
                <div key={camera.cameraId} style={{ 
                  marginTop: '5px',
                  padding: '6px',
                  background: getFloodColorByWaterLevel(camera.flood.waterLevelMm),
                  color: 'white',
                  borderRadius: '3px'
                }}>
                  <div style={{ fontSize: '10px', fontWeight: 'bold' }}>
                    {getSeverityIcon(camera.flood.waterLevelMm)} {camera.roadName}
                  </div>
                  <div style={{ fontSize: '9px' }}>
                    {getSeverityText(camera.flood.waterLevelMm)}
                  </div>
                  <div style={{ fontSize: '8px', opacity: 0.9 }}>
                    📍 {camera.location.lat.toFixed(4)}, {camera.location.lng.toFixed(4)}
                  </div>
                  {isSnapped && camera.snappedLocation && (
                    <div style={{ fontSize: '8px', opacity: 0.9 }}>
                      🎯 Snap: {camera.snappedLocation.lat.toFixed(4)}, {camera.snappedLocation.lng.toFixed(4)}
                    </div>
                  )}
                  <div style={{ fontSize: '8px', opacity: 0.9 }}>
                    📷 {camera.cameraId} {hasPolygon ? '✅' : '⏳'} {isSnapped ? '🎯' : ''}
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {showFirebaseFloodZones && firebaseCameraData.length === 0 && isConnected && (
          <div style={{
            marginTop: '10px',
            padding: '8px',
            background: '#E3F2FD',
            borderRadius: '5px',
            fontSize: '11px',
            color: '#1565C0',
            textAlign: 'center'
          }}>
            ℹ️ Không có vùng ngập cần cảnh báo
          </div>
        )}

        <div style={{
          marginTop: '10px',
          padding: '5px',
          background: '#f0f0f0',
          borderRadius: '3px',
          fontSize: '10px',
          color: '#666'
        }}>
          🔍 Floods={firebaseCameraData.length} | Polygons={floodPolygonsCache.size}
        </div>
        
        <div style={{
          marginTop: '5px',
          padding: '5px',
          background: '#f0f0f0',
          borderRadius: '3px',
          fontSize: '9px',
          color: '#666'
        }}>
          ⏰ {new Date(lastUpdate).toLocaleTimeString()}
        </div>
      </div>

      {/* GOOGLE MAP */}
      <GoogleMap
        key={`map-${mapKey}`}
        mapContainerStyle={getContainerStyle(selectingPoint)}
        center={startPoint || center}
        zoom={14}
        onLoad={onLoad}
        onUnmount={onUnmount}
        onClick={handleMapClick}
        options={{
          zoomControl: true,
          mapTypeControl: false,
          streetViewControl: false,
          fullscreenControl: true
        }}
      >
        {/* === VÙNG NGẬP TỪ FIREBASE + ROADS API === */}
        {showFirebaseFloodZones && firebaseCameraData.map((camera, index) => {
          const cacheKey = `${camera.cameraId}-${camera.flood.waterLevelMm}`;
          const floodPolygon = floodPolygonsCache.get(cacheKey);
          const roadPath = roadPathsCache.get(cacheKey);
          
          if (!floodPolygon || floodPolygon.length < 4) {
            return null;
          }
          
          return (
            <React.Fragment key={`flood-${camera.cameraId}-${index}`}>
              {/* Polygon vùng ngập */}
              <Polygon
                path={floodPolygon}
                options={{
                  strokeColor: getFloodColorByWaterLevel(camera.flood.waterLevelMm),
                  strokeOpacity: 0.9,
                  strokeWeight: isPassable(camera.flood.waterLevelMm) ? 2 : 4,
                  fillColor: getFloodColorByWaterLevel(camera.flood.waterLevelMm),
                  fillOpacity: getFloodOpacityByWaterLevel(camera.flood.waterLevelMm)
                }}
              />
              
              {/* Đường trung tâm (road path) */}
              {roadPath && roadPath.length > 1 && (
                <Polyline
                  path={roadPath}
                  options={{
                    strokeColor: '#000000',
                    strokeOpacity: 0.4,
                    strokeWeight: 2,
                    geodesic: true
                  }}
                />
              )}
              
              {/* Marker camera tại vị trí đã SNAP */}
              <Marker 
                position={camera.snappedLocation || camera.location}
                icon={{
                  path: google.maps.SymbolPath.CIRCLE,
                  scale: 12,
                  fillColor: getFloodColorByWaterLevel(camera.flood.waterLevelMm),
                  fillOpacity: 1,
                  strokeColor: '#FFFFFF',
                  strokeWeight: 3
                }}
                label={{
                  text: getSeverityIcon(camera.flood.waterLevelMm),
                  fontSize: "18px",
                  color: "#FFFFFF"
                }}
                title={`${camera.roadName}\n${getSeverityText(camera.flood.waterLevelMm)}\n📷 ${camera.cameraId}\n🎯 Vị trí trên đường (Roads API)`}
              />
              
              {/* Marker nhỏ cho vị trí gốc camera (tham khảo) */}
              {camera.snappedLocation && (
                <Marker 
                  position={camera.location}
                  icon={{
                    path: google.maps.SymbolPath.CIRCLE,
                    scale: 5,
                    fillColor: '#666666',
                    fillOpacity: 0.6,
                    strokeColor: '#FFFFFF',
                    strokeWeight: 1
                  }}
                  title={`📷 ${camera.cameraId} - Vị trí camera thực tế`}
                />
              )}
              
              {/* Đường nối từ camera gốc đến vị trí snap */}
              {camera.snappedLocation && (
                <Polyline
                  path={[camera.location, camera.snappedLocation]}
                  options={{
                    strokeColor: '#666666',
                    strokeOpacity: 0.5,
                    strokeWeight: 1,
                    geodesic: true,
                    icons: [{
                      icon: {
                        path: 'M 0,-1 0,1',
                        strokeOpacity: 1,
                        scale: 2
                      },
                      offset: '0',
                      repeat: '10px'
                    }]
                  }}
                />
              )}
            </React.Fragment>
          );
        })}

        {/* Đường đi */}
        {showRoute && routePath.length > 0 && (
          <Polyline
            key={`route-${routeKey}`}
            path={routePath}
            options={{ 
              strokeColor: '#2196F3',
              strokeOpacity: 1,
              strokeWeight: 6
            }}
          />
        )}
        
        {/* Markers */}
        {startPoint && (
          <Marker 
            position={startPoint}
            label="A"
            title="Điểm đầu"
            draggable
            onDragEnd={(e) => {
              if (e.latLng) {
                clearRoute();
                setTimeout(() => setStartPoint({ lat: e.latLng!.lat(), lng: e.latLng!.lng() }), 50);
              }
            }}
          />
        )}
        <Marker 
          position={endPoint}
          label="B"
          title="Điểm cuối"
          draggable
          onDragEnd={(e) => {
            if (e.latLng) {
              clearRoute();
              setTimeout(() => setEndPoint({ lat: e.latLng!.lat(), lng: e.latLng!.lng() }), 50);
            }
          }}
        />
      </GoogleMap>
    </div>
  );
};

export default MapFlood;