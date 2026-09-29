import { timingSafeEqual } from "node:crypto";

export function parseAuthorizationHeader(value: string | undefined, scheme: "Basic" | "Bearer"): string {
  const header = String(value ?? "").trim();
  const match = new RegExp(`^${scheme}\\s+(.+)$`, "i").exec(header);
  return match ? match[1].trim() : "";
}

export function constantTimeEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}