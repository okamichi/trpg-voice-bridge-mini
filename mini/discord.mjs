import { check } from "../src/contracts.mjs";
import { voiceCommand } from "../src/chat-voices.mjs";
import { ensureCharacter, findByName, normalizeName } from "./identity.mjs";

// Everything Bridge Mini is operated with: three subcommands, a Collector
// approval button and a button that starts a voice design.
export const COMMAND = {
  name: "bridge",
  description: "TRPG Voice Bridge Mini",
  dm_permission: false,
  options: [
    {
      type: 1,
      name: "join",
      description: "あなたがいるボイスチャンネルに入室し、読み上げを始めます",
    },
    { type: 1, name: "leave", description: "読み上げを止めて退出します" },
    {
      type: 1,
      name: "voice",
      description: "キャラの声を作ります",
      options: [
        {
          type: 3,
          name: "character",
          description: "キャラ名（VTTでの名前と同じにします）",
          required: true,
          autocomplete: true,
          max_length: 200,
        },
        {
          type: 3,
          name: "description",
          description: "声の説明。省略すると、今の声をもとに作り直します",
          required: false,
          max_length: 1000,
        },
      ],
    },
  ],
};

const EPHEMERAL = 64;
const row = (...components) => ({ type: 1, components });
const button = (custom_id, label, style = 2) => ({
  type: 2,
  custom_id,
  label,
  style,
});
const safe = (value) =>
  String(value)
    .replace(/[\\`*_~|<>@]/g, "")
    .slice(0, 200);
const plain = (content, extra = {}) => ({
  content,
  allowedMentions: { parse: [] },
  ...extra,
});

// Bridge's reasons point at its admin page or Player, which Mini does not
// have. Each is turned into what can be done from the chat or Discord.
export const miniReason = (reason) =>
  reason.startsWith("キャラを登録できません")
    ? "キャラを登録できません。キャラは500人まで登録できます"
    : reason.includes("登録上限")
      ? "声の数が上限（500件）に達しています。使わなくなったキャラとして（ブリッジ声削除）と発言し、声を外してください"
      : reason
          .replace(
            /元のWAVを戻すか、管理画面で管理対象から外して登録し直してください|同じ音声か管理画面で確認してください/g,
            "（ブリッジ声登録）で声を作り直してください",
          )
          .replace(/。?管理画面で確認してください。?/g, "。");

// The same permissions Bridge asks for; slash commands need their own scope.
export const inviteUrl = (clientId) =>
  `https://discord.com/oauth2/authorize?client_id=${clientId}&scope=bot+applications.commands&permissions=3247104`;

export class MiniDiscord {
  // tts() gives { status, error } of the bundled speech.cpp.
  constructor({ app, tts, log = () => {}, pairingPollMs = 1000 }) {
    Object.assign(this, { app, tts, log });
    this.engine = app.engine;
    this.store = app.store;
    this.started = Date.now();
    this.channel = null;
    this.owner = null;
    this.reported = new Set();
    this.designJobs = new Set();
    this.pairings = new Map();
    this.lastFailure = 0;
    // Names a bare （ブリッジ声登録） was just answered with a button for.
    this.offered = new Map();
    // Chat commands register at once; the form opens only from Discord.
    this.designer = {
      enabled: () => false,
      run: (task, valid) => {
        check(this.bot?.designVoice, "Discord Botにログインしてください", 503);
        this.designJobs.add(task.job.id);
        return this.bot.designVoice(task, valid);
      },
    };
    this.onNotification = (n) => this.notification(n);
    this.engine.on("notification", this.onNotification);
    this.onInteraction = (interaction) => void this.handle(interaction);
    this.timer = setInterval(() => void this.announcePairings(), pairingPollMs);
    this.timer.unref();
  }
  // The voice design form is posted where /bridge join was run.
  designSettings = () =>
    this.channel
      ? { enabled: true, ...this.channel }
      : { enabled: false, guildId: "", channelId: "" };
  // Wraps Bridge's createBot so the same client also serves Mini's commands.
  botFactory(createBot) {
    return async (options) => {
      const bot = await createBot({
        ...options,
        designSettings: this.designSettings,
        // Steps are a launch option, not a property of a voice.
        designAdvancedKeys: [
          "seed",
          "cfgScaleText",
          "cfgScaleCaption",
          "cfgScaleSpeaker",
        ],
      });
      await this.attach(bot);
      return bot;
    };
  }
  async attach(bot) {
    this.bot?.client.off("interactionCreate", this.onInteraction);
    this.bot = bot;
    bot.client.on("interactionCreate", this.onInteraction);
    try {
      await bot.client.application?.commands.set([COMMAND]);
    } catch {
      this.log(
        "スラッシュコマンドを登録できませんでした。Botを招待し直してください",
      );
    }
  }
  close() {
    clearInterval(this.timer);
    this.engine.off("notification", this.onNotification);
    this.bot?.client.off("interactionCreate", this.onInteraction);
  }

  async post(payload) {
    if (!this.channel || !this.bot?.client.isReady()) return null;
    try {
      const channel = await this.bot.client.channels.fetch(
        this.channel.channelId,
      );
      return await channel.send(plain(payload.content, payload));
    } catch {
      this.log("Discordへ通知を投稿できませんでした");
      return null;
    }
  }
  characterName(id) {
    return (
      this.store.config.characters.find((c) => c.id === id)?.displayName ??
      "キャラ"
    );
  }

  // Engine's identify hook passes every chat line here first. With a
  // description, （ブリッジ声登録） registers at once, as in Bridge. Bare, it
  // only offers a button: nothing is generated until someone asks for it.
  chatCommand(event) {
    const command = voiceCommand(event.text);
    if (command?.kind !== "register" || command.caption || !this.channel)
      return event;
    const name = normalizeName(event.speaker.name);
    // Engine will refuse the bare command for lacking a description; that
    // refusal is the expected path here, not a failure to report.
    this.offered.set(name, Date.now());
    setImmediate(() => {
      const character = findByName(this.store.config, name);
      if (!character?.enabled) return;
      void this.post({
        content: `**${safe(character.displayName)}** の声を作りますか？`,
        components: [row(button(`mini:voice:${character.id}`, "声を作る", 1))],
      });
    });
    return event;
  }
  notification(n) {
    if (n.type === "characters.changed") this.reportVoiceCommands();
    else if (
      n.type === "order.skipped" &&
      n.status === "failed" &&
      Date.now() - this.lastFailure > 60000
    ) {
      this.lastFailure = Date.now();
      void this.post({
        content: `**${safe(this.characterName(n.characterId))}** の読み上げに失敗しました：${safe(miniReason(String(n.reason ?? "")))}`,
      });
    }
  }
  // Bridge shows these results on its admin page; Mini posts them.
  reportVoiceCommands() {
    for (const job of this.store.voiceCommands.all()) {
      if (
        job.updated < this.started ||
        this.reported.has(job.id) ||
        !job.characterId ||
        !["completed", "failed", "rejected"].includes(job.status)
      )
        continue;
      this.reported.add(job.id);
      const name = safe(this.characterName(job.characterId));
      const offered = this.offered.get(
        normalizeName(this.characterName(job.characterId)),
      );
      if (
        job.kind === "register" &&
        job.status === "failed" &&
        offered &&
        job.updated - offered < 5000
      ) {
        this.offered.delete(normalizeName(this.characterName(job.characterId)));
        continue;
      }
      if (job.status !== "completed")
        void this.post({
          content: `**${name}** の声を${job.kind === "delete" ? "外せ" : "登録でき"}ませんでした：${safe(miniReason(job.reason ?? ""))}`,
        });
      // The design form reports its own registration.
      else if (!this.designJobs.has(job.id))
        void this.post({
          content:
            job.kind === "delete"
              ? `**${name}** の声の割り当てを外しました。`
              : `**${name}** の声を登録しました。`,
        });
    }
  }
  async announcePairings() {
    const waiting = this.app.pendingPairings();
    for (const id of this.pairings.keys())
      if (!waiting.some((p) => p.id === id)) this.pairings.delete(id);
    for (const pairing of waiting) {
      if (this.pairings.has(pairing.id)) continue;
      if (!this.channel) {
        if (!this.pairingHint) {
          this.pairingHint = true;
          this.log(
            "Collectorが接続を求めています。Discordで /bridge join を実行すると、承認のボタンが表示されます",
          );
        }
        continue;
      }
      this.pairings.set(pairing.id, null);
      const message = await this.post({
        content: `Collectorが接続を求めています。確認コード：**${pairing.code}**\nCollectorに表示されたコードと同じなら、承認してください。`,
        components: [
          row(
            button(`mini:pair:${pairing.id}:approve`, "承認", 3),
            button(`mini:pair:${pairing.id}:reject`, "拒否", 4),
          ),
        ],
      });
      if (message) this.pairings.set(pairing.id, message);
      else this.pairings.delete(pairing.id);
    }
  }

  requireTts() {
    const { status, error } = this.tts();
    check(
      status === "ready",
      status === "error"
        ? `内蔵TTSを開始できませんでした：${error}`
        : "内蔵TTSの準備中です。少し待ってから、もう一度実行してください",
      503,
    );
  }
  async requireTextChannel(i) {
    const channels = (await this.bot.textChannels()) ?? [];
    check(
      channels.some(
        (c) =>
          c.guildId === i.guildId && c.channelId === i.channelId && c.canSend,
      ),
      "Botがメッセージの送信とファイルの添付をできる、通常のテキストチャンネルで実行してください",
      403,
    );
  }
  async join(i) {
    await i.deferReply();
    const voice = i.member?.voice?.channel;
    check(voice, "先にボイスチャンネルに入ってから実行してください");
    this.requireTts();
    await this.requireTextChannel(i);
    if (this.channel && this.channel.channelId !== i.channelId)
      this.bot.cancelDesigns();
    this.channel = { guildId: i.guildId, channelId: i.channelId };
    this.owner = i.user.id;
    await this.extension.admin({
      method: "PUT",
      path: "settings",
      body: { channel: { guildId: i.guildId, channelId: voice.id } },
    });
    const { data } = await this.extension.admin({
      method: "POST",
      path: "connect",
    });
    check(
      data.state === "connected",
      `ボイスチャンネルに接続できませんでした。${data.error || "Botの権限を確認してください"}`,
      502,
    );
    this.engine.accepting = true;
    this.engine.pump();
    const online = [...this.engine.collectors.values()].filter(
      (c) => Date.now() - c.seen < 60000,
    ).length;
    const silent = this.store.config.characters
      .filter((c) => c.enabled && !c.voiceProfileId)
      .map((c) => safe(c.displayName));
    await i.editReply(
      plain(
        [
          `<#${voice.id}> に入室し、読み上げを始めました。通知と声づくりのフォームは、このチャンネルに出します。`,
          online
            ? `Collector：接続中（${online}件）`
            : "Collector：未接続。VTTのタブでCollectorを接続してください。",
          ...(silent.length
            ? [
                `声が未登録のキャラ：${silent.slice(0, 10).join("、")}${silent.length > 10 ? ` ほか${silent.length - 10}人` : ""}`,
              ]
            : []),
          "声の登録：VTTのチャットで `（ブリッジ声登録）声の説明` と発言します。説明を省いて `（ブリッジ声登録）` だけにすると、ここに「声を作る」ボタンを出します。",
        ].join("\n"),
      ),
    );
    void this.announcePairings();
  }
  async leave(i) {
    await i.deferReply();
    await this.extension.admin({ method: "POST", path: "disconnect" });
    this.engine.reset();
    await i.editReply(plain("読み上げを止めて、退出しました。"));
  }
  async design(i, name, caption) {
    check(this.bot, "Discord Botにログインしてください", 503);
    check(
      normalizeName(name) &&
        [...name].length <= 200 &&
        !/[<>\u0000-\u001f\u007f]/.test(name),
      "キャラ名が不正です",
    );
    check(
      [...caption].length <= 1000 && !/[<>\u0000]/.test(caption),
      "声の説明が不正です",
    );
    this.requireTts();
    if (!this.channel) {
      await this.requireTextChannel(i);
      this.channel = { guildId: i.guildId, channelId: i.channelId };
    }
    const { character, created } = ensureCharacter(this.store, name);
    if (created) this.engine.notify("characters.changed");
    const base = caption
      ? undefined
      : this.store.config.voiceProfiles.find(
          (v) => v.id === character.voiceProfileId,
        );
    check(caption || base, "声の説明を入力してください");
    const { orderId } = this.engine.chatVoices.design(
      character,
      this.designer,
      { caption, base },
    );
    this.designJobs.add(orderId);
    await i.editReply(
      plain(
        `**${safe(character.displayName)}** の声づくりを <#${this.channel.channelId}> で始めました。`,
      ),
    );
  }
  async pair(i, id, action) {
    check(
      i.user.id === this.owner,
      "承認できるのは /bridge join を実行した人だけです",
      403,
    );
    const approve = action === "approve";
    this.app.resolvePairing(id, approve);
    this.pairings.delete(id);
    await i.update(
      plain(
        approve
          ? "Collectorを承認しました。VTTのタブで、もう一度Collectorの接続を押してください。"
          : "Collectorの接続を拒否しました。",
        { components: [] },
      ),
    );
  }
  autocomplete(i) {
    const typed = normalizeName(String(i.options.getFocused() ?? ""));
    return i.respond(
      this.store.config.characters
        .filter(
          (c) => c.enabled && normalizeName(c.displayName).includes(typed),
        )
        .slice(0, 25)
        .map((c) => ({
          name: c.displayName.slice(0, 100),
          value: c.displayName.slice(0, 100),
        })),
    );
  }
  async handle(i) {
    try {
      if (i.isAutocomplete?.()) {
        if (i.commandName === COMMAND.name) await this.autocomplete(i);
        return;
      }
      if (i.isChatInputCommand?.()) {
        if (i.commandName !== COMMAND.name) return;
        check(i.guildId, "サーバーの中で実行してください");
        const sub = i.options.getSubcommand();
        if (sub === "join") await this.join(i);
        else if (sub === "leave") await this.leave(i);
        else if (sub === "voice") {
          await i.deferReply({ flags: EPHEMERAL });
          await this.design(
            i,
            i.options.getString("character"),
            (i.options.getString("description") ?? "").trim(),
          );
        }
        return;
      }
      const [prefix, kind, id, action] = (i.customId ?? "").split(":");
      if (prefix !== "mini") return;
      if (kind === "pair") await this.pair(i, id, action);
      else if (kind === "voice") {
        const character = this.store.config.characters.find((c) => c.id === id);
        check(character, "キャラが見つかりません", 404);
        if (i.isModalSubmit?.()) {
          await i.deferReply({ flags: EPHEMERAL });
          await this.design(
            i,
            character.displayName,
            i.fields.getTextInputValue("description").trim(),
          );
        } else {
          const current = this.store.config.voiceProfiles.find(
            (v) => v.id === character.voiceProfileId,
          );
          await i.showModal({
            custom_id: `mini:voice:${id}`,
            title: `${character.displayName.slice(0, 30)}の声を作る`,
            components: [
              row({
                type: 4,
                custom_id: "description",
                label: "声の説明",
                style: 2,
                required: true,
                max_length: 1000,
                placeholder: "例：落ち着いた知的な若い女性の声。",
                ...(current?.caption ? { value: current.caption } : {}),
              }),
            ],
          });
        }
      }
    } catch (error) {
      const content = error.status
        ? error.message
        : "操作できませんでした。もう一度お試しください。";
      if (!error.status) this.log("Discordの操作に失敗しました");
      try {
        if (i.deferred || i.replied) await i.editReply(plain(content));
        else if (i.reply) await i.reply(plain(content, { flags: EPHEMERAL }));
      } catch {
        this.log("Discordへ操作の結果を返信できませんでした");
      }
    }
  }
}
