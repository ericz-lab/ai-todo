import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTodo, deleteTodo, listRecords, openDb } from "./db.ts";
import { fileStore, type BlobStore } from "./blobs.ts";
import { createServer } from "./index.ts";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=", "base64");
function fixture(wrap: (store: BlobStore) => BlobStore = store => store) {
  const root = mkdtempSync(join(tmpdir(), "todo-images-"));
  const db = openDb(":memory:");
  const todo = createTodo(db, { title: "Evidence" });
  const store = fileStore(root);
  const { server } = createServer({ db, blobs: wrap(store), port: 0, web: false });
  const base = `http://127.0.0.1:${server.port}`;
  return { db, todo, store, base, post: (form: FormData) => fetch(`${base}/api/todos/${todo.id}/records`, { method: "POST", body: form }), close() { server.stop(true); db.close(); rmSync(root, { recursive: true, force: true }); } };
}
function form(count = 1, bytes: BlobPart = png, content = "") {
  const data = new FormData();
  data.set("content", content);
  for (let i = 0; i < count; i++) data.append("images", new File([bytes], `evidence-${i}.png`, { type: "image/png" }));
  return data;
}

test("image-only and mixed records persist, stream original bytes, and disappear from API on todo deletion", async () => {
  const f = fixture();
  try {
    const response = await f.post(form(2));
    expect(response.status).toBe(201);
    const { record } = await response.json();
    expect(record.content).toBe("");
    expect(record.attachments).toHaveLength(2);
    expect(listRecords(f.db, f.todo.id)[0]).toEqual(record);
    const url = `${f.base}/blobs/${record.attachments[0].key}`;
    const image = await fetch(url);
    expect(image.headers.get("content-type")).toBe("image/png");
    expect(image.headers.get("x-content-type-options")).toBe("nosniff");
    expect(Buffer.from(await image.arrayBuffer())).toEqual(png);
    expect((await f.post(form(1, png, "Screenshot verified"))).status).toBe(201);
    deleteTodo(f.db, f.todo.id);
    expect((await fetch(url)).status).toBe(404);
    expect(listRecords(f.db, f.todo.id)).toHaveLength(2);
  } finally { f.close(); }
});

test("rejects fake images, excessive count/size, malformed multipart and empty entries without saving records", async () => {
  const f = fixture();
  try {
    expect((await f.post(form(1, "<svg onload='alert(1)'/>"))).status).toBe(415);
    expect((await f.post(form(7))).status).toBe(400);
    expect((await f.post(form(1, new Uint8Array(10 * 1024 * 1024 + 1)))).status).toBe(413);
    expect((await f.post(form(0))).status).toBe(400);
    expect((await f.post(form(1, png, "x".repeat(20001)))).status).toBe(400);
    expect((await fetch(`${f.base}/api/todos/${f.todo.id}/records`, { method: "POST", headers: { "content-type": "multipart/form-data" }, body: "broken" })).status).toBe(400);
    expect(listRecords(f.db, f.todo.id)).toEqual([]);
  } finally { f.close(); }
});

test("partial uploads and database failures clean up every staged object", async () => {
  for (const failure of ["upload", "audit", "deleted"]) {
    const keys: string[] = [];
    const removed: string[] = [];
    const f = fixture(store => ({ ...store,
      async put(key, data, mime) {
        keys.push(key);
        await store.put(key, data, mime);
        if (failure === "upload" && keys.length === 2) throw new Error("storage failed");
        if (failure === "deleted") deleteTodo(f.db, f.todo.id);
      },
      async remove(key) { removed.push(key); await store.remove(key); },
    }));
    try {
      if (failure === "audit") f.db.exec("CREATE TRIGGER reject_record BEFORE INSERT ON todo_events WHEN NEW.kind = 'record-added' BEGIN SELECT RAISE(ABORT, 'audit unavailable'); END");
      expect((await f.post(form(2))).status).toBe(failure === "deleted" ? 404 : 400);
      expect(removed).toEqual(keys);
      for (const key of keys) expect(await f.store.stream(key)).toBeNull();
      expect(listRecords(f.db, f.todo.id)).toEqual([]);
    } finally { f.close(); }
  }
});

test("existing operation records acquire an empty attachment list and survive reopening", () => {
  const root = mkdtempSync(join(tmpdir(), "todo-images-migrate-"));
  try {
    const path = join(root, "old.db");
    let db = openDb(path);
    db.exec("ALTER TABLE todo_records DROP COLUMN attachments");
    db.exec("INSERT INTO todo_records (todo_id, content, source, created_at) VALUES (1, 'Existing', 'manual', '2026-01-01T00:00:00Z')");
    db.close();
    db = openDb(path);
    expect(listRecords(db, 1)[0]).toMatchObject({ content: "Existing", attachments: [] });
    db.close();
    db = openDb(path);
    expect(listRecords(db, 1)).toHaveLength(1);
    db.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("another app attaches a picture to a task through the record capability, by id in the body", async () => {
  const f = fixture();
  try {
    const data = form(1, png, "来自灵光一闪 #20 的截图");
    data.set("todoId", String(f.todo.id));
    data.set("source", "ai");
    const response = await fetch(`${f.base}/api/capabilities/record`, { method: "POST", body: data });
    expect(response.status).toBe(201);
    const { record } = await response.json();
    expect(record).toMatchObject({ todoId: f.todo.id, content: "来自灵光一闪 #20 的截图", source: "ai" });
    expect(record.attachments).toHaveLength(1);
    expect(Buffer.from(await (await fetch(`${f.base}/blobs/${record.attachments[0].key}`)).arrayBuffer())).toEqual(png);
    const missing = form(1);
    missing.set("todoId", "9999");
    expect((await fetch(`${f.base}/api/capabilities/record`, { method: "POST", body: missing })).status).toBe(404);
    expect((await fetch(`${f.base}/api/capabilities/record`, { method: "POST", body: form(1) })).status).toBe(404);
    expect(listRecords(f.db, f.todo.id)).toHaveLength(1);
  } finally { f.close(); }
});
