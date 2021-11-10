import Redis from 'ioredis';

import RedisUtilService from '../src/redis-util';
import { sleep } from './test-util';

describe('RedisUtilService', () => {
  let service: RedisUtilService;
  let errorHandler: jest.Mock<unknown, unknown[]>;
  let redisSubClient: Redis.Redis;

  beforeEach(() => {
    redisSubClient = new Redis();
    errorHandler = jest.fn();
    service = new RedisUtilService(redisSubClient, errorHandler);
  });

  afterEach(async () => {
    try {
      await redisSubClient.quit();
    } catch (e) {
      if (e.message !== 'Connection is closed.') {
        throw e;
      }
    }
  });

  it('should not cause issues on unknown messages', async () => {
    const redis = new Redis();
    await service['redisSubClient'].subscribe('random');
    await redis.publish('random', 'message');

    await sleep(200);

    expect(errorHandler).toHaveBeenCalledTimes(0);
    await redis.quit();
  });

  it('should call console.error if no error handler is passed', async () => {
    console.error = jest.fn();

    await redisSubClient.quit();
    service = new RedisUtilService(redisSubClient);

    service.subscribeOnce('random', {
      timeoutMs: 200,
      decode: (message: string) => message,
      onSuccess: () => null,
      onError: () => null,
    });

    await sleep(200);
    expect(console.error).toHaveBeenCalledTimes(1);
  });

  it('should not error on unknown channel', async () => {
    service['unsubscribeFromSubscribeOnce']('random', () => null);
  });

  it('should call onError if redis is down when subscribe', async () => {
    const onError = jest.fn();
    await service['redisSubClient'].quit();
    service.subscribeOnce('random', {
      timeoutMs: 200,
      decode: (message: string) => message,
      onSuccess: () => null,
      onError,
    });

    await sleep(200);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(service['subInfo']['random']).toBeUndefined();
  });

  it('should not error if redis is down when unsubscribe', async () => {
    service.subscribeOnce('key', {
      timeoutMs: 200,
      decode: (message: string) => message,
      onSuccess: () => null,
      onError: () => null,
    });
    await sleep(50);
    await service['redisSubClient'].quit();

    await sleep(200);

    expect(errorHandler).toHaveBeenCalledTimes(1);
  });
});
