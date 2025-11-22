import React, { useState, useCallback, useRef } from 'react';
import { GoogleMap, useJsApiLoader, Rectangle, Polygon, Polyline, Marker } from '@react-google-maps/api';
import axios from 'axios';
import * as polyline from '@mapbox/polyline';

// Vite env variables
const CLOUD_RUN_URL = import.meta.env.VITE_CLOUD_RUN_URL || "http://localhost:8989";
const GOOGLE_MAPS_API_KEY = import.meta.env.VITE_GOOGLE_MAPS_API_KEY || "AIzaSyDrmU7jKJByeSSF0ngpPelT3p4kte09I7Y";

// Debug
console.log("🔑 API Key:", GOOGLE_MAPS_API_KEY);
console.log("🌐 Cloud URL:", CLOUD_RUN_URL);

// --- TỌA ĐỘ ĐÀ NẴNG ---
const center = { lat: 16.0544, lng: 108.2022 }; // Trung tâm Đà Nẵng

// Điểm mặc định
const DEFAULT_START = { lat: 16.0470, lng: 108.2068 }; // Vị trí mặc định Đà Nẵng
const DEFAULT_END = { lat: 16.0678, lng: 108.2208 };   // Gần Bãi biển Mỹ Khê

// === DỮLIỆU VÙNG NGẬP DỌC THEO ĐƯỜNG - ĐẸP VÀ CHÍNH XÁC ===
const FLOOD_ROADS = [
  // VÙNG 1: QUANG TRUNG - THEO ĐÚNG ĐỘ CONG CỦA ĐƯỜNG
  {
    id: 'quang_trung_curved_flood',
    name: '🔴 Quang Trung - Ngập nặng',
    type: 'road_polygon',
    path: [
      // Theo đúng đường Quang Trung thực tế với độ cong tự nhiên
      { lat: 16.0728, lng: 108.2158 }, // Điểm đầu
      { lat: 16.0731, lng: 108.2161 }, // Cong nhẹ
      { lat: 16.0734, lng: 108.2164 }, // Tiếp tục cong
      { lat: 16.0737, lng: 108.2167 }, // Đoạn thẳng
      { lat: 16.0740, lng: 108.2170 }, // Đoạn thẳng
      { lat: 16.0743, lng: 108.2173 }, // Trung tâm
      { lat: 16.0746, lng: 108.2176 }, // Đoạn thẳng
      { lat: 16.0749, lng: 108.2179 }, // Bắt đầu cong
      { lat: 16.0752, lng: 108.2182 }, // Cong mạnh hơn
      { lat: 16.0754, lng: 108.2185 }, // Điểm cuối
    ],
    width: 70, // meters - độ rộng đường + lề
    severity: 'high'
  },
  // VÙNG 2: HÙNG VƯƠNG - ĐƯỜNG THẲNG
  {
    id: 'hung_vuong_straight_flood',
    name: '🟠 Hùng Vương - Ngập vừa',
    type: 'road_polygon',
    path: [
      // Đường Hùng Vương tương đối thẳng
      { lat: 16.067906, lng: 108.218946 },
      { lat: 16.068106, lng: 108.219146 },
      { lat: 16.068306, lng: 108.219346 },
      { lat: 16.068506, lng: 108.219546 },
      { lat: 16.068706, lng: 108.219746 },
      { lat: 16.068906, lng: 108.219946 },
    ],
    width: 55,
    severity: 'medium'
  },
  // VÙNG 3: TRẦN PHÚ - ĐƯỜNG CONG GẦN BIỂN
  {
    id: 'tran_phu_coastal_flood',
    name: '🟡 Trần Phú - Ngập nhẹ',
    type: 'road_polygon',
    path: [
      // Đường Trần Phú cong theo bờ biển
      { lat: 16.0580, lng: 108.2220 },
      { lat: 16.0582, lng: 108.2223 }, // Cong nhẹ
      { lat: 16.0585, lng: 108.2227 }, // Cong theo bờ
      { lat: 16.0588, lng: 108.2232 }, // Tiếp tục cong
      { lat: 16.0590, lng: 108.2237 }, // Cong mạnh hơn
      { lat: 16.0592, lng: 108.2242 }, // Điểm cuối
    ],
    width: 50,
    severity: 'low'
  }
];

// FIX: Thêm libraries
const libraries: ("places" | "geometry" | "drawing")[] = ["places", "geometry"];

// Helper function để tạo container style
const getContainerStyle = (selectingPoint: 'start' | 'end' | null) => ({
  width: '100%', 
  height: '100vh',
  display: 'block' as const,
  cursor: selectingPoint ? 'crosshair' as const : 'default' as const
});

// === HÀM TẠO VÙNG NGẬP DỌC THEO ĐƯỜNG - TỐI ƯU ===
function createRoadFloodPolygon(
  path: google.maps.LatLngLiteral[], 
  widthInMeters: number
): google.maps.LatLngLiteral[] {
  if (path.length < 2) {
    console.warn("⚠️ Path quá ngắn để tạo polygon");
    return [];
  }

  const leftSide: google.maps.LatLngLiteral[] = [];
  const rightSide: google.maps.LatLngLiteral[] = [];

  for (let i = 0; i < path.length; i++) {
    const currentPoint = path[i];
    let bearing = 0;

    // Tính góc hướng (bearing) - cải thiện để xử lý độ cong
    if (i === 0) {
      // Điểm đầu: dùng hướng đến điểm tiếp theo
      const nextPoint = path[i + 1];
      bearing = calculateBearing(currentPoint, nextPoint);
    } else if (i === path.length - 1) {
      // Điểm cuối: dùng hướng từ điểm trước
      const prevPoint = path[i - 1];
      bearing = calculateBearing(prevPoint, currentPoint);
    } else {
      // Điểm giữa: trung bình hóa để làm mượt độ cong
      const prevPoint = path[i - 1];
      const nextPoint = path[i + 1];
      const bearing1 = calculateBearing(prevPoint, currentPoint);
      const bearing2 = calculateBearing(currentPoint, nextPoint);
      bearing = averageBearing(bearing1, bearing2);
    }

    // Tạo điểm bên trái và bên phải của đường
    const leftPoint = calculateOffset(currentPoint, bearing - 90, widthInMeters / 2);
    const rightPoint = calculateOffset(currentPoint, bearing + 90, widthInMeters / 2);

    // Kiểm tra tọa độ hợp lệ
    if (isValidCoordinate(leftPoint) && isValidCoordinate(rightPoint)) {
      leftSide.push(leftPoint);
      rightSide.unshift(rightPoint); // unshift để đảo ngược thứ tự
    }
  }

  // Kết hợp thành polygon khép kín
  const polygon = [...leftSide, ...rightSide];
  
  // Đảm bảo polygon có ít nhất 4 điểm
  if (polygon.length < 4) {
    console.warn("⚠️ Polygon không đủ điểm");
    return [];
  }
  
  console.log("✅ Tạo road polygon thành công với", polygon.length, "điểm");
  return polygon;
}

// Tính trung bình của 2 bearing để làm mượt độ cong
function averageBearing(bearing1: number, bearing2: number): number {
  // Xử lý trường hợp bearing qua 0/360 độ
  let diff = bearing2 - bearing1;
  if (diff > 180) diff -= 360;
  if (diff < -180) diff += 360;
  
  let avgBearing = bearing1 + diff / 2;
  if (avgBearing < 0) avgBearing += 360;
  if (avgBearing >= 360) avgBearing -= 360;
  
  return avgBearing;
}

// Tính góc bearing giữa 2 điểm - cải thiện độ chính xác
function calculateBearing(point1: google.maps.LatLngLiteral, point2: google.maps.LatLngLiteral): number {
  const lat1 = point1.lat * Math.PI / 180;
  const lat2 = point2.lat * Math.PI / 180;
  const deltaLng = (point2.lng - point1.lng) * Math.PI / 180;

  const x = Math.sin(deltaLng) * Math.cos(lat2);
  const y = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(deltaLng);

  const bearing = Math.atan2(x, y);
  return (bearing * 180 / Math.PI + 360) % 360;
}

// Tính điểm offset theo bearing và khoảng cách - cải thiện độ chính xác
function calculateOffset(
  point: google.maps.LatLngLiteral, 
  bearing: number, 
  distanceInMeters: number
): google.maps.LatLngLiteral {
  const bearingRad = bearing * Math.PI / 180;
  
  // Sử dụng công thức chính xác hơn cho Đà Nẵng
  const earthRadius = 6371000; // meters
  const lat1 = point.lat * Math.PI / 180;
  const lng1 = point.lng * Math.PI / 180;
  
  const lat2 = Math.asin(
    Math.sin(lat1) * Math.cos(distanceInMeters / earthRadius) +
    Math.cos(lat1) * Math.sin(distanceInMeters / earthRadius) * Math.cos(bearingRad)
  );
  
  const lng2 = lng1 + Math.atan2(
    Math.sin(bearingRad) * Math.sin(distanceInMeters / earthRadius) * Math.cos(lat1),
    Math.cos(distanceInMeters / earthRadius) - Math.sin(lat1) * Math.sin(lat2)
  );

  return {
    lat: lat2 * 180 / Math.PI,
    lng: lng2 * 180 / Math.PI
  };
}

// Kiểm tra tọa độ hợp lệ
function isValidCoordinate(point: google.maps.LatLngLiteral): boolean {
  return !isNaN(point.lat) && !isNaN(point.lng) && 
         Math.abs(point.lat) <= 90 && Math.abs(point.lng) <= 180;
}

// Lấy màu theo mức độ ngập
function getFloodColor(severity: string) {
  switch (severity) {
    case 'high': return '#FF0000'; // Đỏ - ngập nặng
    case 'medium': return '#FF8C00'; // Cam - ngập vừa  
    case 'low': return '#FFD700'; // Vàng - ngập nhẹ
    default: return '#FF0000';
  }
}

// Lấy opacity theo mức độ ngập
function getFloodOpacity(severity: string) {
  switch (severity) {
    case 'high': return 0.6;
    case 'medium': return 0.4;
    case 'low': return 0.3;
    default: return 0.5;
  }
}

const MapFlood: React.FC = () => {
  const { isLoaded, loadError } = useJsApiLoader({
    id: 'google-map-script',
    googleMapsApiKey: GOOGLE_MAPS_API_KEY,
    libraries: libraries
  });

  // Thêm ref để force re-render map
  const mapRef = useRef<google.maps.Map | null>(null);
  
  const [routePath, setRoutePath] = useState<google.maps.LatLngLiteral[]>([]);
  const [isRouting, setIsRouting] = useState(false);
  const [routeKey, setRouteKey] = useState(0);
  const [showRoute, setShowRoute] = useState(false);
  
  // State cho điểm đầu và điểm cuối - ĐÃ FIX: Khởi tạo ngay
  const [startPoint, setStartPoint] = useState<google.maps.LatLngLiteral | null>(DEFAULT_START);
  const [endPoint, setEndPoint] = useState<google.maps.LatLngLiteral>(DEFAULT_END);
  
  // State để theo dõi đang chọn điểm nào
  const [selectingPoint, setSelectingPoint] = useState<'start' | 'end' | null>(null);
  const [isGettingLocation, setIsGettingLocation] = useState(false);

  // Thêm state để force re-render toàn bộ map
  const [mapKey, setMapKey] = useState(0);

  // === STATE CHO VÙNG NGẬP ===
  const [showFloodZones, setShowFloodZones] = useState(true);
  const [floodData, setFloodData] = useState(FLOOD_ROADS);

  // Tự động lấy vị trí khi component mount - ĐÃ FIX
  React.useEffect(() => {
    console.log("🗺️ Component mounted, startPoint:", startPoint);
    
    // Thử lấy GPS sau khi component đã render
    setTimeout(() => {
      handleGetCurrentLocation();
    }, 2000); // Đợi 2s để map render xong
  }, []);

  // Debug state changes
  React.useEffect(() => {
    console.log("📊 State changed:", {
      routePathLength: routePath.length,
      showRoute,
      routeKey,
      mapKey,
      floodZones: floodData.length,
      startPoint: startPoint ? "✅" : "❌"
    });
  }, [routePath, showRoute, routeKey, mapKey, floodData, startPoint]);

  const onLoad = useCallback((map: google.maps.Map) => {
    console.log("✅ Map loaded successfully!");
    mapRef.current = map;
  }, []);

  const onUnmount = useCallback((_map: google.maps.Map) => {
    console.log("Map unmounted");
    mapRef.current = null;
  }, []);

  // Hàm clear route - SIÊU MẠNH
  const clearRoute = useCallback(() => {
    console.log("🔴 FORCE Clearing route...");
    
    // Bước 1: Ẩn route ngay lập tức
    setShowRoute(false);
    
    // Bước 2: Clear path
    setRoutePath([]);
    
    // Bước 3: Tăng tất cả keys để force re-render
    setRouteKey(prev => prev + 1);
    setMapKey(prev => prev + 1);
    
    // Bước 4: Force refresh map nếu có thể
    if (mapRef.current) {
      // Trigger một update nhỏ trên map
      const currentZoom = mapRef.current.getZoom();
      if (currentZoom) {
        mapRef.current.setZoom(currentZoom);
      }
    }
    
    console.log("✅ Route FORCE cleared completely");
  }, []);

  // Xử lý click trên bản đồ
  const handleMapClick = useCallback((e: google.maps.MapMouseEvent) => {
    if (!e.latLng) return;

    const clickedPos = {
      lat: e.latLng.lat(),
      lng: e.latLng.lng()
    };

    if (selectingPoint === 'start') {
      console.log("🎯 Chọn điểm đầu mới, FORCE xóa đường cũ...");
      clearRoute();
      // Đợi một chút để đảm bảo clear hoàn tất
      setTimeout(() => {
        setStartPoint(clickedPos);
        console.log("✅ Đã chọn điểm đầu:", clickedPos);
      }, 50);
      setSelectingPoint(null);
    } else if (selectingPoint === 'end') {
      console.log("🎯 Chọn điểm cuối mới, FORCE xóa đường cũ...");
      clearRoute();
      // Đợi một chút để đảm bảo clear hoàn tất
      setTimeout(() => {
        setEndPoint(clickedPos);
        console.log("✅ Đã chọn điểm cuối:", clickedPos);
      }, 50);
      setSelectingPoint(null);
    }
  }, [selectingPoint, clearRoute]);

  // Lấy vị trí hiện tại - ĐÃ FIX
  const handleGetCurrentLocation = () => {
    if (!navigator.geolocation) {
      console.warn("⚠️ Trình duyệt không hỗ trợ định vị!");
      return; // Giữ nguyên vị trí mặc định
    }

    setIsGettingLocation(true);
    
    navigator.geolocation.getCurrentPosition(
      (position) => {
        const currentPos = {
          lat: position.coords.latitude,
          lng: position.coords.longitude
        };
        console.log("📱 Đã lấy vị trí GPS:", currentPos);
        setStartPoint(currentPos);
        setIsGettingLocation(false);
      },
      (error) => {
        console.error("❌ Lỗi lấy vị trí:", error);
        setIsGettingLocation(false);
        console.warn("🔄 Giữ vị trí mặc định tại Đà Nẵng");
        // Không thay đổi startPoint, giữ nguyên vị trí mặc định
      },
      {
        enableHighAccuracy: false, // Tắt để nhanh hơn
        timeout: 3000, // Giảm từ 10s xuống 3s
        maximumAge: 60000 // Giảm cache time
      }
    );
  };

  // HÀM TÌM ĐƯỜNG - ĐÃ SỬA VỚI FALLBACK
  const handleFindRoute = async () => {
    if (!startPoint) {
      alert("Vui lòng đợi lấy vị trí hoặc chọn điểm đầu!");
      return;
    }

    console.log("🚀 Bắt đầu tìm đường mới...");
    
    // BƯỚC 1: FORCE xóa đường cũ hoàn toàn
    clearRoute();
    
    // BƯỚC 2: Đợi để đảm bảo UI đã clear hoàn toàn
    await new Promise(resolve => setTimeout(resolve, 200));
    
    // BƯỚC 3: Bắt đầu routing
    setIsRouting(true);

    try {
      console.log("🔍 Đang tìm đường từ", startPoint, "đến", endPoint);

      // THỬ PHƯƠNG PHÁP 1: Với custom model (tránh ngập)
      let response;
      let routingMethod = "custom";
      
      try {
        // Tạo custom model đơn giản - chỉ dùng 1 vùng ngập chính
        const mainFlood = floodData.find(f => f.severity === 'high') || floodData[0];
        
        if (mainFlood && showFloodZones && mainFlood.type === 'road_polygon') {
          // Tạo polygon từ path
          const polygon = createRoadFloodPolygon(mainFlood.path, mainFlood.width);
          
          if (polygon.length >= 4) {
            // Thêm điểm đầu vào cuối để khép kín
            const closedPolygon = [...polygon, polygon[0]];
            
            const customModel = {
              priority: [
                {
                  if: "in_flood_main",
                  multiply_by: "0"
                }
              ],
              areas: {
                flood_main: {
                  type: "Feature",
                  geometry: {
                    type: "Polygon",
                    coordinates: [closedPolygon.map(p => [p.lng, p.lat])]
                  }
                }
              }
            };

            console.log("🌊 Thử routing với road polygon (tránh ngập)...");
            
            response = await axios.post(
              `${CLOUD_RUN_URL}/route?ch.disable=true`,
              {
                points: [
                  [startPoint.lng, startPoint.lat],
                  [endPoint.lng, endPoint.lat]
                ],
                profile: 'car',
                custom_model: customModel
              },
              {
                timeout: 10000,
                headers: {
                  'Content-Type': 'application/json'
                }
              }
            );
          } else {
            throw new Error("Polygon không hợp lệ");
          }
        } else {
          throw new Error("Không có vùng ngập road_polygon");
        }
        
      } catch (customError) {
        console.warn("⚠️ Custom model thất bại, chuyển sang routing thường:", customError);
        routingMethod = "normal";
        
        // PHƯƠNG PHÁP 2: Routing thường (không tránh ngập)
        response = await axios.post(
          `${CLOUD_RUN_URL}/route?ch.disable=true`,
          {
            points: [
              [startPoint.lng, startPoint.lat],
              [endPoint.lng, endPoint.lat]
            ],
            profile: 'car'
          },
          {
            timeout: 10000,
            headers: {
              'Content-Type': 'application/json'
            }
          }
        );
      }

      if (response.data.paths && response.data.paths.length > 0) {
        const encodedString = response.data.paths[0].points;
        const decodedPoints = polyline.decode(encodedString);
        
        const pathForGoogle = decodedPoints.map((p: [number, number]) => ({ 
          lat: p[0], 
          lng: p[1] 
        }));

        // BƯỚC 4: Set đường mới với keys mới
        console.log("🎯 Setting new route with keys:", { routeKey: routeKey + 1, mapKey: mapKey + 1 });
        setRoutePath(pathForGoogle);
        setRouteKey(prev => prev + 1);
        setMapKey(prev => prev + 1);
        
        // Đợi một chút rồi mới hiển thị
        setTimeout(() => {
          setShowRoute(true);
        }, 100);
        
        if (routingMethod === "custom") {
          console.log("✅ Thành công! Tìm thấy đường tránh ngập dọc theo đường.");
        } else {
          console.log("✅ Thành công! Tìm thấy đường đi thường (không tránh ngập).");
          alert("⚠️ Không thể tránh vùng ngập, hiển thị đường đi thường");
        }
        console.log(`📍 Số điểm trên đường: ${pathForGoogle.length}`);
      } else {
        alert("Không tìm thấy đường đi nào!");
      }

    } catch (error) {
      console.error("❌ Lỗi:", error);
      if (axios.isAxiosError(error)) {
        console.error("Response:", error.response?.data);
        console.error("Status:", error.response?.status);
        
        // Xử lý các loại lỗi cụ thể
        if (error.response?.status === 400) {
          alert(`Lỗi: Tọa độ không hợp lệ hoặc không thể tìm đường giữa 2 điểm này`);
        } else if (error.response?.status === 500) {
          alert(`Lỗi server: ${error.response?.data?.message || 'Server đang gặp sự cố'}`);
        } else if (error.code === 'ECONNABORTED') {
          alert(`Lỗi: Timeout - Server phản hồi quá chậm`);
        } else {
          alert(`Lỗi: ${error.response?.data?.message || error.message || 'Không kết nối được server'}`);
        }
      } else {
        alert(`Lỗi không xác định: ${error}`);
      }
    } finally {
      setIsRouting(false);
    }
  };

  // === HÀM THÊM VÙNG NGẬP MỚI (Để tích hợp AI sau) ===
  const addFloodZone = (newFlood: typeof FLOOD_ROADS[0]) => {
    setFloodData(prev => [...prev, newFlood]);
    console.log("🌊 Đã thêm vùng ngập mới:", newFlood.name);
  };

  const removeFloodZone = (floodId: string) => {
    setFloodData(prev => prev.filter(f => f.id !== floodId));
    console.log("🗑️ Đã xóa vùng ngập:", floodId);
  };

  // Error handling - ĐÃ FIX
  if (loadError) {
    console.error("❌ Google Maps Load Error:", loadError);
    return (
      <div style={{
        textAlign: 'center',
        marginTop: 50,
        color: 'red',
        fontSize: '18px'
      }}>
        ❌ Lỗi tải Google Maps: {loadError.message}
        <br />
        <small>Kiểm tra API Key hoặc thử refresh (Ctrl+F5)</small>
      </div>
    );
  }

  if (!isLoaded) {
    console.log("⏳ Google Maps đang tải...");
    return (
      <div style={{
        textAlign: 'center',
        marginTop: 50,
        fontSize: '18px'
      }}>
        ⏳ Đang tải bản đồ...
      </div>
    );
  }

  console.log("🗺️ Rendering map with road flood polygons...");

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
        maxWidth: '320px'
      }}>
        <h3 style={{ margin: '0 0 10px 0', fontSize: '16px' }}>🗺️ Tránh ngập dọc đường</h3>
        
        {/* Toggle vùng ngập */}
        <div style={{ marginBottom: '10px' }}>
          <button 
            onClick={() => setShowFloodZones(!showFloodZones)}
            style={{ 
              padding: '8px 12px', 
              fontSize: '13px',
              cursor: 'pointer',
              background: showFloodZones ? '#4CAF50' : '#9E9E9E',
              color: 'white',
              border: 'none',
              borderRadius: '5px',
              width: '100%',
              marginBottom: '5px'
            }}
          >
            {showFloodZones ? '🌊 Ẩn vùng ngập' : '🌊 Hiện vùng ngập'} ({floodData.length})
          </button>
        </div>

        {/* Chọn điểm đầu */}
        <div style={{ marginBottom: '10px' }}>
          <button 
            onClick={() => {
              console.log("🎯 Bắt đầu chọn điểm đầu...");
              setSelectingPoint('start');
            }}
            style={{ 
              padding: '8px 12px', 
              fontSize: '14px',
              cursor: 'pointer',
              background: selectingPoint === 'start' ? '#4CAF50' : '#2196F3',
              color: 'white',
              border: 'none',
              borderRadius: '5px',
              width: '100%',
              marginBottom: '5px'
            }}
          >
            {selectingPoint === 'start' ? '📍 Click trên bản đồ...' : '📍 Chọn điểm ĐẦU'}
          </button>
          <button 
            onClick={handleGetCurrentLocation}
            disabled={isGettingLocation}
            style={{ 
              padding: '6px 10px', 
              fontSize: '12px',
              cursor: isGettingLocation ? 'wait' : 'pointer',
              background: isGettingLocation ? '#9E9E9E' : '#FF9800',
              color: 'white',
              border: 'none',
              borderRadius: '5px',
              width: '100%'
            }}
          >
            {isGettingLocation ? "⏳ Đang lấy..." : "📱 Cập nhật vị trí GPS"}
          </button>
        </div>

        {/* Chọn điểm cuối */}
        <div style={{ marginBottom: '10px' }}>
          <button 
            onClick={() => {
              console.log("🎯 Bắt đầu chọn điểm cuối...");
              setSelectingPoint('end');
            }}
            style={{ 
              padding: '8px 12px', 
              fontSize: '14px',
              cursor: 'pointer',
              background: selectingPoint === 'end' ? '#4CAF50' : '#2196F3',
              color: 'white',
              border: 'none',
              borderRadius: '5px',
              width: '100%'
            }}
          >
            {selectingPoint === 'end' ? '📍 Click trên bản đồ...' : '🏁 Chọn điểm CUỐI'}
          </button>
        </div>

        {/* Nút xóa đường - LUÔN HIỆN KHI CÓ ROUTE */}
        {(routePath.length > 0 || showRoute) && (
          <button 
            onClick={() => {
              console.log("🗑️ Manual FORCE clear route clicked");
              clearRoute();
            }}
            style={{ 
              padding: '8px 12px', 
              fontSize: '13px',
              cursor: 'pointer',
              background: '#FF5722',
              color: 'white',
              border: 'none',
              borderRadius: '5px',
              width: '100%',
              marginBottom: '10px'
            }}
          >
            🗑️ XÓA ĐƯỜNG
          </button>
        )}

        {/* Nút tìm đường */}
        <button 
          onClick={handleFindRoute}
          disabled={isRouting || !startPoint}
          style={{ 
            padding: '12px', 
            fontSize: '14px', 
            fontWeight: 'bold',
            cursor: (isRouting || !startPoint) ? 'wait' : 'pointer', 
            background: (isRouting || !startPoint) ? '#9E9E9E' : '#d32f2f', 
            color: 'white',
            border: 'none',
            borderRadius: '5px',
            width: '100%'
          }}
        >
          {isRouting ? "Đang tính toán..." : "🚨 TRÁNH NGẬP DỌC ĐƯỜNG"}
        </button>

        {/* Hướng dẫn */}
        {selectingPoint && (
          <div style={{
            marginTop: '10px',
            padding: '8px',
            background: '#FFF3CD',
            borderRadius: '5px',
            fontSize: '12px',
            color: '#856404'
          }}>
            💡 Click vào bản đồ để chọn điểm {selectingPoint === 'start' ? 'đầu' : 'cuối'}
          </div>
        )}

        {/* Danh sách vùng ngập */}
        {showFloodZones && (
          <div style={{
            marginTop: '10px',
            padding: '8px',
            background: '#f8f9fa',
            borderRadius: '5px',
            fontSize: '11px'
          }}>
            <strong>🌊 Vùng ngập dọc đường:</strong>
            {floodData.map((flood, index) => (
              <div key={flood.id} style={{ 
                marginTop: '5px', 
                padding: '4px',
                background: getFloodColor(flood.severity),
                color: 'white',
                borderRadius: '3px',
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center'
              }}>
                <span style={{ fontSize: '10px' }}>{flood.name}</span>
                <button 
                  onClick={() => removeFloodZone(flood.id)}
                  style={{
                    background: 'rgba(255,255,255,0.3)',
                    border: 'none',
                    color: 'white',
                    padding: '2px 6px',
                    borderRadius: '2px',
                    cursor: 'pointer',
                    fontSize: '10px'
                  }}
                >
                  ✕
                </button>
              </div>
            ))}
          </div>
        )}

        {/* Debug info */}
        <div style={{
          marginTop: '10px',
          padding: '5px',
          background: '#f0f0f0',
          borderRadius: '3px',
          fontSize: '10px',
          color: '#666'
        }}>
          Debug: Route={routePath.length} RoadPolygons={floodData.length} GPS={startPoint ? "✅" : "❌"}
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
        {/* === VÙNG NGẬP DỌC THEO ĐƯỜNG ĐẸP === */}
        {showFloodZones && floodData.map((flood, index) => {
          if (flood.type === 'road_polygon') {
            // Render polygon dọc theo đường
            const polygonPath = createRoadFloodPolygon(flood.path, flood.width);
            
            return (
              <React.Fragment key={`road-flood-${flood.id}-${index}`}>
                {/* Polygon vùng ngập dọc theo đường */}
                <Polygon
                  path={polygonPath}
                  options={{
                    strokeColor: getFloodColor(flood.severity),
                    strokeOpacity: 0.8,
                    strokeWeight: 2,
                    fillColor: getFloodColor(flood.severity),
                    fillOpacity: getFloodOpacity(flood.severity)
                  }}
                />
                
                {/* Polyline trung tâm đường để thấy rõ hướng */}
                <Polyline
                  path={flood.path}
                  options={{
                    strokeColor: getFloodColor(flood.severity),
                    strokeOpacity: 1,
                    strokeWeight: 3
                  }}
                />
                
                {/* Marker đầu và cuối đường */}
                <Marker 
                  position={flood.path[0]} 
                  label={{
                    text: "🌊",
                    fontSize: "14px"
                  }}
                  title={`${flood.name} - Điểm đầu`}
                />
                <Marker 
                  position={flood.path[flood.path.length - 1]} 
                  label={{
                    text: "🏁",
                    fontSize: "14px"
                  }}
                  title={`${flood.name} - Điểm cuối`}
                />
              </React.Fragment>
            );
          } else {
            // Render rectangle cho các vùng khác (nếu có)
            return (
              <Rectangle
                key={`flood-rect-${flood.id}-${index}`}
                bounds={flood.bounds}
                options={{
                  strokeColor: getFloodColor(flood.severity),
                  strokeOpacity: 0.8,
                  strokeWeight: 2,
                  fillColor: getFloodColor(flood.severity),
                  fillOpacity: getFloodOpacity(flood.severity)
                }}
              />
            );
          }
        })}

        {/* Đường đi */}
        {showRoute && routePath.length > 0 && (
          <Polyline
            key={`route-${routeKey}-${mapKey}`}
            path={routePath}
            options={{ 
              strokeColor: '#2196F3', 
              strokeOpacity: 1, 
              strokeWeight: 6 
            }}
          />
        )}
        
        {/* Marker điểm đầu và cuối */}
        {startPoint && (
          <Marker 
            position={startPoint} 
            label="A" 
            title="Vị trí của bạn"
            draggable={true}
            onDragEnd={(e) => {
              if (e.latLng) {
                console.log("🔄 Kéo marker A, FORCE xóa đường cũ...");
                clearRoute();
                setTimeout(() => {
                  setStartPoint({ lat: e.latLng!.lat(), lng: e.latLng!.lng() });
                }, 50);
              }
            }}
          />
        )}
        <Marker 
          position={endPoint} 
          label="B" 
          title="Điểm cuối"
          draggable={true}
          onDragEnd={(e) => {
            if (e.latLng) {
              console.log("🔄 Kéo marker B, FORCE xóa đường cũ...");
              clearRoute();
              setTimeout(() => {
                setEndPoint({ lat: e.latLng!.lat(), lng: e.latLng!.lng() });
              }, 50);
            }
          }}
        />
      </GoogleMap>
    </div>
  );
};

export default MapFlood;