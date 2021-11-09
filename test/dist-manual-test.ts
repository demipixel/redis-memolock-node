import CacheService from '../dist';

let count = 0;

const service = new CacheService();
const client = service.new(
  {
    getKey: (id: number) => id.toString(),
    ttlMs: 300,
  },
  () =>
    new Promise((resolve) => {
      setTimeout(() => {
        resolve(count++);
      }, 1000);
    }),
);

client.get(123).then(async (value) => {
  console.log('Should be 0: ' + value);
  const second = await client.get(123);
  console.log('Should be 0: ' + second);

  setTimeout(() => {
    client.get(123).then((value) => {
      console.log('Should be 1: ' + value);
      service.disconnect();
    });
  }, 500);
});
