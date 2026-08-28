import { S3Client } from "bun";
import type { Env } from "./config";

// Object storage, replacing the R2 binding. Backed by any S3-compatible
// service: MinIO in docker-compose, real S3/R2/Ceph in production.
//
// The interface is deliberately narrower than either R2's or S3's. It exposes
// only what the app actually does — store a document, stream it back, delete
// it, list the backup snapshots — so the call sites stay readable and the
// storage backend stays swappable.

export type StoredObject = { key: string; uploadedAt: Date };

export type Storage = {
  /**
   * Stores an object.
   *
   * The body is Blob | string ON PURPOSE. Bun's S3 client does NOT accept a
   * ReadableStream: handed one it silently writes the string
   * "[object ReadableStream]" instead of the bytes, with no error. The old
   * R2 code passed `file.stream()`, so accepting a stream here would make
   * that mistake both easy and invisible. A File IS a Blob, so upload call
   * sites pass the File itself and lose nothing.
   */
  put(key: string, body: Blob | string, contentType?: string): Promise<void>;
  /** Streams an object back, or null when it does not exist. */
  getStream(key: string): Promise<ReadableStream | null>;
  /** Deletes one or many objects. Missing keys are not an error. */
  delete(keys: string | string[]): Promise<void>;
  /** Every object under a prefix, paginating internally. */
  list(prefix: string): Promise<StoredObject[]>;
};

export function createStorage(env: Env): Storage {
  const client = new S3Client({
    accessKeyId: env.S3_ACCESS_KEY_ID,
    secretAccessKey: env.S3_SECRET_ACCESS_KEY,
    bucket: env.S3_BUCKET,
    endpoint: env.S3_ENDPOINT,
    region: env.S3_REGION,
  });

  return {
    async put(key, body, contentType) {
      await client.write(key, body, contentType ? { type: contentType } : {});
    },

    async getStream(key) {
      const file = client.file(key);
      // exists() first, rather than streaming optimistically: reading a
      // missing key throws only once the stream is CONSUMED, which for a
      // download route means the 200 and its headers have already gone out
      // and the client receives a truncated body instead of a 404.
      if (!(await file.exists())) return null;
      return file.stream();
    },

    async delete(keys) {
      const list = Array.isArray(keys) ? keys : [keys];
      // No batch-delete in Bun's client; these are handfuls of keys (one
      // vaccine entry allows at most five attachments), so serial is fine.
      await Promise.all(list.map((key) => client.delete(key)));
    },

    async list(prefix) {
      const out: StoredObject[] = [];
      let continuationToken: string | undefined;
      do {
        const page = await client.list({ prefix, continuationToken });
        for (const object of page.contents ?? []) {
          out.push({
            key: object.key,
            // S3 reports lastModified as an ISO string, not a Date.
            uploadedAt: new Date(object.lastModified ?? 0),
          });
        }
        continuationToken = page.isTruncated
          ? page.nextContinuationToken
          : undefined;
      } while (continuationToken);
      return out;
    },
  };
}
