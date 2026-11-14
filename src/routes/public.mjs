import { randomBytes, randomUUID } from "node:crypto";
import { check, hash } from "../contracts.mjs";
import { json, body } from "../http-util.mjs";

/** Health and Collector pairing. Returns true when handled. */
export async function publicRoutes(ctx, req, res, url) {
  const path = url.pathname,
    method = req.method;
  const { pairings } = ctx;
  if (path === "/healthz" && method === "GET")
    return json(res, 200, { status: "ok" });
  if (path === "/api/v1/pairings" && method === "POST") {
    check(
      req.headers.host === new URL(ctx.localOrigin).host,
      "ローカル接続が必要です",
      403,
    );
    check(
      !req.headers.origin ||
        /^chrome-extension:\/\/[a-z]+$/.test(req.headers.origin),
      "拡張から接続してください",
      403,
    );
    const b = await body(req);
    check(
      typeof b.key === "string" && /^[a-f0-9]{64}$/.test(b.key),
      "接続キーが不正です",
    );
    for (const [k, v] of pairings)
      if (v.expires < Date.now()) pairings.delete(k);
    const key = hash(b.key);
    let pending = pairings.get(key);
    if (!pending) {
      check(pairings.size < 20, "接続承認の待機数が上限です", 429);
      pending = {
        id: randomUUID(),
        code: randomBytes(3).toString("hex").toUpperCase(),
        origin: req.headers.origin ?? "",
        expires: Date.now() + 300000,
      };
      pairings.set(key, pending);
    }
    check(pending.origin === (req.headers.origin ?? ""), "異なる拡張です", 403);
    return json(res, 200, {
      code: pending.code,
      status: pending.token
        ? "approved"
        : pending.rejected
          ? "rejected"
          : "pending",
      token: pending.token,
    });
  }
}
