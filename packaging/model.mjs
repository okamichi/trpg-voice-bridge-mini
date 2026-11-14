// Fetches the model Bridge Mini carries into .packaging/model/, with the
// speech.cpp built by `npm run package:speech`. speech verifies the size and
// SHA-256 against its catalog; this script checks them against Mini's own pin.
import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  linkSync,
  mkdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { MINI_MODEL } from "../mini/model.mjs";
import { sha256File } from "./hash.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const speechDir = resolve(
  process.env.TTS_SPEECH_RUNTIME_DIR ?? join(root, ".packaging/speech-runtime"),
);
const speech = join(
  speechDir,
  process.platform === "win32" ? "speech.exe" : "speech",
);
if (!existsSync(speech))
  throw Error(`Run npm run package:speech first: ${speech} is missing`);

const destination = join(root, ".packaging/model", MINI_MODEL.file);
async function verified(path) {
  return (
    existsSync(path) &&
    statSync(path).size === MINI_MODEL.bytes &&
    (await sha256File(path)) === MINI_MODEL.sha256
  );
}

if (await verified(destination)) console.log(`Model: ${destination}`);
else {
  // speech prints the fetched file's path on stdout and progress on stderr.
  const fetched = execFileSync(speech, ["pull", MINI_MODEL.choice], {
    env: {
      ...process.env,
      SPEECH_MODEL_DIR: join(root, ".packaging/model-cache"),
    },
    stdio: ["ignore", "pipe", "inherit"],
    encoding: "utf8",
  })
    .trim()
    .split(/\r?\n/)
    .at(-1);
  if (!(await verified(fetched)))
    throw Error(
      `${MINI_MODEL.choice} does not match the size and SHA-256 pinned in mini/model.mjs`,
    );
  mkdirSync(join(root, ".packaging/model"), { recursive: true });
  rmSync(destination, { force: true });
  try {
    linkSync(fetched, destination);
  } catch {
    copyFileSync(fetched, destination);
  }
  console.log(`Model: ${destination}`);
}
