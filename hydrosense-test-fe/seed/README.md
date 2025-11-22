# 🌊 Auto Seed Script - Dữ liệu Ngập Lụt Đà Nẵng

Script tự động cập nhật dữ liệu ngập lụt ngẫu nhiên lên Firebase cho 15 tuyến đường ở Đà Nẵng.

## 📋 Tính năng

- ✅ Tự động cập nhật dữ liệu mỗi 30 giây (có thể thay đổi)
- ✅ 15 camera giám sát tại các tuyến đường chính ở Đà Nẵng
- ✅ Mức nước ngẫu nhiên theo 4 mức độ nguy hiểm
- ✅ Hiển thị log trực quan với emoji và màu sắc

## 🎯 Các mức độ ngập lụt

| Mức độ | Khoảng | Trạng thái | Icon |
|--------|--------|------------|------|
| Bình thường | 0-130mm | Cho phép đi | 🟢 |
| Cảnh báo | 130-180mm | Cho phép đi | ⚠️ |
| Nguy hiểm | 180-300mm | CHẶN | 🔴 |
| Cực kỳ nguy hiểm | >300mm | CHẶN | 🚨 |

## 🚀 Cách sử dụng

### 1. Chạy script với thời gian mặc định (30 giây)

```bash
node seed/auto-update-seed.js
```

### 2. Thay đổi thời gian cập nhật

Mở file `auto-update-seed.js` và sửa dòng:

```javascript
const UPDATE_INTERVAL_MS = 30000; // Thay đổi giá trị này (đơn vị: milliseconds)
```

Ví dụ:
- 10 giây: `10000`
- 1 phút: `60000`
- 5 phút: `300000`

### 3. Dừng script

Nhấn `Ctrl + C` để dừng script

## 📍 Danh sách tuyến đường

Script giám sát 15 tuyến đường chính ở Đà Nẵng:

1. Nguyễn Văn Linh
2. Lê Duẩn
3. Trần Phú
4. Ngô Quyền
5. Hùng Vương
6. Võ Nguyên Giáp
7. Điện Biên Phủ
8. Phan Châu Trinh
9. Lê Lợi
10. Phan Đăng Lưu
11. Núi Thành
12. Hoàng Diệu
13. Duy Tân
14. Hải Phòng
15. Ông Ích Khiêm

## 📊 Phân bổ xác suất

Script tạo dữ liệu với xác suất như sau:

- 50% - Bình thường (0-130mm)
- 25% - Cảnh báo (130-180mm)
- 15% - Nguy hiểm (180-300mm)
- 10% - Cực kỳ nguy hiểm (300-400mm)

## 🔧 Cấu trúc dữ liệu Firebase

```json
{
  "cameras": {
    "CAM_001": {
      "cameraId": "CAM_001",
      "roadName": "Nguyễn Văn Linh, Đà Nẵng",
      "location": {
        "lat": 16.0593,
        "lng": 108.2121
      },
      "flood": {
        "isFlooded": true,
        "waterLevelMm": 150,
        "status": "warning"
      },
      "updatedAt": 1700000000000
    }
  }
}
```

## 💡 Tips

- Script sẽ tự động chạy ngay lập tức khi khởi động
- Mỗi lần cập nhật sẽ hiển thị log chi tiết với icon và trạng thái
- Dữ liệu được merge với database (không xóa dữ liệu cũ)
- Có thể chạy nhiều script song song nếu cần

## 🐛 Xử lý lỗi

Script tự động xử lý các lỗi:
- Lỗi kết nối Firebase
- Lỗi không mong đợi
- Graceful shutdown khi dừng script
