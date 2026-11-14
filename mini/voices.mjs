import { readdirSync, rmSync } from "node:fs";
import { join } from "node:path";

// Bridge Mini has no page for sorting out voices, so a voice is removed when
// the character it was made for stops using it: one name, one voice. Voices
// that were already unassigned (kept on purpose in Bridge) are never touched.
export class VoiceTidy {
  // uses() gives the voice profile IDs used outside characters (greetings).
  constructor({ store, engine, uses = () => ({}), log = () => {} }) {
    Object.assign(this, { store, engine, uses, log });
    this.assigned = this.snapshot();
    this.dropped = new Set();
    this.work = Promise.resolve();
  }
  snapshot() {
    return new Map(
      this.store.config.characters.map((c) => [c.id, c.voiceProfileId]),
    );
  }
  // Call after characters or their voices change.
  changed() {
    const next = this.snapshot();
    for (const [id, voice] of this.assigned)
      if (voice && next.get(id) !== voice) this.dropped.add(voice);
    this.assigned = next;
    this.work = this.work.then(() => this.sweep()).catch(() => {});
    return this.work;
  }
  close() {
    this.closed = true;
    clearTimeout(this.retry);
  }
  async sweep() {
    if (!this.dropped.size || this.closed) return;
    // A design in progress may be built on the voice it is about to replace,
    // and a registration is still counted as running when it announces its
    // result: look again shortly.
    if (this.engine.chatVoices.tasks.size) {
      clearTimeout(this.retry);
      this.retry = setTimeout(() => void this.changed(), 200);
      this.retry.unref();
      return;
    }
    const candidates = [...this.dropped];
    this.dropped.clear();
    const elsewhere = this.uses();
    const removed = [];
    this.store.change((config) => {
      const used = new Set(config.characters.map((c) => c.voiceProfileId));
      config.voiceProfiles = config.voiceProfiles.filter((voice) => {
        const drop =
          candidates.includes(voice.id) &&
          !used.has(voice.id) &&
          !elsewhere[voice.id]?.length;
        if (drop) removed.push(voice);
        return !drop;
      });
    });
    const kept = new Set(this.store.config.voiceProfiles.map((v) => v.voiceId));
    const { records } = this.engine.references.scan(
      this.engine.config.provider,
    );
    for (const id of new Set(removed.map((v) => v.voiceId))) {
      if (kept.has(id) || !Object.hasOwn(records, id)) continue;
      try {
        await this.engine.references.forget(id, records[id].sha256);
        // Bridge keeps a detached WAV for a person to look at; Mini has no
        // page that would show it.
        const detached = join(this.store.dir, "voices-detached");
        for (const file of readdirSync(detached))
          if (file.startsWith(`${id}-`) && file.endsWith(".wav"))
            rmSync(join(detached, file), { force: true });
      } catch {
        this.log("使わなくなった声の音声ファイルを削除できませんでした");
      }
    }
  }
}

// Names that spoke but were never given a voice return when they speak again.
export function forgetVoiceless(store) {
  store.change((config) => {
    config.characters = config.characters.filter(
      (c) => c.voiceProfileId || !c.enabled || c.bindings.length,
    );
  });
}
