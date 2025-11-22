// backup-firebase.js
// Script để kéo toàn bộ dữ liệu từ Firebase về file local để sao lưu

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DB_URL = "https://hydros-72c7c-default-rtdb.asia-southeast1.firebasedatabase.app";

async function backupFirebase() {
  try {
    console.log("Đang kéo dữ liệu từ Firebase...");
    
    // Fetch toàn bộ dữ liệu từ Firebase
    const response = await fetch(`${DB_URL}/.json`);
    
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }
    
    const data = await response.json();
    
    // Tạo tên file với timestamp
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `firebase-backup-${timestamp}.json`;
    const filepath = path.join(__dirname, filename);
    
    // Ghi dữ liệu ra file
    fs.writeFileSync(filepath, JSON.stringify(data, null, 2), 'utf-8');
    
    console.log(`✅ Sao lưu thành công!`);
    console.log(`📁 File: ${filename}`);
    console.log(`📊 Dữ liệu:`);
    
    // Hiển thị thông tin về dữ liệu đã backup
    if (data) {
      Object.keys(data).forEach(key => {
        const count = data[key] ? Object.keys(data[key]).length : 0;
        console.log(`   - ${key}: ${count} items`);
      });
    } else {
      console.log("   (Không có dữ liệu)");
    }
    
  } catch (err) {
    console.error("❌ Lỗi khi sao lưu dữ liệu:", err.message);
    process.exit(1);
  }
}

backupFirebase();
