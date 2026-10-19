import { describe, it, expect } from 'vitest';
import { validateLongUrl } from '../src/utils/urlSafety.js';
import { createLinkSchema } from '../src/utils/validators.js';

const accepted = (input, options) => {
  const result = validateLongUrl(input, options);
  expect(result.ok, `${input} should be accepted`).toBe(true);
  return result.url;
};

const rejected = (input, options) => {
  const result = validateLongUrl(input, options);
  expect(result.ok, `${input} should be rejected`).toBe(false);
  return result.message;
};

describe('accepted URLs', () => {
  it('accepts ordinary http and https URLs', () => {
    accepted('https://example.com/path?q=1#frag');
    accepted('http://example.com');
    accepted('https://sub.example.co.uk:8443/a/b');
  });

  it('accepts public IP addresses', () => {
    accepted('https://1.1.1.1/');
    accepted('https://[2606:4700:4700::1111]/');
  });

  it('accepts addresses just outside the private ranges', () => {
    accepted('http://11.0.0.1');
    accepted('http://172.15.255.255');
    accepted('http://172.32.0.1');
    accepted('http://100.63.255.255');
    accepted('http://192.169.0.1');
  });

  it('returns the normalised form, trimmed and with a lowercase host', () => {
    expect(accepted('  HTTPS://EXAMPLE.com/Path  ')).toBe('https://example.com/Path');
    expect(accepted('https://example.com')).toBe('https://example.com/');
  });

  it('converts international names to punycode', () => {
    expect(accepted('https://münchen.de/')).toBe('https://xn--mnchen-3ya.de/');
  });
});

describe('rejected schemes and shapes', () => {
  it('rejects anything that is not http or https', () => {
    rejected('javascript:alert(1)');
    rejected('data:text/html,<script>alert(1)</script>');
    rejected('file:///etc/passwd');
    rejected('ftp://example.com/file');
  });

  it('rejects text that is not a full URL', () => {
    rejected('');
    rejected('   ');
    rejected('example.com');
    rejected('//example.com');
  });

  it('rejects spaces and control characters', () => {
    rejected('https://exa mple.com');
    rejected('https://example.com/\nfoo');
    rejected('https://example.com/\tfoo');
  });

  it('rejects credentials in the URL', () => {
    rejected('https://user:pass@example.com');
    rejected('https://paypal.com@evil.com');
  });

  it('rejects URLs that are too long, before and after normalising', () => {
    rejected(`https://example.com/${'a'.repeat(2100)}`);
  });
});

describe('rejected internal addresses', () => {
  it('rejects localhost and internal names', () => {
    rejected('http://localhost');
    rejected('http://localhost:3000/admin');
    rejected('http://localhost./');
    rejected('http://printer.local');
    rejected('http://service.internal');
    rejected('http://EXAMPLE.internal./');
    rejected('http://router.home.arpa');
    rejected('http://intranet');
  });

  it('rejects private, loopback and reserved IPv4 addresses', () => {
    for (const host of [
      '127.0.0.1',
      '10.0.0.1',
      '172.16.0.1',
      '172.31.255.255',
      '192.168.1.1',
      '169.254.169.254',
      '100.64.0.1',
      '0.0.0.0',
      '224.0.0.1',
      '255.255.255.255',
    ]) {
      rejected(`http://${host}/`);
    }
  });

  it('rejects disguised IPv4 addresses, because the URL parser normalises them first', () => {
    rejected('http://2130706433'); // decimal
    rejected('http://0x7f000001'); // hexadecimal
    rejected('http://0177.0.0.1'); // octal
    rejected('http://127.1'); // shortened
  });

  it('rejects private and special IPv6 addresses', () => {
    for (const host of [
      '[::1]',
      '[::]',
      '[fe80::1]',
      '[fc00::1]',
      '[fd12:3456::1]',
      '[::ffff:127.0.0.1]',
      '[::ffff:a00:1]',
      '[64:ff9b::7f00:1]',
      '[2001:db8::1]',
      '[2002:7f00:1::]',
    ]) {
      rejected(`http://${host}/`);
    }
  });

  it('gives one clear message for all of them', () => {
    expect(rejected('http://127.0.0.1')).toBe('Links to private or internal addresses are not allowed');
    expect(rejected('http://printer.local')).toBe('Links to private or internal addresses are not allowed');
  });
});

describe('Kuturl links', () => {
  it('refuses to shorten its own links, but not other sites', () => {
    const options = { ownHost: 'kuturl.example.org' };
    rejected('https://kuturl.example.org/abc1234', options);
    accepted('https://other.example.org/abc1234', options);
  });
});

describe('create link schema', () => {
  const hour = 60 * 60 * 1000;
  const parse = (body) => createLinkSchema.safeParse(body);

  it('accepts a URL on its own, and normalises it', () => {
    const result = parse({ url: 'https://example.com' });
    expect(result.success).toBe(true);
    expect(result.data.url).toBe('https://example.com/');
    expect(result.data.expiresAt).toBeUndefined();
  });

  it('accepts an expiry in the future and turns it into a Date', () => {
    const result = parse({
      url: 'https://example.com',
      expiresAt: new Date(Date.now() + hour).toISOString(),
    });
    expect(result.success).toBe(true);
    expect(result.data.expiresAt).toBeInstanceOf(Date);
  });

  it('rejects an expiry in the past, too far ahead, or badly formatted', () => {
    const past = parse({ url: 'https://example.com', expiresAt: new Date(Date.now() - hour).toISOString() });
    expect(past.success).toBe(false);

    const far = parse({
      url: 'https://example.com',
      expiresAt: new Date(Date.now() + 11 * 365 * 24 * hour).toISOString(),
    });
    expect(far.success).toBe(false);

    expect(parse({ url: 'https://example.com', expiresAt: 'tomorrow' }).success).toBe(false);
    expect(parse({ url: 'https://example.com', expiresAt: 12345 }).success).toBe(false);
  });

  it('rejects a missing or non-string URL', () => {
    expect(parse({}).success).toBe(false);
    expect(parse({ url: 123 }).success).toBe(false);
    expect(parse({ url: null }).success).toBe(false);
  });

  it('reports why a URL was rejected', () => {
    const result = parse({ url: 'http://127.0.0.1' });
    expect(result.success).toBe(false);
    expect(result.error.issues[0].message).toBe('Links to private or internal addresses are not allowed');
  });

  it('rejects fields it does not know, such as a misspelled expiry', () => {
    expect(parse({ url: 'https://example.com', expires_at: '2030-01-01T00:00:00Z' }).success).toBe(false);
  });
});