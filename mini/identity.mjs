import { createHash, randomUUID } from "node:crypto";
import { resolveCharacter } from "../src/contracts.mjs";

// Bridge Mini's one rule: the same name is the same character, whichever VTT
// or room it speaks in. Width and spacing differences are not differences.
export const normalizeName = (name) =>
  name.normalize("NFKC").replace(/\s+/g, " ").trim();

// A speaker ID made from the name, so Bridge's ID matching does the rest.
const speakerId = (name) =>
  `name:${createHash("sha256").update(name).digest("hex").slice(0, 40)}`;

export function findByName(config, name) {
  const wanted = normalizeName(name);
  const same = config.characters.filter(
    (c) => normalizeName(c.displayName) === wanted,
  );
  // Data brought over from Bridge may hold one name several times.
  return same.find((c) => c.voiceProfileId) ?? same[0] ?? null;
}

// Engine's identify hook. When this source has not seen the name before but a
// character of that name exists, that character is bound to the source.
export function identify(event, store) {
  const name = normalizeName(event.speaker.name);
  if (!name) return event;
  const speaker = { kind: "character", id: speakerId(name), name };
  const rewritten = { ...event, speaker };
  if (resolveCharacter(store.config, rewritten)) return rewritten;
  const existing = findByName(store.config, name);
  if (existing) {
    const { adapter, instanceId, contextId } = event.source;
    store.change((config) => {
      const character = config.characters.find((c) => c.id === existing.id);
      // A long campaign visits many rooms; keep the newest bindings.
      while (character.bindings.length >= 100) {
        const old = character.bindings.findIndex((b) =>
          b.speakerId?.startsWith("name:"),
        );
        character.bindings.splice(Math.max(old, 0), 1);
      }
      character.bindings.push({
        adapter,
        instanceId,
        contextId,
        speakerId: speaker.id,
      });
    });
  }
  return rewritten;
}

// A character can be given a voice before it has spoken anywhere.
export function ensureCharacter(store, name) {
  const displayName = normalizeName(name);
  const existing = findByName(store.config, displayName);
  if (existing) return { character: existing, created: false };
  const character = {
    id: randomUUID(),
    displayName,
    enabled: true,
    voiceProfileId: null,
    bindings: [],
  };
  store.change((config) => config.characters.push(character));
  return { character, created: true };
}

// Rooms come and go, and a room's entry is rebuilt when a Collector connects
// or a name speaks. Clearing them at start keeps both under their limits.
export function forgetRooms(store) {
  store.change((config) => {
    config.sources = [];
    for (const character of config.characters)
      character.bindings = character.bindings.filter(
        (b) => !b.speakerId?.startsWith("name:"),
      );
  });
}
