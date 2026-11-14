import { rmSync } from "node:fs";
import { join } from "node:path";
import { createApp } from "../src/http.mjs";
import { initialConfig } from "../src/store.mjs";
import { createExtension } from "../discord/extension.mjs";
import { createBot } from "../discord/bot.mjs";
import { forgetRooms, identify } from "./identity.mjs";
import { MiniDiscord } from "./discord.mjs";
import { VoiceTidy, forgetVoiceless } from "./voices.mjs";
import { shapeSynthesis } from "./synthesis.mjs";

// A new data directory starts from this. Chat registration is always on, and
// there is no Player to publish text to.
export function miniConfig(ttsPort) {
  return {
    ...initialConfig({}),
    roomId: "bridge-mini",
    publishTextToPlayers: false,
    chatVoiceRegistrationEnabled: true,
    provider: {
      type: "speech",
      baseUrl: `http://127.0.0.1:${ttsPort}`,
      model: "irodori-tts",
    },
  };
}

// Bridge's Engine, Collector API and Discord Bot without any web page.
// tts() gives { status, error } of the bundled speech.cpp.
export function createMini({
  dataDir,
  localOrigin,
  ttsPort = 18088,
  steps,
  tts,
  providerOptions = {},
  createBotImpl = createBot,
  installed,
  log = (message) => console.error(message),
  pairingPollMs,
}) {
  let discord, extension;
  // The greetings are kept as files and reused while their text and voice
  // stay the same. Mini makes them again at each start, so a change in how
  // it generates speech reaches them.
  for (const kind of ["enter", "leave"])
    rmSync(join(dataDir, `discord-${kind}.wav`), { force: true });
  const app = createApp({
    dataDir,
    localOrigin,
    initial: miniConfig(ttsPort),
    providerOptions: {
      ...providerOptions,
      fetchImpl: shapeSynthesis(providerOptions.fetchImpl ?? fetch, steps),
      identify: (event, store) => {
        const named = identify(event, store);
        return discord ? discord.chatCommand(named) : named;
      },
    },
    extensions: [
      (options) =>
        (extension = createExtension({
          ...options,
          ...(installed === undefined ? {} : { installed }),
          // The bot logs in after createApp returns, when discord exists.
          botFactory: (bot) => discord.botFactory(createBotImpl)(bot),
          log: (message) => log(`[Discord] ${message}`),
        })),
    ],
  });
  if (!extension) {
    void app.close();
    throw Error("Discord Botを初期化できませんでした");
  }
  // Data brought over from Bridge may have chat registration turned off.
  if (!app.store.config.chatVoiceRegistrationEnabled)
    app.store.change((config) => {
      config.chatVoiceRegistrationEnabled = true;
    });
  forgetRooms(app.store);
  forgetVoiceless(app.store);
  discord = new MiniDiscord({ app, tts, log, pairingPollMs });
  discord.extension = extension;
  // Replaces the extension's designer, which follows Bridge's admin setting.
  app.engine.chatVoices.designer = discord.designer;
  const tidy = new VoiceTidy({
    store: app.store,
    engine: app.engine,
    uses: () => extension.voiceProfileUses(),
    log,
  });
  app.engine.on("notification", (n) => {
    if (n.type === "characters.changed") void tidy.changed();
  });
  const status = () =>
    extension.admin({ method: "GET", path: "status" }).then((r) => r.data);
  return {
    app,
    discord,
    extension,
    tidy,
    status,
    // Saving the token also logs the bot in.
    async login(token) {
      const current = await status();
      if (token || !current.enabled)
        await extension.admin({
          method: "PUT",
          path: "settings",
          body: { enabled: true, ...(token ? { token } : {}) },
        });
      await extension.ready;
      return status();
    },
    async close() {
      tidy.close();
      discord.close();
      await app.close();
    },
  };
}
