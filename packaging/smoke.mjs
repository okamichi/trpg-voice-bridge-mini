// Checks the Bridge Mini archive as a user gets it: extracted to a path with
// spaces and Japanese, run from another directory, without Node on PATH.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync, spawn } from "node:child_process";
import { createServer } from "node:net";
import { MINI_MODEL } from "../mini/model.mjs";
import { checkProjectVersion } from "./version.mjs";
import { sha256File } from "./hash.mjs";

const version = checkProjectVersion();
const archive = resolve(
  process.argv[2] ??
    fileURLToPath(
      new URL(
        `../dist/trpg-voice-bridge-mini-${version}-${process.platform}-${process.arch}.zip`,
        import.meta.url,
      ),
    ),
);
const temporary = mkdtempSync(join(tmpdir(), "bridge-mini-package-"));
const unpacked = join(temporary, "日本語 package");
const cwd = join(temporary, "別の cwd");
mkdirSync(unpacked);
mkdirSync(cwd);
const freePort = () =>
  new Promise((done, fail) => {
    const probe = createServer();
    probe.once("error", fail);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => done(port));
    });
  });
try {
  if (process.platform === "darwin")
    execFileSync("ditto", ["-x", "-k", archive, unpacked]);
  else
    execFileSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "Expand-Archive -LiteralPath $env:BRIDGE_PACKAGE_ZIP -DestinationPath $env:BRIDGE_PACKAGE_DEST",
      ],
      {
        env: {
          ...process.env,
          BRIDGE_PACKAGE_ZIP: archive,
          BRIDGE_PACKAGE_DEST: unpacked,
        },
      },
    );
  const root = join(unpacked, "TRPG-Voice-Bridge-Mini");
  const exe = join(
    root,
    `trpg-voice-bridge-mini${process.platform === "win32" ? ".exe" : ""}`,
  );
  for (const file of [
    "README.txt",
    "LICENSE",
    "collector/manifest.json",
    "licenses/THIRD-PARTY-NOTICES",
    "licenses/model/NOTICE.txt",
    "licenses/model/LICENSE-MIT",
    "licenses/model/LICENSE-APACHE-2.0",
    "licenses/model/LICENSE-modernbert-ja-310m",
    "runtime/speech/build.json",
    "runtime/discord/package.json",
  ])
    assert.ok(existsSync(join(root, file)), `${file} is in the package`);
  for (const absent of ["chatter", "data", "web"])
    assert.ok(
      !existsSync(join(root, absent)),
      `${absent} is not in the package`,
    );
  const model = join(root, "runtime/models", MINI_MODEL.file);
  assert.equal(statSync(model).size, MINI_MODEL.bytes);
  assert.equal(await sha256File(model), MINI_MODEL.sha256);

  // No Node, npm or developer tools: only the system directories.
  const env = {
    PATH:
      process.platform === "win32"
        ? `${process.env.SystemRoot}\\System32;${process.env.SystemRoot}`
        : "/usr/bin:/bin",
    ...(process.platform === "win32"
      ? {
          SystemRoot: process.env.SystemRoot,
          TEMP: process.env.TEMP,
          LOCALAPPDATA: process.env.LOCALAPPDATA,
        }
      : { HOME: process.env.HOME, TMPDIR: process.env.TMPDIR }),
  };
  assert.equal(
    execFileSync(exe, ["--version"], { cwd, env, encoding: "utf8" }).trim(),
    version,
  );
  const selfTest = JSON.parse(
    execFileSync(exe, ["--self-test"], { cwd, env, encoding: "utf8" }),
  );
  assert.equal(selfTest.sqlite, "ok");
  assert.equal(selfTest.discord, "ok");

  // A start with a token Discord rejects: the bundled model must load from
  // the package before the login is attempted, and the exit must be clean.
  const [port, ttsPort] = [await freePort(), await freePort()];
  const child = spawn(
    exe,
    ["--port", String(port), "--tts-port", String(ttsPort)],
    {
      cwd,
      env: { ...env, TRPG_VOICE_BRIDGE_DISCORD_TOKEN: "smoke-test-token" },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let output = "";
  child.stdout.on("data", (chunk) => (output += chunk));
  child.stderr.on("data", (chunk) => (output += chunk));
  const timer = setTimeout(() => child.kill("SIGKILL"), 300000);
  const code = await new Promise((done) => child.once("close", done));
  clearTimeout(timer);
  assert.match(output, /音声モデルを読み込んでいます/, output);
  assert.match(output, /Discord Botにログインできませんでした/, output);
  assert.doesNotMatch(output, /内蔵TTSを開始できませんでした/, output);
  assert.equal(code, 1, output);
  // Data is kept beside the executable.
  assert.ok(existsSync(join(root, "data/bridge.sqlite")));
  assert.ok(existsSync(join(root, "data/discord.json")));
  console.log(`Bridge Mini package OK: ${archive}`);
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
