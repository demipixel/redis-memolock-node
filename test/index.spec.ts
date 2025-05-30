import Redis from 'ioredis';

import MemolockCache from '../src';
import { sleep } from './test-util';

describe('Redis Cache', () => {
  let service: MemolockCache;

  beforeEach(async () => {
    service = new MemolockCache();
  });

  afterEach(async () => {
    service
      .disconnect()
      .catch((err) => console.error('Error service disconnecting', err));

    // Make sure we've unsubscribed from all channels
    const keys = uncheckedKeys;
    uncheckedKeys = [];
    for (const key of keys) {
      expect(service['redisUtil']['subInfo'][key + '_done']).toBeUndefined();
    }
  });

  let keyId = 0;
  const getKey = () => {
    const key = 'test:key_' + keyId++;
    count[key] = 0;
    uncheckedKeys.push(key);
    return key;
  };
  let uncheckedKeys: string[] = [];
  const count: { [key: string]: number } = {};
  const simpleFetch = (key: string) => () => count[key]++;

  const DEFAULT_OPT = {
    ttlMs: 5000,
    lockTimeout: 250,
    getKey: (key: string) => key,
  };

  describe('Get', () => {
    it('should get cached value', async () => {
      const key = getKey();
      const cache = service.new(DEFAULT_OPT, simpleFetch(key));
      const first = await cache.get(key);
      const second = await cache.get(key);

      expect(first).toBe(0);
      expect(second).toBe(0);
    });

    it('should refetch after ttl', async () => {
      const key = getKey();
      const cache = service.new(
        { ttlMs: 100, getKey: (key: string) => key },
        simpleFetch(key),
      );
      const first = await cache.get(key);
      await sleep(150);
      const second = await cache.get(key);

      expect(first).toBe(0);
      expect(second).toBe(1);
    });

    it('should only get one value when fetched async', async () => {
      const key = getKey();
      const cache = service.new(DEFAULT_OPT, simpleFetch(key));
      const values = await Promise.all(
        [...Array(20)].map(async () => cache.get(key)),
      );

      expect(values).toEqual([...Array(20)].map(() => 0));
    });

    it('should get two separate values for different keys', async () => {
      const key = getKey();
      const first = await service.get(key, DEFAULT_OPT, simpleFetch(key));
      const second = await service.get(getKey(), DEFAULT_OPT, simpleFetch(key));

      expect(first).toBe(0);
      expect(second).toBe(1);
    });

    it('should retry if initial fetch fails', async () => {
      const key = getKey();
      const failFirstFetch = async () => {
        count[key]++;
        if (count[key] === 1) {
          throw new Error('fail first fetch');
        }
        return count[key] - 1;
      };

      // No lock timeout defined, will use default of 1000
      const cache = service.new(
        { ttlMs: 5000, getKey: (key: string) => key },
        failFirstFetch,
      );

      const start = Date.now();
      const firstProm = cache.get(key);
      const secondProm = cache.get(key);

      await expect(firstProm).rejects.toThrow('fail first fetch');
      await expect(secondProm).resolves.toBe(1);
      expect(Date.now() - start).toBeGreaterThan(1000);
      expect(Date.now() - start).toBeLessThan(2000);
    });

    it('should fail if fetch always fails', async () => {
      const key = getKey();
      const alwaysFailFetch = async () => {
        throw new Error('always fail fetch');
      };

      const cache = service.new(DEFAULT_OPT, alwaysFailFetch);
      const firstProm = cache.get(key);
      const secondProm = cache.get(key);

      await expect(firstProm).rejects.toThrow('always fail fetch');
      await expect(secondProm).rejects.toThrow('always fail fetch');
    });

    it('should succeed with long fetch', async () => {
      const key = getKey();
      const longFetch = async () => {
        await sleep(100);
        return count[key]++;
      };

      const cache = service.new(DEFAULT_OPT, longFetch);
      const first = await cache.get(key);
      const second = await cache.get(key);

      expect(first).toBe(0);
      expect(second).toBe(0);
    });

    it('should refetch value if forceReresh is true', async () => {
      const key = getKey();
      const cache = service.new(DEFAULT_OPT, simpleFetch(key));
      const first = await cache.get(key);
      const second = await cache.get(key, { forceRefresh: true });

      expect(first).toBe(0);
      expect(second).toBe(1);
    });

    it('should handle lots of concurrent requests', async () => {
      const key = getKey();
      const failEveryOther = async () => {
        count[key]++;
        if (count[key] % 2 === 0) {
          throw new Error('fail randomly');
        }
        return count[key] - 1;
      };

      const cache = service.new(
        { ttlMs: 70, lockTimeout: 20, getKey: (key: string) => key },
        failEveryOther,
      );

      const promises = [...Array(250 * 3)].map(
        async (_, i) =>
          new Promise<string>((res) => {
            setTimeout(
              () =>
                cache
                  .get(key)
                  .then((num) => res(num.toString()))
                  .catch(() => res('error')),
              Math.floor(i / 3),
            );
          }),
      );

      const values = await Promise.all(promises);

      // map from value to count
      const grouped = values.reduce((acc, val) => {
        if (!acc[val]) {
          acc[val] = 0;
        }
        acc[val]++;
        return acc;
      }, {} as { [key: string]: number });

      expect(grouped.error).toBeGreaterThanOrEqual(1);
      expect(grouped['0']).toBeGreaterThan(150);
      expect(grouped['2']).toBeGreaterThan(150);
    });

    it('should throw error if max attempts reached', async () => {
      const key = getKey();
      const cache = service.new(
        {
          ttlMs: 70,
          lockTimeout: 50,
          maxAttempts: 1,
          getKey: (key: string) => key,
        },
        async () => {
          // Don't resolve until after tests complete.
          return new Promise((res) => {
            setTimeout(() => res(count[key]++), 300);
          });
        },
      );

      cache.get(key);
      await expect(cache.get(key)).rejects.toThrow(
        'Never received message that key was unlocked.',
      );
    });

    it('should still function if lockTimeout is too short', async () => {
      const key = getKey();
      const slowFetch = async () => {
        await sleep(120);
        return count[key]++;
      };

      const cache = service.new({ ...DEFAULT_OPT, lockTimeout: 50 }, slowFetch);

      const first = cache.get(key);
      const second = cache.get(key);

      await expect(first).resolves.toBe(0);
      await expect(second).resolves.toBe(1);
    });

    it('should support custom encode/decode', async () => {
      const key = getKey();
      const cache = service.new(
        {
          ttlMs: 1500,
          lockTimeout: 200,
          getKey: (key: string) => key,
          encode: (value: { func: () => number }) => value.func().toString(),
          decode: (value: string) => ({ func: () => parseInt(value, 10) }),
        },
        // Tests encode/decode because JSON.stringify() of this
        // would result in '{}'
        async () => {
          await sleep(50);
          return {
            func: () => 3,
          };
        },
      );

      const firstProm = cache.get(key);
      const secondProm = cache.get(key);

      // First will be original
      // Second will be decoded from published message
      await expect(firstProm).resolves.toHaveProperty('func');
      await expect(secondProm).resolves.toHaveProperty('func');
      expect((await secondProm).func()).toBe(3);
      // This one will be decoded from cache
      expect(await cache.get(key)).toHaveProperty('func');
      expect((await cache.get(key)).func()).toBe(3);
    });

    it('should allow cutom redis to be passed in', async () => {
      const key = getKey();
      await service.disconnect();

      service = new MemolockCache({
        redisClient: new Redis(),
        redisSubClient: new Redis(),
      });
      const cache = service.new(
        {
          ttlMs: 1500,
          getKey: (key: string) => key,
        },
        simpleFetch(key),
      );

      const firstProm = cache.get(key);
      const secondProm = cache.get(key);

      // First will be original
      // Second will be decoded from published message
      await expect(firstProm).resolves.toBe(0);
      await expect(secondProm).resolves.toBe(0);
      // This one will be decoded from cache
      expect(await cache.get(key)).toBe(0);
    });

    it('should release lock on fail', async () => {
      const key = getKey();
      const cache = service.new(
        {
          ttlMs: 0,
          lockTimeout: 1000,
          getKey: (key: string) => key,
        },
        () => {
          if (count[key]++ === 0) {
            throw new Error('fail');
          }
          return count[key] - 1;
        },
      );

      await expect(cache.get(key)).rejects.toThrow('fail');
      const start = Date.now();
      const val = await cache.get(key);
      // Should be fast. If it starts to take a long time, it means
      // the lock was not released.
      expect(Date.now() - start).toBeLessThan(100);
      // If 0, got from cache instead of fetch
      expect(val).toBe(1);
    });

    it('should release lock on success', async () => {
      const key = getKey();
      const cache = service.new(
        {
          ttlMs: 0,
          lockTimeout: 1000,
          getKey: (key: string) => key,
        },
        simpleFetch(key),
      );

      await cache.get(key);
      const start = Date.now();
      const val = await cache.get(key);
      // Should be fast. If it starts to take a long time, it means
      // the lock was not released.
      expect(Date.now() - start).toBeLessThan(100);
      // TTL is 0 so it should fetch again
      expect(val).toBe(1);
    });

    it('should not error if cannot delete lock when failing', async () => {
      await service.disconnect();
      const errorHandler = jest.fn();
      service = new MemolockCache({ errorHandler });

      const key = getKey();
      const cache = service.new({ ...DEFAULT_OPT }, async () => {
        await sleep(100);
        throw new Error('fail from fetch');
      });

      const prom = cache.get(key);
      await sleep(20);
      // disconnect redis
      await service.disconnect();

      // Should not be redis error!
      await expect(prom).rejects.toThrow('fail from fetch');
      expect(errorHandler).toHaveBeenCalled();
    });

    it('should support argument into fetch of new', async () => {
      const cache = service.new({ ...DEFAULT_OPT }, (id: string) => {
        return id;
      });

      const first = await cache.get('asdf');
      expect(first).toBe('asdf');
    });

    it('should support function for ttlMs', async () => {
      const key = getKey();
      const cache = service.new(
        { ...DEFAULT_OPT, ttlMs: (val) => (val >= 1 ? 1000 : 0) },
        simpleFetch(key),
      );

      const first = await cache.get(key);
      expect(first).toBe(0);

      await sleep(100);
      const second = await cache.get(key);
      expect(second).toBe(1); // Should have had 0 ttlMs

      await sleep(100);
      const third = await cache.get(key);
      expect(third).toBe(1); // Should have had 1000 ttlMs
    });

    describe('cacheIf', () => {
      it('should follow condition to decide if should cache', async () => {
        const key = getKey();
        const cache = service.new(
          { ...DEFAULT_OPT, cacheIf: (val) => val >= 1 },
          simpleFetch(key),
        );

        const start = Date.now();

        const first = await cache.get(key);
        expect(first).toBe(0);
        const second = await cache.get(key);
        expect(second).toBe(1);
        const third = await cache.get(key);
        expect(third).toBe(1);

        // No timeouts
        expect(Date.now() - start).toBeLessThan(200);
      });

      it("should publish value even if it doesn't cache", async () => {
        const key = getKey();
        const cache = service.new(
          { ...DEFAULT_OPT, cacheIf: (val) => val >= 1 },
          simpleFetch(key),
        );

        const start = Date.now();
        const [first, second] = await Promise.all([
          cache.get(key),
          cache.get(key),
        ]);

        expect(first).toBe(0);
        expect(second).toBe(0);

        // No timeouts
        expect(Date.now() - start).toBeLessThan(200);
      });
    });
  });

  describe('Delete', () => {
    it('should delete value', async () => {
      const key = getKey();
      const cache = service.new(DEFAULT_OPT, simpleFetch(key));
      await cache.get(key);
      await cache.delete(key);
      const second = await cache.get(key);

      expect(second).toBe(1);
    });

    it('should not error on deleting non-existant key', async () => {
      const key = getKey();
      const countDeleted = await service.delete(key);
      expect(countDeleted).toBe(0);
    });
  });

  describe('Set', () => {
    it('should override existing value', async () => {
      const key = getKey();
      const cache = service.new(DEFAULT_OPT, simpleFetch(key));
      await cache.get(key);
      await cache.set(key, 2);
      const second = await cache.get(key);

      expect(second).toBe(2);
    });

    it('should encode correctly', async () => {
      const key = getKey();
      const cache = service.new(
        {
          ttlMs: 1500,
          lockTimeout: 200,
          getKey: (key: string) => key,
          encode: () => 'encoded',
          decode: (str) => str,
        },
        () => null,
      );

      await cache.set(key, null);
      expect(await cache.get(key)).toBe('encoded');
    });
  });

  describe('decode failures stay local', () => {
    const service = new MemolockCache();
    afterAll(() => service.disconnect());

    it('fetch that resolves to undefined does not crash the process', async () => {
      let uncaught: Error | null = null;
      const listener = (e: Error) => (uncaught = e);
      process.once('uncaughtException', listener);

      const KEY = 'bug:decode:undefined';
      const cache = service.new(
        { ttlMs: 100, lockTimeout: 30, getKey: (k: string) => k },
        async () => {
          await sleep(20);
          return undefined;
        },
      );

      const [v1, v2] = await Promise.all([cache.get(KEY), cache.get(KEY)]);
      await sleep(10);
      process.removeListener('uncaughtException', listener);

      expect(uncaught).toBeNull();
      expect(v1).toBeUndefined();
      expect(v2).toBeNull();
    });

    it('should handle custom decode throwing errors locally', async () => {
      let uncaught: Error | null = null;
      const listener = (e: Error) => (uncaught = e);
      process.once('uncaughtException', listener);

      const KEY = 'bug:decode:throw';
      const cache = service.new(
        {
          ttlMs: 100,
          lockTimeout: 30,
          getKey: (k: string) => k,
          decode: () => {
            throw new Error('decode error');
          },
        },
        async () => {
          await sleep(20);
          return 'some-value';
        },
      );

      const [res1, res2] = await Promise.allSettled([
        cache.get(KEY),
        cache.get(KEY),
      ]);
      await sleep(10);
      process.removeListener('uncaughtException', listener);

      expect(uncaught).toBeNull();

      expect(res1.status).toBe('fulfilled');
      if (res1.status === 'fulfilled') {
        expect(res1.value).toBe('some-value');
      }

      expect(res2.status).toBe('rejected');
      if (res2.status === 'rejected') {
        expect(res2.reason).toEqual(new Error('decode error'));
      }
    });
  });

  describe('safeCall branch', () => {
    it('invokes errorHandler if a user callback throws', async () => {
      const errFn = jest.fn();
      const service = new MemolockCache({ errorHandler: errFn });

      // get direct access to redis and util helper
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const redis = (service as any).redisClient as Redis.Redis;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const util = (service as any).redisUtil;

      // subscribe with a success-callback that throws
      util.subscribeOnce('sc:test', {
        timeoutMs: 1_000,
        decode: (m: string) => m,
        onSuccess: () => {
          throw new Error('boom');
        },
        onError: () => {
          /* ignore */
        },
      });

      // publish a message so that onSuccess runs and throws
      await sleep(50);
      await redis.publish('sc:test', 'payload');
      await sleep(200);

      await service.disconnect();
      expect(errFn).toHaveBeenCalledTimes(1);
      expect(errFn.mock.calls[0][0]).toHaveProperty('message', 'boom');
    });
  });
});
