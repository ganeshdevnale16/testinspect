// Vercel entry: every /api/* request is rewritten here (see vercel.json).
// Vercel needs DATABASE_URL (PostgreSQL) - its file system is read-only, so SQLite cannot be used there.
import { handle, ready } from '../src/app.js';

export const config = { api: { bodyParser: false } };
export default async function handler(req, res) {
  await ready();
  return handle(req, res);
}
