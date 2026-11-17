import test from "node:test";
import assert from "node:assert/strict";
import { synthesize, mockWav } from "./provider.mjs";
const voice = {
  id: "melissa",
  provider: "irodori-local",
  name: "メリッサ",
  voiceId: "voice-20261013-2253",
  caption: "明るい声",
  speed: 1,
  seed: "1",
  steps: 20,
};
const provider = {
  type: "irodori",
  baseUrl: "http://tts.invalid",
  model: "irodori-tts",
};

test("missing reference voice reports the configured ID and does not substitute another voice", async () => {
  const calls = [];
  await assert.rejects(
    synthesize("こんにちは", voice, provider, {
      fetchImpl: async (_url, request) => {
        calls.push(JSON.parse(request.body));
        return Response.json(
          {
            error: {
              message:
                'Irodori-TTS-v4-Large has no voice named "voice-20261013-2253"; its voices are none',
              param: "voice",
              code: "unsupported_value",
            },
          },
          { status: 400 },
        );
      },
    }),
    /参照音声「voice-20261013-2253」が現在のTTSサーバーに登録されていません/,
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0].voice, voice.voiceId);
});
test("structured TTS errors include a bounded single-line explanation; invalid bodies retain status", async () => {
  for (const [body, expected] of [
    [
      JSON.stringify({
        error: { message: "invalid\ncaption", param: "caption" },
      }),
      /TTS HTTP 400: invalid caption/,
    ],
    ["<html>proxy failure</html>", /^TTS HTTP 400$/],
    ["x".repeat(9000), /^TTS HTTP 400$/],
  ]) {
    await assert.rejects(
      synthesize("こんにちは", voice, provider, {
        fetchImpl: async () => new Response(body, { status: 400 }),
      }),
      { message: expected },
    );
  }
});
test("successful WAV responses remain unchanged", async () => {
  const wav = mockWav();
  assert.deepEqual(
    await synthesize("こんにちは", voice, provider, {
      fetchImpl: async () => new Response(wav),
    }),
    wav,
  );
});

test("text and caption cannot inject TTS JSON fields and voice paths are rejected", async () => {
  const injected = `"seed":"__SEED__","speed":100,"voice":"../../secret" $(echo injected)`;
  let calls = 0;
  const fetchImpl = async (url, request) => {
    calls++;
    assert.equal(url, "http://tts.invalid/v1/audio/speech");
    const body = JSON.parse(request.body);
    assert.equal(body.input, injected);
    assert.equal(body.irodori.caption, injected);
    assert.equal(body.irodori.seed, 1);
    assert.equal(body.speed, voice.speed);
    assert.equal(body.voice, voice.voiceId);
    return new Response(mockWav());
  };
  await synthesize(injected, { ...voice, caption: injected }, provider, {
    fetchImpl,
  });
  for (const voiceId of ["../../secret", "%2e%2e%2fsecret", "x;echo injected"])
    await assert.rejects(
      synthesize("test", { ...voice, voiceId }, provider, { fetchImpl }),
      /参照voiceが不正/,
    );
  assert.equal(calls, 1);
});

test("the voice description and the line's direction are joined with a slash", async () => {
  const { payload } = await import("./provider.mjs");
  const model = {
    id: "m",
    speech: {
      voices: [{ name: "none" }, { name: "r" }],
      options: [{ name: "instructions" }, { name: "steps", default: 40 }],
    },
  };
  const voice = (caption, voiceId = "r") => ({
    id: "v",
    name: "v",
    provider: "irodori-local",
    voiceId,
    caption,
    seed: "1",
    speed: 1,
    steps: 12,
  });
  const sent = (text, caption, mode = "append", voiceId) =>
    JSON.parse(
      payload(text, voice(caption, voiceId), { type: "speech" }, mode, model),
    ).instructions;
  assert.equal(
    sent(
      "（演技：震える声で、怯えながら）誰か……いるの？",
      "活発な若い男の低い声",
    ),
    "活発な若い男の低い声/演技: 震える声で、怯えながら",
  );
  assert.equal(
    sent("（演技:小声で）待って。", "落ち着いた初老の男性の声。"),
    "落ち着いた初老の男性の声/演技: 小声で",
  );
  assert.equal(
    sent("（演技:小声で）待って。", "落ち着いた声", "prepend"),
    "演技: 小声で/落ち着いた声",
  );
  assert.equal(
    sent("（演技:小声で）待って。", "落ち着いた声", "replace"),
    "演技: 小声で",
  );
  // Without a direction the saved description is sent unchanged.
  assert.equal(sent("（怒り）ふざけるな！", "活発な声。"), "活発な声。");
  assert.equal(sent("こんにちは。", ""), "");
});

test("the emotion boost goes only with a reference voice, to a model that takes it", async () => {
  const { payload, EMOTION_BOOST } = await import("./provider.mjs");
  const { voiceSchema } = await import("./contracts.mjs");
  const options = [
    { name: "instructions" },
    { name: "steps", default: 40 },
    { name: "cfg_scale_speaker" },
    { name: "speaker_kv_scale" },
    { name: "speaker_kv_min_t" },
  ];
  const model = (names = options) => ({
    id: "m",
    speech: { voices: [{ name: "none" }, { name: "r" }], options: names },
  });
  const voice = (fields = {}) => ({
    id: "v",
    name: "v",
    provider: "irodori-local",
    voiceId: "r",
    caption: "明るく元気な若い女性の声",
    seed: "1",
    speed: 1,
    steps: 12,
    ...fields,
  });
  const sent = (v, m = model()) =>
    JSON.parse(
      payload("（演技:怯えながら）誰？", v, { type: "speech" }, "replace", m),
    );
  assert.deepEqual(EMOTION_BOOST, {
    speaker_kv_scale: 0.4,
    speaker_kv_min_t: 0.7,
  });
  const boosted = sent(voice({ emotionBoost: true }));
  assert.equal(boosted.speaker_kv_scale, 0.4);
  assert.equal(boosted.speaker_kv_min_t, 0.7);
  // Off, which is no key at all, sends neither.
  for (const body of [
    sent(voice()),
    sent(voice({ emotionBoost: true, voiceId: "none" })),
    // A MeanFlow model takes neither setting.
    sent(
      voice({ emotionBoost: true }),
      model([{ name: "instructions" }, { name: "steps", default: 4 }]),
    ),
  ]) {
    assert.ok(!("speaker_kv_scale" in body));
    assert.ok(!("speaker_kv_min_t" in body));
  }
  voiceSchema(voice({ emotionBoost: true }));
  for (const value of [false, "on", 1])
    assert.throws(() => voiceSchema(voice({ emotionBoost: value })), {
      message: /感情ブースト/,
    });
});
