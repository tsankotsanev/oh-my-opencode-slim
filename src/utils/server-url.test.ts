import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  clientBaseUrl,
  createLaneServerUrlResolver,
  createServerUrlResolver,
  SERVER_URL_ENV,
  serverUrlFromEnv,
  validServerUrl,
} from './server-url';

let originalEnv: string | undefined;

beforeEach(() => {
  originalEnv = process.env[SERVER_URL_ENV];
  delete process.env[SERVER_URL_ENV];
});

afterEach(() => {
  if (originalEnv === undefined) delete process.env[SERVER_URL_ENV];
  else process.env[SERVER_URL_ENV] = originalEnv;
});

describe('validServerUrl', () => {
  test('normalizes http(s) URLs', () => {
    expect(validServerUrl('http://127.0.0.1:4096')).toBe(
      'http://127.0.0.1:4096/',
    );
    expect(validServerUrl(new URL('https://example.test:8443/x'))).toBe(
      'https://example.test:8443/x',
    );
  });

  test('rejects non-http schemes and junk', () => {
    for (const value of [
      'ws://127.0.0.1:4096',
      'file:///tmp/x',
      'not a url',
      '',
      undefined,
      null,
      42,
      {},
    ]) {
      expect(validServerUrl(value)).toBeNull();
    }
  });
});

describe('clientBaseUrl', () => {
  test('digs baseUrl out of the SDK client transport', () => {
    const client = {
      _client: { getConfig: () => ({ baseUrl: 'http://127.0.0.1:5000' }) },
    };
    expect(clientBaseUrl(client)).toBe('http://127.0.0.1:5000/');
  });

  test('never throws for hostile or partial clients', () => {
    const hostile: unknown[] = [
      undefined,
      null,
      {},
      { _client: null },
      { _client: {} },
      { _client: { getConfig: 5 } },
      { _client: { getConfig: () => undefined } },
      { _client: { getConfig: () => ({}) } },
      new Proxy(
        {},
        {
          has: () => true,
          get: () => {
            throw new Error('get');
          },
        },
      ),
      Object.defineProperty({}, '_client', {
        get: () => {
          throw new Error('accessor');
        },
      }),
      {
        _client: {
          getConfig: () =>
            Object.defineProperty({}, 'baseUrl', {
              get: () => {
                throw new Error('baseUrl');
              },
            }),
        },
      },
    ];
    for (const client of hostile) {
      expect(clientBaseUrl(client)).toBeNull();
    }
  });
});

describe('createServerUrlResolver', () => {
  test('prefers ctx.serverUrl and re-reads it on every call', () => {
    let serverUrl: unknown = 'http://127.0.0.1:4096';
    const ctx = {
      get serverUrl() {
        return serverUrl;
      },
      client: { _client: { getConfig: () => ({ baseUrl: 'http://a.test' }) } },
    };
    const resolve = createServerUrlResolver(ctx);
    expect(resolve()).toBe('http://127.0.0.1:4096/');
    serverUrl = undefined;
    expect(resolve()).toBe('http://a.test/');
  });

  test('survives a throwing host getter', () => {
    const ctx = {
      get serverUrl(): unknown {
        throw new Error('not ready');
      },
      client: { _client: { getConfig: () => ({ baseUrl: 'http://b.test' }) } },
    };
    expect(createServerUrlResolver(ctx)()).toBe('http://b.test/');
  });

  test('does NOT consult the environment (multiplexer safety)', () => {
    process.env[SERVER_URL_ENV] = 'http://127.0.0.1:9999';
    expect(createServerUrlResolver({})()).toBeNull();
  });
});

describe('createLaneServerUrlResolver', () => {
  test('falls back to the environment when the context has no URL', () => {
    expect(
      createLaneServerUrlResolver(
        {},
        { [SERVER_URL_ENV]: ' http://127.0.0.1:7777 ' },
      )(),
    ).toBe('http://127.0.0.1:7777/');
  });

  test('context wins over the environment', () => {
    expect(
      createLaneServerUrlResolver(
        { serverUrl: 'http://ctx.test' },
        { [SERVER_URL_ENV]: 'http://env.test' },
      )(),
    ).toBe('http://ctx.test/');
  });

  test('invalid environment values are ignored', () => {
    expect(
      createLaneServerUrlResolver({}, { [SERVER_URL_ENV]: 'nope' })(),
    ).toBeNull();
    expect(serverUrlFromEnv({ [SERVER_URL_ENV]: 'nope' })).toBeNull();
  });
});
