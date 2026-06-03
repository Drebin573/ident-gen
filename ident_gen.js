#!/usr/bin/env node

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { parseArgs } from 'util';
import { createCanvas, Image } from 'canvas';

const DEFAULT_PALETTE_PATH = path.join(import.meta.dirname, 'palette.json');
const DEFAULT_MAX_COLORS = 32;
const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp)$/i;

class IdenticonGenerator {
	/** @type { number[][] } */
	palette;

	/**
	 * @param { object } [ options ]
	 * @param { string } [ options.palettePath ] Path to a palette source. A `.json`
	 *   file is read as an array of RGB triples; an image file
	 *   (.png/.jpg/.gif/.webp/.bmp) has its dominant colors extracted.
	 * @param { number } [ options.maxColors ] Max colors to pull from an image.
	 */
	constructor(options = {}) {
		const { palettePath = DEFAULT_PALETTE_PATH, maxColors = DEFAULT_MAX_COLORS } = options;
		this.palette = this.loadPalette(palettePath, maxColors);
	}

	/**
	 * @param { string } palettePath
	 * @param { number } maxColors
	 * @returns { number[][] }
	 */
	loadPalette(palettePath, maxColors) {
		try {
			if (IMAGE_EXT.test(palettePath)) {
				return this.extractPaletteFromImage(palettePath, maxColors);
			}
			const paletteData = JSON.parse(fs.readFileSync(palettePath, 'utf8'));
			if (!Array.isArray(paletteData)) {
				throw new Error('Palette must be an array of RGB colors');
			}
			return paletteData;
		} catch (error) {
			console.error('Error loading palette:', error.message);
			console.log('Falling back to generated palette');
			return this.generateColorPalette(DEFAULT_MAX_COLORS);
		}
	}

	/**
	 * Build a palette from an image. Two cases, chosen automatically:
	 *  - The image already has at most `maxColors` distinct colors (a swatch
	 *    strip or other intentional palette): the exact colors are used,
	 *    unchanged, in left-to-right / top-to-bottom order. No distortion.
	 *  - The image has more than `maxColors` colors (a photo): colors are quantized
	 *    by bucketing each channel and averaging within each bucket, then the
	 *    `maxColors` most frequent buckets are kept.
	 *
	 * @param { string } imagePath
	 * @param { number } maxColors
	 * @returns { number[][] }
	 */
	extractPaletteFromImage(imagePath, maxColors) {
		const img = new Image();
		img.src = fs.readFileSync(imagePath);

		const canvas = createCanvas(img.width, img.height);
		const ctx = canvas.getContext('2d');
		ctx.drawImage(img, 0, 0);
		const { data } = ctx.getImageData(0, 0, img.width, img.height);

		const step = 16; // channel bucket size; smaller = more distinct colors
		const exact = new Map();
		const buckets = new Map();
		let exactOverflow = false;
		let order = 0;

		for (let i = 0; i < data.length; i += 4) {
			if (data[i + 3] < 128) continue; // skip (semi-)transparent pixels
			const r = data[i];
			const g = data[i + 1];
			const b = data[i + 2];

			if (!exactOverflow) {
				const exactKey = (r << 16) | (g << 8) | b;
				if (!exact.has(exactKey)) {
					if (exact.size >= maxColors) {
						exactOverflow = true; // more distinct colors than we keep -> quantize
					} else {
						exact.set(exactKey, { rgb: [r, g, b], order: order++ });
					}
				}
			}

			const bucketKey = `${ Math.round(r / step) }, ${ Math.round(g / step) }, ${ Math.round(b / step) }`;
			let bucket = buckets.get(bucketKey);
			if (!bucket) {
				bucket = { r: 0, g: 0, b: 0, count: 0 };
				buckets.set(bucketKey, bucket);
			}
			bucket.r += r;
			bucket.g += g;
			bucket.b += b;
			bucket.count++;
		}

		if (buckets.size === 0) throw new Error('No opaque pixels found in palette image');

		if (!exactOverflow) {
			const palette = [...exact.values()]
				.sort((a, b) => a.order - b.order)
				.map(e => e.rgb);
			console.log(`Loaded ${ palette.length } exact colors from ${ imagePath }`);
			return palette;
		}

		const palette = [...buckets.values()]
			.sort((a, b) => b.count - a.count)
			.slice(0, maxColors)
			.map(({ r, g, b, count }) => [
				Math.round(r / count),
				Math.round(g / count),
				Math.round(b / count)
			]);
		console.log(`Extracted ${ palette.length } colors from ${ imagePath } (quantized)`);
		return palette;
	}

	/**
	 * Generate `numColors` evenly-spaced hues as RGB triples.
	 * @param { number } numColors
	 * @returns { number[][] }
	 */
	generateColorPalette(numColors) {
		const palette = [];
		for (let i = 0; i < numColors; i++) {
			const hue = i / numColors;
			const saturation = 0.8;
			const value = 0.9;

			// HSV -> RGB
			const hi = Math.floor(hue * 6);
			const f = hue * 6 - hi;
			const p = value * (1 - saturation);
			const q = value * (1 - f * saturation);
			const t = value * (1 - (1 - f) * saturation);

			let rgb;
			switch (hi % 6) {
				case 0: rgb = [value, t, p]; break;
				case 1: rgb = [q, value, p]; break;
				case 2: rgb = [p, value, t]; break;
				case 3: rgb = [p, q, value]; break;
				case 4: rgb = [t, p, value]; break;
				default: rgb = [value, p, q]; break;
			}

			palette.push(rgb.map(x => Math.floor(x * 255)));
		}
		return palette;
	}

	/**
	 * SHA-256 hash of a UUID, as a 64-char hex string (32 bytes of entropy).
	 * @param { string } uuid
	 * @returns { string }
	 */
	hashUUID(uuid) {
		return crypto.createHash('sha256').update(uuid).digest('hex');
	}

	/**
	 * Pick a palette color deterministically from the first hash byte.
	 * @param { string } hash
	 * @returns { number[] }
	 */
	colorForHash(hash) {
		const colorIndex = parseInt(hash.substring(0, 2), 16) % this.palette.length;
		return this.palette[colorIndex];
	}

	/**
	 * Decide whether the cell at (x, y) in the left half of the grid is filled.
	 * One bit of the hash drives each cell. Byte 0 is reserved for color, so
	 * cell bits are read from bytes 1..31 (wrapping to stay within the hash).
	 * @param { string } hash
	 * @param { number } x
	 * @param { number } y
	 * @param { number } size
	 * @returns { boolean }
	 */
	isPixelSet(hash, x, y, size) {
		const halfWidth = Math.ceil(size / 2);
		const bitIndex = y * halfWidth + x;
		const byteIndex = ((bitIndex >> 3) % 31) + 1;
		const byteVal = parseInt(hash.substring(byteIndex * 2, byteIndex * 2 + 2), 16);
		return (byteVal & (1 << (bitIndex % 8))) !== 0;
	}

	/**
	 * Run the generator over many UUIDs to measure color and pixel distribution.
	 * @param { number } iterations
	 * @param { number } size
	 * @param { string | null } [ seed ]
	 */
	benchmark(iterations, size, seed = null) {
		const colorCounts = new Array(this.palette.length).fill(0);
		const pixelHeatmap = Array.from({ length: size }, () => new Array(size).fill(0));
		const halfWidth = Math.ceil(size / 2);
		const nextToken = makeTokenSource(seed);

		for (let i = 0; i < iterations; i++) {
			const hash = this.hashUUID(nextToken(i));

			const colorIndex = parseInt(hash.substring(0, 2), 16) % this.palette.length;
			colorCounts[colorIndex]++;

			for (let y = 0; y < size; y++) {
				for (let x = 0; x < halfWidth; x++) {
					if (this.isPixelSet(hash, x, y, size)) {
						pixelHeatmap[y][x]++;
						pixelHeatmap[y][size - 1 - x]++; // mirror
					}
				}
			}
		}

		return { colorCounts, pixelHeatmap };
	}

	/**
	 * @param { number[][] } pixelHeatmap
	 * @param { number } size
	 */
	generateHeatmap(pixelHeatmap, size) {
		const scale = 50;
		const margin = 25;

		const canvas = createCanvas(size * scale + margin * 2, size * scale + margin * 2);
		const ctx = canvas.getContext('2d');

		const maxCount = Math.max(...pixelHeatmap.flat());
		const logMax = Math.log(maxCount + 1) || 1;

		for (let y = 0; y < size; y++) {
			for (let x = 0; x < size; x++) {
				const intensity = Math.log(pixelHeatmap[y][x] + 1) / logMax;
				const hue = 240 - intensity * 240; 
				ctx.fillStyle = `hsl(${ hue }, 100%, 50%)`;
				ctx.fillRect(x * scale + margin, y * scale + margin, scale, scale);

				ctx.fillStyle = 'white';
				ctx.font = '12px Arial';
				ctx.textAlign = 'center';
				ctx.fillText(
					pixelHeatmap[y][x].toString(),
					x * scale + margin + scale / 2,
					y * scale + margin + scale / 2
				);
			}
		}

		return canvas;
	}

	/**
	 * Resolve a color spec to an `[r, g, b]` triple. Accepts an existing RGB
	 * array, a hex string (`#ff0077`, `#f07`, or without the `#`), or a palette
	 * index (a bare integer). Returns null for empty input (use the hash color).
	 * @param { string | number | number[] | null } [ spec ]
	 * @returns { number[] | null }
	 */
	resolveColor(spec) {
		if (spec === undefined || spec === null || spec === '') return null;
		if (Array.isArray(spec)) return spec;
		const s = String(spec).trim();
		if (/^\d+$/.test(s)) {
			const index = parseInt(s, 10);
			if (index < 0 || index >= this.palette.length) {
				throw new Error(`Palette index ${ index } out of range (0–${ this.palette.length - 1 })`);
			}
			return this.palette[index];
		}
		return hexToRgb(s);
	}

	/**
	 * Render a symmetric identicon for a UUID.
	 * @param { string } uuid
	 * @param { number } size
	 * @param { number } scale
	 * @param { string | number | number[] | null } [ color ] override color
	 */
	generateIdenticon(uuid, size, scale = 25, color = null) {
		const canvas = createCanvas(size * scale, size * scale);
		const ctx = canvas.getContext('2d');

		const hash = this.hashUUID(uuid);
		const [r, g, b] = this.resolveColor(color) ?? this.colorForHash(hash);
		ctx.fillStyle = `rgb(${ r }, ${ g }, ${ b })`;

		const halfWidth = Math.ceil(size / 2);
		for (let y = 0; y < size; y++) {
			for (let x = 0; x < halfWidth; x++) {
				if (this.isPixelSet(hash, x, y, size)) {
					ctx.fillRect(x * scale, y * scale, scale, scale);
					ctx.fillRect((size - 1 - x) * scale, y * scale, scale, scale); // right side mirrors the left
				}
			}
		}

		return canvas;
	}

	/**
	 * Generate a grid of identicons.
	 * @param { number } rows
	 * @param { number } cols
	 * @param { object } options
	 */
	generateIconGrid(rows, cols, options = {}) {
		const {
			size = 8,
			iconSize = 25,
			spacing = 50,
			margin = 25,
			backgroundColor = null,
			seed = null,
			color = null
		} = options;

		const totalWidth = cols * (iconSize * size) + (cols - 1) * spacing + margin * 2;
		const totalHeight = rows * (iconSize * size) + (rows - 1) * spacing + margin * 2;

		const canvas = createCanvas(totalWidth, totalHeight);
		const ctx = canvas.getContext('2d');

		if (backgroundColor) {
			ctx.fillStyle = backgroundColor;
			ctx.fillRect(0, 0, totalWidth, totalHeight);
		}

		const nextToken = makeTokenSource(seed);
		let index = 0;
		for (let row = 0; row < rows; row++) {
			for (let col = 0; col < cols; col++) {
				const x = margin + col * (iconSize * size + spacing);
				const y = margin + row * (iconSize * size + spacing);

				const iconCanvas = this.generateIdenticon(nextToken(index++), size, iconSize, color);
				ctx.drawImage(iconCanvas, x, y);
			}
		}

		return canvas;
	}

	/**
	 * Save a grid of identicons to a PNG file.
	 * @param { number } rows
	 * @param { number } cols
	 * @param { string } filename
	 * @param { object } options
	 */
	saveIconGrid(rows, cols, filename, options = {}) {
		const canvas = this.generateIconGrid(rows, cols, options);
		writePng(filename, canvas);
	}

	/**
	 * Save an identicon to a PNG file.
	 * @param { string } uuid
	 * @param { number } size
	 * @param { string } filename
	 * @param { string | number | number[] | null } [ color ]
	 */
	saveIdenticon(uuid, size, filename, color = null) {
		const canvas = this.generateIdenticon(uuid, size, 25, color);
		writePng(filename, canvas);
	}
}

function generateRandomUUID() {
	return crypto.randomUUID();
}

/**
 * Build a function that yields hash-input tokens by index. 
 * @param { string | null } [ seed ]
 * @returns { (index: number) => string }
 */
function makeTokenSource(seed) {
	if (seed === undefined || seed === null || seed === '') {
		return () => generateRandomUUID();
	}
	return (index) => `${ seed }-${ index }`;
}

/**
 * Write a canvas to a PNG file, creating the parent directory if needed.
 * @param { string } filename
 * @param { canvas } canvas
 */
function writePng(filename, canvas) {
	fs.mkdirSync(path.dirname(filename), { recursive: true });
	fs.writeFileSync(filename, canvas.toBuffer('image/png'));
}

/**
 * Insert an index before a path's extension, e.g. out.png -> out_2.png.
 * @param { string } filename
 * @param { number } index
 * @returns { string }
 */
function withIndex(filename, index) {
	const ext = path.extname(filename);
	return `${ filename.slice(0, filename.length - ext.length) }_${ index + 1 }${ ext }`;
}

/**
 * @param { string | undefined } output
 * @param { string } fallback
 * @param { number } index
 * @param { number } total
 * @returns { string }
 */
function outputPath(output, fallback, index, total) {
	if (!output) return fallback;
	return total > 1 ? withIndex(output, index) : output;
}

/**
 * Parse a --gridSize value. "N" means an N x N grid; "MxN" means M rows by
 * N columns. Falls back to 1 x 1 for missing/invalid input.
 * @param {string} [value]
 * @returns {{ rows: number, cols: number }}
 */
function parseGrid(value) {
	if (!value) return { rows: 1, cols: 1 };
	const [rowsStr, colsStr] = String(value).toLowerCase().split('x');
	const rows = Math.max(1, parseInt(rowsStr, 10) || 1);
	const cols = colsStr === undefined ? rows : Math.max(1, parseInt(colsStr, 10) || 1);
	return { rows, cols };
}

/**
 * Parse a hex color (`#ff0077`, `ff0077`, `#f07`, or `f07`) to `[r, g, b]`.
 * @param { string } value
 * @returns { number[] }
 */
function hexToRgb(value) {
	const hex = value.replace(/^#/, '');
	if (/^[0-9a-f]{3}$/i.test(hex)) {
		return [hex[0], hex[1], hex[2]].map(c => parseInt(c + c, 16));
	}
	if (/^[0-9a-f]{6}$/i.test(hex)) {
		return [hex.slice(0, 2), hex.slice(2, 4), hex.slice(4, 6)].map(c => parseInt(c, 16));
	}
	throw new Error(`Invalid color "${ value }": use a hex code (#ff0077) or a palette index`);
}

const cliOptions = {
	size: { type: 'string', short: 's' },
	gridSize: { type: 'string', short: 'g' },
	iterations: { type: 'string', short: 'i' },
	palette: { type: 'string', short: 'p' },
	colors: { type: 'string', short: 'c' },
	color: { type: 'string' },
	output: { type: 'string', short: 'o' },
	seed: { type: 'string' },
	help: { type: 'boolean', short: 'h' }
};

const HELP = `ident_gen — deterministic, symmetric identicon generator

Usage:
  ident_gen [options]            Generate identicon(s) from random UUIDs
  ident_gen -g <spec> [options]  Generate a grid of identicons (N or MxN)
  ident_gen benchmark [options]  Generate a distribution heatmap
  ident_gen help                 Show this help

Options:
  -s, --size <n>        Identicon width/height in cells       (default: 8)
  -g, --gridSize <spec> Grid dimensions: N for N x N, or MxN   (default: 1)
						for M rows by N columns
  -i, --iterations <n>  Number of icons (or benchmark runs)   (default: 1)
  -p, --palette <path>  Palette source: a .json array of RGB triples, or an
						image. Swatch images (<= colors) are read exactly;
						photos are quantized to the most common colors.
  -c, --colors <n>      Max colors to take from a palette image (default: 32)
	  --color <c>       Force the icon color: a hex code (#ff0077) or a palette
						index (e.g. 5). Default: derived from the hash.
  -o, --output <path>   Output file path. With multiple icons, a 1-based index
						is inserted before the extension (out.png -> out_2.png).
	  --seed <string>   Reproducible output: same seed -> same icon(s). Omit
						for random UUIDs.
  -h, --help            Show this help

Examples:
  ident_gen                        # one 8x8 identicon
  ident_gen -i 5                   # five identicons
  ident_gen -s 16                  # a 16x16 identicon
  ident_gen -g 4                   # a 4x4 grid
  ident_gen -g 3x5                 # 3 rows by 5 columns
  ident_gen -o avatar.png          # write to a chosen path
  ident_gen --color "#ff0077"      # force a hex color
  ident_gen --color 5              # force palette color #5
  ident_gen --seed alice           # reproducible icon for "alice"
  ident_gen -g 4 --seed teamA      # reproducible grid
  ident_gen -p sunset.png          # colors pulled from an image
  ident_gen -p sunset.png -c 8     # ...limited to 8 colors
  ident_gen benchmark -i 10000

Output defaults to icons/ when --output is not given.`;

function main() {
	const { values, positionals } = parseArgs({ options: cliOptions, allowPositionals: true });

	if (values.help || positionals.includes('help')) {
		console.log(HELP);
		return;
	}

	const generator = new IdenticonGenerator({
		palettePath: values.palette,
		maxColors: parseInt(values.colors) || DEFAULT_MAX_COLORS
	});

	const size = parseInt(values.size) || 8;
	const { rows, cols } = parseGrid(values.gridSize);
	const iterations = parseInt(values.iterations) || 1;
	const seed = values.seed ?? null;
	const output = values.output;

	let color;
	try {
		color = generator.resolveColor(values.color);
	} catch (error) {
		console.error(`Error: ${error.message}`);
		process.exitCode = 1;
		return;
	}

	if (positionals.includes('benchmark')) {
		console.log(`Running benchmark with ${ iterations } iterations...`);

		const { colorCounts, pixelHeatmap } = generator.benchmark(iterations, size, seed);

		console.log('\nColor Usage Statistics:');
		colorCounts.forEach((count, index) => {
			const percentage = (count / iterations * 100).toFixed(2);
			console.log(`Color ${ index }: ${ count } times (${ percentage }%)`);
		});

		const filename = output || `icons/size_${ size }_heatmap.png`;
		writePng(filename, generator.generateHeatmap(pixelHeatmap, size));
		console.log(`\nHeatmap saved to: ${filename}`);
	} else if (rows * cols > 1) {
		const filename = output || `icons/size_${ size }_grid_${ rows }x${ cols }.png`;
		generator.saveIconGrid(rows, cols, filename, { size, seed, color });
		console.log(`Generated grid (${ rows }x${ cols }): ${ filename }`);
	} else {
		console.log(`Generating ${ iterations } identicon(s)...`);
		const nextToken = makeTokenSource(seed);
		for (let i = 0; i < iterations; i++) {
			const token = nextToken(i);
			const filename = outputPath(output, `icons/identicon_${ token }.png`, i, iterations);
			generator.saveIdenticon(token, size, filename, color);
			console.log(`Generated (${ i + 1 }/${ iterations }): ${ filename }`);
		}
	}
}

if (import.meta.main) {
	main();
}

export default IdenticonGenerator;
