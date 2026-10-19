import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import pool, { query, closePool } from '../src/config/db.js';
import { withTransaction } from '../src/db/transaction.js';
import { createApiKey, findActiveApiKeyByHash } from '../src/db/apiKeys.js';
import { reserveLinkId, insertLink, findLinkByCode } from '../src/db/links.js';
import { CodeTakenError } from '../src/db/errors.js';

const stamp = Date.now().toString(36);
const sha = (value) => createHash('sha256').update(value).digest('hex');
const hashes = []; // everything created here is removed in afterAll

const makeKey = async (name = 'db test key') => {
  const keyHash = sha(randomBytes(16).toString('hex'));
  hashes.push(keyHash);
  const key = await createApiKey({ name, keyPrefix: 'kt_test', keyHash });
  return { key, keyHash };
};

const makeLink = async (apiKeyId, code, longUrl = 'https://example.com/page') =>
  insertLink({ id: await reserveLinkId(), code, longUrl, apiKeyId });

let owner;

beforeAll(async () => {
  ({ key: owner } = await makeKey('owner'));
});

afterAll(async () => {
  // Links go with their key (ON DELETE CASCADE)
  await query('DELETE FROM api_keys WHERE key_hash = ANY($1)', [hashes]);
  await closePool();
});

describe('migrations', () => {
  it('created the expected tables', async () => {
    const { rows } = await query(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name IN ('api_keys', 'links', 'pgmigrations')`
    );
    expect(rows.map((row) => row.table_name).sort()).toEqual(['api_keys', 'links', 'pgmigrations']);
  });
});

describe('api keys', () => {
  it('stores a key and finds it by its hash', async () => {
    const { key, keyHash } = await makeKey('lookup');
    expect(key.name).toBe('lookup');
    expect(key.keyPrefix).toBe('kt_test');

    const found = await findActiveApiKeyByHash(keyHash);
    expect(found.id).toBe(key.id);
  });

  it('never exposes the hash in what it returns', async () => {
    const { key } = await makeKey();
    expect(Object.keys(key).sort()).toEqual(['createdAt', 'id', 'keyPrefix', 'name', 'revokedAt']);
  });

  it('does not find a key that does not exist', async () => {
    expect(await findActiveApiKeyByHash(sha('no such key'))).toBeUndefined();
  });

  it('stops finding a key once it is revoked', async () => {
    const { key, keyHash } = await makeKey('to revoke');
    await query('UPDATE api_keys SET revoked_at = now() WHERE id = $1', [key.id]);
    expect(await findActiveApiKeyByHash(keyHash)).toBeUndefined();
  });

  it('refuses a second key with the same hash', async () => {
    const { keyHash } = await makeKey();
    await expect(createApiKey({ name: 'copy', keyPrefix: 'kt_test', keyHash })).rejects.toMatchObject({
      code: '23505',
    });
  });
});

describe('links', () => {
  it('inserts a link and finds it by code', async () => {
    const link = await makeLink(owner.id, `a-${stamp}`);

    expect(link.code).toBe(`a-${stamp}`);
    expect(link.longUrl).toBe('https://example.com/page');
    expect(link.isCustom).toBe(false);
    expect(link.expiresAt).toBeNull();

    const found = await findLinkByCode(`a-${stamp}`);
    expect(found.id).toBe(link.id);
  });

  it('keeps ids as strings, so large values never lose precision', async () => {
    const link = await makeLink(owner.id, `b-${stamp}`);
    expect(typeof link.id).toBe('string');
    expect(typeof link.apiKeyId).toBe('string');
  });

  it('returns nothing for an unknown code', async () => {
    expect(await findLinkByCode(`missing-${stamp}`)).toBeUndefined();
  });

  it('treats codes as case sensitive', async () => {
    await makeLink(owner.id, `Case${stamp}`);
    expect(await findLinkByCode(`Case${stamp}`)).toBeDefined();
    expect(await findLinkByCode(`case${stamp}`)).toBeUndefined();
  });

  it('reports a taken code as CodeTakenError', async () => {
    await makeLink(owner.id, `dup-${stamp}`);
    await expect(makeLink(owner.id, `dup-${stamp}`)).rejects.toBeInstanceOf(CodeTakenError);
  });

  it('lets exactly one of several simultaneous inserts claim a code', async () => {
    const attempts = await Promise.allSettled(
      Array.from({ length: 6 }, async () => makeLink(owner.id, `race-${stamp}`))
    );

    expect(attempts.filter((a) => a.status === 'fulfilled')).toHaveLength(1);
    const failures = attempts.filter((a) => a.status === 'rejected');
    expect(failures).toHaveLength(5);
    failures.forEach((f) => expect(f.reason).toBeInstanceOf(CodeTakenError));
  });

  it('hands out unique ids to simultaneous requests', async () => {
    const ids = await Promise.all(Array.from({ length: 50 }, () => reserveLinkId()));
    expect(new Set(ids).size).toBe(50);
  });

  it('refuses a link for an owner that does not exist, without calling it a taken code', async () => {
    const error = await makeLink('999999999999', `orphan-${stamp}`).catch((e) => e);
    expect(error).not.toBeInstanceOf(CodeTakenError);
    expect(error.code).toBe('23503'); // foreign key violation
  });

  it('enforces the code format and the URL length in the database itself', async () => {
    const badCode = await makeLink(owner.id, 'has spaces!').catch((e) => e);
    expect(badCode.code).toBe('23514'); // check violation

    const longUrl = await makeLink(owner.id, `long-${stamp}`, `https://example.com/${'x'.repeat(2100)}`).catch(
      (e) => e
    );
    expect(longUrl.code).toBe('23514');
  });

  it('removes a key\'s links when the key is deleted', async () => {
    const { key } = await makeKey('cascade');
    await makeLink(key.id, `cascade-${stamp}`);

    await query('DELETE FROM api_keys WHERE id = $1', [key.id]);
    expect(await findLinkByCode(`cascade-${stamp}`)).toBeUndefined();
  });
});

describe('transactions', () => {
  it('commits everything when the function succeeds', async () => {
    const keyHash = sha(`commit-${stamp}`);
    hashes.push(keyHash);

    await withTransaction(async (client) => {
      const key = await createApiKey({ name: 'tx ok', keyPrefix: 'kt_test', keyHash }, client);
      await insertLink(
        { id: await reserveLinkId(client), code: `tx-ok-${stamp}`, longUrl: 'https://example.com', apiKeyId: key.id },
        client
      );
    });

    expect(await findActiveApiKeyByHash(keyHash)).toBeDefined();
    expect(await findLinkByCode(`tx-ok-${stamp}`)).toBeDefined();
  });

  it('rolls everything back when the function throws', async () => {
    const keyHash = sha(`rollback-${stamp}`);
    hashes.push(keyHash);

    await expect(
      withTransaction(async (client) => {
        await createApiKey({ name: 'tx fail', keyPrefix: 'kt_test', keyHash }, client);
        throw new Error('something went wrong halfway');
      })
    ).rejects.toThrow('something went wrong halfway');

    expect(await findActiveApiKeyByHash(keyHash)).toBeUndefined();
  });

  it('returns its connection to the pool, even after a failure', async () => {
    await withTransaction(async () => {}).catch(() => {});
    await withTransaction(async () => {
      throw new Error('boom');
    }).catch(() => {});

    expect(pool.totalCount - pool.idleCount).toBe(0); // nothing is still checked out
  });
});