import { Buffer } from "buffer";
import { sha256 } from "@noble/hashes/sha256";
import { PublicKey } from "@solana/web3.js";
import { bounded, U64_MAX } from "./math.ts";

export const utf8 = new TextEncoder();
export const discriminator = (namespace: "global" | "account" | "event", name: string): Buffer =>
  Buffer.from(sha256(utf8.encode(`${namespace}:${name}`)).slice(0, 8));
export function u8(n: number): Buffer {
  if (!Number.isInteger(n) || n < 0 || n > 255) throw new RangeError("Invalid u8");
  return Buffer.from([n]);
}
export function u16(n: number): Buffer {
  if (!Number.isInteger(n) || n < 0 || n > 65535) throw new RangeError("Invalid u16");
  const b = Buffer.alloc(2); b.writeUInt16LE(n); return b;
}
export function u32(n: number): Buffer {
  if (!Number.isSafeInteger(n) || n < 0 || n > 0xffffffff) throw new RangeError("Invalid u32");
  const b = Buffer.alloc(4); b.writeUInt32LE(n); return b;
}
export function u64(n: bigint): Buffer {
  bounded(n, U64_MAX, "u64");
  const b = Buffer.alloc(8); b.writeBigUInt64LE(n); return b;
}
export function textField(text: string, maxBytes: number, label: string, allowEmpty = false): Buffer {
  const bytes = Buffer.from(utf8.encode(text));
  if ((!allowEmpty && text.trim().length === 0) || bytes.length > maxBytes || /\p{Cc}/u.test(text)) throw new RangeError(`Invalid ${label}`);
  return Buffer.concat([u32(bytes.length), bytes]);
}
export class Reader {
  offset = 0;
  constructor(readonly data: Buffer) {}
  take(length: number): Buffer {
    if (!Number.isSafeInteger(length) || length < 0 || this.offset + length > this.data.length) throw new Error("Truncated account data");
    const result = this.data.subarray(this.offset, this.offset + length); this.offset += length; return result;
  }
  byte(): number { return this.take(1)[0]; }
  short(): number { return this.take(2).readUInt16LE(0); }
  int(): number { return this.take(4).readUInt32LE(0); }
  long(): bigint { return this.take(8).readBigUInt64LE(0); }
  wide(): bigint { return this.long() + (this.long() << 64n); }
  key(): PublicKey { return new PublicKey(this.take(32)); }
  text(max: number, allowEmpty = false): string {
    const length = this.int();
    if ((!allowEmpty && length === 0) || length > max) throw new Error("Invalid account text length");
    const value = new TextDecoder("utf-8", { fatal: true }).decode(this.take(length));
    if ((!allowEmpty && value.trim().length === 0) || /\p{Cc}/u.test(value)) throw new Error("Invalid account text");
    return value;
  }
  finish(): void { if (this.take(this.data.length - this.offset).some((x) => x !== 0)) throw new Error("Unexpected account data suffix"); }
}
