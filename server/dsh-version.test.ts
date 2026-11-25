import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { detectDshVersion } from "./dsh-version.js";

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "paseo-dsh-version-test-"));
  return {
    root,
    async script(name: string, body: string): Promise<string> {
      const executable = path.join(root, process.platform === "win32" ? `${name}.cmd` : name);
      const script = process.platform === "win32"
        ? path.join(root, "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js")
        : executable;
      await mkdir(path.dirname(script), { recursive: true });
      if (process.platform === "win32") await writeFile(executable, "@echo off\r\n");
      await writeFile(script, `#!/usr/bin/env node\n${body}\n`);
      await chmod(script, 0o755);
      return executable;
    },
  };
}

describe("detectDshVersion", () => {
  it("parses the version a well-behaved executable prints", async () => {
    const f = await fixture();
    try {
      const exe = await f.script("dsh-ok", `console.log("0.1.7-rc.2");`);
      assert.equal(await detectDshVersion(exe), "0.1.7-rc.2");
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });

  it("tolerates surrounding text around the version", async () => {
    const f = await fixture();
    try {
      const exe = await f.script("dsh-prefixed", `console.log("dsh version 0.2.0-rc.1");`);
      assert.equal(await detectDshVersion(exe), "0.2.0-rc.1");
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });

  it("returns an empty string on a non-zero exit", async () => {
    const f = await fixture();
    try {
      const exe = await f.script("dsh-fails", `console.error("boom");\nprocess.exit(1);`);
      assert.equal(await detectDshVersion(exe), "");
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });

  it("returns an empty string when the output has no parseable version", async () => {
    const f = await fixture();
    try {
      const exe = await f.script("dsh-garbled", `console.log("not a version");`);
      assert.equal(await detectDshVersion(exe), "");
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });

  it("returns an empty string and kills the process on timeout", async () => {
    const f = await fixture();
    try {
      const exe = await f.script("dsh-hangs", `setInterval(() => {}, 1000);`);
      assert.equal(await detectDshVersion(exe, { timeoutMs: 50 }), "");
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });

  it("aborts an uncached version probe and does not poison the shared cache", async () => {
    const f = await fixture();
    const controller = new AbortController();
    try {
      const pidFile = path.join(f.root, "child.pid");
      const exe = await f.script("dsh-abort", `require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));\nsetInterval(() => {}, 1000);`);
      const probing = detectDshVersion(exe, { signal: controller.signal });
      while (true) {
        try { await stat(pidFile); break; }
        catch { await new Promise((resolve) => setTimeout(resolve, 10)); }
      }
      const pid = Number((await readFile(pidFile, "utf8")).trim());
      controller.abort();
      await assert.rejects(probing, { name: "AbortError" });
      assert.throws(() => process.kill(pid, 0), (error: NodeJS.ErrnoException) => error.code === "ESRCH");
      assert.equal(await detectDshVersion(exe, { timeoutMs: 50 }), "");
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });

  it("caches by executable path: a second call does not spawn again", async () => {
    const f = await fixture();
    try {
      const log = path.join(f.root, "calls.log");
      const exe = await f.script("dsh-counted", `require("node:fs").appendFileSync(${JSON.stringify(log)}, "called\\n");\nconsole.log("0.1.1");`);
      assert.equal(await detectDshVersion(exe), "0.1.1");
      assert.equal(await detectDshVersion(exe), "0.1.1");
      assert.equal((await readFile(log, "utf8")).trim().split("\n").length, 1);
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });
});
