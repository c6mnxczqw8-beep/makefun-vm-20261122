# Tiny Stack VM

A single-file interpreter (`main.ts`, Node 22, no dependencies) for make.fun's
tiny stack ISA v1. Per-opcode tables (immediate length, pops, pushes) drive the
checks in the ISA's order — step limit, pc range, opcode, immediate fit, stack
underflow/overflow — before each instruction runs with exact reference
semantics: `Math.imul` multiplication, unsigned DIVU/MODU/LTU, 5-bit shift
counts, sign-extended PUSH8, all ten trap codes, and the output limit.
