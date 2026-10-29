'use strict';
// Transport between Zalo's main process and the call engine (see re/NOTES.md,
// "Engine ⇄ Electron IPC"). Zalo listens on two Unix sockets and spawns the
// engine as `engine <recvPath> <sendPath>`:
//   - recvPath: engine → Zalo, frames `hex(AES-128-CBC(JSON))$`
//   - sendPath: Zalo → engine, same frames, split into 4000-char pieces
//     suffixed `#<msgId>#<count>#<index>#`; Zalo sends the next piece only
//     after the engine writes something back, so every piece is acked.
const net = require('net');
const crypto = require('crypto');
const { EventEmitter } = require('events');

const IV = Buffer.alloc(16);
const CHUNK_RX = /#(\d+)#(\d+)#(\d+)#$/;

class ZaloIpc extends EventEmitter {
  constructor(recvPath, sendPath, keyBase64) {
    super();
    this.recvPath = recvPath;
    this.sendPath = sendPath;
    this.key = Buffer.from(keyBase64, 'base64');
    this.out = null;
    this.inBuf = '';
    this.partial = new Map(); // msgId -> pieces[]
  }

  encrypt(text) {
    const c = crypto.createCipheriv('aes-128-cbc', this.key, IV);
    return Buffer.concat([c.update(text, 'utf8'), c.final()]).toString('hex');
  }

  decrypt(hex) {
    const d = crypto.createDecipheriv('aes-128-cbc', this.key, IV);
    return Buffer.concat([d.update(Buffer.from(hex, 'hex')), d.final()]).toString('utf8');
  }

  // Zalo starts listening right before spawning us, so the sockets may not
  // accept yet: retry a short while before giving up.
  connect(attempt = 0) {
    const out = net.connect(this.recvPath);
    out.once('error', e => {
      if (attempt < 50 && (e.code === 'ENOENT' || e.code === 'ECONNREFUSED')) {
        setTimeout(() => this.connect(attempt + 1), 100);
      } else {
        this.emit('error', e);
      }
    });
    out.once('connect', () => {
      this.out = out;
      out.on('error', e => this.emit('error', e));
      out.on('close', () => this.emit('close'));
      this.connectIn();
      this.emit('ready');
    });
  }

  connectIn() {
    const inSock = net.connect(this.sendPath);
    inSock.setEncoding('utf8');
    inSock.on('data', data => {
      this.inBuf += data;
      let i;
      while ((i = this.inBuf.indexOf('$')) >= 0) {
        const piece = this.inBuf.slice(0, i);
        this.inBuf = this.inBuf.slice(i + 1);
        this.onPiece(piece);
        inSock.write('1'); // ack: lets Zalo send the next piece
      }
    });
    inSock.on('error', e => this.emit('error', e));
    inSock.on('close', () => this.emit('close'));
  }

  onPiece(piece) {
    if (!piece) return;
    const m = CHUNK_RX.exec(piece);
    let hex = piece;
    if (m) {
      const [, id, count, index] = m;
      const parts = this.partial.get(id) || [];
      parts[Number(index)] = piece.slice(0, m.index);
      this.partial.set(id, parts);
      if (parts.filter(p => p !== undefined).length < Number(count)) return;
      this.partial.delete(id);
      hex = parts.join('');
    }
    let msg;
    try {
      msg = JSON.parse(this.decrypt(hex).replace(/\0/g, ''));
    } catch (e) {
      this.emit('error', new Error(`undecodable frame (${hex.length} chars): ${e.message}`));
      return;
    }
    this.emit('message', msg);
  }

  send(msg) {
    if (!this.out) throw new Error('ipc not connected');
    this.out.write(this.encrypt(JSON.stringify(msg)) + '$');
  }
}

module.exports = { ZaloIpc };
