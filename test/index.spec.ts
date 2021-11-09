import Redis from 'ioredis';

import CacheService from '../src';
import { sleep } from './test-util';

describe('Redis Cache', () => {
  let service: CacheService;

  beforeAll(async () => {
    service = new CacheService();
  });

  afterAll(async () => {
    await service.disconnect();
  });

  beforeEach(async () => {
    count = 0;
    key = getKey();
  });

  afterEach(async () => {
    // Make sure we've unsubscribed from all channels
    expect(service['redisUtil']['subInfo'][key + '_done']).toBeUndefined();
  });

  let keyId = 0;
  const getKey = () => 'test:key_' + keyId++;
  let key = '';
  let count = 0;
  const simpleFetch = async () => count++;

  const DEFAULT_OPT = {
    ttlMs: 5000,
    lockTimeout: 250,
    getKey: (key: string) => key,
  };

  describe('Get', () => {
    it('should get cached value', async () => {
      const cache = service.new(DEFAULT_OPT, simpleFetch);
      const first = await cache.get(key);
      const second = await cache.get(key);

      expect(first).toBe(0);
      expect(second).toBe(0);
    });

    it('should refetch after ttl', async () => {
      const cache = service.new(
        { ttlMs: 100, getKey: (key: string) => key },
        simpleFetch,
      );
      const first = await cache.get(key);
      await sleep(150);
      const second = await cache.get(key);

      expect(first).toBe(0);
      expect(second).toBe(1);
    });

    it('should only get one value when fetched async', async () => {
      const cache = service.new(DEFAULT_OPT, simpleFetch);
      const values = await Promise.all(
        [...Array(20)].map(async () => cache.get(key)),
      );

      expect(values).toEqual([...Array(20)].map(() => 0));
    });

    it('should get two separate values for different keys', async () => {
      const first = await service.get(key, DEFAULT_OPT, simpleFetch);
      const second = await service.get(getKey(), DEFAULT_OPT, simpleFetch);

      expect(first).toBe(0);
      expect(second).toBe(1);
    });

    it('should retry if initial fetch fails', async () => {
      const failFirstFetch = async () => {
        count++;
        if (count === 1) {
          throw new Error('fail first fetch');
        }
        return count - 1;
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
      const longFetch = async () => {
        await sleep(100);
        return count++;
      };

      const cache = service.new(DEFAULT_OPT, longFetch);
      const first = await cache.get(key);
      const second = await cache.get(key);

      expect(first).toBe(0);
      expect(second).toBe(0);
    });

    it('should refetch value if forceReresh is true', async () => {
      const cache = service.new(DEFAULT_OPT, simpleFetch);
      const first = await cache.get(key);
      const second = await cache.get(key, { forceRefresh: true });

      expect(first).toBe(0);
      expect(second).toBe(1);
    });

    it('should handle lots of concurrent requests', async () => {
      const failEveryOther = async () => {
        count++;
        if (count % 2 === 0) {
          throw new Error('fail randomly');
        }
        return count - 1;
      };

      const cache = service.new(
        { ttlMs: 70, lockTimeout: 20, getKey: (key: string) => key },
        failEveryOther,
      );

      const promises = [...Array(250 * 3)].map(
        async (_, i) =>
          new Promise<string>((res, rej) => {
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
      const cache = service.new(
        {
          ttlMs: 70,
          lockTimeout: 50,
          maxAttempts: 1,
          getKey: (key: string) => key,
        },
        async () => {
          // Don't resolve until after tests complete.
          return new Promise((res, rej) => {
            setTimeout(() => res(count++), 300);
          });
        },
      );

      cache.get(key);
      await expect(cache.get(key)).rejects.toThrow(
        'Never received message that key was unlocked.',
      );
    });

    it('should still function if lockTimeout is too short', async () => {
      const slowFetch = async () => {
        await sleep(120);
        return count++;
      };

      const cache = service.new({ ...DEFAULT_OPT, lockTimeout: 50 }, slowFetch);

      const first = cache.get(key);
      const second = cache.get(key);

      await expect(first).resolves.toBe(0);
      await expect(second).resolves.toBe(1);
    });

    it('should support custom encode/decode', async () => {
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
      // This one will be decoded from cache
      expect(await cache.get(key)).toHaveProperty('func');
    });

    it('shoud allow cutom redis to be passed in', async () => {
      await service.disconnect();

      service = new CacheService({
        redisClient: new Redis(),
        redisSubClient: new Redis(),
      });
      const cache = service.new(
        {
          ttlMs: 1500,
          getKey: (key: string) => key,
        },
        simpleFetch,
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
  });

  describe('Delete', () => {
    it('should delete value', async () => {
      const cache = service.new(DEFAULT_OPT, simpleFetch);
      await cache.get(key);
      await cache.delete(key);
      const second = await cache.get(key);

      expect(second).toBe(1);
    });

    it('should not error on deleting non-existant key', async () => {
      const countDeleted = await service.delete(key);
      expect(countDeleted).toBe(0);
    });
  });
});
