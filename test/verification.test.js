import assert from "node:assert/strict";
import { test } from "node:test";
import {
  listNotifications,
  sendVerification,
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
