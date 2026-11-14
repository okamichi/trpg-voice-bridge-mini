import { MINI_STEPS } from "./model.mjs";

// Given a reference voice or a voice description, the model often plans two
// to four times too long an utterance for a short sentence, and fills the
// time by saying it again or with noise. Sentences up to this many spoken
// characters are measured first.
const SHORT = 16;
// Steps do not change the planned length, so the measuring pass is cheap.
const PROBE_STEPS = 4;
// A reference voice may speak a little slower than the model's own pace.
const PACE = 1.15;
const PAUSE_SECONDS = 0.3;

const spoken = (text) => (text.match(/[\p{L}\p{N}]/gu) ?? []).length;

// Sentences as speech.cpp speaks them, one at a time. A piece with nothing to
// say (an emoji, a run of dots) stays with its neighbour.
export function sentences(text) {
  const parts = [];
  for (const piece of text.match(
    /[^。！？!?]+[。！？!?]*[」』）)]*|[。！？!?]+/gu,
  ) ?? [])
    if (parts.length && (!spoken(piece) || !spoken(parts.at(-1))))
      parts[parts.length - 1] += piece;
    else parts.push(piece);
  return parts;
}

// Wraps the fetch that reaches speech.cpp. Every synthesis carries Mini's
// step count, since Mini has no screen for choosing it and voices brought
// from Bridge may hold other values. A line in a designed voice that has a
// short sentence is spoken sentence by sentence: each short one is first
// generated plainly, without the reference or the description, to learn its
// length, then generated in the voice with that length given. The greeting
// and the sample a new voice is made from go the same way.
export function shapeSynthesis(fetchImpl, steps = MINI_STEPS) {
  return async (input, init) => {
    if (
      init?.method !== "POST" ||
      typeof init.body !== "string" ||
      !String(input).endsWith("/v1/audio/speech")
    )
      return fetchImpl(input, init);
    const body = JSON.parse(init.body);
    // Only speech.cpp's own request has a top-level step count.
    if (!Number.isInteger(body.steps)) return fetchImpl(input, init);
    const request = (fields) =>
      fetchImpl(input, {
        ...init,
        body: JSON.stringify({ ...body, steps, ...fields }),
      });
    const parts =
      (body.voice !== "none" || body.instructions) &&
      body.seconds === undefined &&
      body.response_format === "pcm" &&
      typeof body.input === "string"
        ? sentences(body.input)
        : [];
    if (!parts.some((part) => spoken(part) <= SHORT)) return request({});

    let rate;
    const chunks = [];
    for (const part of parts) {
      const fields = { input: part };
      if (spoken(part) <= SHORT) {
        const {
          cfg_scale_speaker,
          cfg_scale_instructions,
          instructions,
          ...plain
        } = body;
        const probe = await fetchImpl(input, {
          ...init,
          body: JSON.stringify({
            ...plain,
            input: part,
            voice: "none",
            steps: Math.min(PROBE_STEPS, steps),
          }),
        });
        if (!probe.ok) return probe;
        const probeRate = Number(probe.headers.get("X-Sample-Rate"));
        const bytes = (await probe.arrayBuffer()).byteLength;
        if (probeRate > 0 && bytes > 0)
          fields.seconds = Math.min(
            30,
            Math.max(0.5, (bytes / (probeRate * 2)) * PACE),
          );
      }
      const response = await request(fields);
      if (!response.ok) return response;
      const sampleRate = Number(response.headers.get("X-Sample-Rate"));
      // Engine rejects the audio when the rate is missing or changes.
      if (rate && sampleRate !== rate) return request({});
      rate = sampleRate;
      if (chunks.length)
        chunks.push(Buffer.alloc(Math.round(rate * PAUSE_SECONDS) * 2));
      chunks.push(Buffer.from(await response.arrayBuffer()));
    }
    return new Response(Buffer.concat(chunks), {
      status: 200,
      headers: {
        "Content-Type": "audio/pcm",
        "X-Sample-Rate": String(rate),
      },
    });
  };
}
