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
import cacheService from 'redis-memolock';

function getArticle(articleId: string) {
  return cacheService.get(
    // Key
    'article:' + articleId,
    // Cache for a minute
    { ttlMs: 60 * 1000 },
    // Fetch post normally
    async () => {
      const post = await postService.getPost(1);
      return post;
    },
  );
}
```

OR:

```ts
import cacheService from 'redis-memolock';

const articleCache = cachService.new({
  getKey: (articleId: number) => 'article:' + articleId,
  ttlMs: 60 * 1000,
});

// Fetch the article at any time
articleCache.get(123);

// When article is updated
articleCache.delete(123);
```
