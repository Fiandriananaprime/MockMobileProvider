export type ProviderType = "MVOLA" | "ORANGE_MONEY";

export interface RuntimeConfig {
  databaseUrl: string;
  userAuthSecret: string;
  maxBalance: number;
  msisdnPrefixes: Record<ProviderType, string[]>;
  userFrontendOrigins: string[];
  adminFrontendOrigins: string[];
}

const parseOrigins = (name: string, rawValue: string | undefined, isProduction: boolean, developmentDefault: string): string[] => {
  if (!rawValue?.trim()) {
    if (isProduction) throw new Error(`${name} must be configured in production`);
    return [developmentDefault];
  }

  const rawOrigins = rawValue.split(",").map((origin) => origin.trim());
  if (rawOrigins.some((origin) => !origin)) throw new Error(`${name} cannot contain an empty origin`);

  return rawOrigins.map((origin) => {
    if (origin === "*") throw new Error(`${name} cannot contain '*'`);
    try {
      const url = new URL(origin);
      if (!["http:", "https:"].includes(url.protocol) || !url.hostname || url.username || url.password ||
          url.pathname !== "/" || url.search || url.hash) {
        throw new Error("Invalid origin");
      }
      return url.origin;
    } catch {
      throw new Error(`Invalid ${name} entry: ${origin}`);
    }
  });
};

const parsePrefixes = (name: string, rawValue: string | undefined, defaults: string[]): string[] => {
  const prefixes = rawValue === undefined ? defaults : rawValue.split(",").map((prefix) => prefix.trim());
  if (prefixes.length === 0 || prefixes.some((prefix) => !/^\d{3}$/.test(prefix))) {
    throw new Error(`${name} must contain comma-separated three-digit prefixes`);
  }
  return [...new Set(prefixes)];
};

export function loadRuntimeConfig(env: NodeJS.ProcessEnv = process.env): RuntimeConfig {
  const databaseUrl = env.DATABASE_URL?.trim() ?? "";
  if (!databaseUrl) throw new Error("DATABASE_URL must be configured");
  try {
    const parsed = new URL(databaseUrl);
    if (!["postgres:", "postgresql:"].includes(parsed.protocol)) throw new Error("Invalid protocol");
  } catch {
    throw new Error("DATABASE_URL must be a valid PostgreSQL connection URL");
  }

  const userAuthSecret = env.USER_AUTH_SECRET ?? "";
  if (Buffer.byteLength(userAuthSecret, "utf8") < 32) {
    throw new Error("USER_AUTH_SECRET must contain at least 32 bytes");
  }

  const maxBalance = Number(env.MAX_BALANCE ?? 10_000_000);
  if (!Number.isFinite(maxBalance) || maxBalance <= 0 || maxBalance > Number.MAX_SAFE_INTEGER) {
    throw new Error("MAX_BALANCE must be a positive safe number");
  }

  const isProduction = env.NODE_ENV === "production";
  return {
    databaseUrl,
    userAuthSecret,
    maxBalance,
    msisdnPrefixes: {
      MVOLA: parsePrefixes("MVOLA_MSISDN_PREFIXES", env.MVOLA_MSISDN_PREFIXES, ["034", "038"]),
      ORANGE_MONEY: parsePrefixes("ORANGE_MONEY_MSISDN_PREFIXES", env.ORANGE_MONEY_MSISDN_PREFIXES, ["032", "037"]),
    },
    userFrontendOrigins: parseOrigins("USER_FRONTEND_ORIGINS", env.USER_FRONTEND_ORIGINS, isProduction, "http://localhost:5175"),
    adminFrontendOrigins: parseOrigins("ADMIN_FRONTEND_ORIGINS", env.ADMIN_FRONTEND_ORIGINS, isProduction, "http://localhost:5176"),
  };
}