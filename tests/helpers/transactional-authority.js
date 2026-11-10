// Isolated synthetic transaction boundary. This is not browser IndexedDB qualification.
import { BrowserAuthorityStore } from '../../src/layer1-uor/browser-authority.js';
export class SyntheticAuthorityStore extends BrowserAuthorityStore {
  constructor(state = { records: new Map(), tail: Promise.resolve() }) { super(); this.state = state; this.fail = false; this.count = 0; }
  exclusivePublication(scope, work) {
    this.state.locks ??= new Map();
    const result = (this.state.locks.get(scope) ?? Promise.resolve()).then(work);
    this.state.locks.set(scope, result.catch(() => {})); return result;
  }
  transaction(key, change) {
    const result = this.state.tail.then(() => {
      const update = change(structuredClone(this.state.records.get(key)));
      this.count++;
      if (this.fail === true || this.fail === this.count) throw Error('synthetic quota abort');
      if (update.write !== undefined) this.state.records.set(key, structuredClone(update.write));
      return structuredClone(update.result);
    });
    this.state.tail = result.catch(() => {}); return result;
  }
}
