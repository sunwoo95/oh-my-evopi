/**
 * Node-only hashing for hashline (replaces the upstream `Bun.hash` usage).
 *
 * `xxHash32` is a standard XXH32 over the UTF-8 bytes of the input, seed 0 —
 * byte-identical to `Bun.hash.xxHash32(text, 0)`, which is what mints the
 * 4-hex file-hash anchor in `format.ts`. Keeping it exact preserves the on-wire
 * hashline anchor format so snapshots and golden tests stay valid.
 *
 * `hashKey` is an internal, non-load-bearing cache key (parse/boundary caches);
 * any deterministic function suffices, so it reuses `xxHash32`.
 */

const PRIME32_1 = 0x9e3779b1;
const PRIME32_2 = 0x85ebca77;
const PRIME32_3 = 0xc2b2ae3d;
const PRIME32_4 = 0x27d4eb2f;
const PRIME32_5 = 0x165667b1;

const encoder = new TextEncoder();

function rotl(value: number, bits: number): number {
	return (value << bits) | (value >>> (32 - bits));
}

function round(acc: number, input: number): number {
	acc = (acc + Math.imul(input, PRIME32_2)) | 0;
	acc = rotl(acc, 13);
	return Math.imul(acc, PRIME32_1) | 0;
}

/** Standard XXH32 over the UTF-8 bytes of `input`. Returns an unsigned 32-bit. */
export function xxHash32(input: string, seed = 0): number {
	const data = encoder.encode(input);
	const len = data.length;
	let index = 0;
	let h32: number;

	if (len >= 16) {
		const limit = len - 16;
		let v1 = (seed + PRIME32_1 + PRIME32_2) | 0;
		let v2 = (seed + PRIME32_2) | 0;
		let v3 = (seed + 0) | 0;
		let v4 = (seed - PRIME32_1) | 0;
		do {
			v1 = round(v1, readU32(data, index));
			v2 = round(v2, readU32(data, index + 4));
			v3 = round(v3, readU32(data, index + 8));
			v4 = round(v4, readU32(data, index + 12));
			index += 16;
		} while (index <= limit);
		h32 = (rotl(v1, 1) + rotl(v2, 7) + rotl(v3, 12) + rotl(v4, 18)) | 0;
	} else {
		h32 = (seed + PRIME32_5) | 0;
	}

	h32 = (h32 + len) | 0;

	while (index + 4 <= len) {
		h32 = (h32 + Math.imul(readU32(data, index), PRIME32_3)) | 0;
		h32 = Math.imul(rotl(h32, 17), PRIME32_4) | 0;
		index += 4;
	}

	while (index < len) {
		h32 = (h32 + Math.imul(data[index]!, PRIME32_5)) | 0;
		h32 = Math.imul(rotl(h32, 11), PRIME32_1) | 0;
		index += 1;
	}

	h32 ^= h32 >>> 15;
	h32 = Math.imul(h32, PRIME32_2) | 0;
	h32 ^= h32 >>> 13;
	h32 = Math.imul(h32, PRIME32_3) | 0;
	h32 ^= h32 >>> 16;

	return h32 >>> 0;
}

function readU32(data: Uint8Array, offset: number): number {
	return (data[offset]! | (data[offset + 1]! << 8) | (data[offset + 2]! << 16) | (data[offset + 3]! << 24)) >>> 0;
}

/** Deterministic, collision-resistant cache key for internal parse caches. */
export function hashKey(text: string): string {
	return xxHash32(text, 0).toString(36);
}
