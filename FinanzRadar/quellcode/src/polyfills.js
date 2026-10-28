// Polyfills für neuere JS-Features, die pdf.js 6 nutzt (ältere Chrome/Firefox/Safari)
for (const C of [Map, WeakMap]) {
  if (!C.prototype.getOrInsert) {
    Object.defineProperty(C.prototype, 'getOrInsert', { configurable: true, writable: true, value(key, value) { if (!this.has(key)) this.set(key, value); return this.get(key); } });
  }
  if (!C.prototype.getOrInsertComputed) {
    Object.defineProperty(C.prototype, 'getOrInsertComputed', { configurable: true, writable: true, value(key, fn) { if (!this.has(key)) this.set(key, fn(key)); return this.get(key); } });
  }
}
if (!Promise.withResolvers) {
  Promise.withResolvers = function () { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
}
