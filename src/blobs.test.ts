import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { blobTarget, fileStore, KEY_RE, mimeOfKey, newKey, openStore, s3Store } from "./blobs.ts";

describe("blob store", () => {
  let root = "";
  beforeAll(() => { root = mkdtempSync(join(tmpdir(), "todo-blobs-")); });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  test("BLOB_URL: file, s3 and the default directory", () => {
    expect(blobTarget({ BLOB_URL: "file:///srv/data/ai-todo/blobs" })).toEqual({ kind: "file", dir: "/srv/data/ai-todo/blobs" });
    expect(blobTarget({ BLOB_URL: "s3://my-bucket/ai-todo/" })).toEqual({ kind: "s3", bucket: "my-bucket", prefix: "ai-todo/" });
    expect(blobTarget({ BLOB_URL: "s3://bucket" })).toEqual({ kind: "s3", bucket: "bucket", prefix: "" });
    expect(blobTarget({ SPACE_APP_DATA_DIR: "/srv/data/x" })).toEqual({ kind: "file", dir: "/srv/data/x/blobs" });
    expect(() => blobTarget({ BLOB_URL: "gs://x" })).toThrow();
    expect(() => openStore({ BLOB_URL: "s3://b/p/" })).toThrow(/S3_ACCESS_KEY_ID/);
  });

  test("keys stay inside the store", () => {
    const k = newKey("records/3", "image/png", 1_700_000_000_000);
    expect(k).toMatch(/^records\/3\/1700000000000-[0-9a-f]{32}\.png$/);
    expect(KEY_RE.test(k)).toBe(true);
    expect(KEY_RE.test(newKey("records/1", "image/webp", 1))).toBe(true);
    expect(mimeOfKey(k)).toBe("image/png");
    for (const bad of ["../main.db", "plans/../x.png", "plans/1-abcdef12.svg", "records/x/1-abcdef12.png"]) expect(KEY_RE.test(bad)).toBe(false);
    expect(() => newKey("records/1", "image/svg+xml", 1)).toThrow();
  });

  test("file store: put, stream, remove; bad keys never touch the disk", async () => {
    const s = fileStore(join(root, "files"));
    const key = newKey("records/1", "image/jpeg", 1);
    await s.put(key, new Blob([new Uint8Array([0xff, 0xd8, 0xff])]), "image/jpeg");
    expect(new Uint8Array(await new Response((await s.stream(key))!).arrayBuffer())).toEqual(new Uint8Array([0xff, 0xd8, 0xff]));
    expect(await s.stream("../x.png")).toBeNull();
    await expect(s.put("../x.png", new Blob(["x"]), "image/png")).rejects.toThrow();
    await s.remove(key);
    expect(await s.stream(key)).toBeNull();
  });

  test("s3 store: keys are prefixed and typed", async () => {
    const objects = new Map<string, { data: Blob; type: string }>();
    const client = {
      write: async (k: string, data: Blob, o: { type: string }) => { objects.set(k, { data, type: o.type }); return data.size; },
      file: (k: string) => ({ exists: async () => objects.has(k), stream: () => objects.get(k)!.data.stream() }),
      delete: async (k: string) => { objects.delete(k); },
    };
    const s = s3Store({ bucket: "b", prefix: "ai-todo/", client: client as unknown as import("bun").S3Client });
    expect(s.location).toBe("s3://b/ai-todo/");
    const key = newKey("records/1", "image/png", 2);
    await s.put(key, new Blob([new Uint8Array([0x89, 0x50])]), "image/png");
    expect([...objects.keys()]).toEqual([`ai-todo/${key}`]);
    expect(objects.get(`ai-todo/${key}`)!.type).toBe("image/png");
    expect(await new Response((await s.stream(key))!).arrayBuffer()).toHaveLength(2);
    expect(await s.stream("../main.db")).toBeNull();
    await s.remove(key);
    expect(objects.size).toBe(0);
  });
});
