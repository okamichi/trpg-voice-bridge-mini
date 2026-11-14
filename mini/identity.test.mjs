import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store, initialConfig } from "../src/store.mjs";
import { Engine } from "../src/engine.mjs";
import {
  ensureCharacter,
  findByName,
  forgetRooms,
  identify,
  normalizeName,
} from "./identity.mjs";

const NAME = "メリッサ・クローデル";
function setup(t) {
  const dir = mkdtempSync(join(tmpdir(), "mini-identity-"));
  const config = initialConfig({});
  config.provider.type = "mock";
  const store = new Store(dir, config);
  const engine = new Engine(store, { identify });
  t.after(() => {
    engine.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  let message = 0;
  const say = (contextId, speaker, adapter = "ccfolia") => {
    const source = { adapter, instanceId: "vtt", contextId };
    if (!store.config.sources.some((s) => s.contextId === contextId))
      store.change((c) => c.sources.push(source));
    engine.connect({ source, collectorId: "collector" });
    return engine.ingress(
      {
        schemaVersion: 1,
        eventId: `event-${++message}`,
        roomId: store.config.roomId,
        sessionId: engine.sessionId,
        source: { ...source, messageId: `m${message}`, revision: 0 },
        speaker: { kind: "character", ...speaker },
        channel: "main",
        visibility: "public",
        kind: "dialogue",
        text: "さあ、冒険に出かけよう！",
        occurredAt: new Date().toISOString(),
      },
      "collector",
    );
  };
  return { store, engine, say };
}

test("names differing only in width or spacing are the same name", () => {
  assert.equal(normalizeName("  ﾒﾘｯｻ　ｸﾛｰﾃﾞﾙ "), "メリッサ クローデル");
  assert.equal(normalizeName("ＡＢＣ１"), "ABC1");
});

test("one name is one character across speaker IDs, rooms and VTTs", (t) => {
  const { store, say } = setup(t);
  say("room-1", { id: '["user-a","x"]', name: NAME });
  say("room-1", { id: '["user-b","x"]', name: NAME });
  say("room-2", { id: "other", name: `${NAME} ` });
  say("world", { id: "actor", name: NAME, tokenId: "t", sceneId: "s" }, "fvtt");
  assert.equal(store.config.characters.length, 1);
  assert.equal(store.config.characters[0].displayName, NAME);
  assert.equal(store.config.characters[0].bindings.length, 3);
});

test("different names are different characters", (t) => {
  const { store, say } = setup(t);
  say("room-1", { id: "same-id", name: "村人A" });
  say("room-1", { id: "same-id", name: "村人B" });
  assert.deepEqual(
    store.config.characters.map((c) => c.displayName),
    ["村人A", "村人B"],
  );
});

test("a character made before it speaks is the one that speaks later", (t) => {
  const { store, say } = setup(t);
  const { character, created } = ensureCharacter(store, ` ${NAME}`);
  assert.equal(created, true);
  assert.equal(ensureCharacter(store, NAME).created, false);
  say("room-1", { id: "any", name: NAME });
  assert.equal(store.config.characters.length, 1);
  assert.equal(findByName(store.config, NAME).id, character.id);
});

test("a name brought over from Bridge keeps its voice in a new room", (t) => {
  const { store, say } = setup(t);
  store.change((c) => {
    c.voiceProfiles.push({
      id: "voice",
      name: "声",
      provider: "irodori-local",
      voiceId: "none",
      caption: "落ち着いた声",
      seed: "1",
      speed: 1,
      steps: 20,
    });
    c.characters.push(
      {
        id: "silent",
        displayName: NAME,
        enabled: true,
        voiceProfileId: null,
        bindings: [],
      },
      {
        id: "voiced",
        displayName: NAME,
        enabled: true,
        voiceProfileId: "voice",
        bindings: [
          {
            adapter: "fvtt",
            instanceId: "old",
            contextId: "world",
            speakerId: "actor-1",
          },
        ],
      },
    );
  });
  say("room-9", { id: "new", name: NAME });
  assert.equal(store.config.characters.length, 2);
  assert.equal(
    store.config.characters.find((c) => c.id === "voiced").bindings.length,
    2,
  );
});

test("rooms are forgotten at start and names still resolve", (t) => {
  const { store, say } = setup(t);
  for (let room = 0; room < 3; room++)
    say(`room-${room}`, { id: "x", name: NAME });
  forgetRooms(store);
  assert.deepEqual(store.config.sources, []);
  assert.deepEqual(store.config.characters[0].bindings, []);
  say("room-new", { id: "y", name: NAME });
  assert.equal(store.config.characters.length, 1);
});

test("bindings stay within the limit over many rooms", (t) => {
  const { store } = setup(t);
  const { character } = ensureCharacter(store, NAME);
  for (let room = 0; room < 105; room++)
    identify(
      {
        source: {
          adapter: "ccfolia",
          instanceId: "vtt",
          contextId: `r${room}`,
        },
        speaker: { kind: "character", id: "x", name: NAME },
      },
      store,
    );
  const bindings = store.config.characters.find(
    (c) => c.id === character.id,
  ).bindings;
  assert.equal(bindings.length, 100);
  assert.equal(bindings.at(-1).contextId, "r104");
});
