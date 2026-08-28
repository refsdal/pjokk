// The contracts apps/api depends on. Interfaces ONLY — no construction, and
// nothing here may import from ./infrastructure. apps/server picks the
// implementations; this file is what both sides agree on.

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

export type RateLimitStore = {
  /** Increments the window's counter and returns its new value. */
  hit(key: string, windowSeconds: number): Promise<number>;
  /** Drops expired rows. KV expired them for us; nothing does here. */
  sweep(now?: Date): Promise<number>;
};

export type PushPayload = {
  title: string;
  body: string;
  url?: string;
};

/**
 * Web push, with the database and the VAPID credentials closed over.
 *
 * Narrower than the function it replaces: `pushToUser(db, env, ...)` made
 * every caller carry a Db and the whole Env just to send a notification.
 * Dead subscriptions are still pruned inside the implementation.
 *
 * Returns the number of successful deliveries.
 */
export type PushSender = {
  toUser(userId: string, payload: PushPayload): Promise<number>;
};

/**
 * The peer address of a request, or null when it cannot be determined.
 *
 * A port rather than a value because only Bun's server handle knows it, and
 * that handle does not exist until Bun.serve() has returned — so apps/server
 * supplies a closure over its own mutable reference. Tests pass one that
 * returns null, which is why the rate limiter's "unknown" bucket exists.
 */
export type PeerAddress = (request: Request) => string | null;

/** Injected so reminder and backup tests are deterministic rather than
 *  dependent on the wall clock. */
export type Clock = () => Date;
