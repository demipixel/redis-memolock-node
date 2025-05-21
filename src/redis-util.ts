import Redis from 'ioredis';

export class RedisUtilService {
  private subInfo: {
    [channel: string]: {
      callbacks: Set<SubSuccess>;
      errCallbacks: Set<SubError>;
      timeouts: NodeJS.Timeout[];
      decode: (message: string) => unknown;
    };
  } = {};

  constructor(
    private readonly redisSubClient: Redis.Redis,
    private errorHandler: ErrorHandler = (e) => console.error(e),
  ) {
    this.redisSubClient.on('message', (channel: string, message: string) => {
      if (!this.subInfo[channel]) {
        return;
      }

      const { callbacks, errCallbacks, timeouts, decode } =
        this.subInfo[channel];
      delete this.subInfo[channel];

      let data: unknown;
      try {
        data = decode(message);
      } catch (err) {
        errCallbacks.forEach((cb) =>
          this.safeCall(() => cb(false, err as Error)),
        );
        timeouts.forEach((timeout) => clearTimeout(timeout));
        this.redisSubClient.unsubscribe(channel).catch(this.errorHandler);
        return;
      }

      callbacks.forEach((cb) => this.safeCall(() => cb(data)));
      timeouts.forEach((timeout) => clearTimeout(timeout));
      this.redisSubClient.unsubscribe(channel).catch(this.errorHandler);
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
      onSuccess: SubSuccess;
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
      this.subInfo[channel].errCallbacks.add(onError);
    } else {
      this.subInfo[channel] = {
        callbacks: new Set([onSuccess]),
        errCallbacks: new Set([onError]),
        timeouts: [],
        decode,
      };
      this.redisSubClient.subscribe(channel).catch((err) => {
        onError(false, err);
        this.unsubscribeFromSubscribeOnce(channel, onSuccess, onError);
      });
    }

    this.subInfo[channel].timeouts.push(
      setTimeout(() => {
        this.unsubscribeFromSubscribeOnce(channel, onSuccess, onError);
        onError(true);
      }, timeoutMs),
    );
  }

  private unsubscribeFromSubscribeOnce(
    channel: string,
    successCallback: SubSuccess,
    errorCallback: SubError,
  ) {
    const info = this.subInfo[channel];
    if (!info) {
      return;
    }

    info.callbacks.delete(successCallback);
    if (errorCallback) {
      info.errCallbacks.delete(errorCallback);
    }

    if (info.callbacks.size === 0) {
      delete this.subInfo[channel];
      this.redisSubClient.unsubscribe(channel).catch(this.errorHandler);
    }
  }

  // utility: never let a userspace callback crash the process
  private safeCall(fn: () => void) {
    try {
      fn();
    } catch (e) {
      this.errorHandler(e as Error);
    }
  }
}

type SubSuccess = (data: unknown) => void;
type SubError = (timeout: boolean, err?: Error) => void;
type ErrorHandler = (err: Error) => void;

export default RedisUtilService;
