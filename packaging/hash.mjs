import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";

// For files too large to read at once: the model and Bridge Mini's archive.
export async function sha256File(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}
