# png-squeeze

A lossless PNG recompressor for 1280x720 RGBA screenshots, written for the
make.fun bounty "Squeeze screenshots into the smallest PNG, 27 November 2026"
(`png-squeeze-01-run-20261127`).

## What it does

`main.ts` reads every instance in `/input/<id>/image.png` and writes a
losslessly recompressed PNG to `/output/<id>/image.png`, creating the output
directories itself. Only Node's built-in modules are used; nothing is
installed, no network is touched, and the program is fully deterministic —
the same input always produces the same bytes.

## Strategy

1. **Decode** the stored input PNG with Node's built-in zlib, expanding any
   colour type to RGBA.
2. **Reduce the colour type** whenever it is exact:
   - palette (colour type 3, transparent entries first so `tRNS` stays short)
     when the image has at most 256 colours, ordered by count or by luminance;
   - grey / grey+alpha when every pixel is grey;
   - RGB (+ a `tRNS` key when the image has a single fully-transparent colour
     value) when every other pixel is opaque;
   - RGBA otherwise.
3. **Screen every form** with each fixed filter (None, Sub, Up, Average,
   Paeth) and with per-row minimum-sum filtering, deflated at zlib level 9.
   A fixed filter keeps raw bytes equal across repeated rows, which zlib's
   LZ77 then matches far better than any adaptive choice on screenshots
   (this is worth ~20% on images with large repeated areas).
4. **Refine the winner**: brute-force per-row filter choice (each trial row
   deflated at level 4 against the preceding 32 KiB of filtered data) and the
   filtered deflate strategy, keeping the smallest stream.
5. **Write a minimal PNG**: `IHDR`, `PLTE` / `tRNS` only when needed, one
   `IDAT`, `IEND`.

The work is bounded by the data, never by the clock: no wall-clock reads,
no randomness, no environment input affects the output bytes.

## Local run

```sh
mkdir -p out
MAKEFUN_INPUT_DIR=practice/input MAKEFUN_OUTPUT_DIR=out node main.ts
```

## Practice-set results (1280x720, 8 instances)

| instance | theme | bytes | points (of 1,000) |
|----------|-------|------:|------------------:|
| i001 | flat  | 12,496 | 718.37 |
| i002 | rich  | 51,852 | 705.54 |
| i003 | alpha | 106,644 | 674.38 |
| i004 | grey  | 105,605 | 696.32 |
| i005 | flat  | 16,552 | 742.25 |
| i006 | rich  | 179,219 | 688.53 |
| i007 | alpha | 60,935 | 701.40 |
| i008 | grey  | 24,897 | 714.16 |
| **total** | | | **705,118** |

For comparison, the house baseline (fixed-Paeth RGBA, zlib level 9) scores
420,399 on the same practice set. Every output pixel decodes exactly, and
two runs produce byte-identical outputs. Total runtime is ~23 s on one CPU
for all 8 instances, inside the 60 s wall budget.

## Licence

MIT — see `LICENSE`.
