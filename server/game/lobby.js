// Room registry: create/find/list rooms, quick play (join an open public room or make one).
import crypto from 'node:crypto';
import { Room } from './room.js';

const ADJ = ['Crimson', 'Azure', 'Golden', 'Emerald', 'Obsidian', 'Silver', 'Iron', 'Shadow'];
const NOUN = ['Gate', 'Hall', 'Pit', 'Keep', 'Crypt', 'Spire', 'Maw', 'Depths'];

export class Lobby {
  constructor() { this.rooms = new Map(); }

  list() {
    return [...this.rooms.values()].filter((r) => r.isPublic).map((r) => r.info());
  }

  create({ name, source, isPublic = true } = {}) {
    const id = crypto.randomBytes(3).toString('hex');
    const roomName = String(name || `${ADJ[Math.floor(Math.random() * ADJ.length)]} ${NOUN[Math.floor(Math.random() * NOUN.length)]}`).slice(0, 24);
    const room = new Room({ id, name: roomName, seed: id, source: source || { type: 'campaign' }, isPublic, onEmpty: (r) => this.rooms.delete(r.id) });
    this.rooms.set(id, room);
    return room;
  }

  get(id) { return this.rooms.get(id) || null; }

  /** Quick play: join the fullest public campaign room still in its lobby (not yet started), or make one. */
  quick() {
    const candidates = [...this.rooms.values()].filter((r) => r.isPublic && !r.full && r.source.type === 'campaign' && r.state === 'lobby');
    candidates.sort((a, b) => b.playerCount - a.playerCount);
    return candidates[0] || this.create({});
  }
}
