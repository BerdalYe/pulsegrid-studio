/**
 * Talks to the plugin host program (native/plugin-host): starts it, sends it requests and reads its answers and
 * notices. Every message, either way, is a frame: three little-endian 32-bit numbers (kind, JSON length, binary
 * length), the JSON, then the binary bytes. Used by the plugin bridge (pluginBridge.cjs) in its own process.
 */
const { spawn } = require("node:child_process");

const REQUEST = 1;
const RESPONSE = 2;
const EVENT = 3;

class PluginHostClient {
  /**
   * @param {string} exePath the host program
   * @param {{ onEvent?: (event: object) => void, onExit?: (code: number | null) => void }} handlers
   */
  constructor(exePath, handlers = {}) {
    this.handlers = handlers;
    this.nextId = 1;
    this.waiting = new Map();
    this.buffer = Buffer.alloc(0);
    this.alive = true;

    this.child = spawn(exePath, [], { stdio: ["pipe", "pipe", "ignore"], windowsHide: true });
    this.child.stdout.on("data", (chunk) => this.receive(chunk));
    this.child.on("exit", (code) => {
      this.alive = false;
      for (const { reject } of this.waiting.values()) reject(new Error("The plugin host stopped."));
      this.waiting.clear();
      this.handlers.onExit?.(code);
    });
    this.child.on("error", (error) => {
      this.alive = false;
      this.handlers.onExit?.(null, error);
    });
    // A request written after the host has gone must not throw from the stream.
    this.child.stdin.on("error", () => undefined);
  }

  /**
   * Send a request; resolves with { message, binary } once the host answers.
   * @param {object} message must have `cmd`
   * @returns {Promise<{ message: any, binary: Buffer }>}
   */
  request(message) {
    if (!this.alive) return Promise.reject(new Error("The plugin host isn't running."));
    const id = this.nextId++;
    const json = Buffer.from(JSON.stringify({ ...message, id }), "utf8");
    const header = Buffer.alloc(12);
    header.writeUInt32LE(REQUEST, 0);
    header.writeUInt32LE(json.length, 4);
    header.writeUInt32LE(0, 8);
    return new Promise((resolve, reject) => {
      this.waiting.set(id, { resolve, reject });
      this.child.stdin.write(Buffer.concat([header, json]));
    });
  }

  /** Like request(), but turns { ok: false, error } into a rejection. */
  async call(message) {
    const { message: reply, binary } = await this.request(message);
    if (!reply.ok) throw new Error(reply.error || "The plugin host couldn't do that.");
    return { reply, binary };
  }

  receive(chunk) {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
    for (;;) {
      if (this.buffer.length < 12) return;
      const kind = this.buffer.readUInt32LE(0);
      const jsonLength = this.buffer.readUInt32LE(4);
      const binaryLength = this.buffer.readUInt32LE(8);
      const total = 12 + jsonLength + binaryLength;
      if (this.buffer.length < total) return;

      let message = null;
      try {
        message = JSON.parse(this.buffer.toString("utf8", 12, 12 + jsonLength));
      } catch {
        message = null;
      }
      // Copied out, so the read buffer can be reused and the audio can be handed on without holding it.
      const binary = Buffer.from(this.buffer.subarray(12 + jsonLength, total));
      this.buffer = this.buffer.subarray(total);
      if (!message) continue;

      if (kind === RESPONSE) {
        const waiting = this.waiting.get(message.id);
        if (waiting) {
          this.waiting.delete(message.id);
          waiting.resolve({ message, binary });
        }
      } else if (kind === EVENT) {
        this.handlers.onEvent?.(message);
      }
    }
  }

  stop() {
    if (!this.alive) return;
    this.child.stdin.end();
    // A plugin that hangs on the way out must not keep the program running.
    setTimeout(() => {
      if (this.alive) this.child.kill();
    }, 3000).unref?.();
  }
}

/**
 * Ask a fresh host what plugins one file holds. Each file is opened in a program of its own, so a plugin that
 * crashes while being looked at can't take anything else down with it.
 */
function scanFile(exePath, filePath, timeoutMs = 20000) {
  return new Promise((resolve) => {
    const child = spawn(exePath, ["--scan", filePath], { stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
    let output = "";
    const timer = setTimeout(() => {
      child.kill();
      resolve({ path: filePath, plugins: [], error: "It took too long to open." });
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      output += chunk.toString("utf8");
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      try {
        resolve(JSON.parse(output));
      } catch {
        resolve({ path: filePath, plugins: [], error: code === 0 ? "It gave no answer." : "It crashed while being opened." });
      }
    });
    child.on("error", () => {
      clearTimeout(timer);
      resolve({ path: filePath, plugins: [], error: "The plugin host couldn't start." });
    });
  });
}

module.exports = { PluginHostClient, scanFile };
