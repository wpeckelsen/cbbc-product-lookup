import express from 'express';
import path from 'path';
import {
  search,
  close,
  canonicalizeBrand,
  listWhitelist,
  listCatalog,
  addBrand,
  removeBrand,
  listEvents,
} from './db';

const app = express();
const port = parseInt(process.env.PORT || '3000', 10);

// --- HTTP Basic Auth (multi-user) ---
// AUTH_USERS is a comma-separated list of "user:password" pairs. If unset, fall
// back to the legacy single AUTH_USER/AUTH_PASS pair. The authenticated username
// is stored in res.locals.user and used as the `actor` in the audit log.
const AUTH_USERS_RAW = process.env.AUTH_USERS || '';
const AUTH_USER = process.env.AUTH_USER || '';
const AUTH_PASS = process.env.AUTH_PASS || '';

function buildUsers(): Map<string, string> {
  const users = new Map<string, string>();
  if (AUTH_USERS_RAW !== '') {
    for (const entry of AUTH_USERS_RAW.split(',')) {
      const sep = entry.indexOf(':');
      if (sep === -1) continue;
      const user = entry.slice(0, sep);
      const pass = entry.slice(sep + 1);
      if (user !== '') users.set(user, pass);
    }
  }
  if (users.size === 0 && AUTH_USER !== '' && AUTH_PASS !== '') {
    users.set(AUTH_USER, AUTH_PASS);
  }
  return users;
}

const users = buildUsers();
const authEnabled = users.size > 0;

function sendChallenge(res: express.Response): void {
  res.setHeader('WWW-Authenticate', 'Basic realm="Product Lookup"');
  res.status(401).send('Authentication required');
}

app.use((req, res, next) => {
  // Keep the health check open (it reveals nothing).
  if (req.path === '/api/health') return next();

  if (!authEnabled) return next();

  const header = req.headers.authorization || '';
  const match = /^Basic (.+)$/.exec(header);
  if (!match) return sendChallenge(res);

  const decoded = Buffer.from(match[1], 'base64').toString('utf-8');
  const sep = decoded.indexOf(':');
  const user = sep === -1 ? decoded : decoded.slice(0, sep);
  const pass = sep === -1 ? '' : decoded.slice(sep + 1);

  if (users.has(user) && users.get(user) === pass) {
    res.locals.user = user;
    return next();
  }
  return sendChallenge(res);
});

app.use(express.json());

// Static front-end
app.use(express.static(path.join(__dirname, '..', 'public')));

app.get('/api/health', (_req, res) => {
  res.json({ ok: true });
});

app.get('/api/search', async (req, res) => {
  const q = typeof req.query.q === 'string' ? req.query.q : '';
  try {
    const results = await search(q);
    res.json({ query: q, results });
  } catch (error) {
    console.error('search failed', error);
    res.status(500).json({ error: 'Search failed' });
  }
});

// --- Brand whitelist management ---

app.get('/brands/whitelist', async (_req, res) => {
  try {
    res.json(await listWhitelist());
  } catch (error) {
    console.error('list whitelist failed', error);
    res.status(500).json({ error: 'Failed to list whitelisted brands' });
  }
});

app.get('/brands/catalog', async (_req, res) => {
  try {
    res.json(await listCatalog());
  } catch (error) {
    console.error('list catalog failed', error);
    res.status(500).json({ error: 'Failed to list brands' });
  }
});

app.post('/brands/whitelist', async (req, res) => {
  const input = typeof req.body?.brand_key === 'string' ? req.body.brand_key : '';
  if (canonicalizeBrand(input) === '') {
    return res.status(400).json({ error: 'brand_key is required' });
  }
  const actor = res.locals.user || '';
  try {
    const row = await addBrand(input, actor);
    res.json(row);
  } catch (error) {
    console.error('add brand failed', error);
    res.status(500).json({ error: 'Failed to add brand' });
  }
});

app.delete('/brands/whitelist/:brand_key', async (req, res) => {
  // Express URL-decodes the path param for us.
  const actor = res.locals.user || '';
  try {
    const removed = await removeBrand(req.params.brand_key, actor);
    if (removed === null) {
      return res.status(404).json({ error: 'Brand not whitelisted' });
    }
    res.status(204).end();
  } catch (error) {
    console.error('remove brand failed', error);
    res.status(500).json({ error: 'Failed to remove brand' });
  }
});

app.get('/brands/events', async (req, res) => {
  const brandKey =
    typeof req.query.brand_key === 'string' ? req.query.brand_key : undefined;
  const limit = toInt(req.query.limit, 100);
  const offset = toInt(req.query.offset, 0);
  try {
    res.json(await listEvents({ brandKey, limit, offset }));
  } catch (error) {
    console.error('list events failed', error);
    res.status(500).json({ error: 'Failed to list history' });
  }
});

function toInt(value: unknown, fallback: number): number {
  const n = typeof value === 'string' ? parseInt(value, 10) : NaN;
  return Number.isNaN(n) || n < 0 ? fallback : n;
}

const server = app.listen(port, () => {
  console.log(`Product lookup UI listening on http://localhost:${port}`);
});

async function shutdown(): Promise<void> {
  await close();
  server.close(() => process.exit(0));
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
