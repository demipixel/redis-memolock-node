# Redis Memolock for Node

A simple, fast, and reliable memolock for Node.js and TypeScript.

> A MemoLock is a form of distributed caching with promises. It's like memoization, but since the cache is shared by multiple consumers, each key has a locking mechanism that ensures that multiple concurrent requests for the same resource don't cause unnecessary work.

\- Stolen from https://github.com/kristoff-it/redis-memolock. Read more about memolock and why you want it there :)

## Installation

```bash
npm i --save redis-memolock
```

## Usage

```ts
import MemolockCache from 'redis-memolock';

const cache = new MemolockCache();

function getArticle(id: string) {
  return cache.get(
    // Key
    'article:' + id,
    // Cache for a minute
    { ttlMs: 60 * 1000 },
    // Fetch article normally
    async () => {
      const article = await articleService.getArticle(id);
      return article;
    },
  );
}
```

OR:

```ts
import MemolockCache from 'redis-memolock';

const cache = new MemolockCache();
const articleCache = cache.new(
  {
    getKey: (articleId: number) => 'article:' + articleId,
    ttlMs: 60 * 1000,
  },
  (id) => articleService.getArticle(id),
);

// Fetch the article at any time
articleCache.get(123);

// When article is updated
articleCache.delete(123);
```

---

## API

---

## MemolockCache

### **MemolockCache.get(redisKey, opt, fetchFn)**

Fetch a value from the cache. If the value is not in the cache, it will be fetched or wait for another process to fetch it.

- `redisKey`: The key to use in Redis.
- `opt`: Options for the cache (see below).
- `fetchFn`: A function that will be called to fetch the actual data if the cache is empty.

### **MemolockCache.delete(redisKey)**

Identical to `redis.del(redisKey)`.

### **MemolockCache.new(opt)**

Returns a `CacheClient` instance with two methods: `get` and `delete`. See below for available options.

---

## CacheClient

### **CacheClient.get(val, opt)**

Passes `val` into your provided `getKey` function to get the Redis key. `opt` will override any options passed to `new`. Otherwise works the same as `MemolockCache.get`.

### **CacheClient.delete(val)**

Pass `val` into your provided `getKey` function to get the Redis key. Works the same as `MemolockCache.delete`.

---

## Options

Options are available on `MemolockCache.get`, `MemolockCache.new`, and `CacheClient.get`.

When using `MemolockCache.get`, you should always pass the same options for the same key to avoid unexpected behavior.

- `ttlMs`: How long before the cache expires in milliseconds. (Required for `MemolockCache.get` and `CacheClient.new`)
- `lockTimeout`: How long a lock is held. This should be longer than you expect a full fetch to take. If a process waits longer than `lockTimeout` for the cache to be populated, it will try again. (Default: 1000ms)
- `maxAttempts`: How many lock timeouts before giving up and throwing an error. (Default: 3)
- `forceRefresh`: Will ignore the cache and attempt to fetch the data again. Will not attempt a fetch if there's already a fetch in-progress. (Default: false)
- - `getKey`: Function that converts a value to the cache key (Required, only on `CacheClient.new`)
- `encode`: Function that encodes the value to a string before storing it in the cache. (Default: `JSON.stringify`)
- `decode`: Function that decodes the value from a string before returning it from the cache. (Default: `JSON.parse`)
