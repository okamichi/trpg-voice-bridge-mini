import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBot } from "../discord/bot.mjs";
import { fakeDiscord, until } from "../discord/test-helpers.mjs";
import { mockWav } from "../src/provider.mjs";
import { createMini } from "./app.mjs";
import { COMMAND, miniReason } from "./discord.mjs";
import { ensureCharacter } from "./identity.mjs";

const GUILD = "11111111111111111",
  VOICE = "11111111111111111",
  TEXT = "11111111111111119",
  OWNER = "900",
  NAME = "メリッサ・クローデル";

async function setup(
  t,
  { tts = { status: "ready", error: "" }, dataDir: shared } = {},
) {
  // A test that starts Mini twice on one directory passes it to the second
  // setup; only the setup that made the directory removes it.
  const dataDir = shared ?? mkdtempSync(join(tmpdir(), "mini-app-"));
  const fake = fakeDiscord(),
    posts = [],
    registered = [],
    logs = [],
    generations = [];
  const guild = fake.guilds.get(GUILD);
  const textChannel = {
    id: TEXT,
    guild,
    guildId: GUILD,
    name: "卓",
    type: 0,
    permissionsFor: () => ({ has: () => true }),
    send: async (payload) => {
      const message = {
        id: String(40000000000000000n + BigInt(posts.length)),
        payload,
        edit: async (next) => {
          message.payload = { ...message.payload, ...next };
          return message;
        },
      };
      posts.push(message);
      return message;
    },
  };
  guild.channels.cache.set(TEXT, textChannel);
  const mini = createMini({
    dataDir,
    localOrigin: "http://127.0.0.1:0",
    tts: () => tts,
    installed: true,
    pairingPollMs: 5,
    log: (message) => logs.push(message),
    providerOptions: {
      resolveProvider: (saved) => ({ ...saved, type: "irodori" }),
      fetchImpl: async (url, init = {}) => {
        if (String(url).endsWith("/v1/audio/speech")) {
          generations.push(JSON.parse(init.body));
          return new Response(mockWav());
        }
        if (init.method === "POST")
          return Response.json(
            { id: init.body.get("voice_id") },
            { status: 201 },
          );
        return Response.json({ data: [] });
      },
    },
    createBotImpl: async (options) => {
      const bot = await createBot({ ...options, deps: fake.deps });
      bot.client.channels = { fetch: async () => textChannel };
      bot.client.application = {
        commands: { set: async (commands) => registered.push(commands) },
      };
      return bot;
    },
  });
  await new Promise((r) => mini.app.server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${mini.app.server.address().port}`;
  let closed;
  const close = () => (closed ??= mini.close());
  t.after(async () => {
    await close();
    // Windows cannot remove a file another Mini still has open. A failed
    // removal must not stop the hooks that close the other Minis, or their
    // servers keep the test process alive.
    if (!shared)
      try {
        rmSync(dataDir, { recursive: true, force: true });
      } catch {
        /* the temporary directory is left behind */
      }
  });
  const interaction = (extra = {}) => ({
    guildId: GUILD,
    channelId: TEXT,
    user: { id: OWNER },
    member: { voice: { channel: { id: VOICE } } },
    replies: [],
    isAutocomplete: () => false,
    isChatInputCommand: () => false,
    isModalSubmit: () => false,
    async deferReply() {
      this.deferred = true;
    },
    async deferUpdate() {
      this.deferred = true;
    },
    async editReply(payload) {
      this.replies.push(payload);
    },
    async reply(payload) {
      this.replied = true;
      this.replies.push(payload);
    },
    async update(payload) {
      this.replied = true;
      this.replies.push(payload);
    },
    async showModal(modal) {
      this.modal = modal;
    },
    ...extra,
  });
  const send = async (i) => {
    await mini.discord.handle(i);
    return i;
  };
  const command = (sub, options = {}, extra = {}) =>
    send(
      interaction({
        isChatInputCommand: () => true,
        commandName: "bridge",
        options: {
          getSubcommand: () => sub,
          getString: (key) => options[key] ?? null,
        },
        ...extra,
      }),
    );
  const call = (path, method = "GET", data, headers = {}) =>
    fetch(base + path, {
      method,
      headers: {
        ...(data ? { "Content-Type": "application/json" } : {}),
        ...headers,
      },
      body: data ? JSON.stringify(data) : undefined,
    });
  // Pairs a Collector through the Discord button, then connects a room.
  let collector;
  async function pair() {
    const key = "ab".repeat(32);
    const first = await (
      await call("/api/v1/pairings", "POST", { key })
    ).json();
    await until(() =>
      posts.some((m) => m.payload.content.includes(first.code)),
    );
    const post = posts.find((m) => m.payload.content.includes(first.code));
    const [approve] = post.payload.components[0].components;
    return { key, first, post, approve };
  }
  async function connect(contextId = "room-1") {
    const { key, approve } = await pair();
    await send(interaction({ customId: approve.custom_id }));
    const { token } = await (
      await call("/api/v1/pairings", "POST", { key })
    ).json();
    const source = { adapter: "ccfolia", instanceId: "vtt", contextId };
    const headers = { Authorization: `Bearer ${token}` };
    const joined = await (
      await call(
        "/api/v1/collectors/connect",
        "POST",
        { source, collectorId: "collector-1" },
        headers,
      )
    ).json();
    collector = { source, headers, ...joined };
    return collector;
  }
  let message = 0;
  const say = async (text, name = NAME) =>
    (
      await call(
        "/api/v1/events",
        "POST",
        {
          schemaVersion: 1,
          eventId: `event-${++message}`,
          roomId: collector.roomId,
          sessionId: collector.sessionId,
          source: {
            ...collector.source,
            messageId: `m${message}`,
            revision: 0,
          },
          speaker: { kind: "character", id: `uid-${name}`, name },
          channel: "main",
          visibility: "public",
          kind: "dialogue",
          text,
          occurredAt: new Date().toISOString(),
        },
        { ...collector.headers, "X-Collector-Id": "collector-1" },
      )
    ).json();
  const character = (name = NAME) =>
    mini.app.store.config.characters.find((c) => c.displayName === name);
  return {
    mini,
    close,
    fake,
    posts,
    registered,
    logs,
    generations,
    interaction,
    send,
    command,
    call,
    pair,
    connect,
    say,
    character,
  };
}

test("only the Collector's routes are served", async (t) => {
  const { call } = await setup(t);
  assert.equal((await call("/healthz")).status, 200);
  for (const path of [
    "/admin/",
    "/player/",
    "/web/admin.js",
    "/downloads/chatter.zip",
    "/api/v1/admin/config",
    "/api/v1/participant/session",
  ])
    assert.equal((await call(path)).status, 404, path);
  assert.equal(
    (await call("/api/v1/admin-login", "POST", { access: "x" })).status,
    404,
  );
  assert.equal(
    (await call("/api/v1/events", "POST", {})).status,
    401,
    "Collector API stays behind its token",
  );
});

test("login registers the command; join enters the caller's voice channel and starts reading", async (t) => {
  const { mini, registered, command, fake } = await setup(t);
  const status = await mini.login("token-1");
  assert.equal(status.state, "logged-in");
  assert.deepEqual(registered, [[COMMAND]]);
  assert.equal(mini.app.engine.accepting, false);

  const outside = await command("join", {}, { member: { voice: {} } });
  assert.match(outside.replies[0].content, /先にボイスチャンネルに入って/);
  assert.equal(mini.app.engine.accepting, false);

  const joined = await command("join");
  assert.match(joined.replies[0].content, /入室し、読み上げを始めました/);
  assert.match(joined.replies[0].content, /Collector：未接続/);
  assert.deepEqual(joined.replies[0].allowedMentions, { parse: [] });
  assert.equal(mini.app.engine.accepting, true);
  assert.equal(fake.connections[0].joinConfig.channelId, VOICE);
  assert.deepEqual(mini.discord.channel, { guildId: GUILD, channelId: TEXT });

  const left = await command("leave");
  assert.match(left.replies[0].content, /退出しました/);
  assert.equal(mini.app.engine.accepting, false);
});

test("join waits for the model and needs a text channel the bot can post in", async (t) => {
  const tts = { status: "starting", error: "" };
  const { mini, command } = await setup(t, { tts });
  await mini.login("token-1");
  assert.match((await command("join")).replies[0].content, /準備中/);
  tts.status = "error";
  tts.error = "モデルを読み込めません";
  assert.match(
    (await command("join")).replies[0].content,
    /開始できませんでした：モデルを読み込めません/,
  );
  tts.status = "ready";
  const thread = await command("join", {}, { channelId: "55555555555555555" });
  assert.match(thread.replies[0].content, /通常のテキストチャンネル/);
  assert.equal(mini.app.engine.accepting, false);
});

test("a Collector is approved by the button, and only by whoever ran join", async (t) => {
  const { mini, command, pair, send, interaction, call, logs } = await setup(t);
  await mini.login("token-1");
  const key = "cd".repeat(32);
  await call("/api/v1/pairings", "POST", { key });
  await until(() => logs.some((l) => l.includes("/bridge join")));

  await command("join");
  const { first, approve, post, key: pairedKey } = await pair();
  assert.equal(first.status, "pending");
  assert.match(post.payload.content, new RegExp(first.code));

  const stranger = await send(
    interaction({ customId: approve.custom_id, user: { id: "901" } }),
  );
  assert.match(stranger.replies[0].content, /実行した人だけ/);
  assert.equal(
    (await (await call("/api/v1/pairings", "POST", { key: pairedKey })).json())
      .status,
    "pending",
  );

  const owner = await send(interaction({ customId: approve.custom_id }));
  assert.match(owner.replies[0].content, /承認しました/);
  assert.deepEqual(owner.replies[0].components, []);
  const approved = await (
    await call("/api/v1/pairings", "POST", { key: pairedKey })
  ).json();
  assert.equal(approved.status, "approved");
  assert.match(approved.token, /^[a-f0-9]{64}$/);
});

test("an unvoiced name is left alone; a chat command with a description registers at once", async (t) => {
  const { mini, command, connect, say, posts, character, generations } =
    await setup(t);
  await mini.login("token-1");
  await command("join");
  await connect();
  const before = posts.length;

  assert.equal((await say("こんにちは。")).status, "ignored");
  assert.equal((await say("もう一度。", "村人A")).status, "ignored");
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(
    posts.length,
    before,
    "nothing is posted for names without a voice",
  );

  const registered = await say(
    "（ブリッジ声登録）落ち着いた知的な若い女性の声。",
  );
  assert.equal(registered.status, "queued");
  await until(() => character().voiceProfileId);
  await until(() =>
    posts.some((m) => m.payload.content.includes("** の声を登録しました")),
  );
  assert.equal(
    generations.at(-1).irodori.caption,
    "落ち着いた知的な若い女性の声。",
  );
  assert.ok(!posts.some((m) => m.payload.content.includes("の声づくり")));

  const spoken = await say("さあ、冒険に出かけよう！");
  assert.equal(spoken.status, "queued");

  await say("（ブリッジ声削除）");
  await until(() =>
    posts.some((m) => m.payload.content.includes("割り当てを外しました")),
  );
  assert.equal(character().voiceProfileId, null);
});

test("a chat command without a description offers a button; nothing is generated until it is used", async (t) => {
  const {
    mini,
    command,
    connect,
    say,
    posts,
    send,
    interaction,
    character,
    generations,
  } = await setup(t);
  await mini.login("token-1");
  await command("join");
  await connect();
  const made = generations.length;

  assert.equal((await say("（ブリッジ声登録）")).status, "failed");
  await until(() =>
    posts.some((m) => m.payload.content.includes("の声を作りますか")),
  );
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(generations.length, made, "no audio is made for the offer");
  assert.ok(
    !posts.some((m) => m.payload.content.includes("登録できませんでした")),
    "the bare command is not reported as a failure",
  );
  assert.ok(!posts.some((m) => m.payload.content.includes("の声づくり")));
  const offer = posts.find((m) =>
    m.payload.content.includes("の声を作りますか"),
  );
  const [button] = offer.payload.components[0].components;
  assert.equal(button.custom_id, `mini:voice:${character().id}`);

  const opened = await send(interaction({ customId: button.custom_id }));
  assert.equal(opened.modal.custom_id, button.custom_id);
  assert.equal(opened.modal.components[0].components[0].value, undefined);
  assert.equal(generations.length, made);

  const submitted = await send(
    interaction({
      customId: button.custom_id,
      isModalSubmit: () => true,
      fields: { getTextInputValue: () => "低く落ち着いた声。" },
    }),
  );
  assert.match(submitted.replies[0].content, /声づくりを/);
  const form = () =>
    posts.find((m) => m.payload.content.includes("の声づくり"));
  const confirm = () =>
    form()
      ?.payload.components?.flatMap((r) => r.components)
      .find((c) => c.label === "この声に決定");
  await until(() => confirm() && !confirm().disabled);
  assert.match(form().payload.content, /低く落ち着いた声。/);
  mini.discord.bot.client.emit(
    "interactionCreate",
    interaction({ customId: confirm().custom_id, message: { id: form().id } }),
  );
  await until(() => character().voiceProfileId);

  // Asked again, the description the character now has is offered for editing.
  await say("（ブリッジ声登録）");
  await until(
    () =>
      posts.filter((m) => m.payload.content.includes("の声を作りますか"))
        .length === 2,
  );
  const again = await send(interaction({ customId: button.custom_id }));
  assert.equal(
    again.modal.components[0].components[0].value,
    "低く落ち着いた声。",
  );

  // A command that fails for another reason is still reported.
  mini.app.store.change((c) => {
    for (let n = c.voiceProfiles.length; n < 500; n++)
      c.voiceProfiles.push({
        id: `v${n}`,
        name: `声${n}`,
        provider: "irodori-local",
        voiceId: "none",
        caption: "x",
        seed: "1",
        speed: 1,
        steps: 20,
      });
  });
  await say("（ブリッジ声登録）明るい声。", "村人A");
  await until(() => posts.some((m) => m.payload.content.includes("上限")));
});

test("without join there is no channel for a form, and the bare command asks for a description", async (t) => {
  const { mini, command, connect, say, close } = await setup(t);
  await mini.login("token-1");
  await command("join");
  await connect();
  mini.discord.channel = null;
  const result = await say("（ブリッジ声登録）");
  assert.equal(result.status, "failed");
  assert.match(result.reason, /声の説明を入力/);
  await close();
});

test("the same name keeps its voice in another room", async (t) => {
  const { mini, command, connect, say, character } = await setup(t);
  await mini.login("token-1");
  await command("join");
  await connect("room-1");
  await say("（ブリッジ声登録）落ち着いた声。");
  await until(() => character().voiceProfileId);
  await connect("room-2");
  assert.equal((await say("別の部屋でも同じ声です。")).status, "queued");
  assert.equal(mini.app.store.config.characters.length, 1);
});

test("voice opens the design form for a name that has not spoken yet", async (t) => {
  const { mini, command, posts, interaction, character } = await setup(t);
  await mini.login("token-1");
  await command("join");

  const missing = await command("voice", { character: NAME });
  assert.match(missing.replies[0].content, /声の説明を入力してください/);

  const started = await command("voice", {
    character: ` ${NAME}`,
    description: "澄んだ中性的な声。",
  });
  assert.match(
    started.replies[0].content,
    /声づくりを <#11111111111111119> で/,
  );
  assert.equal(character().voiceProfileId, null);
  const form = () =>
    posts.find((m) => m.payload.content.includes("の声づくり"));
  const confirm = () =>
    form()
      ?.payload.components?.flatMap((r) => r.components)
      .find((c) => c.label === "この声に決定");
  await until(() => confirm() && !confirm().disabled);
  assert.match(form().payload.content, /澄んだ中性的な声/);

  // The form's own buttons go to Bridge's handler on the same client.
  mini.discord.bot.client.emit(
    "interactionCreate",
    interaction({
      customId: confirm().custom_id,
      message: { id: form().id },
    }),
  );
  await until(() => character().voiceProfileId);
  const voice = mini.app.store.config.voiceProfiles.at(-1);
  assert.equal(voice.caption, "澄んだ中性的な声。");
  assert.match(voice.voiceId, /^chat-/);
  // The form reports its own result; no second message is posted.
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(
    posts.filter((m) => m.payload.content.includes("** の声を登録しました"))
      .length,
    0,
  );

  const again = await command("voice", { character: NAME });
  assert.match(again.replies[0].content, /声づくりを/);
});

test("character names are offered while typing", async (t) => {
  const { mini, send, interaction } = await setup(t);
  await mini.login("token-1");
  for (const name of [NAME, "村人A", "村人B"])
    ensureCharacter(mini.app.store, name);
  let offered;
  await send(
    interaction({
      isAutocomplete: () => true,
      commandName: "bridge",
      options: { getFocused: () => "村人" },
      respond: async (choices) => {
        offered = choices;
      },
    }),
  );
  assert.deepEqual(
    offered.map((c) => c.value),
    ["村人A", "村人B"],
  );
});

test("data brought from Bridge gets chat registration turned on", async (t) => {
  const { mini } = await setup(t);
  assert.equal(mini.app.store.config.chatVoiceRegistrationEnabled, true);
  assert.equal(mini.app.store.config.deliveryCaptionMode, "replace");
  assert.equal(mini.app.engine.config.provider.type, "irodori");
  assert.equal(mini.app.store.config.provider.type, "speech");
});

test("a replaced or removed voice is deleted with its audio; other voices stay", async (t) => {
  const { mini, command, connect, say, character } = await setup(t);
  await mini.login("token-1");
  await command("join");
  await connect();
  // A voice nobody is assigned, as data brought from Bridge may hold.
  mini.app.store.change((c) =>
    c.voiceProfiles.push({
      id: "spare",
      name: "予備の声",
      provider: "irodori-local",
      voiceId: "none",
      caption: "予備",
      seed: "1",
      speed: 1,
      steps: 20,
    }),
  );
  const voices = () => mini.app.store.config.voiceProfiles;
  const files = () =>
    readdirSync(join(mini.app.store.dir, "voices")).filter((f) =>
      f.endsWith(".wav"),
    );

  await say("（ブリッジ声登録）落ち着いた声。");
  await until(() => character().voiceProfileId);
  const first = character().voiceProfileId;
  await until(() => files().length === 1);

  await say("（ブリッジ声登録）明るく元気な声。");
  await until(() => character().voiceProfileId !== first);
  await until(() => !voices().some((v) => v.id === first));
  await until(() => files().length === 1);
  assert.deepEqual(
    voices().map((v) => v.id),
    ["spare", character().voiceProfileId],
  );

  await say("（ブリッジ声削除）");
  await until(() => voices().length === 1);
  assert.equal(voices()[0].id, "spare");
  await until(() => files().length === 0);
  assert.ok(
    !existsSync(join(mini.app.store.dir, "voices-detached")) ||
      !readdirSync(join(mini.app.store.dir, "voices-detached")).length,
  );
});

test("names left without a voice are cleared at the next start", async (t) => {
  const first = await setup(t);
  await first.mini.login("token-1");
  await first.command("join");
  await first.connect();
  await first.say("こんにちは。", "村人A");
  await first.say("（ブリッジ声登録）落ち着いた声。");
  await until(() => first.character().voiceProfileId);
  assert.equal(first.mini.app.store.config.characters.length, 2);
  const dataDir = first.mini.app.store.dir;
  await first.close();
  const again = await setup(t, { dataDir });
  assert.deepEqual(
    again.mini.app.store.config.characters.map((c) => c.displayName),
    [NAME],
  );
  // Close it here, before the first setup's hook removes the directory.
  await again.close();
});

test("the voice limit is explained without pointing at an admin page", async (t) => {
  const { mini, command, connect, say, posts } = await setup(t);
  await mini.login("token-1");
  await command("join");
  await connect();
  mini.app.store.change((c) => {
    for (let n = 0; n < 500; n++)
      c.voiceProfiles.push({
        id: `v${n}`,
        name: `声${n}`,
        provider: "irodori-local",
        voiceId: "none",
        caption: "x",
        seed: "1",
        speed: 1,
        steps: 20,
      });
  });
  await say("（ブリッジ声登録）落ち着いた声。");
  await until(() => posts.some((m) => m.payload.content.includes("上限")));
  const notice = posts.find((m) => m.payload.content.includes("上限"));
  assert.match(notice.payload.content, /（ブリッジ声削除）/);
  assert.doesNotMatch(notice.payload.content, /管理画面/);
});

test("the design form's advanced settings offer the seed and the CFG scales, not steps", async (t) => {
  const { mini, command, posts, interaction } = await setup(t);
  await mini.login("token-1");
  await command("join");
  await command("voice", { character: NAME, description: "澄んだ声。" });
  const form = () =>
    posts.find((m) => m.payload.content.includes("の声づくり"));
  const advanced = () =>
    form()
      ?.payload.components?.flatMap((r) => r.components)
      .find((c) => c.label === "詳細設定");
  await until(() => advanced() && !advanced().disabled);
  const opened = interaction({
    customId: advanced().custom_id,
    message: { id: form().id },
  });
  mini.discord.bot.client.emit("interactionCreate", opened);
  await until(() => opened.modal);
  assert.deepEqual(
    opened.modal.components.map((r) => r.components[0].custom_id),
    ["seed", "cfgScaleText", "cfgScaleCaption", "cfgScaleSpeaker"],
  );
});

test("reasons that point at Bridge's admin page are rewritten for Discord", () => {
  for (const reason of [
    "TTSが不調です。管理画面で確認してください",
    "キャラを登録できません。登録上限と設定を管理画面で確認してください。",
    "登録上限です。管理画面で確認してください",
    "参照音声を登録できませんでした。管理画面で確認してください。",
    "参照音声「chat-1」の元WAVがありません。元のWAVを戻すか、管理画面で管理対象から外して登録し直してください",
    "接続先の参照音声「chat-1」と保存済み音声が衝突しています。同じ音声か管理画面で確認してください",
  ])
    assert.doesNotMatch(miniReason(reason), /管理画面|Player/, reason);
  assert.equal(
    miniReason("TTSが不調です。管理画面で確認してください"),
    "TTSが不調です。",
  );
  assert.match(
    miniReason(
      "参照音声「chat-1」の元WAVがありません。元のWAVを戻すか、管理画面で管理対象から外して登録し直してください",
    ),
    /（ブリッジ声登録）で声を作り直してください$/,
  );
  assert.match(
    miniReason(
      "キャラを登録できません。登録上限と設定を管理画面で確認してください。",
    ),
    /キャラは500人まで/,
  );
});

test("a new voice gets a random seed; remaking it from its settings keeps the seed", async (t) => {
  const { mini, command, connect, say, posts, character, generations } =
    await setup(t);
  await mini.login("token-1");
  await command("join");
  await connect();
  const voice = () =>
    mini.app.store.config.voiceProfiles.find(
      (v) => v.id === character()?.voiceProfileId,
    );

  await say("（ブリッジ声登録）落ち着いた声。");
  await until(() => voice());
  const first = voice().seed;
  assert.notEqual(first, "1");
  assert.equal(String(generations.at(-1).irodori.seed), first);

  await say("（ブリッジ声登録）落ち着いた声。");
  await until(() => voice() && voice().seed !== first);
  const second = voice().seed;
  assert.notEqual(second, first, "the same description makes another voice");

  // /bridge voice without a description starts from the current voice.
  const made = generations.length;
  await command("voice", { character: NAME });
  await until(() => generations.length > made);
  assert.equal(String(generations.at(-1).irodori.seed), second);
  assert.ok(posts.some((m) => m.payload.content.includes("の声づくり")));
});

test("with a reference voice, a direction replaces the voice description", async (t) => {
  const { mini, command, connect, say, character, generations } =
    await setup(t);
  await mini.login("token-1");
  await command("join");
  await connect();
  await say("（ブリッジ声登録）活発な若い男の低い声。");
  await until(() => character().voiceProfileId);
  // The confirmation sample has no reference yet; it is made from the description.
  assert.equal(generations.at(-1).irodori.caption, "活発な若い男の低い声。");

  const made = generations.length;
  await say("（演技:小声で）待って、この先に見張りがいる。");
  await until(() => generations.length > made);
  assert.equal(generations.at(-1).irodori.caption, "演技: 小声で");

  const plain = generations.length;
  await say("この先に見張りがいる、音を立てるなよ。");
  await until(() => generations.length > plain);
  assert.equal(generations.at(-1).irodori.caption, "活発な若い男の低い声。");
});
