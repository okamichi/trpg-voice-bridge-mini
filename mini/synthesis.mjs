import { MINI_STEPS } from "./model.mjs";

// speech.cpp speaks a line one sentence at a time. Given a reference voice or
// a voice description, the model often plans two to four times too long an
// utterance for a sentence of up to about this many spoken characters, and
// fills the time by saying it again or with noise.
const SHORT = 16;
// Steps do not change the planned length, so the measuring pass is cheap.
const PROBE_STEPS = 4;

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

// A 「。」 between two sentences becomes 「、」 when either sentence is short, so
// speech.cpp speaks them as one longer sentence. A 「。」 between two long
// sentences, a line's last 「。」, 「！」, 「？」 and a 「。」 inside brackets stay.
export function joinShortSentences(text) {
  const parts = sentences(text);
  return parts
    .map((part, i) =>
      i < parts.length - 1 &&
      part.endsWith("。") &&
      (spoken(part) <= SHORT || spoken(parts[i + 1]) <= SHORT)
        ? `${part.slice(0, -1)}、`
        : part,
    )
    .join("");
}

// Wraps the fetch that reaches speech.cpp. Every synthesis carries Mini's
// step count, since Mini has no screen for choosing it and voices brought
// from Bridge may hold other values. For a designed voice, short sentences
// are joined first; a line that is still short is generated once plainly,
// without the reference or the description, to learn its length, and then in
// the voice with that length given. The greeting and the sample a new voice
// is made from go the same way.
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
    if (
      (body.voice === "none" && !body.instructions) ||
      body.seconds !== undefined ||
      typeof body.input !== "string"
    )
      return request({});
    const text = joinShortSentences(body.input);
    if (spoken(text) > SHORT) return request({ input: text });

    // The measuring pass goes in the voice none, which speech.cpp refuses the
    // reference's settings for: its CFG and the emotion boost's K/V scaling.
    const {
      cfg_scale_speaker,
      cfg_scale_instructions,
      instructions,
      speaker_kv_scale,
      speaker_kv_min_t,
      ...plain
    } = body;
    const probe = await fetchImpl(input, {
      ...init,
      body: JSON.stringify({
        ...plain,
        input: text,
        voice: "none",
        steps: Math.min(PROBE_STEPS, steps),
        response_format: "pcm",
      }),
    });
    if (!probe.ok) return probe;
    const rate = Number(probe.headers.get("X-Sample-Rate"));
    const bytes = (await probe.arrayBuffer()).byteLength;
    return request({
      input: text,
      ...(rate > 0 && bytes > 0
        ? { seconds: Math.min(30, Math.max(0.5, bytes / (rate * 2))) }
        : {}),
    });
  };
}
