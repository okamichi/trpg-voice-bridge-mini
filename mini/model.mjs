// The one model Bridge Mini carries: Irodori-TTS-v4.1-Small, Q4_K.
// speech.cpp's catalog pins the same repository revision for this choice.
export const MINI_MODEL = Object.freeze({
  choice: "irodori-tts:q4_k",
  file: "Irodori-TTS-859M-v4.1-Q4_K.gguf",
  bytes: 859871072,
  sha256: "a1c174f4552817e84dd6a2a020bc3d0589fd7f30d0c3db53ad04a1e69fb5dbfd",
  repository: "sakasegawa/Irodori-TTS-v4.1-Small-GGUF",
  revision: "66fe2cde1973fd44e7202fbe36df722103958188",
});

// Every line is generated in this many steps, whatever a voice has saved,
// unless --steps says otherwise. Twelve was chosen by listening against
// twenty on the same lines: no worse to the ear or to a recognizer, and
// faster.
export const MINI_STEPS = 12;
