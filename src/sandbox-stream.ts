import { SandboxOutput } from "./sandbox.js";

/** Incremental Docker framing: never allocate the worker-declared frame size. */
export class SandboxFrames {
  private header = Buffer.alloc(8);
  private headerBytes = 0;
  private remaining = 0;
  constructor(private readonly output: SandboxOutput) {}

  append(chunk: Buffer): boolean {
    let offset = 0;
    while (offset < chunk.length) {
      if (this.remaining === 0) {
        const count = Math.min(8 - this.headerBytes, chunk.length - offset);
        chunk.copy(this.header, this.headerBytes, offset, offset + count);
        this.headerBytes += count;
        offset += count;
        if (this.headerBytes < 8) continue;
        if (
          ![1, 2].includes(this.header[0]) ||
          this.header.readUIntBE(1, 3) !== 0
        )
          throw new Error("Invalid sandbox stream");
        this.remaining = this.header.readUInt32BE(4);
        this.headerBytes = 0;
      }
      const count = Math.min(this.remaining, chunk.length - offset);
      if (!this.output.append(chunk.subarray(offset, offset + count)))
        return false;
      this.remaining -= count;
      offset += count;
    }
    return true;
  }

  finish(): void {
    if (this.headerBytes || this.remaining)
      throw new Error("Truncated sandbox stream");
  }
}
