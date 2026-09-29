import type { FastifyPluginAsync } from "fastify";
import { MockError } from "../shared/errors.js";
import { mvolaByServerCorrelationId } from "../providers/mvola/mvola.store.js";
import { orangeByPayToken } from "../providers/orange-money/orange.store.js";
import { confirmPayment } from "../providers/orange-money/orange.service.js";
import { getConfig, resetEverything, resetOne, updateConfig } from "./mock.service.js";
import { getProfile, listProfiles } from "./profiles.js";

const esc = (s: unknown): string =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/** EVERYTHING here is MOCK-ONLY and lives under /__mock. None of it exists in the real providers. */
export const mockRoutes: FastifyPluginAsync = async (app) => {
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof MockError) return reply.code(err.statusCode).send({ error: "MOCK_ERROR", message: err.message });
    const status = (err as { statusCode?: number }).statusCode ?? 500;
    return reply.code(status).send({ error: "MOCK_ERROR", message: (err as Error).message });
  });

  app.get("/__mock/profiles", async () => listProfiles());

  app.get("/__mock/profiles/:profile", async (req) => {
    const p = getProfile((req.params as { profile: string }).profile);
    if (!p) throw new MockError(404, "Unknown profile");
    return p;
  });

  // Only way to restore a balance: back to the predefined initialBalance (no arbitrary balances).
  app.post("/__mock/profiles/:profile/reset", async (req) => resetOne((req.params as { profile: string }).profile));

  app.post("/__mock/reset", async (req) => {
    const q = req.query as { transactions?: string; config?: string };
    return resetEverything({ transactions: q.transactions === "true", config: q.config === "true" });
  });

  app.get("/__mock/config", async () => getConfig());
  app.post("/__mock/config", async (req) => updateConfig(req.body));

  // Inspection helper
  app.get("/__mock/transactions", async () => ({
    mvola: Array.from(mvolaByServerCorrelationId.values()).map((t) => ({
      serverCorrelationId: t.serverCorrelationId,
      transactionReference: t.transactionReference ?? null,
      status: t.status,
      amount: t.amount,
      debitMsisdn: t.debitMsisdn,
      profile: t.profileType,
    })),
    orangeMoney: Array.from(orangeByPayToken.values()).map((t) => ({
      order_id: t.request.order_id,
      pay_token: t.payToken,
      status: t.status,
      amount: t.amount,
      txnid: t.txnid ?? null,
      profile: t.profileType,
    })),
  }));

  /* ---- Orange hosted payment page (stands in for Orange's real customer-facing page) ---- */

  app.get("/__mock/orange/pay/:payToken", async (req, reply) => {
    const tx = orangeByPayToken.get((req.params as { payToken: string }).payToken);
    if (!tx) throw new MockError(404, "Unknown pay_token");
    const buttons = listProfiles()
      .filter((p) => p.provider === "ORANGE_MONEY")
      .map(
        (p) =>
          `<button name="profile" value="${esc(p.type)}">${esc(p.type)} — ${esc(p.fakeMsisdn)} — balance ${p.balance} Ar</button>`,
      )
      .join("<br><br>");
    return reply.type("text/html").send(`<!doctype html><html><head><meta charset="utf-8"><title>Mock Orange Money</title></head>
<body style="font-family:sans-serif;max-width:560px;margin:40px auto">
<h2>Mock Orange Money — hosted payment page</h2>
<p><b>MOCK-ONLY.</b> Order <code>${esc(tx.request.order_id)}</code> — <b>${esc(tx.amount)}</b> ${esc(tx.request.currency)} — status <b>${esc(tx.status)}</b></p>
<form method="POST" action="/__mock/orange/pay/${esc(tx.payToken)}/confirm">${buttons}</form>
</body></html>`);
  });

  // JSON: { "profile": "ORANGE_MONEY_5" }  or  HTML form post (redirects to return_url)
  app.post("/__mock/orange/pay/:payToken/confirm", async (req, reply) => {
    const payToken = (req.params as { payToken: string }).payToken;
    const profile = String(((req.body ?? {}) as Record<string, unknown>).profile ?? "");
    const tx = confirmPayment(payToken, profile);
    const isForm = String(req.headers["content-type"] ?? "").includes("application/x-www-form-urlencoded");
    if (isForm) return reply.redirect(tx.request.return_url, 303);
    return { status: tx.status, order_id: tx.request.order_id, profile: tx.profileType };
  });
};
