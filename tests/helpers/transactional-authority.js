// Isolated synthetic transaction boundary. This is not browser IndexedDB qualification.
import { BrowserAuthorityStore } from '../../src/layer1-uor/browser-authority.js';
export class SyntheticAuthorityStore extends BrowserAuthorityStore {
  constructor(state = { records: new Map(), tail: Promise.resolve() }) { super(); this.state = state; this.fail = false; this.count = 0; }
  exclusiveAuthority(work) { return this.exclusivePublication("origin-lifecycle", work); }
  exclusivePublication(scope, work) {
    scope = "origin-lifecycle";
    this.state.locks ??= new Map();
    const result = (this.state.locks.get(scope) ?? Promise.resolve()).then(work);
    this.state.locks.set(scope, result.catch(() => {})); return result;
  }
  records() { return this.state.tail.then(() => structuredClone([...this.state.records])); }
  transactionMany(keys, change) {
    const result = this.state.tail.then(() => {
      const values = new Map(keys.map(key => [key, structuredClone(this.state.records.get(key))]));
      const update = change(values);
      this.count++;
      if (this.fail === true || this.fail === this.count) throw Error('synthetic quota abort');
      for (const [key, value] of update.writes ?? []) this.state.records.set(key, structuredClone(value));
      for (const key of update.deletes ?? []) this.state.records.delete(key);
      return structuredClone(update.result);
    });
    this.state.tail = result.catch(() => {}); return result;
  }
}
