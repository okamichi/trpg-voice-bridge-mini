// The executable of the Bridge Mini package. Everything it reads and writes
// is beside it: the model, speech.cpp and the data directory. The model can
// be another GGUF file given by TRPG_VOICE_BRIDGE_MINI_MODEL, as from the
// source tree.
import { dirname, join, resolve } from "node:path";
import { Readable } from "node:stream";
import { DatabaseSync } from "node:sqlite";
import { runMini } from "../mini/run.mjs";
import { MINI_MODEL } from "../mini/model.mjs";
import { readAsset } from "../src/runtime/assets.mjs";
import { loadDependencies } from "../discord/bot.mjs";

async function selfTest() {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec("CREATE TABLE smoke (value TEXT); INSERT INTO smoke VALUES ('ok')");
    if (db.prepare("SELECT value FROM smoke").get().value !== "ok")
      throw Error("SQLite");
  } finally {
    db.close();
  }
  const deps = await loadDependencies();
  const resource = deps.createAudioResource(
    Readable.from([Buffer.alloc(960 * 4)]),
    { inputType: deps.StreamType.Raw },
  );
  let packets = 0;
  for await (const packet of resource.playStream) {
    if (!packet.length) throw Error("Opus");
    packets++;
  }
  if (!packets) throw Error("Opus");
  console.log(
    JSON.stringify({
      sqlite: "ok",
      discord: "ok",
      opusPackets: packets,
      node: process.version,
    }),
  );
}

runMini({
  version: () => JSON.parse(readAsset("build-info.json")).version,
  selfTest,
  layout: () => {
    const root = dirname(process.execPath);
    const model = process.env.TRPG_VOICE_BRIDGE_MINI_MODEL;
    return {
      dataDir: join(root, "data"),
      speechDir: join(root, "runtime/speech"),
      model: model
        ? resolve(model)
        : join(root, "runtime/models", MINI_MODEL.file),
      modelHint: model
        ? "環境変数 TRPG_VOICE_BRIDGE_MINI_MODEL のGGUFの場所を確認してください。"
        : "展開したフォルダのruntime/modelsを確認してください。実行ファイルだけを別の場所へ移すと動きません。",
    };
  },
}).catch((error) => {
  // Do not print arbitrary library errors containing secrets.
  console.error(
    error?.expose || error?.status
      ? error.message
      : error?.code === "ERR_PARSE_ARGS_UNKNOWN_OPTION"
        ? "不明なオプションです。--help で使い方を確認してください。"
        : error?.code === "EADDRINUSE"
          ? "ポートは使用中です。--port で別のポートを指定してください。"
          : "Bridge Miniを起動できませんでした。ポート・保存先・同梱のruntimeを確認してください。",
  );
  process.exitCode = 1;
});
