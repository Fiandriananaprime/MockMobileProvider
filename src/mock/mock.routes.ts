import type { FastifyPluginAsync } from "fastify";
import { orangeByPayToken } from "../providers/orange-money/orange.store.js";
import { confirmPayment } from "../providers/orange-money/orange.service.js";
import { getPublicAccountByMsisdn, listAccounts } from "../db.js";
import { MockError } from "../shared/errors.js";

const escapeHtml = (value: unknown): string =>
  String(value).replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[character]!);

const formatAmount = (amount: number): string => new Intl.NumberFormat("fr-FR").format(amount);

const checkoutPage = (input: {
  payToken: string;
  orderId: string;
  amount: number;
  currency: string;
  status: string;
  accounts: Array<{ msisdn: string; balance: number; currency: string }>;
}): string => {
  const canConfirm = input.status === "INITIATED";
  const accountChoices = input.accounts.map((account) => `
    <label class="wallet-option">
      <input type="radio" name="msisdn" value="${escapeHtml(account.msisdn)}" required ${canConfirm ? "" : "disabled"}>
      <span class="wallet-copy">
        <strong>Orange Money</strong>
        <span class="wallet-number">${escapeHtml(account.msisdn)}</span>
      </span>
      <span class="wallet-balance">${formatAmount(account.balance)} ${escapeHtml(account.currency)}</span>
    </label>`).join("");

  const content = canConfirm
    ? input.accounts.length
      ? `<form method="POST" action="/__mock/orange/pay/${escapeHtml(input.payToken)}/confirm">
          <fieldset>
            <legend>Choisissez le wallet à débiter</legend>
            <div class="wallet-list">${accountChoices}</div>
          </fieldset>
          <button class="confirm-button" type="submit">Confirmer le paiement</button>
        </form>`
      : `<p class="empty-state">Aucun compte Orange Money actif n'est disponible pour ce paiement.</p>`
    : `<p class="status-message">Cette demande n'est plus en attente. Statut : <strong>${escapeHtml(input.status)}</strong></p>`;

  return `<!doctype html>
<html lang="fr">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="light">
  <title>Paiement Orange Money</title>
  <style>
    :root { font-family: "Segoe UI", Arial, sans-serif; color: #202124; background: #f4f5f6; font-synthesis: none; }
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 28px 16px; }
    main { width: min(100%, 520px); background: #fff; border: 1px solid #e2e4e7; border-radius: 12px; overflow: hidden; box-shadow: 0 16px 42px #17212b12; }
    .brand { display: flex; align-items: center; justify-content: space-between; padding: 22px 26px; border-bottom: 1px solid #eceef0; }
    .brand-name { display: flex; align-items: center; gap: 10px; color: #202124; font-weight: 700; font-size: 18px; }
    .brand-mark { width: 12px; height: 26px; border-radius: 3px; background: #ff7900; }
    .simulation { color: #626970; font-size: 12px; }
    .content { padding: 28px 26px 26px; }
    h1 { margin: 0 0 8px; font-size: 23px; line-height: 1.25; }
    .intro { margin: 0 0 22px; color: #626970; font-size: 14px; line-height: 1.5; }
    .payment-summary { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 16px; margin-bottom: 26px; background: #fff7ef; border: 1px solid #ffe2c5; border-radius: 8px; }
    .summary-label { color: #626970; font-size: 13px; }
    .order-id { display: block; margin-top: 5px; max-width: 250px; overflow-wrap: anywhere; font-size: 13px; font-weight: 600; }
    .amount { flex: 0 0 auto; color: #242424; font-size: 20px; font-weight: 700; text-align: right; }
    fieldset { min-width: 0; margin: 0; padding: 0; border: 0; }
    legend { margin-bottom: 12px; font-size: 14px; font-weight: 650; }
    .wallet-list { display: grid; gap: 10px; }
    .wallet-option { display: flex; align-items: center; gap: 12px; min-height: 70px; padding: 12px 14px; border: 1px solid #dfe2e5; border-radius: 8px; cursor: pointer; }
    .wallet-option:has(input:checked) { border-color: #f47700; box-shadow: 0 0 0 1px #f47700; background: #fffaf5; }
    .wallet-option input { width: 18px; height: 18px; flex: 0 0 auto; accent-color: #e96d00; }
    .wallet-copy { display: grid; gap: 4px; min-width: 0; font-size: 13px; }
    .wallet-number { color: #626970; }
    .wallet-balance { margin-left: auto; color: #41464b; font-size: 12px; text-align: right; }
    .confirm-button { width: 100%; min-height: 48px; margin-top: 20px; padding: 12px 16px; border: 0; border-radius: 7px; background: #f47700; color: #fff; font: inherit; font-weight: 700; cursor: pointer; }
    .confirm-button:hover { background: #db6800; }
    .confirm-button:focus-visible, .wallet-option:focus-within { outline: 3px solid #252525; outline-offset: 2px; }
    .empty-state, .status-message { padding: 16px; border-radius: 8px; background: #f3f4f5; color: #50565c; font-size: 14px; line-height: 1.5; }
    footer { padding: 15px 26px; border-top: 1px solid #eceef0; color: #71777d; font-size: 11px; line-height: 1.45; }
    @media (max-width: 440px) { .brand, .content { padding-left: 18px; padding-right: 18px; } .payment-summary { align-items: flex-start; flex-direction: column; } .amount { text-align: left; } footer { padding-left: 18px; padding-right: 18px; } }
  </style>
</head>
<body>
  <main>
    <header class="brand">
      <div class="brand-name"><span class="brand-mark" aria-hidden="true"></span>Orange Money</div>
      <span class="simulation">Paiement simulé</span>
    </header>
    <section class="content">
      <h1>Confirmer le paiement</h1>
      <p class="intro">Sélectionnez le compte Orange Money à utiliser pour cette transaction.</p>
      <div class="payment-summary">
        <div><span class="summary-label">Commande</span><strong class="order-id">${escapeHtml(input.orderId)}</strong></div>
        <strong class="amount">${formatAmount(input.amount)} ${escapeHtml(input.currency)}</strong>
      </div>
      ${content}
    </section>
    <footer>Simulation de paiement pour environnement de développement. Aucun paiement réel ne sera effectué.</footer>
  </main>
</body>
</html>`;
};

export const mockRoutes: FastifyPluginAsync = async (app) => {
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof MockError) {
      return reply.code(error.statusCode).send({ error: "MOCK_ERROR", message: error.message });
    }
    const statusCode = (error as { statusCode?: number }).statusCode ?? 500;
    return reply.code(statusCode).send({ error: "MOCK_ERROR", message: error instanceof Error ? error.message : "Internal error" });
  });

  app.get("/__mock/orange/pay/:payToken", async (request, reply) => {
    const payToken = (request.params as { payToken: string }).payToken;
    const transaction = orangeByPayToken.get(payToken);
    if (!transaction) throw new MockError(404, "Unknown pay_token");

    const accounts = (await listAccounts())
      .filter((account) => account.provider === "ORANGE_MONEY" && account.status === "ACTIVE")
      .map(({ msisdn, balance, currency }) => ({ msisdn, balance, currency }));

    return reply.type("text/html; charset=utf-8").send(checkoutPage({
      payToken,
      orderId: transaction.request.order_id,
      amount: transaction.amount,
      currency: transaction.request.currency,
      status: transaction.status,
      accounts,
    }));
  });

  app.post("/__mock/orange/pay/:payToken/confirm", async (request, reply) => {
    const payToken = (request.params as { payToken: string }).payToken;
    const msisdn = String(((request.body ?? {}) as Record<string, unknown>).msisdn ?? "");
    const transaction = await confirmPayment(payToken, msisdn);
    const isForm = String(request.headers["content-type"] ?? "").includes("application/x-www-form-urlencoded");
    if (isForm) return reply.redirect(transaction.request.return_url, 303);
    return { status: transaction.status, order_id: transaction.request.order_id, msisdn: transaction.accountMsisdn };
  });
};