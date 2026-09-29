export function isCallbackUrlAllowed(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }

  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) return false;
  if (process.env.NODE_ENV !== "production") return true;
  if (url.protocol !== "https:") return false;

  const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
  const allowedHosts = (process.env.CALLBACK_ALLOWED_HOSTS ?? "")
    .split(",")
    .map((host) => host.trim().toLowerCase().replace(/\.$/, ""))
    .filter(Boolean);
  return allowedHosts.includes(hostname);
}