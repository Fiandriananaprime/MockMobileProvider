import { randomInt, randomUUID } from "node:crypto";

const OTP_TTL_MS = 5 * 60 * 1000;
const MAX_NOTIFICATIONS_PER_PHONE = 20;

export interface VerificationNotification {
  id: string;
  type: "PHONE_VERIFICATION";
  phoneNumber: string;
  message: string;
  otp: string;
  createdAt: string;
  expiresAt: string;
}

interface PendingVerification {
  phoneNumber: string;
  code: string;
  expiresAt: number;
  consumed: boolean;
}

const pendingByPhone = new Map<string, PendingVerification>();
const notificationsByPhone = new Map<string, VerificationNotification[]>();

export function normalizePhoneNumber(value: unknown): string {
  if (typeof value !== "string" || !/^\+[1-9]\d{7,14}$/.test(value)) {
    throw new Error("phoneNumber must be a valid international phone number");
  }
  return value;
}

export function sendVerification(phoneNumber: string): { expiresAt: string } {
  const now = Date.now();
  const expiresAt = now + OTP_TTL_MS;
  const code = randomInt(100000, 1000000).toString();

  pendingByPhone.set(phoneNumber, { phoneNumber, code, expiresAt, consumed: false });

  const notification: VerificationNotification = {
    id: randomUUID(),
    type: "PHONE_VERIFICATION",
    phoneNumber,
    message: `Votre code de verification est ${code}. Il expire dans 5 minutes.`,
    otp: code,
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(expiresAt).toISOString(),
  };
  const notifications = notificationsByPhone.get(phoneNumber) ?? [];
  notifications.unshift(notification);
  notificationsByPhone.set(phoneNumber, notifications.slice(0, MAX_NOTIFICATIONS_PER_PHONE));

  return { expiresAt: notification.expiresAt };
}

export function verifyVerification(phoneNumber: string, code: string): boolean {
  const pending = pendingByPhone.get(phoneNumber);
  if (!pending || pending.consumed || pending.expiresAt <= Date.now() || pending.code !== code) {
    return false;
  }
  pending.consumed = true;
  return true;
}

export function listNotifications(phoneNumber: string): VerificationNotification[] {
  return notificationsByPhone.get(phoneNumber) ?? [];
}
