import type { Storage, StoredObject } from "../src/storage";

// An in-memory Storage for tests.
//
// The suite used miniflare's R2 simulator before; there is no equivalent for
// S3, and pointing the tests at MinIO would make them need a running service
// to check things that have nothing to do with object storage. The Storage
// interface is four methods, so implementing it honestly is cheaper than
// either alternative — and the real client's behaviour was verified directly
// against MinIO while it was written.

export type MemoryStorage = Storage & {
  /** Test-only: raw bytes behind a key, or null. */
  read(key: string): Promise<string | null>;
  /** Test-only: forget everything (called between test files). */
  clear(): void;
};

export function createMemoryStorage(): MemoryStorage {
  const objects = new Map<string, { body: Uint8Array; uploadedAt: Date }>();

  const encode = async (body: Blob | string): Promise<Uint8Array> =>
    typeof body === "string"
      ? new TextEncoder().encode(body)
      : new Uint8Array(await body.arrayBuffer());

  return {
    async put(key, body) {
      objects.set(key, { body: await encode(body), uploadedAt: new Date() });
    },

    async getStream(key) {
      const object = objects.get(key);
      if (!object) return null;
      return new Blob([object.body]).stream();
    },

    async delete(keys) {
      for (const key of Array.isArray(keys) ? keys : [keys]) {
        objects.delete(key);
      }
    },

    async list(prefix) {
      const out: StoredObject[] = [];
      for (const [key, object] of objects) {
        if (key.startsWith(prefix)) {
          out.push({ key, uploadedAt: object.uploadedAt });
        }
      }
      // S3 returns keys in lexicographic order; matching that keeps tests
      // that assert on ordering honest.
      return out.sort((a, b) => a.key.localeCompare(b.key));
    },

    async read(key) {
      const object = objects.get(key);
      return object ? new TextDecoder().decode(object.body) : null;
    },

    clear() {
      objects.clear();
    },
  };
}
