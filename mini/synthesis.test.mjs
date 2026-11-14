import test from "node:test";
import assert from "node:assert/strict";
import { MINI_STEPS } from "./model.mjs";
import { sentences, shapeSynthesis } from "./synthesis.mjs";

const URL_ = "http://127.0.0.1:18088/v1/audio/speech";
const RATE = 48000;
// A stand-in for speech.cpp: a plain sentence takes one second; with a
// reference or a description it takes three unless the request says how long.
function speech() {
  const requests = [];
  const fetchImpl = async (url, init) => {
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : null;
    requests.push(body ?? init);
    if (!body?.input) return new Response("ok");
    if (body.input.includes("失敗"))
      return Response.json({ error: { message: "no" } }, { status: 400 });
    const plain = body.voice === "none" && !body.instructions;
    const seconds = body.seconds ?? (plain ? 1 : 3);
    return new Response(Buffer.alloc(Math.round(seconds * RATE) * 2), {
      headers: { "X-Sample-Rate": String(RATE) },
    });
  };
  const say = async (fields) => {
    const response = await shapeSynthesis(fetchImpl)(URL_, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "m",
        response_format: "pcm",
        voice: "chat-1",
        steps: 20,
        seed: 1,
        instructions: "落ち着いた声",
        cfg_scale_speaker: 5,
        ...fields,
      }),
      signal: AbortSignal.timeout(5000),
    });
    return {
      response,
      seconds: response.ok
        ? (await response.arrayBuffer()).byteLength / (RATE * 2)
        : null,
    };
  };
  return { requests, say, fetchImpl };
}

test("sentences are split where speech.cpp ends one, keeping marks with their sentence", () => {
  assert.deepEqual(sentences("待って。誰か来る。"), ["待って。", "誰か来る。"]);
  assert.deepEqual(sentences("😠ふざけるな！⏸️……もういい。"), [
    "😠ふざけるな！",
    "⏸️……もういい。",
  ]);
  assert.deepEqual(sentences("😲えっ、本当に？"), ["😲えっ、本当に？"]);
  assert.deepEqual(sentences("「行くぞ！」と叫んだ"), [
    "「行くぞ！」",
    "と叫んだ",
  ]);
  assert.deepEqual(sentences("こんにちは"), ["こんにちは"]);
  assert.deepEqual(sentences("……。"), ["……。"]);
});

test("a short sentence in a reference voice is measured, then spoken at that length", async () => {
  const { requests, say } = speech();
  const { seconds, response } = await say({ input: "こんにちは" });
  assert.equal(seconds, 1.15);
  assert.equal(response.headers.get("X-Sample-Rate"), String(RATE));
  assert.equal(requests.length, 2);
  const [probe, spoken] = requests;
  assert.equal(probe.voice, "none");
  assert.equal(probe.steps, 4);
  assert.ok(!("instructions" in probe));
  assert.ok(!("cfg_scale_speaker" in probe));
  assert.equal(spoken.instructions, "落ち着いた声");
  assert.equal(spoken.voice, "chat-1");
  assert.equal(spoken.steps, MINI_STEPS);
  assert.equal(spoken.seconds, 1.15);
  assert.equal(spoken.cfg_scale_speaker, 5);
});

test("a line of several sentences is spoken one sentence at a time", async () => {
  const { requests, say } = speech();
  const long = "古い地図によれば、この森を抜けた先に遺跡があるはずです。";
  const { seconds } = await say({ input: `待って。${long}誰か来る。` });
  assert.deepEqual(
    requests.map((r) => [r.input, r.voice, r.seconds]),
    [
      ["待って。", "none", undefined],
      ["待って。", "chat-1", 1.15],
      [long, "chat-1", undefined],
      ["誰か来る。", "none", undefined],
      ["誰か来る。", "chat-1", 1.15],
    ],
  );
  assert.ok(Math.abs(seconds - (1.15 + 0.3 + 3 + 0.3 + 1.15)) < 0.001);
});

test("a described voice without a reference is shaped too: the greeting and a new voice's sample", async () => {
  const { requests, say } = speech();
  const { seconds } = await say({
    input: "こんにちは。これからこの声でお話しします。",
    voice: "none",
  });
  assert.deepEqual(
    requests.map((r) => [r.input, r.voice, r.instructions, r.seconds]),
    [
      ["こんにちは。", "none", undefined, undefined],
      ["こんにちは。", "none", "落ち着いた声", 1.15],
      ["これからこの声でお話しします。", "none", undefined, undefined],
      ["これからこの声でお話しします。", "none", "落ち着いた声", 1.15],
    ],
  );
  assert.ok(Math.abs(seconds - (1.15 + 0.3 + 1.15)) < 0.001);
});

test("longer sentences and plain voices go through as one request", async () => {
  const { requests, say } = speech();
  const long =
    "古い地図によれば、この森を抜けた先に遺跡があるはずです。日が暮れる前に野営の準備を済ませておきましょう。";
  await say({ input: long });
  await say({ input: "こんにちは", voice: "none", instructions: "" });
  await say({ input: "こんにちは", seconds: 2 });
  assert.deepEqual(
    requests.map((r) => [r.input, r.voice, r.steps, r.seconds]),
    [
      [long, "chat-1", MINI_STEPS, undefined],
      ["こんにちは", "none", MINI_STEPS, undefined],
      ["こんにちは", "chat-1", MINI_STEPS, 2],
    ],
  );
});

test("a refusal from speech.cpp is passed on for Engine to handle", async () => {
  const { say } = speech();
  assert.equal((await say({ input: "失敗。" })).response.status, 400);
  assert.equal(
    (await say({ input: "待って。失敗する長い文章がここに続いています。" }))
      .response.status,
    400,
  );
});

test("requests that are not a speech.cpp synthesis pass unchanged", async () => {
  const { requests, fetchImpl } = speech();
  const shaped = shapeSynthesis(fetchImpl);
  const form = new FormData();
  const irodori = JSON.stringify({ input: "", irodori: { num_steps: 20 } });
  await shaped("http://127.0.0.1:18088/v1/models");
  await shaped("http://127.0.0.1:18088/v1/audio/voices", {
    method: "POST",
    body: form,
  });
  await shaped("http://127.0.0.1:8088/v1/audio/speech", {
    method: "POST",
    body: irodori,
  });
  assert.equal(requests[0], undefined);
  assert.equal(requests[1].body, form);
  assert.deepEqual(requests[2], JSON.parse(irodori));
});

test("the step count can be set at launch", async () => {
  const requests = [];
  const shaped = shapeSynthesis(async (url, init) => {
    const body = JSON.parse(init.body);
    requests.push(body);
    return new Response(Buffer.alloc(RATE * 2), {
      headers: { "X-Sample-Rate": String(RATE) },
    });
  }, 2);
  const send = (input) =>
    shaped(URL_, {
      method: "POST",
      body: JSON.stringify({
        input,
        voice: "chat-1",
        steps: 20,
        response_format: "pcm",
      }),
    });
  await send("古い地図によれば、この森を抜けた先に遺跡があるはずです。");
  await send("うん。");
  assert.deepEqual(
    requests.map((r) => r.steps),
    [2, 2, 2],
    "the measuring pass never takes more steps than the line itself",
  );
});
