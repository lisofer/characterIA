import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

const now = () => new Date().toISOString();
// New installations start with zero NPCs. Existing profiles on disk are preserved.
const initial = () => ({ profiles: {}, memories: {} });
const keyOf = (npcId, playerId) => JSON.stringify([npcId, playerId]);
const freshMemory = (version = 0) => ({ version, summary: '', turns: [], updatedAt: now() });

export class MemoryStore {
  constructor(file = process.env.DATA_FILE || '/data/npc-data.json') {
    this.file = file;
    this.state = initial();
    this.queue = Promise.resolve();
  }
  async init() {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    try {
      const data = JSON.parse(await fs.readFile(this.file, 'utf8'));
      if (!data || typeof data !== 'object' || !data.profiles || !data.memories) {
        throw new Error('Formato de datos persistentes invalido');
      }
      this.state = data;
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
      await this._write();
    }
    return this;
  }
  async _write() {
    const tmp = this.file + '.' + process.pid + '.tmp';
    await fs.writeFile(tmp, JSON.stringify(this.state, null, 2), { mode: 0o600 });
    await fs.rename(tmp, this.file);
  }
  async update(fn) {
    const next = this.queue.catch(() => {}).then(async () => {
      const result = fn(this.state);
      await this._write();
      return result;
    });
    this.queue = next;
    return next;
  }
  async getProfile(id) {
    await this.queue.catch(() => {});
    return this.state.profiles[id] ? structuredClone(this.state.profiles[id]) : null;
  }
  async getProfiles() {
    await this.queue.catch(() => {});
    return Object.values(this.state.profiles).map(v => structuredClone(v));
  }
  async createProfile(changes) {
    return this.update(db => {
      const id = 'npc_' + crypto.randomBytes(10).toString('hex');
      const profile = {
        id,
        name: changes.name,
        voice: changes.voice,
        prompt: changes.prompt,
        createdAt: now(),
        updatedAt: now()
      };
      db.profiles[id] = profile;
      return structuredClone(profile);
    });
  }
  async saveProfile(id, changes) {
    return this.update(db => {
      const profile = db.profiles[id];
      if (!profile) return null; // Never silently create a different NPC on update.
      profile.name = changes.name;
      profile.voice = changes.voice;
      profile.prompt = changes.prompt;
      profile.updatedAt = now();
      return structuredClone(profile);
    });
  }
  async deleteProfile(id) {
    return this.update(db => {
      if (!db.profiles[id]) return false;
      delete db.profiles[id];
      for (const key of Object.keys(db.memories)) {
        if (JSON.parse(key)[0] === id) delete db.memories[key];
      }
      return true;
    });
  }
  async getMemory(npcId, playerId) {
    await this.queue.catch(() => {});
    return structuredClone(this.state.memories[keyOf(npcId, playerId)] || freshMemory());
  }
  async appendTurn(npcId, playerId, role, text) {
    if (!['user', 'npc'].includes(role) || !text.trim()) return;
    return this.update(db => {
      if (!db.profiles[npcId]) return null; // Deleted profiles cannot recreate memory.
      const key = keyOf(npcId, playerId);
      const mem = db.memories[key] || freshMemory();
      mem.turns.push({ role, text: text.slice(0, 1200), at: now() });
      mem.turns = mem.turns.slice(-16);
      mem.updatedAt = now();
      db.memories[key] = mem;
      return mem.version;
    });
  }
  async saveSummaryIfVersion(npcId, playerId, expectedVersion, summary) {
    return this.update(db => {
      const mem = db.memories[keyOf(npcId, playerId)];
      if (!mem || mem.version !== expectedVersion) return false;
      mem.summary = String(summary).slice(0, 1200);
      mem.updatedAt = now();
      return true;
    });
  }
  async reset(npcId, playerId) {
    return this.update(db => {
      const key = keyOf(npcId, playerId);
      const previous = db.memories[key];
      db.memories[key] = freshMemory((previous?.version || 0) + 1);
      return structuredClone(db.memories[key]);
    });
  }
  async resetAllForNpc(npcId) {
    return this.update(db => {
      let count = 0;
      for (const key of Object.keys(db.memories)) {
        if (JSON.parse(key)[0] === npcId) {
          // Leave a version tombstone, so delayed summaries cannot resurrect memories.
          db.memories[key] = freshMemory((db.memories[key]?.version || 0) + 1);
          count++;
        }
      }
      return count;
    });
  }
}
