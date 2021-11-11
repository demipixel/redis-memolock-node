import Redis from 'ioredis';

import RedisUtilService from './redis-util';

export type MemolockConstructorOpt = {
  redisClient?: Redis.Redis;
  redisSubClient?: Redis.Redis;

  redisPort?: number;
  redisHost?: string;
  redisOptions?: Redis.RedisOptions;
  errorHandler?: (err: Error) => void;
};

interface MemolockOpt<T> {
  ttlMs?: number;
  lockTimeout?: number;
  maxAttempts?: number;
  forceRefresh?: boolean;

  encode?: (data: T) => string;
  decode?: (data: string) => T;
}

export interface MemolockOptWithTtl<T> extends MemolockOpt<T> {
  ttlMs: number;
}

export interface MemolockOptForClient<T, U> extends MemolockOptWithTtl<T> {
  getKey: (keyVal: U) => string;
}

export interface CacheClient<T, U> {
  get(keyVal: U, opt?: MemolockOpt<T>): Promise<T>;
  delete(keyVal: U): Promise<number>;
}

const DEFAULT_LOCK_TIMEOUT = 1000;
const DEFAULT_MAX_ATTEMPTS = 3;

export class MemolockCache {
  private redisClient: Redis.Redis;
  private redisSubClient: Redis.Redis;
  private isLockedCache: Set<string>;
  private redisUtil: RedisUtilService;
  private errorHandler?: (err: Error) => void;

  constructor(opt?: MemolockConstructorOpt) {
    /* istanbul ignore next */
    this.redisClient =
      opt?.redisClient ??
      new Redis(opt?.redisPort, opt?.redisHost, opt?.redisOptions);
    /* istanbul ignore next */
    this.redisSubClient =
      opt?.redisSubClient ??
      new Redis(opt?.redisPort, opt?.redisHost, opt?.redisOptions);

    this.isLockedCache = new Set();
    this.errorHandler = opt?.errorHandler;
    this.redisUtil = new RedisUtilService(
      this.redisSubClient,
      this.errorHandler,
    );
  }

  async disconnect() {
    await Promise.all([
      this.redisClient.quit(),
      this.redisSubClient.quit(),
    ]).catch((err) => {
      /* istanbul ignore next */
      if (err.message !== 'Connection is closed.') {
        throw err;
      }
    });
  }

  new<T, U>(
    clientOpt: MemolockOptForClient<T, U>,
    fetch: (keyVal: U) => T | Promise<T>,
  ): CacheClient<T, U> {
    return {
      get: (keyVal: U, opt?: MemolockOpt<T>) =>
        this.get(
          clientOpt.getKey(keyVal),
          { ...clientOpt, ...opt },
          fetch.bind(null, keyVal) as () => T | Promise<T>,
        ),
      delete: (keyVal: U) => this.delete(clientOpt.getKey(keyVal)),
    };
  }

  async get<T>(
    key: string,
    opt: MemolockOptWithTtl<T>,
    fetch: () => T | Promise<T>,
    attempts = 0,
  ): Promise<T> {
    const value = opt.forceRefresh ? null : await this.redisClient.get(key);
    if (value) {
      return opt.decode ? opt.decode(value) : JSON.parse(value);
    } else {
      return this.getLockOrWaitForLock(key, opt, fetch, attempts);
    }
  }

  private async getLockOrWaitForLock<T>(
    key: string,
    opt: MemolockOptWithTtl<T>,
    fetch: () => T | Promise<T>,
    attempts: number,
  ): Promise<T> {
    const lockTimeout = (opt.lockTimeout ??= DEFAULT_LOCK_TIMEOUT);

    const lockKey = `${key}:lock`;

    const keyChannel = `${key}_done`;

    if (await this.isLocked(key, lockKey, opt.lockTimeout)) {
      this.isLockedCache.add(key);

      // Subscribe to event to wait for the value
      return new Promise<T>((resolve, reject) => {
        this.redisUtil.subscribeOnce(keyChannel, {
          timeoutMs: lockTimeout,
          decode: (message: string) =>
            opt.decode ? opt.decode(message) : JSON.parse(message),
          onSuccess: (data: T) => {
            this.isLockedCache.delete(key);
            resolve(data);
          },
          onError: () => {
            this.isLockedCache.delete(key);

            if (attempts < (opt.maxAttempts ?? DEFAULT_MAX_ATTEMPTS) - 1) {
              resolve(this.get(key, opt, fetch, attempts + 1));
            } else {
              reject(
                new Error('Never received message that key was unlocked.'),
              );
            }
          },
        });
      });
    } else {
      // Fetch value, convert to promise as needed.
      const value = await Promise.resolve()
        .then(() => fetch())
        .catch((e) => {
          // Silent catch isn't ideal, but failure inside of
          // failure seems worse. We can still recover if
          // this delete fails.
          this.redisClient.del(lockKey).catch(() => {
            if (this.errorHandler) {
              this.errorHandler(e);
            }
          });
          this.isLockedCache.delete(key);
          // Still throw error so user can handle it
          throw e;
        });

      await this.redisClient
        .pipeline()
        // Set value in cache
        .set(key, JSON.stringify(value), 'PX', opt.ttlMs)
        // Publish value
        .publish(keyChannel, JSON.stringify(value))
        // Release lock
        .del(lockKey)
        .exec();
      this.isLockedCache.delete(key);

      return value;
    }
  }

  async delete(key: string) {
    return this.redisClient.del(key);
  }

  private async isLocked(
    key: string,
    lockKey: string,
    lockTimeout: number,
  ): Promise<boolean> {
    if (this.isLockedCache.has(key)) {
      return true;
    } else {
      this.isLockedCache.add(key);
      const wasLocked =
        (await this.redisClient.set(
          lockKey,
          'locked',
          'PX',
          lockTimeout,
          'NX',
        )) !== 'OK';

      return wasLocked;
    }
  }
}

export default MemolockCache;
