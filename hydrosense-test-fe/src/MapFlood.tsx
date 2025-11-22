import React, { useState, useCallback, useRef } from 'react';
import { GoogleMap, useJsApiLoader, Circle, Polyline, Marker, Polygon } from '@react-google-maps/api';
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
const DEFAULT_START = null; // Sẽ lấy vị trí GPS
const DEFAULT_END = { lat: 16.0678, lng: 108.2208 };   // Gần Bãi biển Mỹ Khê

// === DỮLIỆU VÙNG NGẬP DỌC THEO ĐƯỜNG ===
// Ví dụ: Đường Trần Phú bị ngập (có thể thay bằng dữ liệu AI)
const FLOOD_ROADS = [
  {
    id: 'quang_trung_main_flood',
    name: 'Đường Quang Trung (đoạn chính) - Ngập nặng',
    path: [
      { lat: 16.074358, lng: 108.217684 }, // Tọa độ chính xác Quang Trung
      { lat: 16.074500, lng: 108.217800 }, // Đoạn tiếp theo
      { lat: 16.074650, lng: 108.217920 }, // Đoạn giữa 1
      { lat: 16.074800, lng: 108.218040 }, // Đoạn giữa 2
      { lat: 16.074950, lng: 108.218160 }, // Đoạn giữa 3
      { lat: 16.075100, lng: 108.218280 }, // Đoạn cuối
    ],
    width: 50, // meters - đường chính rộng
    severity: 'high' // ngập nặng do là đường chính
  },
  {
    id: 'quang_trung_intersection_flood',
    name: 'Giao lộ Quang Trung - Ngập cực nặng',
    path: [
      { lat: 16.074200, lng: 108.217500 }, // Giao lộ phía tây
      { lat: 16.074358, lng: 108.217684 }, // Trung tâm Quang Trung
      { lat: 16.074500, lng: 108.217850 }, // Giao lộ phía đông
    ],
    width: 70, // meters - giao lộ rộng hơn
    severity: 'high'
  },
  {
    id: 'quang_trung_side_flood',
    name: 'Đường nhánh Quang Trung - Ngập vừa',
    path: [
      { lat: 16.074100, lng: 108.217400 }, // Nhánh phía nam
      { lat: 16.074200, lng: 108.217550 }, // Kết nối
      { lat: 16.074358, lng: 108.217684 }, // Giao với đường chính
    ],
    width: 35, // meters
    severity: 'medium'
  },
  {
    id: 'nearby_street_flood',
    name: 'Đường phụ gần Quang Trung - Ngập nhẹ',
    path: [
      { lat: 16.074600, lng: 108.217400 }, // Đường song song
      { lat: 16.074700, lng: 108.217600 }, // Đoạn giữa
      { lat: 16.074800, lng: 108.217800 }, // Kết nối
    ],
    width: 30, // meters
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

// === HÀM TẠO VÙNG NGẬP DỌC THEO ĐƯỜNG ===
function createFloodPolygonAlongPath(
  path: google.maps.LatLngLiteral[], 
  widthInMeters: number
): google.maps.LatLngLiteral[] {
  if (path.length < 2) return [];

  const polygonPoints: google.maps.LatLngLiteral[] = [];
  const leftSide: google.maps.LatLngLiteral[] = [];
  const rightSide: google.maps.LatLngLiteral[] = [];

  for (let i = 0; i < path.length; i++) {
    const currentPoint = path[i];
    let bearing = 0;

    // Tính góc hướng (bearing) giữa các điểm
    if (i < path.length - 1) {
      const nextPoint = path[i + 1];
      bearing = calculateBearing(currentPoint, nextPoint);
    } else if (i > 0) {
      const prevPoint = path[i - 1];
      bearing = calculateBearing(prevPoint, currentPoint);
    }

    // Tạo điểm bên trái và bên phải của đường
    const leftPoint = calculateOffset(currentPoint, bearing - 90, widthInMeters / 2);
    const rightPoint = calculateOffset(currentPoint, bearing + 90, widthInMeters / 2);

    leftSide.push(leftPoint);
    rightSide.unshift(rightPoint); // unshift để đảo ngược thứ tự
  }

  // Kết hợp thành polygon khép kín
  return [...leftSide, ...rightSide];
}

// Tính góc bearing giữa 2 điểm
function calculateBearing(point1: google.maps.LatLngLiteral, point2: google.maps.LatLngLiteral): number {
  const lat1 = point1.lat * Math.PI / 180;
  const lat2 = point2.lat * Math.PI / 180;
  const deltaLng = (point2.lng - point1.lng) * Math.PI / 180;

  const x = Math.sin(deltaLng) * Math.cos(lat2);
  const y = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(deltaLng);

  const bearing = Math.atan2(x, y);
  return (bearing * 180 / Math.PI + 360) % 360;
}

// Tính điểm offset theo bearing và khoảng cách
function calculateOffset(
  point: google.maps.LatLngLiteral, 
  bearing: number, 
  distanceInMeters: number
): google.maps.LatLngLiteral {
  const bearingRad = bearing * Math.PI / 180;
  
  // Chuyển đổi meters sang degrees (xấp xỉ)
  const latOffset = (distanceInMeters / 111320) * Math.cos(bearingRad);
  const lngOffset = (distanceInMeters / (111320 * Math.cos(point.lat * Math.PI / 180))) * Math.sin(bearingRad);

  return {
    lat: point.lat + latOffset,
    lng: point.lng + lngOffset
  };
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
  
  // State cho điểm đầu và điểm cuối
  const [startPoint, setStartPoint] = useState<google.maps.LatLngLiteral | null>(null);
  const [endPoint, setEndPoint] = useState<google.maps.LatLngLiteral>(DEFAULT_END);
  
  // State để theo dõi đang chọn điểm nào
  const [selectingPoint, setSelectingPoint] = useState<'start' | 'end' | null>(null);
  const [isGettingLocation, setIsGettingLocation] = useState(false);

  // Thêm state để force re-render toàn bộ map
  const [mapKey, setMapKey] = useState(0);

  // === STATE CHO VÙNG NGẬP ===
  const [showFloodZones, setShowFloodZones] = useState(true);
  const [floodData, setFloodData] = useState(FLOOD_ROADS);

  // Tự động lấy vị trí khi component mount
  React.useEffect(() => {
    if (!startPoint) {
      handleGetCurrentLocation();
    }
  }, []);

  // Debug state changes
  React.useEffect(() => {
    console.log("📊 State changed:", {
      routePathLength: routePath.length,
      showRoute,
      routeKey,
      mapKey,
      floodZones: floodData.length
    });
  }, [routePath, showRoute, routeKey, mapKey, floodData]);

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

  // Lấy vị trí hiện tại
  const handleGetCurrentLocation = () => {
    if (!navigator.geolocation) {
      alert("Trình duyệt không hỗ trợ định vị!");
      // Fallback về vị trí mặc định Đà Nẵng
      setStartPoint({ lat: 16.0470, lng: 108.2068 });
      return;
    }

    setIsGettingLocation(true);
    
    navigator.geolocation.getCurrentPosition(
      (position) => {
        const currentPos = {
          lat: position.coords.latitude,
          lng: position.coords.longitude
        };
        console.log("📱 Cập nhật vị trí GPS, FORCE xóa đường cũ...");
        clearRoute();
        setTimeout(() => {
          setStartPoint(currentPos);
          console.log("✅ Đã lấy vị trí hiện tại:", currentPos);
        }, 50);
        setIsGettingLocation(false);
      },
      (error) => {
        console.error("Lỗi lấy vị trí:", error);
        
        // Fallback về vị trí mặc định Đà Nẵng
        const fallbackPos = { lat: 16.0470, lng: 108.2068 };
        setStartPoint(fallbackPos);
        setIsGettingLocation(false);
        
        if (error.code === error.PERMISSION_DENIED) {
          alert("Bạn đã từ chối chia sẻ vị trí. Sử dụng vị trí mặc định tại Đà Nẵng.");
        }
      },
      {
        enableHighAccuracy: true,
        timeout: 10000,
        maximumAge: 300000
      }
    );
  };

  // HÀM TÌM ĐƯỜNG - ĐÃ SỬA MẠNH
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
        // Tạo custom model đơn giản hơn - chỉ dùng 1 vùng ngập chính
        const mainFlood = floodData.find(f => f.severity === 'high') || floodData[0];
        
        if (mainFlood && showFloodZones) {
          const polygonCoords = createFloodPolygonAlongPath(mainFlood.path, mainFlood.width);
          
          // Đảm bảo polygon hợp lệ (ít nhất 4 điểm và khép kín)
          if (polygonCoords.length >= 4) {
            // Thêm điểm đầu vào cuối để khép kín polygon
            const closedPolygon = [...polygonCoords, polygonCoords[0]];
            
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
  
            console.log("🌊 Thử routing với custom model (tránh ngập)...");
            console.log("📐 Polygon points:", closedPolygon.length);
            
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
                timeout: 10000, // 10 seconds timeout
                headers: {
                  'Content-Type': 'application/json'
                }
              }
            );
          } else {
            throw new Error("Polygon không hợp lệ");
          }
        } else {
          throw new Error("Không có vùng ngập hoặc đã tắt hiển thị");
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
            // Không có custom_model
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
          console.log("✅ Thành công! Tìm thấy đường tránh ngập Quang Trung.");
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

  if (loadError) {
    return (
      <div style={{
        textAlign:'center', 
        marginTop: 50, 
        color: 'red',
        fontSize: '18px'
      }}>
        ❌ Lỗi tải Google Maps: {loadError.message}
        <br/>
        <small>Kiểm tra API Key hoặc thử refresh (Ctrl+F5)</small>
      </div>
    );
  }

  if (!isLoaded) {
    return (
      <div style={{
        textAlign:'center', 
        marginTop: 50,
        fontSize: '18px'
      }}>
        ⏳ Đang tải bản đồ...
      </div>
    );
  }

  // Thêm loading cho GPS
  if (!startPoint) {
    return (
      <div style={{
        textAlign:'center', 
        marginTop: 50,
        fontSize: '18px'
      }}>
        📍 Đang lấy vị trí của bạn...
        <br />
        <small>Vui lòng cho phép truy cập vị trí</small>
      </div>
    );
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
        maxWidth: '320px'
      }}>
        <h3 style={{ margin: '0 0 10px 0', fontSize: '16px' }}>🗺️ Điều khiển</h3>
        
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
            {isGettingLocation ? "⏳ Đang lấy..." : "📱 Cập nhật vị trí"}
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
          {isRouting ? "Đang tính toán..." : "🚨 Tìm đường TRÁNH NGẬP"}
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
            <strong>🌊 Vùng ngập hiện tại:</strong>
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
                <span>{flood.name}</span>
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

        {/* Debug info - NÂNG CẤP */}
        <div style={{
          marginTop: '10px',
          padding: '5px',
          background: '#f0f0f0',
          borderRadius: '3px',
          fontSize: '10px',
          color: '#666'
        }}>
          Debug: Route={routePath.length} Show={showRoute.toString()} Floods={floodData.length}
        </div>
      </div>

      {/* GOOGLE MAP VỚI KEY ĐỂ FORCE RE-RENDER */}
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
        {/* === VÙNG NGẬP DỌC THEO ĐƯỜNG === */}
        {showFloodZones && floodData.map((flood, index) => {
          const polygonPath = createFloodPolygonAlongPath(flood.path, flood.width);
          
          return (
            <React.Fragment key={`flood-${flood.id}-${index}`}>
              {/* Polygon vùng ngập */}
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
              
              {/* Polyline trung tâm đường ngập */}
              <Polyline
                path={flood.path}
                options={{
                  strokeColor: getFloodColor(flood.severity),
                  strokeOpacity: 1,
                  strokeWeight: 4,
                  strokePattern: [10, 5] // Đường đứt nét
                }}
              />
              
              {/* Marker đầu đường ngập */}
              <Marker 
                position={flood.path[0]} 
                label={{
                  text: "🌊",
                  fontSize: "16px"
                }}
                title={flood.name}
              />
            </React.Fragment>
          );
        })}

        {/* Đường đi - VỚI DOUBLE KEY ĐỂ FORCE RE-RENDER */}
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

// Hàm tạo hình tròn (giữ lại cho tương thích)
function createCircleCoordinates(lat: number, lng: number, radiusInMeters: number): number[][] {
  const points = 32;
  const coordinates: number[][] = [];
  const distanceX = radiusInMeters / (111320 * Math.cos(lat * Math.PI / 180));
  const distanceY = radiusInMeters / 110540;

  for (let i = 0; i <= points; i++) {
    const angle = (i / points) * 2 * Math.PI;
    const dx = distanceX * Math.cos(angle);
    const dy = distanceY * Math.sin(angle);
    coordinates.push([lng + dx, lat + dy]);
  }

  return coordinates;
}

export default MapFlood;