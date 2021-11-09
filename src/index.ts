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

export class CacheService {
  private redisClient: Redis.Redis;
  private redisSubClient: Redis.Redis;
  private isLockedCache: Set<string>;
  private redisUtil: RedisUtilService;

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
    this.redisUtil = new RedisUtilService(
      this.redisSubClient,
      opt?.errorHandler,
    );
  }

  async disconnect() {
    await Promise.all([this.redisClient.quit(), this.redisSubClient.quit()]);
  }

  new<T, U>(
    clientOpt: MemolockOptForClient<T, U>,
    fetch: () => T | Promise<T>,
  ): CacheClient<T, U> {
    return {
      get: (keyVal: U, opt?: MemolockOpt<T>) =>
        this.get(clientOpt.getKey(keyVal), { ...clientOpt, ...opt }, fetch),
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
    opt.lockTimeout ??= DEFAULT_LOCK_TIMEOUT;

    const keyLock = `${key}:lock`;
    const isLocked =
      this.isLockedCache.has(key) ||
      (await this.redisClient.set(
        keyLock,
        'locked',
        'PX',
        opt.lockTimeout,
        'NX',
      )) !== 'OK';

    const keyChannel = `${key}_done`;

    if (isLocked) {
      this.isLockedCache.add(key);

      // Subscribe to event to wait for the value
      return new Promise<T>((resolve, reject) => {
        this.redisUtil.subscribeOnce(keyChannel, {
          timeoutMs: opt.lockTimeout!,
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
      this.isLockedCache.add(key);
      // Fetch value
      const value = await fetch();
      await this.redisClient
        .pipeline()
        // Set value in cache
        .set(key, JSON.stringify(value), 'PX', opt.ttlMs)
        // Publish value
        .publish(keyChannel, JSON.stringify(value))
        // Release lock
        .del(keyLock)
        .exec();
      this.isLockedCache.delete(key);

      return value;
    }
  }

  async delete(key: string) {
    return this.redisClient.del(key);
  }
}

export default CacheService;
