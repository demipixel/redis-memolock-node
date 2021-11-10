import Redis from 'ioredis';

export class RedisUtilService {
  private subInfo: {
    [channel: string]: {
      callbacks: Set<SubType>;
      timeouts: NodeJS.Timeout[];
      decode: (message: string) => unknown;
    };
  } = {};

  constructor(
    private readonly redisSubClient: Redis.Redis,
    private errorHandler?: ErrorHandler,
  ) {
    if (!this.errorHandler) {
      this.errorHandler = (e) => console.error(e);
    }

    this.redisSubClient.on('message', (channel: string, message: string) => {
      if (!this.subInfo[channel]) {
        return;
      }

      const { callbacks, timeouts, decode } = this.subInfo[channel];
      delete this.subInfo[channel];

      const data = decode(message);
      callbacks.forEach((callback) => callback(data));
      timeouts.forEach((timeout) => clearTimeout(timeout));
      this.redisSubClient.unsubscribe(channel).catch(errorHandler);
    });
  }

  subscribeOnce(
    channel: string,
    {
      timeoutMs,
      decode,
      onSuccess,
      onError: onError_UNSAFE,
    }: {
      timeoutMs: number;
      decode: (message: string) => unknown;
      onSuccess: SubType;
      onError: (timeout: boolean, err?: Error) => void;
    },
  ) {
    let hadCallback = false;
    const onError: typeof onError_UNSAFE = (...args) => {
      if (hadCallback) {
        return;
      }
      hadCallback = true;
      return onError_UNSAFE(...args);
    };

    if (this.subInfo[channel]) {
      this.subInfo[channel].callbacks.add(onSuccess);
    } else {
      this.subInfo[channel] = {
        callbacks: new Set([onSuccess]),
        timeouts: [],
        decode,
      };
      this.redisSubClient.subscribe(channel).catch((err) => {
        onError(false, err);
        this.unsubscribeFromSubscribeOnce(channel, onSuccess);
      });
    }

    this.subInfo[channel].timeouts.push(
      setTimeout(() => {
        this.unsubscribeFromSubscribeOnce(channel, onSuccess);
        onError(true);
      }, timeoutMs),
    );
  }

  private unsubscribeFromSubscribeOnce(channel: string, callback: SubType) {
    if (!this.subInfo[channel]) {
      return;
    }

    this.subInfo[channel].callbacks.delete(callback);
    if (this.subInfo[channel].callbacks.size === 0) {
      delete this.subInfo[channel];
      this.redisSubClient.unsubscribe(channel).catch(this.errorHandler);
    }
  }
}

type SubType = (data: unknown) => void;
type ErrorHandler = (err: Error) => void;

export default RedisUtilService;
