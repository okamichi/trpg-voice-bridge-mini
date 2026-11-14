import test from "node:test";
import assert from "node:assert/strict";
import { voiceSchema } from "./contracts.mjs";
import { NEW_VOICE_DEFAULTS, newVoiceSeed } from "./voice-defaults.mjs";

test("each new voice gets a different seed within what speech.cpp accepts", () => {
  const seeds = Array.from({ length: 200 }, newVoiceSeed);
  assert.equal(new Set(seeds).size, seeds.length);
  for (const seed of seeds) {
    assert.match(seed, /^[1-9]\d*$/);
    assert.ok(BigInt(seed) <= (1n << 53n) - 1n, seed);
    voiceSchema({ ...NEW_VOICE_DEFAULTS, id: "v", name: "v", seed });
  }
});
