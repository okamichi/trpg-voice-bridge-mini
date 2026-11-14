// Bridge Mini from the source tree: `npm start`.
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runMini } from "./mini/run.mjs";
import { MINI_MODEL } from "./mini/model.mjs";

const local = (path) => fileURLToPath(new URL(path, import.meta.url));

try {
  await runMini({
    version: () => JSON.parse(readFileSync(local("./package.json"))).version,
    layout: () => {
      const speechDir = resolve(
        process.env.TTS_SPEECH_RUNTIME_DIR ??
          local("./.packaging/speech-runtime/"),
      );
      if (!existsSync(join(speechDir, "build.json")))
        throw Object.assign(
          Error(
            `speech.cppのビルドがありません（${speechDir}）。npm run package:speech を実行してから起動してください。`,
          ),
          { expose: true },
        );
      return {
        dataDir: local("./data/"),
        speechDir,
        speechPlace: `speech.cppのビルド（${speechDir}）`,
        model: resolve(
          process.env.TRPG_VOICE_BRIDGE_MINI_MODEL ??
            join(local("./.packaging/model/"), MINI_MODEL.file),
        ),
        modelHint:
          "npm run package:model を実行するか、環境変数 TRPG_VOICE_BRIDGE_MINI_MODEL でGGUFの場所を指定してください。",
      };
    },
  });
} catch (error) {
  // Library errors may carry secrets; only fixed messages reach the console.
  console.error(
    error?.expose || error?.status
      ? error.message
      : error?.code === "ERR_PARSE_ARGS_UNKNOWN_OPTION"
        ? "不明なオプションです。--help で使い方を確認してください。"
        : "Bridge Miniを起動できませんでした。ポート・保存先・speech.cppのビルドを確認してください。",
  );
  process.exitCode = 1;
}
