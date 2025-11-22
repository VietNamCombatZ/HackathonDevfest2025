// auto-update-seed.js
// Script tự động cập nhật dữ liệu ngập lụt ngẫu nhiên mỗi 30 giây

const DB_URL = "https://hydros-72c7c-default-rtdb.asia-southeast1.firebasedatabase.app";

// Danh sách các tuyến đường ở Đà Nẵng
const daNangRoads = [
  { cameraId: "CAM_001", roadName: "Nguyễn Văn Linh", location: { lat: 16.0593, lng: 108.2121 } },
  { cameraId: "CAM_002", roadName: "Lê Duẩn", location: { lat: 16.0678, lng: 108.2208 } },
  { cameraId: "CAM_003", roadName: "Trần Phú", location: { lat: 16.0544, lng: 108.2302 } },
//   { cameraId: "CAM_004", roadName: "Ngô Quyền", location: { lat: 16.0697, lng: 108.2235 } },
  { cameraId: "CAM_005", roadName: "Hùng Vương", location: { lat: 16.0667, lng: 108.2178 } },
//   { cameraId: "CAM_006", roadName: "Võ Nguyên Giáp", location: { lat: 16.0423, lng: 108.2463 } },
//   { cameraId: "CAM_007", roadName: "Điện Biên Phủ", location: { lat: 16.0733, lng: 108.2198 } },
//   { cameraId: "CAM_008", roadName: "Phan Châu Trinh", location: { lat: 16.0689, lng: 108.2186 } },
//   { cameraId: "CAM_009", roadName: "Lê Lợi", location: { lat: 16.0656, lng: 108.2167 } },
//   { cameraId: "CAM_010", roadName: "Phan Đăng Lưu", location: { lat: 16.0621, lng: 108.2156 } },
//   { cameraId: "CAM_011", roadName: "Núi Thành", location: { lat: 16.0573, lng: 108.2089 } },
//   { cameraId: "CAM_012", roadName: "Hoàng Diệu", location: { lat: 16.0712, lng: 108.2223 } },
//   { cameraId: "CAM_013", roadName: "Duy Tân", location: { lat: 16.0612, lng: 108.2134 } },
//   { cameraId: "CAM_014", roadName: "Hải Phòng", location: { lat: 16.0689, lng: 108.2245 } },
//   { cameraId: "CAM_015", roadName: "Ông Ích Khiêm", location: { lat: 16.0634, lng: 108.2189 } },
];

// Hàm tạo mức nước ngẫu nhiên theo phân bổ xác suất
function generateRandomWaterLevel() {
  const random = Math.random();
  
  // Phân bổ xác suất:
  // 50% - Bình thường (0-130mm)
  // 25% - Cảnh báo (130-180mm)
  // 15% - Nguy hiểm (180-300mm)
  // 10% - Cực kỳ nguy hiểm (>300mm, tối đa 400mm)
  
  if (random < 0.5) {
    // Bình thường: 0-130mm
    return Math.floor(Math.random() * 131);
  } else if (random < 0.75) {
    // Cảnh báo: 130-180mm
    return Math.floor(130 + Math.random() * 51);
  } else if (random < 0.9) {
    // Nguy hiểm: 180-300mm
    return Math.floor(180 + Math.random() * 121);
  } else {
    // Cực kỳ nguy hiểm: 300-400mm
    return Math.floor(300 + Math.random() * 101);
  }
}

// Hàm xác định trạng thái ngập lụt
function getFloodStatus(waterLevelMm) {
  if (waterLevelMm === 0) {
    return { isFlooded: false, status: "normal", icon: "🟢" };
  } else if (waterLevelMm < 130) {
    return { isFlooded: true, status: "normal", icon: "🟢" };
  } else if (waterLevelMm < 180) {
    return { isFlooded: true, status: "warning", icon: "⚠️" };
  } else if (waterLevelMm < 300) {
    return { isFlooded: true, status: "danger", icon: "🔴" };
  } else {
    return { isFlooded: true, status: "critical", icon: "🚨" };
  }
}

// Hàm tạo dữ liệu ngẫu nhiên cho tất cả các camera
function generateFloodData() {
  const data = {};
  
  daNangRoads.forEach(road => {
    const waterLevelMm = generateRandomWaterLevel();
    const floodStatus = getFloodStatus(waterLevelMm);
    
    data[road.cameraId] = {
      cameraId: road.cameraId,
      roadName: `${road.roadName}, Đà Nẵng`,
      location: road.location,
      flood: {
        isFlooded: floodStatus.isFlooded,
        waterLevelMm: waterLevelMm,
        status: floodStatus.status
      },
      updatedAt: Date.now()
    };
  });
  
  return data;
}

// Hàm push dữ liệu lên Firebase
async function updateFloodData() {
  try {
    const floodData = generateFloodData();
    
    const response = await fetch(`${DB_URL}/cameras.json`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(floodData)
    });

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    const result = await response.json();
    
    // In thông tin tóm tắt
    console.log("\n" + "=".repeat(60));
    console.log(`⏰ Cập nhật lúc: ${new Date().toLocaleString('vi-VN')}`);
    console.log("=".repeat(60));
    
    Object.values(floodData).forEach(cam => {
      const status = getFloodStatus(cam.flood.waterLevelMm);
      console.log(`${status.icon} ${cam.roadName}: ${cam.flood.waterLevelMm}mm - ${status.status.toUpperCase()}`);
    });
    
    console.log("=".repeat(60));
    console.log("✅ Cập nhật thành công!\n");
    
  } catch (err) {
    console.error("❌ Lỗi cập nhật dữ liệu:", err.message);
  }
}

// Cấu hình thời gian cập nhật (mặc định 30 giây, có thể thay đổi)
const UPDATE_INTERVAL_MS = 30000; // 30 giây

console.log("🚀 Script tự động cập nhật dữ liệu ngập lụt Đà Nẵng");
console.log(`⏱️  Cập nhật mỗi ${UPDATE_INTERVAL_MS / 1000} giây`);
console.log(`📍 Số lượng camera: ${daNangRoads.length} điểm`);
console.log("\n🔄 Bắt đầu cập nhật...\n");

// Chạy lần đầu tiên ngay lập tức
updateFloodData();

// Sau đó chạy định kỳ theo interval
const intervalId = setInterval(updateFloodData, UPDATE_INTERVAL_MS);

// Xử lý khi dừng script (Ctrl+C)
process.on('SIGINT', () => {
  console.log("\n\n🛑 Dừng script...");
  clearInterval(intervalId);
  console.log("✅ Đã dừng thành công!");
  process.exit(0);
});

// Xử lý lỗi không bắt được
process.on('uncaughtException', (err) => {
  console.error("❌ Lỗi không mong đợi:", err);
});

process.on('unhandledRejection', (err) => {
  console.error("❌ Promise rejection:", err);
});
