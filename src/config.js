// All server settings in one place. Values come from environment variables (see .env.example).
const env = (name, fallback = '') => {
  const v = process.env[name] ?? process.env[name.toLowerCase()];
  return v === undefined || v === '' ? fallback : String(v).trim();
};
const flag = (name, fallback) => {
  const v = env(name, '');
  if (!v) return fallback;
  return !/^(0|false|off|no)$/i.test(v);
};

export const VERSION = '5.0.0';

export const config = {
  port: Number(env('PORT', '3000')),
  production: env('NODE_ENV') === 'production',
  appName: env('APP_NAME', 'Inspection AI'),
  publicUrl: env('PUBLIC_URL', ''),

  // Database: PostgreSQL in production (DATABASE_URL). Without it, a local SQLite file is used (development / demo only).
  databaseUrl: env('DATABASE_URL'),
  databaseSsl: env('DATABASE_SSL', 'auto'), // auto | true | false
  sqliteFile: env('SQLITE_FILE', './data/inspection-ai.db'),

  // Security
  sessionSecret: env('SESSION_SECRET'),
  encryptionKey: env('ENCRYPTION_KEY'),
  sessionDays: Math.min(90, Math.max(1, Number(env('SESSION_DAYS', '14')))),
  maxLoginAttempts: Number(env('MAX_LOGIN_ATTEMPTS', '6')),

  // First platform owner (created on first start if no super admin exists)
  superAdminEmail: env('SUPERADMIN_EMAIL'),
  superAdminPassword: env('SUPERADMIN_PASSWORD'),
  superAdminName: env('SUPERADMIN_NAME', 'Platform owner'),

  // Platform-level AI keys (fallback for clients whose plan includes "platform AI")
  env: {
    azure: {
      endpoint: env('AZURE_OPENAI_ENDPOINT'),
      key: env('AZURE_OPENAI_API_KEY'),
      deployment: env('AZURE_OPENAI_DEPLOYMENT', 'gpt-4o'),
      apiVersion: env('AZURE_OPENAI_API_VERSION', '2024-10-21'),
    },
    openai: { key: env('OPENAI_API_KEY'), model: env('OPENAI_MODEL', 'gpt-4o') },
    anthropic: { key: env('ANTHROPIC_API_KEY'), model: env('ANTHROPIC_MODEL', 'claude-sonnet-5-5') },
    gemini: { key: env('GEMINI_API_KEY'), model: env('GEMINI_MODEL', 'gemini-flash-latest') },
  },

  // Demo / local testing: fake AI answers, no key needed. Never switch on for real customers.
  aiMock: flag('AI_MOCK', false),

  // AI defaults (each client can change these in Console > AI models)
  minConfidence: Number(env('MIN_CONFIDENCE', '0.7')),
  strictVerify: flag('STRICT_VERIFY', true),
  aiTimeoutMs: Number(env('AI_TIMEOUT_MS', '90000')),

  maxBodyMb: Number(env('MAX_BODY_MB', '25')),
};
