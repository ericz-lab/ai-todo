/** Image storage follows trade-journal: private BLOB_URL objects streamed by the app. */
import { S3Client } from "bun";
import { mkdirSync } from "node:fs";
import { unlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const IMAGE_TYPES: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif" };

export const KEY_RE = /^records\/\d+\/\d+-[0-9a-f]{32}\.(?:png|jpg|webp|gif)$/;

export const mimeOfKey = (key: string): string => {
  const ext = key.slice(key.lastIndexOf(".") + 1);
  return Object.entries(IMAGE_TYPES).find(([, e]) => e === ext)?.[0] ?? "application/octet-stream";
};

/** A new key under `records/<todoId>` for an image of type `mime`. */
export function newKey(dir: string, mime: string, now: number): string {
  const ext = IMAGE_TYPES[mime];
  if (!ext) throw new Error(`unsupported image type ${mime}`);
  return `${dir}/${now}-${crypto.randomUUID().replaceAll("-", "")}.${ext}`;
}

export interface BlobStore {
  kind: "file" | "s3";
  /** Where the bytes live, for logs: a directory or `s3://bucket/prefix/`. */
  location: string;
  put(key: string, data: Blob, mime: string): Promise<void>;
  /** A stream for serving, or null when the key is invalid or the object is gone. */
  stream(key: string): Promise<ReadableStream<Uint8Array> | null>;
  remove(key: string): Promise<void>;
}

export type BlobTarget = { kind: "file"; dir: string } | { kind: "s3"; bucket: string; prefix: string };

/** `BLOB_URL` (file:///dir or s3://bucket/prefix/) from ai-space, else <data>/blobs. */
export function blobTarget(e: Record<string, string | undefined> = process.env): BlobTarget {
  const url = (e.BLOB_URL ?? "").trim();
  if (!url) return { kind: "file", dir: resolve(e.SPACE_APP_DATA_DIR ?? "data", "blobs") };
  if (url.startsWith("file://")) return { kind: "file", dir: fileURLToPath(url) };
  const s3 = /^s3:\/\/([^/]+)\/?(.*)$/.exec(url);
  if (s3) {
    const prefix = s3[2]!.replace(/^\/+/, "").replace(/\/*$/, "");
    return { kind: "s3", bucket: s3[1]!, prefix: prefix ? `${prefix}/` : "" };
  }
  throw new Error(`BLOB_URL must be file:///dir or s3://bucket/prefix, got ${url}`);
}

export function fileStore(root: string): BlobStore {
  mkdirSync(root, { recursive: true });
  const pathOf = (key: string) => (KEY_RE.test(key) ? join(root, key) : null);
  return {
    kind: "file",
    location: root,
    async put(key, data) {
      const path = pathOf(key);
      if (!path) throw new Error(`invalid blob key ${key}`);
      mkdirSync(dirname(path), { recursive: true });
      await Bun.write(path, data);
    },
    async stream(key) {
      const path = pathOf(key);
      const f = path ? Bun.file(path) : null;
      return f && (await f.exists()) ? f.stream() : null;
    },
    async remove(key) {
      const path = pathOf(key);
      if (path) await unlink(path).catch(() => {});
    },
  };
}

export function s3Store(o: { bucket: string; prefix: string; client?: S3Client }): BlobStore {
  const client = o.client ?? new S3Client({ bucket: o.bucket });
  const objectKey = (key: string) => (KEY_RE.test(key) ? `${o.prefix}${key}` : null);
  return {
    kind: "s3",
    location: `s3://${o.bucket}/${o.prefix}`,
    async put(key, data, mime) {
      const k = objectKey(key);
      if (!k) throw new Error(`invalid blob key ${key}`);
      await client.write(k, data, { type: mime });
    },
    async stream(key) {
      const k = objectKey(key);
      const f = k ? client.file(k) : null;
      return f && (await f.exists()) ? f.stream() : null;
    },
    async remove(key) {
      const k = objectKey(key);
      if (k) await client.delete(k).catch(() => {});
    },
  };
}

/** The store `BLOB_URL` names; S3 credentials come from the `S3_*` variables Bun reads itself. */
export function openStore(e: Record<string, string | undefined> = process.env): BlobStore {
  const t = blobTarget(e);
  if (t.kind === "file") return fileStore(t.dir);
  if (!e.S3_ACCESS_KEY_ID || !e.S3_SECRET_ACCESS_KEY) throw new Error("BLOB_URL is an s3 store but S3_ACCESS_KEY_ID / S3_SECRET_ACCESS_KEY are not set");
  return s3Store({ bucket: t.bucket, prefix: t.prefix });
}

/** Sniff the image type from the first bytes; the browser's declared type is not trusted. */
export function sniffImage(bytes: Uint8Array): string | null {
  const b = bytes;
  if (b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "image/png";
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.length > 6 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return "image/gif";
  if (b.length > 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return "image/webp";
  return null;
}
