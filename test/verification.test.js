import assert from "node:assert/strict";
import { test } from "node:test";
import {
  listNotifications,
  sendVerification,
  subscribeToNotifications,
  verifyVerification,
} from "../dist/mock/verification.store.js";

test("phone verification creates a notification without exposing the code in send response", () => {
  const phoneNumber = "+261341234567";
  const response = sendVerification(phoneNumber);
  assert.equal(typeof response.expiresAt, "string");
  assert.equal("otp" in response, false);

  const [notification] = listNotifications(phoneNumber);
  assert.equal(notification.type, "PHONE_VERIFICATION");
  assert.match(notification.otp, /^\d{6}$/);
  assert.equal(verifyVerification(phoneNumber, notification.otp), true);
  assert.equal(verifyVerification(phoneNumber, notification.otp), false);
});

test("a new phone verification invalidates the previous code", () => {
  const phoneNumber = "+261341234568";
  sendVerification(phoneNumber);
  const first = listNotifications(phoneNumber)[0].otp;
  sendVerification(phoneNumber);
  const second = listNotifications(phoneNumber)[0].otp;

  assert.notEqual(first, second);
  assert.equal(verifyVerification(phoneNumber, first), false);
  assert.equal(verifyVerification(phoneNumber, second), true);
});

test("phone verification is pushed to connected WebSocket subscribers", () => {
  const phoneNumber = "+261341234569";
  const messages = [];
  const socket = { readyState: 1, send: (payload) => messages.push(JSON.parse(payload)) };
  const unsubscribe = subscribeToNotifications(phoneNumber, socket);

  sendVerification(phoneNumber);
  unsubscribe();

  assert.equal(messages.length, 1);
  assert.equal(messages[0].phoneNumber, phoneNumber);
  assert.equal(messages[0].type, "PHONE_VERIFICATION");
});
