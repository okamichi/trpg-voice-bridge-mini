import { accessSync, constants, statSync } from "node:fs";
import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import { exposed, platformBackends } from "../src/runtime/settings.mjs";
import { SpeechRuntime } from "../src/runtime/speech.mjs";
import { checkDataDir, probePort } from "../src/runtime/startup.mjs";
import { createMini } from "./app.mjs";
import { inviteUrl } from "./discord.mjs";
import { MINI_STEPS } from "./model.mjs";

const TOKEN_ENV = "TRPG_VOICE_BRIDGE_DISCORD_TOKEN";

const port = (value, fallback, label) => {
  if (value === undefined) return fallback;
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1 || number > 65535)
    throw exposed(`${label}は1～65535で指定してください`);
  return number;
};
const validToken = (token) =>
  token.length > 0 && token.length <= 200 && !/\s/.test(token);

async function askToken(first) {
  if (!process.stdin.isTTY)
    throw exposed(
      first
        ? `Discord Botのトークンがありません。端末から起動して入力するか、環境変数 ${TOKEN_ENV} で指定してください`
        : "トークンを確認して、起動し直してください",
    );
  console.log(
    first
      ? "\nDiscord Botのトークンを貼り付けて、Enterを押してください。\n（Discord Developer PortalのBotのページで発行できます。入力した値は保存先のdiscord.jsonに保存されます）"
      : "\nもう一度、Discord Botのトークンを貼り付けて、Enterを押してください。",
  );
  const terminal = createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  try {
    for (;;) {
      const token = (await terminal.question("トークン> ")).trim();
      if (validToken(token)) return token;
      console.log("トークンは空白を含まない200文字以内の文字列です。");
    }
  } finally {
    terminal.close();
  }
}

// layout() gives { dataDir, speechDir, speechPlace, model } for this start:
// the package and the source tree keep them in different places.
export async function runMini({
  args = process.argv.slice(2),
  version,
  selfTest,
  layout,
}) {
  const { values } = parseArgs({
    args,
    options: {
      help: { type: "boolean" },
      version: { type: "boolean" },
      ...(selfTest ? { "self-test": { type: "boolean" } } : {}),
      "data-dir": { type: "string" },
      port: { type: "string" },
      "tts-port": { type: "string" },
      steps: { type: "string" },
      "tts-backend": { type: "string" },
    },
  });
  if (values.help) {
    console.log(
      `TRPG Voice Bridge Mini\n--help --version --data-dir <path> --port <1-65535> --tts-port <1-65535>\n--steps <1-100> (default ${MINI_STEPS})\n--tts-backend <vulkan|cpu> (Windows)`,
    );
    return;
  }
  if (values.version) {
    console.log(version());
    return;
  }
  if (values["self-test"]) {
    await selfTest();
    return;
  }
  const place = layout();
  const dataDir = resolve(values["data-dir"] ?? place.dataDir);
  const bridgePort = port(values.port, 8090, "ポート");
  const ttsPort = port(values["tts-port"], 18088, "TTSポート");
  const steps = values.steps === undefined ? MINI_STEPS : Number(values.steps);
  if (!Number.isInteger(steps) || steps < 1 || steps > 100)
    throw exposed("--steps は1～100の整数で指定してください");
  const backends = platformBackends();
  if (
    values["tts-backend"] !== undefined &&
    !backends.includes(values["tts-backend"])
  )
    throw exposed(`--tts-backend は${backends.join("、")}から指定してください`);
  try {
    if (!statSync(place.model).isFile()) throw Error();
    accessSync(place.model, constants.R_OK);
  } catch {
    throw exposed(
      `音声モデルが見つかりません（${place.model}）。${place.modelHint}`,
    );
  }
  checkDataDir(dataDir);
  await probePort(bridgePort, "127.0.0.1");

  console.log(
    `TRPG Voice Bridge Mini ${version()}${steps === MINI_STEPS ? "" : `（生成ステップ数 ${steps}）`}`,
  );
  const openSpeech = async (backend) => {
    const created = new SpeechRuntime({
      dataDir,
      runtimeDir: place.speechDir,
      place: place.speechPlace,
      backends,
      overrides: { mode: "bundled", model: place.model, ttsPort, backend },
      restoreReferences: false,
    });
    await created.acquire();
    return created;
  };
  let runtime = await openSpeech(values["tts-backend"] ?? backends[0]);
  let mini, stopping;
  const stop = () =>
    (stopping ??= (async () => {
      for (const name of ["SIGINT", "SIGTERM"]) process.off(name, signal);
      await mini?.close();
      await runtime.close();
    })());
  const signal = () => {
    console.log("\n終了しています…");
    stop().then(
      () => process.exit(process.exitCode ?? 0),
      () => process.exit(1),
    );
  };
  for (const name of ["SIGINT", "SIGTERM"]) process.once(name, signal);
  const startSpeech = async () => {
    process.stdout.write("音声モデルを読み込んでいます");
    const dots = setInterval(() => process.stdout.write("."), 2000);
    try {
      await runtime.start();
    } finally {
      clearInterval(dots);
      process.stdout.write("\n");
    }
  };
  try {
    // The bot greets with a generated line, so the model is loaded before the
    // bot logs in.
    await startSpeech();
    // Without --tts-backend, a PC with no usable GPU gets the CPU build.
    if (
      runtime.status === "error" &&
      !stopping &&
      values["tts-backend"] === undefined &&
      runtime.settings.active.backend === "vulkan"
    ) {
      console.log("GPU（Vulkan）版を使えないため、CPU版で起動します。");
      await runtime.close();
      runtime = await openSpeech("cpu");
      await startSpeech();
    }
    if (stopping) return;
    if (runtime.status !== "ready")
      throw exposed(`内蔵TTSを開始できませんでした。${runtime.error}`);
    runtime.onFatal = signal;

    mini = createMini({
      dataDir,
      ttsPort,
      steps,
      localOrigin: `http://127.0.0.1:${bridgePort}`,
      tts: () => ({ status: runtime.status, error: runtime.error }),
      providerOptions: {
        resolveProvider: (saved) => runtime.provider(saved),
        fetchImpl: (...request) => runtime.fetch(...request),
      },
    });
    await new Promise((done, fail) => {
      mini.app.server.once("error", fail);
      mini.app.server.listen(bridgePort, "127.0.0.1", () => {
        mini.app.server.off("error", fail);
        done();
      });
    });

    let token = process.env[TOKEN_ENV]?.trim();
    if (token && !validToken(token))
      throw exposed(`環境変数 ${TOKEN_ENV} のトークンが不正です`);
    if (!token && !(await mini.status()).tokenSet) token = await askToken(true);
    let bot = await mini.login(token);
    if (!bot.installed)
      throw exposed(
        "Discordに接続するための部品が見つかりません。展開したフォルダを確認してください",
      );
    while (bot.state !== "logged-in" && !stopping) {
      console.error(
        "Discord Botにログインできませんでした。トークンとネットワークを確認してください。",
      );
      bot = await mini.login(await askToken(false));
    }
    if (stopping) return;

    const client = mini.discord.bot?.client;
    console.log(`Discord Bot「${bot.botName}」でログインしました。`);
    if (client?.user && !client.guilds.cache.size)
      console.log(
        `Botをサーバーに招待してください：\n${inviteUrl(client.user.id)}`,
      );
    console.log(
      `Collectorの接続先：http://127.0.0.1:${bridgePort}\n準備ができました。Discordで /bridge join を実行してください。終了するにはCtrl+Cを押します。`,
    );
  } catch (error) {
    await stop();
    throw error;
  }
}
