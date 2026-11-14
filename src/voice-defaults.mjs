import { randomBytes } from "node:crypto";

export const NEW_VOICE_DEFAULTS = Object.freeze({
  provider: "irodori-local",
  voiceId: "none",
  caption: "",
  seed: "1",
  speed: 1,
  steps: 20,
});
// A new voice gets its own seed, so two voices made from the same description
// differ. speech.cpp takes seeds up to 2^53 - 1; staying within that keeps the
// saved seed the one speech.cpp actually uses.
export function newVoiceSeed() {
  const range = (1n << 53n) - 1n;
  return String((randomBytes(8).readBigUInt64BE() % range) + 1n);
}
export const VOICE_CONFIRMATION = "こんにちは。これからこの声でお話しします。";
