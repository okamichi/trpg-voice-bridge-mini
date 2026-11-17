import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store, initialConfig } from "../src/store.mjs";
import { Engine } from "../src/engine.mjs";
import { mockWav } from "../src/provider.mjs";
import { VoiceDesign } from "./voice-design.mjs";
import { until } from "./test-helpers.mjs";

const guildId = "11111111111111111",
  channelId = "22222222222222222";
const source = { adapter: "fixture", instanceId: "test", contextId: "room" };
function setup(t, options = {}) {
  const dir = mkdtempSync(join(tmpdir(), "voice-design-"));
  const config = initialConfig({});
  config.chatVoiceRegistrationEnabled = true;
  config.sources = [source];
  const store = new Store(dir, config),
    uploads = [],
    generations = [],
    posts = [],
    edits = [],
    errors = [];
  const engine = new Engine(store, {
    fetchImpl: async (url, init = {}) => {
      if (url.endsWith("/v1/audio/speech")) {
        generations.push(JSON.parse(init.body));
        if (options.generate) await options.generate();
        return new Response(mockWav());
      }
      if (init.method === "POST") {
        uploads.push(Buffer.from(await init.body.get("file").arrayBuffer()));
        return Response.json(
          { id: init.body.get("voice_id") },
          { status: 201 },
        );
      }
      return Response.json({
        data: Array.from({ length: 28 }, (_, i) => ({ id: `ref-${i}` })),
      });
    },
  });
  const client = new EventEmitter();
  client.isReady = () => true;
  const message = {
    id: "33333333333333333",
    edit: async (data) => {
      if (options.edit) await options.edit(data);
      edits.push(data);
      return message;
    },
  };
  client.channels = {
    fetch: async () => ({
      guildId,
      type: 0,
      send: async (data) => {
        posts.push(data);
        return message;
      },
    }),
  };
  const settings = { enabled: true, guildId, channelId };
  const design = new VoiceDesign({
    client,
    engine,
    settings: () => settings,
    report: (e) => errors.push(e),
    ttl: options.ttl,
    advancedKeys: options.advancedKeys,
  });
  engine.chatVoices.designer = {
    enabled: () => settings.enabled,
    run: (task, valid) => design.open(task, valid),
  };
  engine.connect({ source, collectorId: "collector" });
  let sequence = 0;
  const send = (
    text = "（ブリッジ声登録）イケオジボイス。",
    actor = "alfred",
  ) => {
    const n = ++sequence;
    return engine.ingress(
      {
        schemaVersion: 1,
        eventId: `event${n}`,
        roomId: config.roomId,
        sessionId: engine.sessionId,
        source: { ...source, messageId: `message${n}`, revision: 0 },
        speaker: { kind: "character", id: actor, name: actor },
        channel: "main",
        kind: "dialogue",
        visibility: "public",
        text,
        occurredAt: new Date().toISOString(),
      },
      "collector",
    );
  };
  t.after(async () => {
    design.close();
    engine.close();
    await engine.references.close();
    await engine.chatVoices.drain();
    while (engine.busy) await new Promise((r) => setTimeout(r, 5));
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const ready = async (id) => {
    await until(
      () =>
        design.sessions.get(id)?.published &&
        !design.sessions.get(id)?.operating,
    );
    return design.sessions.get(id);
  };
  const act = async (s, action, extra = {}) => {
    const replies = [];
    const i = {
      customId: design.id(s, action),
      guildId,
      channelId,
      message,
      user: { id: "44444444444444444" },
      fields: {
        getTextInputValue: (key) => String(extra.fields?.[key] ?? ""),
        getStringSelectValues: () => extra.values ?? [],
      },
      deferReply: async () => {
        i.deferred = true;
      },
      deferUpdate: async () => {
        i.deferred = true;
      },
      deleteReply: async () => replies.push({ deleted: true }),
      editReply: async (data) => replies.push(data),
      reply: async (data) => replies.push(data),
      showModal: async (data) => replies.push(data),
      ...extra,
    };
    if (extra.fields)
      i.fields = {
        getTextInputValue: (key) => String(extra.fields[key] ?? ""),
        getStringSelectValues: (key) => extra.selects?.[key] ?? [],
      };
    await design.handle(i);
    return replies;
  };
  return {
    store,
    engine,
    design,
    settings,
    send,
    ready,
    act,
    posts,
    edits,
    uploads,
    generations,
    errors,
  };
}

test("VTT starts one post, saving settings regenerates in place, confirms exactly the published WAV", async (t) => {
  const f = setup(t);
  const job = f.send();
  const s = await f.ready(job.orderId);
  assert.equal(f.posts.length, 1);
  assert.equal(s.sample, "これからこの声でお話しします。");
  assert.equal(f.uploads.length, 0);
  assert.equal(f.store.config.characters[0].voiceProfileId, null);
  assert.equal(f.store.voiceCommands.get(job.orderId).status, "designing");
  assert.equal(f.send().status, "rejected");
  const old = f.design.id(s, "confirm");
  const modal = (await f.act(s, "basic"))[0];
  assert.equal(modal.components.length, 4);
  await f.act(s, "basicSave", {
    fields: {
      name: "渋い声",
      caption: "低い声 @everyone <script>",
      speed: "0.85",
      sample: "お待たせしました。",
    },
  });
  // Saving a changed setting makes the candidate again at once.
  assert.equal(f.generations.length, 2);
  assert.equal(f.generations[1].input, "お待たせしました。");
  assert.equal(s.dirty, false);
  assert.ok(s.published);
  assert.match(
    (await f.act(s, "confirm", { customId: old }))[0].content,
    /古い/,
  );
  await f.act(s, "advancedSave", {
    fields: {
      seed: "9223372036854775807",
      steps: "25",
      cfgScaleText: "2",
      cfgScaleCaption: "",
      cfgScaleSpeaker: "0",
    },
  });
  assert.equal(s.voice.seed, "9223372036854775807");
  assert.equal(s.voice.cfgScaleText, 2);
  assert.equal(s.voice.cfgScaleCaption, undefined);
  const wav = s.wav;
  assert.equal(f.generations.length, 3);
  assert.equal(f.posts.length, 1);
  const attached = f.edits.filter((e) => e.files?.length);
  assert.equal(attached.length, 3);
  assert.deepEqual(attached[2].files[0].attachment, wav);
  assert.deepEqual(attached[2].attachments, []);
  assert.deepEqual(attached[2].allowedMentions, { parse: [] });
  await f.act(s, "confirm");
  await until(() => !f.engine.chatVoices.tasks.size);
  assert.equal(f.uploads.length, 1);
  assert.deepEqual(f.uploads[0], wav);
  assert.equal(f.store.voiceCommands.get(job.orderId).status, "completed");
  assert.ok(f.store.config.characters[0].voiceProfileId);
  assert.equal(f.generations.length, 3);
  assert.deepEqual(f.edits.at(-1).components, []);
  assert.equal(f.design.sessions.size, 0);
});

test("foreign channel, invalid input, stale modal and duplicate confirmation do not mutate voice", async (t) => {
  const f = setup(t),
    job = f.send(),
    s = await f.ready(job.orderId);
  assert.match(
    (await f.act(s, "confirm", { channelId: "other" }))[0].content,
    /チャンネル/,
  );
  const before = structuredClone(s.voice);
  await f.act(s, "advancedSave", {
    fields: { seed: "9223372036854775808", steps: "20" },
  });
  assert.deepEqual(s.voice, before);
  await Promise.all([f.act(s, "confirm"), f.act(s, "confirm")]);
  await until(() => !f.engine.chatVoices.tasks.size);
  assert.equal(f.uploads.length, 1);
});

test("reference choice pagination and explicit seed editing", async (t) => {
  const f = setup(t),
    s = await f.ready(f.send().orderId);
  const menu = (await f.act(s, "refs1"))[0];
  assert.equal(menu.components[0].component.options.length, 6);
  assert.equal(f.generations.length, 1);
  await f.act(s, "refsSelect", {
    values: [menu.components[0].component.options[4].value],
  });
  assert.equal(s.voice.voiceId, "ref-27");
  // Choosing a reference makes the candidate with it at once.
  assert.equal(f.generations.length, 2);
  const seed = s.voice.seed;
  await f.act(s, "advancedSave", {
    fields: {
      seed: "2",
      steps: String(s.voice.steps),
      cfgScaleText: s.voice.cfgScaleText ?? "",
      cfgScaleCaption: s.voice.cfgScaleCaption ?? "",
      cfgScaleSpeaker: s.voice.cfgScaleSpeaker ?? "",
    },
  });
  assert.notEqual(s.voice.seed, seed);
  assert.equal(f.generations.length, 3);
  assert.equal(f.posts.length, 1);
  await f.act(s, "cancel");
  await until(() => !f.engine.chatVoices.tasks.size);
  assert.equal(f.uploads.length, 0);
});

test("解除 alias cancels a draft; disabled mode preserves immediate registration", async (t) => {
  const f = setup(t),
    s = await f.ready(f.send().orderId);
  assert.equal(f.send("（ブリッジ声解除）").status, "completed");
  await until(() => !f.engine.chatVoices.tasks.size);
  assert.equal(f.uploads.length, 0);
  assert.match((await f.act(s, "confirm"))[0].content, /期限切れ/);
  f.settings.enabled = false;
  f.send();
  await until(() => !f.engine.chatVoices.tasks.size);
  assert.equal(f.uploads.length, 1);
  assert.equal(f.posts.length, 1);
});

test("expiry and bot shutdown release active registrations without replacing an existing voice", async (t) => {
  const f = setup(t, { ttl: 150 });
  f.settings.enabled = false;
  f.send();
  await until(() => !f.engine.chatVoices.tasks.size);
  const saved = f.store.config.characters[0].voiceProfileId;
  f.settings.enabled = true;
  const job = f.send();
  await f.ready(job.orderId);
  await until(() => !f.engine.chatVoices.tasks.size);
  assert.equal(f.store.config.characters[0].voiceProfileId, saved);
  assert.equal(f.store.voiceCommands.get(job.orderId).status, "failed");
  await f.ready(f.send().orderId);
  f.design.close();
  await until(() => !f.engine.chatVoices.tasks.size);
  assert.equal(f.store.config.characters[0].voiceProfileId, saved);
});

test("attachment upload failure never makes the candidate confirmable; retry can recover", async (t) => {
  let reject = true;
  const f = setup(t, {
    edit: async (data) => {
      if (reject && data.files?.length) throw new Error("upload failed");
    },
  });
  const job = f.send();
  await until(
    () => f.store.voiceCommands.get(job.orderId)?.status === "designing",
  );
  const s = f.design.sessions.get(job.orderId);
  assert.equal(s.wav, null);
  const labels = () =>
    f.design.payload(s).components[1].components.map((b) => b.label);
  // Only a failed generation offers to generate again.
  assert.deepEqual(labels(), ["もう一度生成", "この声に決定", "取消"]);
  assert.match((await f.act(s, "confirm"))[0].content, /音声ができてから/);
  reject = false;
  await f.act(s, "generate");
  assert.ok(s.published);
  assert.deepEqual(labels(), ["この声に決定", "取消"]);
  await f.act(s, "confirm");
  await until(() => !f.engine.chatVoices.tasks.size);
  assert.equal(f.uploads.length, 1);
});

test("cancel during upload leaves the final post disabled and without stale audio", async (t) => {
  let block = false,
    started = false,
    release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const f = setup(t, {
    edit: async (data) => {
      if (block && data.files?.length) {
        started = true;
        await gate;
      }
    },
  });
  const s = await f.ready(f.send().orderId);
  block = true;
  // Saving starts the generation whose upload the cancellation overtakes.
  const generating = f.act(s, "advancedSave", {
    fields: { seed: "2", steps: "20" },
  });
  await until(() => started);
  await f.act(s, "cancel");
  release();
  await generating;
  await until(() => !f.engine.chatVoices.tasks.size);
  assert.deepEqual(f.edits.at(-1).components, []);
  assert.deepEqual(f.edits.at(-1).attachments, []);
  assert.equal(f.edits.at(-1).files, undefined);
  assert.equal(f.uploads.length, 0);
});

test("draft capacity is bounded and failed admission does not post or register", async (t) => {
  const f = setup(t);
  for (let i = 0; i < 4; i++)
    await f.ready(f.send(undefined, `actor-${i}`).orderId);
  const extra = f.send(undefined, "extra");
  await until(
    () => f.store.voiceCommands.get(extra.orderId)?.status === "failed",
  );
  assert.equal(f.design.sessions.size, 4);
  assert.equal(f.posts.length, 4);
  assert.equal(f.uploads.length, 0);
  f.design.cancel();
  await until(() => !f.engine.chatVoices.tasks.size);
});

test("voice selectors open cancelable modals without changing a published candidate", async (t) => {
  const f = setup(t),
    s = await f.ready(f.send().orderId);
  const wav = s.wav,
    version = s.version,
    voice = structuredClone(s.voice);
  for (const action of ["voices0", "refs0"]) {
    const modal = (await f.act(s, action))[0];
    assert.ok(modal.title);
    assert.equal(modal.components[0].type, 18);
    assert.equal(modal.components[0].component.type, 3);
    assert.match(modal.components[0].description, /キャンセル/);
  }
  assert.equal(s.wav, wav);
  assert.equal(s.version, version);
  assert.equal(s.dirty, false);
  assert.deepEqual(s.voice, voice);
  const prompt = (await f.act(s, "refsSelect", { values: ["page-1"] }))[0];
  assert.equal(prompt.components[0].components[1].label, "閉じる");
  assert.deepEqual(await f.act(s, "closePicker"), [{ deleted: true }]);
  assert.equal(s.version, version);
  assert.equal(s.wav, wav);
});

test("unchanged settings do not regenerate; changed settings regenerate at once; seed changes require explicit editing", async (t) => {
  const f = setup(t),
    s = await f.ready(f.send().orderId);
  const labels = () =>
    f.design.payload(s).components[1].components.map((b) => b.label);
  assert.deepEqual(labels(), ["この声に決定", "取消"]);
  assert.match((await f.act(s, "generate"))[0].content, /変更されていません/);
  assert.equal(f.generations.length, 1);
  const fields = {
    name: s.voice.name,
    caption: s.voice.caption,
    speed: String(s.voice.speed),
    sample: s.sample,
  };
  const edits = f.edits.length;
  await f.act(s, "basicSave", { fields });
  assert.equal(s.dirty, false);
  assert.equal(f.generations.length, 1);
  assert.equal(f.edits.length, edits);
  const seed = s.voice.seed;
  await f.act(s, "basicSave", {
    fields: { ...fields, caption: "もっと落ち着いた声" },
  });
  assert.equal(s.voice.seed, seed);
  assert.equal(f.generations.length, 2);
  assert.equal(s.dirty, false);
  assert.deepEqual(labels(), ["この声に決定", "取消"]);
  const voice = structuredClone(s.voice);
  await f.act(s, "advancedSave", {
    fields: {
      seed: "2",
      steps: String(s.voice.steps),
      cfgScaleText: s.voice.cfgScaleText ?? "",
      cfgScaleCaption: s.voice.cfgScaleCaption ?? "",
      cfgScaleSpeaker: s.voice.cfgScaleSpeaker ?? "",
    },
  });
  assert.notEqual(s.voice.seed, seed);
  assert.equal(f.generations.length, 3);
  assert.equal(f.generations[2].irodori.seed, 2);
  assert.deepEqual({ ...s.voice, seed }, voice);
});

test("audio placeholder switches from waiting to generating and is replaced by the attachment", async (t) => {
  let release,
    started = false;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const f = setup(t, {
    generate: async () => {
      started = true;
      await gate;
    },
  });
  t.after(() => release());
  const job = f.send();
  await until(
    () => started && f.edits.some((e) => e.content.includes("音声を生成中")),
  );
  assert.match(f.posts[0].content, /生成準備中/);
  assert.equal(f.posts[0].files, undefined);
  assert.ok(f.edits.some((e) => e.content.includes("生成待ち")));
  const progress = f.edits.at(-1);
  assert.match(progress.content, /<t:\d+:R>/);
  assert.equal(progress.files, undefined);
  assert.equal(
    progress.components
      .flatMap((r) => r.components)
      .some((b) => b.custom_id.endsWith(":another")),
    false,
  );
  release();
  await f.ready(job.orderId);
  assert.doesNotMatch(f.edits.at(-1).content, /⏳|⚙️/);
  assert.equal(f.edits.at(-1).files.length, 1);
});

for (const accepting of [true, false]) {
  test(`Discord confirmation stays silent while reading is ${accepting ? "active" : "stopped"}; immediate registration keeps its confirmation`, async (t) => {
    const f = setup(t);
    f.engine.accepting = accepting;
    const notifications = [];
    f.engine.on("notification", (event) => notifications.push(event));
    const job = f.send();
    const s = await f.ready(job.orderId);
    await f.act(s, "confirm");
    await until(() => !f.engine.chatVoices.tasks.size);
    assert.equal(f.store.voiceCommands.get(job.orderId).status, "completed");
    assert.equal(f.store.voiceCommands.get(job.orderId).unplayed, false);
    assert.equal(f.engine.audio.size, 0);
    assert.equal(f.engine.orders.size, 0);
    assert.equal(
      notifications.filter((n) => n.type === "audio.ready").length,
      0,
    );
    assert.match(f.edits.at(-1).content, /この声を登録しました/);
    assert.equal(f.uploads.length, 1);

    f.settings.enabled = false;
    const immediate = f.send(undefined, "another-character");
    await until(() => !f.engine.chatVoices.tasks.size);
    assert.equal(
      f.store.voiceCommands.get(immediate.orderId).unplayed,
      !accepting,
    );
    assert.equal(
      notifications.filter((n) => n.type === "audio.ready").length,
      accepting ? 1 : 0,
    );
    assert.equal(f.uploads.length, 2);
  });
}

test("MF details offer only seed and ignore stale CFG/steps fields", () => {
  const design = Object.create(VoiceDesign.prototype);
  const s = {
    task: { job: { id: "mf" } },
    version: 0,
    constraints: { fixedSteps: 4, cfg: false },
    voice: {
      id: "v",
      name: "声",
      provider: "irodori-local",
      voiceId: "none",
      caption: "",
      seed: "1",
      steps: 20,
      speed: 1,
      cfgScaleText: 3,
    },
    sample: "こんにちは",
  };
  const modal = design.modal(s, "advanced");
  assert.deepEqual(
    modal.components.map((r) => r.components[0].custom_id),
    ["seed"],
  );
  design.edit(
    s,
    {
      fields: {
        getTextInputValue: (key) => {
          assert.equal(key, "seed");
          return "2";
        },
      },
    },
    "advanced",
  );
  assert.equal(s.voice.seed, "2");
  assert.equal(s.voice.steps, 20);
  assert.equal(s.voice.cfgScaleText, 3);
});

test("the emotion boost is a choice in Mini's advanced settings; on and off regenerate at once", async (t) => {
  const keys = [
    "seed",
    "cfgScaleText",
    "cfgScaleCaption",
    "cfgScaleSpeaker",
    "emotionBoost",
  ];
  const f = setup(t, { advancedKeys: keys }),
    s = await f.ready(f.send().orderId);
  const modal = () => f.design.modal(s, "advanced");
  const boostField = () => modal().components.at(-1);
  assert.equal(modal().components.length, 5);
  assert.equal(boostField().component.custom_id, "emotionBoost");
  assert.deepEqual(
    boostField().component.options.map((o) => [o.value, o.default]),
    [
      ["off", true],
      ["on", false],
    ],
  );
  const fields = {
    seed: s.voice.seed,
    cfgScaleText: "",
    cfgScaleCaption: "",
    cfgScaleSpeaker: "",
  };
  await f.act(s, "advancedSave", { fields, selects: { emotionBoost: ["on"] } });
  assert.equal(s.voice.emotionBoost, true);
  assert.equal(f.generations.length, 2);
  assert.match(f.design.payload(s).content, /感情ブースト：オン/);
  assert.deepEqual(
    boostField().component.options.map((o) => o.default),
    [false, true],
  );
  // Saving it on again changes nothing.
  await f.act(s, "advancedSave", { fields, selects: { emotionBoost: ["on"] } });
  assert.equal(f.generations.length, 2);
  // Off leaves no key, as a voice made without the boost has none.
  await f.act(s, "advancedSave", {
    fields,
    selects: { emotionBoost: ["off"] },
  });
  assert.ok(!("emotionBoost" in s.voice));
  assert.equal(f.generations.length, 3);
  assert.doesNotMatch(f.design.payload(s).content, /感情ブースト/);
});

test("without chosen keys, as in Bridge, the advanced settings keep to five fields without the boost", () => {
  const design = Object.create(VoiceDesign.prototype);
  const s = {
    task: { job: { id: "rf" } },
    version: 0,
    constraints: { fixedSteps: null, cfg: true },
    voice: {
      id: "v",
      name: "声",
      provider: "irodori-local",
      voiceId: "none",
      caption: "",
      seed: "1",
      steps: 20,
      speed: 1,
    },
    sample: "こんにちは",
  };
  assert.deepEqual(
    design
      .modal(s, "advanced")
      .components.map((r) => r.components[0].custom_id),
    ["seed", "steps", "cfgScaleText", "cfgScaleCaption", "cfgScaleSpeaker"],
  );
});

test("a design heard with a reference keeps it on confirmation; a voice made from a description registers what was heard", async (t) => {
  const f = setup(t),
    s = await f.ready(f.send().orderId);
  const menu = (await f.act(s, "refs1"))[0];
  await f.act(s, "refsSelect", {
    values: [menu.components[0].component.options[4].value],
  });
  assert.equal(s.voice.voiceId, "ref-27");
  await f.act(s, "confirm");
  await until(() => !f.engine.chatVoices.tasks.size);
  assert.equal(f.uploads.length, 0, "no new reference is registered");
  const saved = f.store.config.voiceProfiles.find(
    (v) => v.id === f.store.config.characters[0].voiceProfileId,
  );
  assert.equal(saved.voiceId, "ref-27");
});
