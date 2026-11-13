/** Deliberately small local v86 filesystem double, with allocations visible to tests. */
export function filesystemFixture() {
  const fs = {
    inodes: [{ size: 0, mode: 0x4000, direntries: new Map() }], inodedata: {}, mounts: [], allocations: [], reads: [],
    CreateInode() { return { size: 0, mode: 0x8000, direntries: new Map() }; },
    link_under_dir(parent, id, name) { this.inodes[parent].direntries.set(name, id); },
    CreateFile(name, parent) { const id = this.inodes.length; this.inodes.push(this.CreateInode()); this.link_under_dir(parent, id, name); return id; },
    SearchPath(name) { return { id: this.inodes[0].direntries.get(name) ?? -1 }; },
    GetInode(id) { return this.inodes[id]; },
    async Read(id, offset, length) { this.reads.push({ id, offset, length }); return this.inodedata[id]?.subarray(offset, offset + length) ?? new Uint8Array(0); },
    async ChangeSize(id, size) { this.allocations.push(size); this.inodedata[id] = new Uint8Array(size); this.inodes[id].size = size; },
    async CreateBinaryFile(name, parent, bytes) {
      const id = this.CreateFile(name, parent); this.allocations.push(bytes.length);
      this.inodedata[id] = bytes.slice(); this.inodes[id].size = bytes.length; return id;
    },
    async CreateTextFile(name, parent, text) {
      const id = this.CreateFile(name, parent); this.allocations.push(text.length);
      this.inodedata[id] = new TextEncoder().encode(text); this.inodes[id].size = text.length; return id;
    },
    FillDirectory(id) {
      const size = [...this.inodes[id].direntries.keys()].reduce((sum, name) => sum + 24 + new TextEncoder().encode(name).length, 0);
      this.allocations.push(size); this.inodedata[id] = new Uint8Array(size); this.inodes[id].size = size;
    },
    setResult(name, bytes) {
      const id = this.CreateFile(name, 0); this.inodedata[id] = bytes; this.inodes[id].size = bytes.length; return id;
    }
  };
  return fs;
}
