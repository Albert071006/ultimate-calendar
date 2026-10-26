import type { OfflinePartition } from './types';

export interface OfflineStorage {
  read<T>(key: string): Promise<T | undefined>;
  write<T>(key: string, value: T): Promise<void>;
  remove(key: string): Promise<void>;
}

/** IndexedDB transactions must complete before a draft is acknowledged to the UI. */
export function createOfflineStorage(factory: IDBFactory = indexedDB): OfflineStorage {
  let database: Promise<IDBDatabase> | undefined;
  const open = () => database ??= new Promise((resolve, reject) => {
    const request = factory.open('ultimate-calendar-phone-v1', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('records');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => { database = undefined; reject(request.error ?? Error('无法打开手机储存')); };
    request.onblocked = () => { database = undefined; reject(Error('请关闭旧版日历页面后重试')); };
  });
  async function transaction<T>(key: string, mode: IDBTransactionMode, operation: (store: IDBObjectStore) => IDBRequest): Promise<T> {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('records', mode);
      const request = operation(tx.objectStore('records'));
      tx.oncomplete = () => resolve(request.result as T);
      tx.onerror = tx.onabort = () => reject(tx.error ?? request.error ?? Error('手机储存未完成：' + key));
    });
  }
  return {
    read: <T>(key: string) => transaction<T | undefined>(key, 'readonly', store => store.get(key)),
    write: async (key, value) => { await transaction(key, 'readwrite', store => store.put(value, key)); },
    remove: async key => { await transaction(key, 'readwrite', store => store.delete(key)); },
  };
}

export function partitionKey(origin: string, session: OfflinePartition['session']): string {
  return ['partition', origin, session.identity.dataInstanceId, session.identity.generation, session.device.id].join(':');
}
export function emptyPartition(session: OfflinePartition['session']): OfflinePartition {
  return { session: { ...session, csrfToken: '' }, snapshot: null, ledgers: {}, cachedAt: null, queue: [], aliases: {}, completed: [] };
}

export function createMemoryStorage(): OfflineStorage {
  const records = new Map<string, unknown>();
  return {
    async read<T>(key: string) { return structuredClone(records.get(key)) as T | undefined; },
    async write(key, value) { records.set(key, structuredClone(value)); },
    async remove(key) { records.delete(key); },
  };
}
