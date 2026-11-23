import { expect, test } from "bun:test";
import { join } from "node:path";

// The package's declaration (space.release.yaml, spec 2) and the git deployment's (space.yaml,
// spec 1) describe the same app until the deployment moves to the package: they must not drift.

const root = join(import.meta.dir, "..");
const read = async (file: string) => Bun.YAML.parse(await Bun.file(join(root, file)).text()) as Record<string, unknown>;

test("space.release.yaml carries space.yaml's components", async () => {
  const source = await read("space.yaml");
  const release = await read("space.release.yaml");
  const { spec: _s, service: _sv, url: _u, deploy: _d, storage: sourceStorage, tasks: sourceTasks, ...components } = source;
  const { spec, version, requires, offline, launch, build, storage, tasks, ...releaseComponents } = release;
  expect(releaseComponents).toEqual(components);
  // A package's HTTP task names a path on the app's own service; the git deployment's names the loopback port.
  const local = (t: { run: { http?: { url: string } } }) => (t.run.http ? { ...t, run: { ...t.run, http: { ...t.run.http, url: t.run.http.url.replace(/^http:\/\/127\.0\.0\.1:\$\{PORT\}/, "") } } } : t);
  expect(tasks).toEqual((sourceTasks as Parameters<typeof local>[0][]).map(local));
  expect((tasks as { run: { http?: { url: string } } }[]).every((t) => !t.run.http || t.run.http.url.startsWith("/"))).toBe(true);
  // The one difference: a package installs on a Space without a bucket too, where pictures go to files.
  const { blobs: sourceBlobs, ...sourceRest } = sourceStorage as Record<string, unknown>;
  const { blobs, ...rest } = storage as Record<string, unknown>;
  expect(rest).toEqual(sourceRest);
  expect(sourceBlobs).toBe("s3");
  expect(blobs).toEqual({ backend: "s3", fallback: "file" });
  expect(spec).toBe(2);
  expect(version).toBe((await Bun.file(join(root, "package.json")).json()).version);
  expect(requires).toMatchObject({ spaceApi: 1 });
  expect(offline).toBeDefined();
  expect(launch).toMatchObject({ kind: "process", entry: "dist/index.js", health: (source.service as { health: string }).health });
  expect(build).toMatchObject({ run: "bun run build" });
  // The planner agent runs `bun src/cli.ts` (which prints its chat cards with src/cards.ts): the package must carry both.
  expect((build as { include: string[] }).include).toEqual(expect.arrayContaining(["dist", "src/cli.ts", "src/cards.ts", "agents", "skills", "icon.png"]));
});
