import React, { useState, useCallback } from 'react';
import { GoogleMap, useJsApiLoader, Circle, Polyline, Marker } from '@react-google-maps/api';
import axios from 'axios';
import * as polyline from '@mapbox/polyline';

// read env
const CLOUD_RUN_URL = import.meta.env.VITE_CLOUD_RUN_URL;
const GOOGLE_MAPS_API_KEY = import.meta.env.VITE_GOOGLE_MAPS_API_KEY;

// --- TỌA ĐỘ ĐÀ NẴNG ---
const center = { lat: 16.0544, lng: 108.2022 }; // Trung tâm Đà Nẵng

// Giả sử điểm ngập gần cầu Rồng
const FLOOD_POINT = { lat: 16.0608, lng: 108.2238 }; 
const FLOOD_RADIUS = 300; // 300 meters

// Điểm mặc định
const DEFAULT_START = { lat: 16.0470, lng: 108.2068 }; // Gần Sân bay Đà Nẵng
const DEFAULT_END = { lat: 16.0678, lng: 108.2208 };   // Gần Bãi biển Mỹ Khê

const containerStyle = { 
  width: '100%', 
  height: '100vh',
  display: 'block'
};

const libraries: ("places" | "geometry" | "drawing")[] = ["places", "geometry"];

const RoutePolyline: React.FC<{
  path: google.maps.LatLngLiteral[];
  show: boolean;
  routeKey: number;
}> = ({ path, show, routeKey }) => {
  console.log("🔵 RoutePolyline render:", { show, pathLength: path.length, routeKey });
  
  if (!show || path.length === 0) {
    console.log("❌ Not rendering polyline");
    return null;
  }
  
  console.log("✅ Rendering polyline");
  return (
    <Polyline
      key={`polyline-${routeKey}`}
      path={path}
      options={{ 
        strokeColor: '#2196F3', 
        strokeOpacity: 1, 
        strokeWeight: 6 
      }}
    />
  );
};

const MapFlood: React.FC = () => {
  const { isLoaded, loadError } = useJsApiLoader({
    id: 'google-map-script',
    googleMapsApiKey: GOOGLE_MAPS_API_KEY,
    libraries: libraries
  });

  const [routePath, setRoutePath] = useState<google.maps.LatLngLiteral[]>([]);
const [isRouting, setIsRouting] = useState(false);
const [routeKey, setRouteKey] = useState(0);
const [showRoute, setShowRoute] = useState(true); // ← THÊM STATE MỚI


  
  // State cho điểm đầu và điểm cuối
  const [startPoint, setStartPoint] = useState<google.maps.LatLngLiteral>(DEFAULT_START);
  const [endPoint, setEndPoint] = useState<google.maps.LatLngLiteral>(DEFAULT_END);
  
  // State để theo dõi đang chọn điểm nào
  const [selectingPoint, setSelectingPoint] = useState<'start' | 'end' | null>(null);

  const onLoad = useCallback((_map: google.maps.Map) => {
    console.log("✅ Map loaded successfully!");
  }, []);

  const onUnmount = useCallback((_map: google.maps.Map) => {
    console.log("Map unmounted");
  }, []);


  // Thêm useEffect để debug
React.useEffect(() => {
  console.log("📊 State changed:", {
    routePathLength: routePath.length,
    showRoute,
    routeKey
  });
}, [routePath, showRoute, routeKey]);

  // Hàm clear route
  // Dòng 55-58: Sửa hàm clearRoute
  const clearRoute = useCallback(() => {
    console.log("🔴 Clearing route...");
    setShowRoute(false); // Ẩn trước
    
    // Đợi React unmount Polyline
    setTimeout(() => {
      setRoutePath([]); // Clear data
      setRouteKey(prev => prev + 1); // Update key
      console.log("✅ Route cleared");
    }, 50);
  }, []);

  // Xử lý click trên bản đồ
  const handleMapClick = useCallback((e: google.maps.MapMouseEvent) => {
    if (!e.latLng) return;

    const clickedPos = {
      lat: e.latLng.lat(),
      lng: e.latLng.lng()
    };

    if (selectingPoint === 'start') {
      // clearRoute()
      setStartPoint(clickedPos);
      clearRoute(); // XÓA ĐƯỜNG CŨ
      
      console.log("✅ Đã chọn điểm đầu:", clickedPos);
      setSelectingPoint(null);
    } else if (selectingPoint === 'end') {
      setEndPoint(clickedPos);
      clearRoute(); // XÓA ĐƯỜNG CŨ
    
      console.log("✅ Đã chọn điểm cuối:", clickedPos);
      setSelectingPoint(null);
    }
  }, [selectingPoint, clearRoute]);

  // Lấy vị trí hiện tại
  const handleGetCurrentLocation = () => {
    if (!navigator.geolocation) {
      alert("Trình duyệt không hỗ trợ định vị!");
      return;
    }

    navigator.geolocation.getCurrentPosition(
      (position) => {
        const currentPos = {
          lat: position.coords.latitude,
          lng: position.coords.longitude
        };
        setStartPoint(currentPos);
        clearRoute(); // XÓA ĐƯỜNG CŨ
        console.log("✅ Đã lấy vị trí hiện tại:", currentPos);
        alert("Đã set điểm đầu là vị trí hiện tại của bạn!");
      },
      (error) => {
        console.error("Lỗi lấy vị trí:", error);
        alert("Không thể lấy vị trí hiện tại. Vui lòng cho phép truy cập vị trí!");
      }
    );
  };

  const handleFindRoute = async () => {
    // Clear đường cũ trước
    clearRoute();
    
    // Đợi lâu hơn để đảm bảo unmount
    await new Promise(resolve => setTimeout(resolve, 200)); // Tăng từ 100 lên 200
    
    setIsRouting(true);
  
    const customModel = {
      priority: [
        {
          if: "in_custom1",
          multiply_by: "0"
        }
      ],
      areas: {
        custom1: {
          type: "Feature",
          geometry: {
            type: "Polygon",
            coordinates: [
              createCircleCoordinates(FLOOD_POINT.lat, FLOOD_POINT.lng, FLOOD_RADIUS)
            ]
          }
        }
      }
    };
  
    try {
      console.log("🔍 Đang tìm đường từ", startPoint, "đến", endPoint);
  
      const response = await axios.post(
        `${CLOUD_RUN_URL}/route?ch.disable=true`,
        {
          points: [
            [startPoint.lng, startPoint.lat],
            [endPoint.lng, endPoint.lat]
          ],
          profile: 'car',
          custom_model: customModel
        }
      );
  
      if (response.data.paths && response.data.paths.length > 0) {
        const encodedString = response.data.paths[0].points;
        const decodedPoints = polyline.decode(encodedString);
        
        const pathForGoogle = decodedPoints.map((p: [number, number]) => ({ 
          lat: p[0], 
          lng: p[1] 
        }));
  
        // Đảm bảo showRoute = false trước khi set path mới
        setShowRoute(false);
        await new Promise(resolve => setTimeout(resolve, 100));
        
        // Set path mới
        setRoutePath(pathForGoogle);
        setRouteKey(prev => prev + 1);
        
        // Hiện route mới
        setShowRoute(true);
        
        console.log("✅ Thành công! Tìm thấy đường né ngập.");
        console.log(`📍 Số điểm trên đường: ${pathForGoogle.length}`);
      } else {
        alert("Không tìm thấy đường đi nào!");
      }
  
    } catch (error) {
      console.error("❌ Lỗi:", error);
      if (axios.isAxiosError(error)) {
        console.error("Response:", error.response?.data);
        console.error("Status:", error.response?.status);
        alert(`Lỗi: ${error.response?.data?.message || 'Không kết nối được server'}`);
      }
    } finally {
      setIsRouting(false);
    }
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
        maxWidth: '300px'
      }}>
        <h3 style={{ margin: '0 0 10px 0', fontSize: '16px' }}>🗺️ Điều khiển</h3>
        
        {/* Chọn điểm đầu */}
        <div style={{ marginBottom: '10px' }}>
          <button 
            onClick={() => setSelectingPoint('start')}
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
            style={{ 
              padding: '6px 10px', 
              fontSize: '12px',
              cursor: 'pointer',
              background: '#FF9800',
              color: 'white',
              border: 'none',
              borderRadius: '5px',
              width: '100%'
            }}
          >
            📱 Vị trí hiện tại
          </button>
        </div>

        {/* Chọn điểm cuối */}
        <div style={{ marginBottom: '10px' }}>
          <button 
            onClick={() => setSelectingPoint('end')}
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


        {/* NÚT XÓA ĐƯỜNG - THÊM PHẦN NÀY */}
        {routePath.length > 0 && (
  <button 
    onClick={() => {
      console.log("🗑️ Click xóa đường");
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
    🗑️ Xóa đường
  </button>
)}
        {/* Nút tìm đường */}
        <button 
          onClick={handleFindRoute}
          disabled={isRouting}
          style={{ 
            padding: '12px', 
            fontSize: '14px', 
            fontWeight: 'bold',
            cursor: isRouting ? 'wait' : 'pointer', 
            background: '#d32f2f', 
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
      </div>

      <GoogleMap
       
        mapContainerStyle={containerStyle}
        center={center}
        zoom={14}
        onLoad={onLoad}
        onUnmount={onUnmount}
        onClick={handleMapClick}
        
        options={{
          zoomControl: true,
          mapTypeControl: false,
          streetViewControl: false,
          fullscreenControl: true,
          // cursor: selectingPoint ? 'crosshair' : 'default'
        }}
      >
       
        
        {/* Vùng ngập */}
        <Circle
          center={FLOOD_POINT}
          radius={FLOOD_RADIUS}
          options={{ 
            strokeColor: '#FF0000', 
            strokeOpacity: 0.8, 
            strokeWeight: 2,
            fillColor: '#FF0000', 
            fillOpacity: 0.35 
          }}
        />
        <Marker position={FLOOD_POINT} label="🌊" title="Vùng ngập lụt" />

        {/* Đường đi */}
<RoutePolyline 
  path={routePath} 
  show={showRoute} 
  routeKey={routeKey}
/>
        
        {/* Marker điểm đầu và cuối */}
        <Marker 
          position={startPoint} 
          label="A" 
          title="Điểm đầu"
          draggable={true}
          onDragEnd={(e) => {
            if (e.latLng) {
              setStartPoint({ lat: e.latLng.lat(), lng: e.latLng.lng() });
              clearRoute(); // XÓA ĐƯỜNG CŨ
            }
          }}
        />
        <Marker 
          position={endPoint} 
          label="B" 
          title="Điểm cuối"
          draggable={true}
          onDragEnd={(e) => {
            if (e.latLng) {
              setEndPoint({ lat: e.latLng.lat(), lng: e.latLng.lng() });
              clearRoute(); // XÓA ĐƯỜNG CŨ
            }
          }}
        />
      </GoogleMap>
    </div>
  );
};

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