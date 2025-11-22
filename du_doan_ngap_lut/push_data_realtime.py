# -*- coding: utf-8 -*-
import requests
import time

FIREBASE_URL = "https://hydros-72c7c-default-rtdb.asia-southeast1.firebasedatabase.app"

# Cấu hình camera
CAMERA_ID = "CAM_001"
CAMERA_LAT = 16.074745
CAMERA_LNG = 108.219738
CAMERA_ROAD = "Quang Trung, Đà Nẵng"

def determine_status(water_level_mm):
    """
    🟢 0-130mm: Bình thường
    ⚠️ 130-180mm: Cảnh báo
    🔴 180-300mm: Nguy hiểm
    🚨 >300mm: Cực kỳ nguy hiểm
    """
    if water_level_mm < 130:
        return "normal"
    elif water_level_mm < 180:
        return "warning"
    elif water_level_mm < 300:
        return "danger"
    else:
        return "critical"

def push_flood_result(water_level_mm, is_flooded):
    """Push kết quả AI lên Firebase"""
    status = determine_status(water_level_mm)
    timestamp = int(time.time() * 1000)
    
    data = {
        "cameraId": CAMERA_ID,
        "flood": {
            "isFlooded": is_flooded,
            "status": status,
            "waterLevelMm": water_level_mm
        },
        "location": {
            "lat": CAMERA_LAT,
            "lng": CAMERA_LNG
        },
        "roadName": CAMERA_ROAD,
        "updatedAt": timestamp
    }
    
    url = f"{FIREBASE_URL}/cameras/{CAMERA_ID}.json"
    
    try:
        response = requests.put(url, json=data)
        if response.status_code == 200:
            print(f"✅ Đã push Firebase: {water_level_mm}mm - {status.upper()}")
            return True
        else:
            print(f"❌ Lỗi push: {response.status_code}")
            return False
    except Exception as e:
        print(f"❌ Lỗi: {e}")
        return False