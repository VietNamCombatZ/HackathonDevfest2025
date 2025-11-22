import { initializeApp } from 'firebase/app';
import { getDatabase, ref, onValue, Database } from 'firebase/database';

// Cấu hình Firebase
const firebaseConfig = {
  databaseURL: 'https://hydros-72c7c-default-rtdb.asia-southeast1.firebasedatabase.app'
};

// Khởi tạo Firebase
const app = initializeApp(firebaseConfig);
const database = getDatabase(app);

// Export database instance
export { database, ref, onValue };
export type { Database };
