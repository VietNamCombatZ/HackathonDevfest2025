import { useEffect, useState } from 'react';
import { database, ref, onValue } from './firebase';

/**
 * Custom hook để lấy dữ liệu realtime từ Firebase
 * @param path - Đường dẫn trong database (ví dụ: 'users', 'data/sensors')
 * @returns Object chứa data, loading, và error
 */
export function useFirebaseData<T = any>(path: string) {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    const dataRef = ref(database, path);
    
    const unsubscribe = onValue(
      dataRef,
      (snapshot) => {
        try {
          const value = snapshot.val();
          setData(value);
          setLoading(false);
        } catch (err) {
          setError(err as Error);
          setLoading(false);
        }
      },
      (err) => {
        setError(err as Error);
        setLoading(false);
      }
    );

    // Cleanup subscription khi component unmount
    return () => unsubscribe();
  }, [path]);

  return { data, loading, error };
}
