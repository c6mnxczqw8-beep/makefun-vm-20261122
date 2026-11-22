// A tiny stack virtual machine for make.fun's tiny stack ISA (v1), following
// the ISA's hard rules exactly: wrapping 32-bit arithmetic, unsigned DIVU /
// MODU / LTU, shift counts masked to 5 bits, sign-extended PUSH8, every trap
// with its own exit code, and the step and output limits. For each instance
// under the input dir it runs program.bin against input.bin and writes
// stdout.bin (the exact bytes written) and exit.txt (the exit code).
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// Per-opcode tables: immediate byte count (-1 marks a byte that is no opcode),
// values popped, values left pushed.
const IM = new Int8Array(256).fill(-1);
const PP = new Int8Array(256);
const PS = new Int8Array(256);
const def = (b, i, p, s) => { IM[b] = i; PP[b] = p; PS[b] = s; };
def(0x00, 0, 0, 0); def(0x01, 1, 0, 1); def(0x02, 4, 0, 1); // HALT PUSH8 PUSH32
def(0x03, 0, 1, 0); def(0x04, 0, 1, 2); def(0x05, 0, 2, 2); // POP DUP SWAP
def(0x06, 0, 2, 3); def(0x07, 0, 3, 3); // OVER ROT
for (let b = 0x10; b <= 0x1e; b++) def(b, 0, b === 0x17 || b === 0x1b ? 1 : 2, 1); // arithmetic, logic
def(0x20, 0, 2, 1); def(0x21, 0, 2, 1); def(0x22, 0, 2, 1); // EQ LT LTU
def(0x30, 2, 0, 0); def(0x31, 2, 1, 0); def(0x32, 2, 1, 0); // JMP JZ JNZ
def(0x33, 2, 0, 0); def(0x34, 0, 0, 0); // CALL RET
def(0x40, 0, 1, 1); def(0x41, 0, 2, 0); // LOAD STORE
def(0x50, 0, 1, 0); def(0x51, 0, 1, 0); def(0x52, 0, 0, 1); def(0x53, 0, 1, 0); // PRINT PUTC IN EXIT

// Runs one program to its end; returns the bytes it wrote and its exit code
// (a trap's code when it traps). Traps: 2 stack underflow, 3 stack overflow,
// 4 division by zero, 5 unknown opcode, 6 bad memory address, 7 call stack
// overflow, 8 RET on an empty call stack, 9 pc outside the program or a
// cut-off immediate, 10 step limit, 11 output limit.
function run(P, inp) {
  const n = P.length;
  const D = new Int32Array(256);
  const C = new Int32Array(64);
  const M = new Int32Array(256);
  const out = new Uint8Array(65536);
  let sp = 0, csp = 0, olen = 0, ip = 0, pc = 0, steps = 0;
  const end = (code) => ({ out: out.subarray(0, olen), code });
  for (;;) {
    if (steps === 1000000) return end(10);
    if (pc < 0 || pc >= n) return end(9);
    const op = P[pc];
    const im = IM[op];
    if (im < 0) return end(5);
    if (pc + im >= n) return end(9);
    steps++;
    const nx = pc + 1 + im;
    if (sp < PP[op]) return end(2);
    if (sp - PP[op] + PS[op] > 256) return end(3);
    pc = nx;
    switch (op) {
      case 0x00: return end(0); // HALT
      case 0x01: D[sp++] = (P[nx - 1] << 24) >> 24; break; // PUSH8, sign-extended
      case 0x02: D[sp++] = P[nx - 4] | (P[nx - 3] << 8) | (P[nx - 2] << 16) | (P[nx - 1] << 24); break; // PUSH32
      case 0x03: sp--; break; // POP
      case 0x04: D[sp] = D[sp - 1]; sp++; break; // DUP
      case 0x05: { const t = D[sp - 1]; D[sp - 1] = D[sp - 2]; D[sp - 2] = t; break; } // SWAP
      case 0x06: D[sp] = D[sp - 2]; sp++; break; // OVER
      case 0x07: { const a = D[sp - 3]; D[sp - 3] = D[sp - 2]; D[sp - 2] = D[sp - 1]; D[sp - 1] = a; break; } // ROT
      case 0x17: D[sp - 1] = -D[sp - 1] | 0; break; // NEG, wrapping
      case 0x1b: D[sp - 1] = ~D[sp - 1]; break; // NOT
      case 0x30: case 0x31: case 0x32: { // JMP JZ JNZ, signed offset from the next instruction
        const rel = ((P[nx - 2] | (P[nx - 1] << 8)) << 16) >> 16;
        if (op === 0x30 || (D[--sp] === 0) === (op === 0x31)) pc = nx + rel;
        break;
      }
      case 0x33: // CALL, to the unsigned absolute address in the immediate
        if (csp === 64) return end(7);
        C[csp++] = nx;
        pc = P[nx - 2] | (P[nx - 1] << 8);
        break;
      case 0x34: // RET
        if (csp === 0) return end(8);
        pc = C[--csp];
        break;
      case 0x40: { // LOAD
        const a = D[sp - 1];
        if (a < 0 || a > 255) return end(6);
        D[sp - 1] = M[a];
        break;
      }
      case 0x41: { // STORE
        const a = D[sp - 1];
        if (a < 0 || a > 255) return end(6);
        M[a] = D[sp - 2];
        sp -= 2;
        break;
      }
      case 0x50: { // PRINT: decimal ASCII; a print that would pass the limit writes nothing
        const s = '' + D[sp - 1];
        if (olen + s.length > 65536) return end(11);
        sp--;
        for (let k = 0; k < s.length; k++) out[olen++] = s.charCodeAt(k);
        break;
      }
      case 0x51: // PUTC
        if (olen === 65536) return end(11);
        out[olen++] = D[--sp] & 255;
        break;
      case 0x52: D[sp++] = ip < inp.length ? inp[ip++] : -1; break; // IN, -1 at end of input
      case 0x53: return end(D[--sp] & 255); // EXIT, the low byte of the value
      default: { // the binary operators: pop b (top) and a, push the result
        const b = D[sp - 1];
        const a = D[sp - 2];
        let r;
        switch (op) {
          case 0x10: r = (a + b) | 0; break; // ADD
          case 0x11: r = (a - b) | 0; break; // SUB
          case 0x12: r = Math.imul(a, b); break; // MUL, low 32 bits of the exact product
          case 0x13: if (b === 0) return end(4); r = a === -2147483648 && b === -1 ? a : (a / b) | 0; break; // DIV
          case 0x14: if (b === 0) return end(4); r = b === -1 ? 0 : (a % b) | 0; break; // MOD
          case 0x15: if (b === 0) return end(4); r = Math.floor((a >>> 0) / (b >>> 0)) | 0; break; // DIVU
          case 0x16: if (b === 0) return end(4); r = ((a >>> 0) % (b >>> 0)) | 0; break; // MODU
          case 0x18: r = a & b; break; // AND
          case 0x19: r = a | b; break; // OR
          case 0x1a: r = a ^ b; break; // XOR
          case 0x1c: r = a << (b & 31); break; // SHL
          case 0x1d: r = a >> (b & 31); break; // SHR, arithmetic
          case 0x1e: r = (a >>> (b & 31)) | 0; break; // SHRU, logical
          case 0x20: r = a === b ? 1 : 0; break; // EQ
          case 0x21: r = a < b ? 1 : 0; break; // LT
          default: r = (a >>> 0) < (b >>> 0) ? 1 : 0; break; // LTU
        }
        sp--;
        D[sp - 1] = r;
        break;
      }
    }
  }
}

const I = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const O = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';
for (const id of readdirSync(I).sort()) {
  const r = run(readFileSync(join(I, id, 'program.bin')), readFileSync(join(I, id, 'input.bin')));
  mkdirSync(join(O, id), { recursive: true });
  writeFileSync(join(O, id, 'stdout.bin'), r.out);
  writeFileSync(join(O, id, 'exit.txt'), r.code + '\n');
}
