// seed-firebase.js
const DB_URL = "https://hydros-72c7c-default-rtdb.asia-southeast1.firebasedatabase.app";

const camerasSample = {
  // CAM_001: {
  //   cameraId: "CAM_001",
  //   roadName: "Nguyễn Văn Linh, Đà Nẵng",
  //   location: { lat: 16.0593, lng: 108.2121 },
  //   flood: { isFlooded: true, waterLevelMm: 120 },
  //   updatedAt: Date.now()
  // },
  CAM_003: {
    cameraId: "CAM_003",
    roadName: "Trần Phú, Đà Nẵng",
    location: { lat: 16.068364, lng: 108.223877 },
    flood: { isFlooded: true, waterLevelMm: 200 },
    updatedAt: Date.now()
  },
  CAM_004: {
    cameraId: "CAM_004",
    roadName: "Lê Duẩn, Đà Nẵng",
    location: { lat: 16.066961, lng: 108.207360 },
    flood: { isFlooded: true, waterLevelMm: 150 },
    updatedAt: Date.now()
  }
};

async function seed() {
  try {
    const response = await fetch(`${DB_URL}/cameras.json`, {
      method: "PATCH", // merge, không ghi đè tất cả
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(camerasSample)
    });

    const result = await response.json();
    console.log("Đã seed thành công:", result);
  } catch (err) {
    console.error("Lỗi seed dữ liệu:", err);
  }
}

seed();
