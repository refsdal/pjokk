import { S3Client } from "bun";
import type { Storage, StoredObject } from "../ports";

// Object storage, replacing the R2 binding. Backed by any S3-compatible
// service: MinIO in docker-compose, real S3/R2/Ceph in production.
//
// The interface is deliberately narrower than either R2's or S3's. It exposes
// only what the app actually does — store a document, stream it back, delete
// it, list the backup snapshots — so the call sites stay readable and the
// storage backend stays swappable.

export type S3Config = {
  bucket: string;
  endpoint: string;
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
};

export function createStorage(cfg: S3Config): Storage {
  const client = new S3Client({
    accessKeyId: cfg.accessKeyId,
    secretAccessKey: cfg.secretAccessKey,
    bucket: cfg.bucket,
    endpoint: cfg.endpoint,
    region: cfg.region,
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
