import React, { useState, useCallback, useRef, useEffect } from 'react';
import { GoogleMap, useJsApiLoader, Polygon, Polyline, Marker } from '@react-google-maps/api';
import axios from 'axios';
import * as polyline from '@mapbox/polyline';

// Vite env variables
const CLOUD_RUN_URL = import.meta.env.VITE_CLOUD_RUN_URL || "http://localhost:8989";
const GOOGLE_MAPS_API_KEY = import.meta.env.VITE_GOOGLE_MAPS_API_KEY || "AIzaSyDrmU7jKJByeSSF0ngpPelT3p4kte09I7Y";

// === FIREBASE REALTIME DATABASE URL ===
const FIREBASE_DB_URL = "https://hydros-72c7c-default-rtdb.asia-southeast1.firebasedatabase.app";

// Debug
console.log("🔑 API Key:", GOOGLE_MAPS_API_KEY);
console.log("🌐 Cloud URL:", CLOUD_RUN_URL);
console.log("🔥 Firebase DB:", FIREBASE_DB_URL);

// --- TỌA ĐỘ ĐÀ NẴNG ---
const center = { lat: 16.0544, lng: 108.2022 };

// Điểm mặc định
const DEFAULT_START = { lat: 16.0470, lng: 108.2068 };
const DEFAULT_END = { lat: 16.0678, lng: 108.2208 };

// === PHÂN CẤP MỨC NƯỚC THEO THỰC TẾ ===
// 0-130mm: Bình thường (cho phép đi)
// 130-180mm: Cảnh báo (cho phép đi nhưng cẩn thận)
// 180-300mm: Nguy hiểm (CHẶN - không cho đi)
// >300mm: Cực kỳ nguy hiểm (CHẶN - không cho đi)

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
}

// === PHÂN LOẠI MỨC ĐỘ NGẬP ===
function getFloodSeverity(waterLevelMm: number): FloodSeverity {
  if (waterLevelMm > 300) return 'critical';  // Cực kỳ nguy hiểm
  if (waterLevelMm > 180) return 'danger';    // Nguy hiểm
  if (waterLevelMm > 130) return 'warning';   // Cảnh báo
  return 'normal';                             // Bình thường
}

// Kiểm tra có cho phép đi qua không
function isPassable(waterLevelMm: number): boolean {
  return waterLevelMm <= 180; // Chỉ cho phép đi khi <= 180mm
}

// Kiểm tra có cần hiển thị trên bản đồ không (chỉ hiển thị từ mức cảnh báo trở lên)
function shouldDisplayOnMap(waterLevelMm: number): boolean {
  return waterLevelMm > 130; // Chỉ hiển thị từ 130mm trở lên
}

// === MÀU SẮC THEO MỨC ĐỘ NGẬP ===
function getFloodColorByWaterLevel(waterLevelMm: number): string {
  const severity = getFloodSeverity(waterLevelMm);
  switch (severity) {
    case 'critical': return '#8B0000'; // Đỏ đậm - Cực kỳ nguy hiểm (>300mm)
    case 'danger': return '#FF0000';   // Đỏ - Nguy hiểm (180-300mm)
    case 'warning': return '#FFA500';  // Cam - Cảnh báo (130-180mm)
    case 'normal': return '#90EE90';   // Xanh nhạt - Bình thường (0-130mm)
  }
}

function getFloodOpacityByWaterLevel(waterLevelMm: number): number {
  const severity = getFloodSeverity(waterLevelMm);
  switch (severity) {
    case 'critical': return 0.8; // Rất đậm
    case 'danger': return 0.7;   // Đậm
    case 'warning': return 0.5;  // Vừa
    case 'normal': return 0.3;   // Nhẹ
  }
}

function getSeverityIcon(waterLevelMm: number): string {
  const severity = getFloodSeverity(waterLevelMm);
  switch (severity) {
    case 'critical': return '🚨'; // Cực kỳ nguy hiểm
    case 'danger': return '🔴';   // Nguy hiểm
    case 'warning': return '⚠️';  // Cảnh báo
    case 'normal': return '🟢';   // Bình thường
  }
}

function getSeverityText(waterLevelMm: number): string {
  const severity = getFloodSeverity(waterLevelMm);
  const passable = isPassable(waterLevelMm);
  
  switch (severity) {
    case 'critical': return `Cực kỳ nguy hiểm (${waterLevelMm}mm) - CHẶN`;
    case 'danger': return `Nguy hiểm (${waterLevelMm}mm) - CHẶN`;
    case 'warning': return `Cảnh báo (${waterLevelMm}mm) - Cho phép đi`;
    case 'normal': return `Bình thường (${waterLevelMm}mm)`;
  }
}

// === HÀM TẠO VÙNG NGẬP DỰA TRÊN TỌA ĐỘ ===
function createFloodZoneFromLocation(
  location: { lat: number; lng: number },
  waterLevelMm: number
): google.maps.LatLngLiteral[] {
  
  console.log(`🗺️ Tạo vùng ngập tại (${location.lat.toFixed(4)}, ${location.lng.toFixed(4)}), mức nước: ${waterLevelMm}mm, mức độ: ${getFloodSeverity(waterLevelMm)}`);
  
  // Tính độ rộng và độ dài vùng ngập dựa trên mức nước
  const baseWidth = Math.max(50, Math.min(150, waterLevelMm * 0.8)); // 50-150 meters
  const floodLength = Math.max(200, Math.min(400, waterLevelMm * 2)); // 200-400 meters
  
  const halfWidth = baseWidth / 2;
  const halfLength = floodLength / 2;
  
  // Tạo hình chữ nhật đơn giản quanh vị trí camera
  const bearing = 45; // Hướng mặc định: Đông Bắc
  
  // Tạo 4 góc của hình chữ nhật
  const corners: google.maps.LatLngLiteral[] = [];
  
  // Góc 1: Trên-Trái
  const topLeft = calculateOffset(
    calculateOffset(location, bearing, halfLength),
    bearing - 90,
    halfWidth
  );
  corners.push(topLeft);
  
  // Góc 2: Trên-Phải
  const topRight = calculateOffset(
    calculateOffset(location, bearing, halfLength),
    bearing + 90,
    halfWidth
  );
  corners.push(topRight);
  
  // Góc 3: Dưới-Phải
  const bottomRight = calculateOffset(
    calculateOffset(location, bearing, -halfLength),
    bearing + 90,
    halfWidth
  );
  corners.push(bottomRight);
  
  // Góc 4: Dưới-Trái
  const bottomLeft = calculateOffset(
    calculateOffset(location, bearing, -halfLength),
    bearing - 90,
    halfWidth
  );
  corners.push(bottomLeft);
  
  console.log(`✅ Tạo polygon với 4 góc`);
  return corners;
}

// Tính điểm offset
function calculateOffset(
  point: google.maps.LatLngLiteral,
  bearing: number,
  distanceMeters: number
): google.maps.LatLngLiteral {
  const R = 6371000; // Earth radius in meters
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

  // === STATE CHO DỮ LIỆU TỪ FIREBASE ===
  const [firebaseCameraData, setFirebaseCameraData] = useState<CameraData[]>([]);
  const [showFirebaseFloodZones, setShowFirebaseFloodZones] = useState(true);
  const [lastUpdate, setLastUpdate] = useState(Date.now());
  const [isConnected, setIsConnected] = useState(false);

  // === LẤY DỮ LIỆU TỪ FIREBASE BẰNG FETCH ===
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
        // Chuyển đổi object thành array
        const camerasArray: CameraData[] = Object.entries(rawData)
          .map(([key, value]: [string, any]) => {
            if (!value || typeof value !== 'object') {
              console.warn(`⚠️ Camera ${key} có dữ liệu không hợp lệ:`, value);
              return null;
            }
            
            if (!value.location || 
                typeof value.location.lat !== 'number' || 
                typeof value.location.lng !== 'number') {
              console.warn(`⚠️ Camera ${key} thiếu location:`, value);
              return null;
            }
            
            if (!value.flood || typeof value.flood.isFlooded !== 'boolean') {
              console.warn(`⚠️ Camera ${key} thiếu flood data:`, value);
              return null;
            }
            
            const camera: CameraData = {
              cameraId: value.cameraId || key,
              roadName: value.roadName || 'Unknown Road',
              location: {
                lat: value.location.lat,
                lng: value.location.lng
              },
              flood: {
                isFlooded: value.flood.isFlooded,
                waterLevelMm: value.flood.waterLevelMm || 0
              },
              updatedAt: value.updatedAt || Date.now()
            };
            
            console.log(`✅ Camera ${key} parsed:`, camera, `| Mức độ: ${getFloodSeverity(camera.flood.waterLevelMm)} | Cho phép đi: ${isPassable(camera.flood.waterLevelMm)}`);
            return camera;
          })
          .filter((camera): camera is CameraData => camera !== null);
        
        // Chỉ lấy camera đang ngập VÀ cần hiển thị (>130mm)
        const displayableCameras = camerasArray.filter(
          camera => camera.flood.isFlooded && shouldDisplayOnMap(camera.flood.waterLevelMm)
        );
        
        console.log(`🌊 Tìm thấy ${displayableCameras.length}/${camerasArray.length} camera cần hiển thị (>130mm):`, displayableCameras);
        setFirebaseCameraData(displayableCameras);
        setLastUpdate(Date.now());
        setIsConnected(true);
      } else {
        console.warn("⚠️ Dữ liệu Firebase rỗng hoặc không hợp lệ");
        setFirebaseCameraData([]);
        setIsConnected(true);
      }
    } catch (error) {
      console.error("❌ Lỗi khi lấy dữ liệu Firebase:", error);
      setIsConnected(false);
    }
  };

  // Lấy dữ liệu lần đầu và cập nhật định kỳ
  useEffect(() => {
    console.log("🔥 Khởi tạo kết nối Firebase...");
    fetchFirebaseData();
    
    const interval = setInterval(() => {
      console.log("🔄 Cập nhật dữ liệu Firebase...");
      fetchFirebaseData();
    }, 5000);
    
    return () => {
      console.log("🔌 Dọn dẹp interval");
      clearInterval(interval);
    };
  }, []);

  useEffect(() => {
    console.log("🗺️ Component mounted");
    setTimeout(() => {
      handleGetCurrentLocation();
    }, 2000);
  }, []);

  useEffect(() => {
    console.log("📊 State hiện tại:", {
      route: routePath.length,
      floodZones: firebaseCameraData.length,
      firebase: isConnected ? "✅" : "❌",
      gps: startPoint ? "✅" : "❌",
      showFloodZones: showFirebaseFloodZones
    });
  }, [routePath, firebaseCameraData, startPoint, isConnected, showFirebaseFloodZones]);

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
        setStartPoint({
          lat: position.coords.latitude,
          lng: position.coords.longitude
        });
        setIsGettingLocation(false);
      },
      () => {
        setIsGettingLocation(false);
      },
      { enableHighAccuracy: false, timeout: 3000, maximumAge: 60000 }
    );
  };

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
      
      // CHỈ CHẶN CÁC VÙNG NGUY HIỂM VÀ CỰC KỲ NGUY HIỂM (>180mm)
      const blockedFloods = firebaseCameraData.filter(c => 
        c.flood.isFlooded && !isPassable(c.flood.waterLevelMm) // >180mm
      );
      
      console.log(`🚫 Tìm thấy ${blockedFloods.length} vùng CHẶN (>180mm):`, blockedFloods);
      
      if (blockedFloods.length > 0 && showFirebaseFloodZones) {
        try {
          // Lấy vùng ngập nguy hiểm nhất
          const mostDangerous = blockedFloods.sort((a, b) => 
            b.flood.waterLevelMm - a.flood.waterLevelMm
          )[0];
          
          const polygon = createFloodZoneFromLocation(
            mostDangerous.location,
            mostDangerous.flood.waterLevelMm
          );
          
          if (polygon.length >= 4) {
            const closedPolygon = [...polygon, polygon[0]];
            
            console.log(`🚫 Áp dụng CHẶN cho ${mostDangerous.cameraId} (${mostDangerous.flood.waterLevelMm}mm)`);
            
            response = await axios.post(
              `${CLOUD_RUN_URL}/route?ch.disable=true`,
              {
                points: [
                  [startPoint.lng, startPoint.lat],
                  [endPoint.lng, endPoint.lat]
                ],
                profile: 'car',
                custom_model: {
                  priority: [{ if: "in_flood", multiply_by: "0" }],
                  areas: {
                    flood: {
                      type: "Feature",
                      geometry: {
                        type: "Polygon",
                        coordinates: [closedPolygon.map(p => [p.lng, p.lat])]
                      }
                    }
                  }
                }
              },
              { timeout: 10000, headers: { 'Content-Type': 'application/json' } }
            );
            routingMethod = "avoid_danger";
          }
        } catch (err) {
          console.warn("⚠️ Custom routing failed, fallback to normal");
        }
      }
      
      // Fallback to normal routing
      if (routingMethod === "normal") {
        response = await axios.post(
          `${CLOUD_RUN_URL}/route?ch.disable=true`,
          {
            points: [
              [startPoint.lng, startPoint.lat],
              [endPoint.lng, endPoint.lat]
            ],
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
          console.log(`✅ Tìm thấy đường TRÁNH vùng nguy hiểm: ${path.length} điểm`);
          alert("✅ Đã tìm đường tránh vùng nguy hiểm!");
        } else {
          console.log(`✅ Tìm thấy đường bình thường: ${path.length} điểm`);
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
          🔥 Firebase Real-time Flood
        </h3>
        
        {/* Trạng thái Firebase */}
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

        {/* Chú thích mức độ ngập */}
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

        {/* Toggle flood zones */}
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

        {/* Danh sách camera */}
        {showFirebaseFloodZones && firebaseCameraData.length > 0 && (
          <div style={{
            marginTop: '10px',
            padding: '8px',
            background: '#f8f9fa',
            borderRadius: '5px',
            fontSize: '11px'
          }}>
            <strong>📷 Camera Flood Data:</strong>
            {firebaseCameraData.map((camera) => (
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
                <div style={{ fontSize: '8px', opacity: 0.9 }}>
                  📷 {camera.cameraId}
                </div>
              </div>
            ))}
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
          🔍 Route={routePath.length} | Floods={firebaseCameraData.length} | Show={showFirebaseFloodZones ? "✅" : "❌"}
        </div>
        
        <div style={{
          marginTop: '5px',
          padding: '5px',
          background: '#f0f0f0',
          borderRadius: '3px',
          fontSize: '9px',
          color: '#666'
        }}>
          ⏰ Cập nhật: {new Date(lastUpdate).toLocaleTimeString()}
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
        {/* === VÙNG NGẬP TỪ FIREBASE (CHỈ HIỂN THỊ >130MM) === */}
        {showFirebaseFloodZones && firebaseCameraData.map((camera, index) => {
          console.log(`🎨 Rendering flood zone ${index + 1}/${firebaseCameraData.length}:`, camera.cameraId, `(${camera.flood.waterLevelMm}mm)`);
          
          const floodPolygon = createFloodZoneFromLocation(
            camera.location,
            camera.flood.waterLevelMm
          );
          
          if (floodPolygon.length < 4) {
            console.warn(`⚠️ Polygon không hợp lệ cho ${camera.cameraId}`);
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
                  strokeWeight: isPassable(camera.flood.waterLevelMm) ? 2 : 4, // Đường dày hơn nếu CHẶN
                  fillColor: getFloodColorByWaterLevel(camera.flood.waterLevelMm),
                  fillOpacity: getFloodOpacityByWaterLevel(camera.flood.waterLevelMm)
                }}
              />
              
              {/* Marker camera */}
              <Marker 
                position={camera.location}
                label={{
                  text: getSeverityIcon(camera.flood.waterLevelMm),
                  fontSize: "20px"
                }}
                title={`${camera.roadName}\n${getSeverityText(camera.flood.waterLevelMm)}\n📷 ${camera.cameraId}`}
              />
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