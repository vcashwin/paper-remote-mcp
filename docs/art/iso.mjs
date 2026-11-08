// Isometric illustration kit: drawing and motion primitives that return SVG strings. Pure functions, no DOM, so the same
// code runs in Node (stills, frames) and in a browser (the video player). Every animated drawing is a function of time `t`.
//
// The language is Linear / Linefold's empty-state and onboarding art: rounded cards in a 30° isometric projection, faces
// filled with the background and outlined in label tones that dim from base (the hero) to shade (the farthest ghost),
// dotted lines for text, a thick bar for a title, dashed rings for boundaries, slabs whose lower outline peeks out under the
// top face, and colour only on what moves or matters. See ../STYLE.md.

// ── palette: Linefold's themes (bg exact, outline tones lifted a little so 2px lines read at 1080p) + accents ──
export const THEMES = {
  dark: {
    bg: "lch(5.52% 0.4 272)", shade: "lch(9% 0.85 272)", border: "lch(20% 1.48 272)", thin: "lch(28% 1.48 272)",
    faint: "lch(40% 1.2 272)", muted: "lch(62% 1.2 272)", base: "lch(90.5% 1.2 272)", title: "lch(100% 0 272)",
    blue: "lch(72% 48 262)", teal: "lch(76% 38 200)", yellow: "lch(86% 62 88)", green: "lch(74% 52 145)",
    purple: "lch(70% 48 298)", orange: "lch(74% 55 58)", red: "lch(66% 62 30)",
  },
  light: {
    bg: "lch(97.94% 0.5 282)", shade: "lch(90% 0.5 282)", border: "lch(81% 0.5 282)", thin: "lch(72% 1 282)",
    faint: "lch(60% 1.25 282)", muted: "lch(42% 1.25 282)", base: "lch(19.6% 1.25 282)", title: "lch(9.8% 0 282)",
    blue: "lch(50% 62 262)", teal: "lch(55% 40 200)", yellow: "lch(68% 70 80)", green: "lch(55% 55 145)",
    purple: "lch(48% 58 298)", orange: "lch(60% 65 55)", red: "lch(50% 65 30)",
  },
};
/** the live palette: every piece reads it when called, so switch themes before drawing */
export const P = { ...THEMES.dark };
/** "dark" | "light" | an object of overrides (e.g. CSS variables: { base: "var(--color-label-base)" }) */
export const useTheme = th => Object.assign(P, typeof th === "string" ? THEMES[th] : th);
/** outline width in px of the canvas: 2 on a 1920×1080 frame, 1.5 on a ~280px spot illustration */
export let SW = 2;
export const setStroke = w => { SW = w; };

// ── time ──
export const clamp = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x));
export const lerp = (a, b, u) => a + (b - a) * u;
/** 3b1b's "smooth": slow out, slow in */
export const smooth = u => { u = clamp(u); return u * u * u * (u * (u * 6 - 15) + 10); };
/** the onboarding entrance curve, cubic-bezier(.16, 1, .3, 1), close enough: expo out */
export const expo = u => { u = clamp(u); return u === 1 ? 1 : 1 - Math.pow(2, -10 * u); };
/** progress of something that starts at `at` and takes `d` seconds */
export const k = (t, at, d = 0.8, f = smooth) => f((t - at) / d);
/** visible from `a` (fading in) until `b` (fading out) */
export const vis = (t, a, b = Infinity, d = 0.45) => Math.min(k(t, a, d), 1 - k(t, b, d));

// ── svg ──
const n = x => Math.round(x * 100) / 100;
export const pt = q => `${n(q[0])} ${n(q[1])}`;

export function G(inner, { o = 1, x = 0, y = 0, s = 1, at = [0, 0], r = 0 } = {}) {
  if (o <= 0.001 || !inner) return "";
  const tr = [];
  if (x || y) tr.push(`translate(${n(x)} ${n(y)})`);
  if (s !== 1 || r) tr.push(`translate(${n(at[0])} ${n(at[1])})`, s !== 1 ? `scale(${n(s * 1000) / 1000})` : "", r ? `rotate(${n(r)})` : "", `translate(${n(-at[0])} ${n(-at[1])})`);
  const a = [tr.length ? `transform="${tr.join(" ")}"` : "", o < 1 ? `opacity="${n(o * 1000) / 1000}"` : ""].join(" ");
  return `<g ${a}>${inner}</g>`;
}
/** an entrance: rises (or slides from `from`) and fades in at `at`, as the onboarding art's `In` */
export const In = (t, at, inner, from = [0, 14], d = 0.7) => {
  const u = k(t, at, d, expo);
  return u <= 0 ? "" : G(inner, { o: clamp((t - at) / (d * 0.6)), x: from[0] * (1 - u), y: from[1] * (1 - u) });
};
/** a pop: scales from 0 with a little overshoot */
export const Pop = (t, at, c, inner, d = 0.45) => {
  const u = clamp((t - at) / d);
  if (u <= 0) return "";
  const s = u >= 1 ? 1 : 1 + 2.2 * Math.pow(u - 1, 3) + 1.2 * Math.pow(u - 1, 2);
  return G(inner, { s, at: c, o: clamp(u * 3) });
};

export const face = (d, stroke, fill = P.bg, w = SW) => `<path d="${d}" fill="${fill}" stroke="${stroke}" stroke-width="${w}" stroke-linejoin="round"/>`;
export const stroke = (d, c, w = SW, extra = "") => `<path d="${d}" fill="none" stroke="${c}" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round" ${extra}/>`;
export const dots = (d, c = P.border, w = SW) => stroke(d, c, w, `stroke-dasharray="${w * 0.01} ${w * 2.6}"`);
export const bar = (d, c = P.muted, w = SW) => stroke(d, c, w * 2.6);
export const ring = (d, c = P.border, w = SW) => stroke(d, c, w, `stroke-dasharray="${w * 2} ${w * 8 / 3}"`);
export const glyph = (d, c = P.muted) => `<path d="${d}" fill="${c}"/>`;

export const SANS = "Inter Variable, Inter, system-ui, sans-serif";
export const MONO = "Berkeley Mono, JetBrains Mono, SF Mono, ui-monospace, Menlo, monospace";
export function text(x, y, s, { size = 26, weight = 560, color = P.base, anchor = "middle", mono = false, o = 1, ls = 0, italic = false, accent = P.yellow } = {}) {
  if (o <= 0.001) return "";
  const fam = mono ? MONO : SANS;
  return `<text x="${n(x)}" y="${n(y)}" font-family="${fam}" font-size="${size}" font-weight="${weight}" fill="${color}" text-anchor="${anchor}"` +
    `${o < 1 ? ` opacity="${n(o)}"` : ""}${ls ? ` letter-spacing="${ls}"` : ""}${italic ? ` font-style="italic"` : ""}>${rich(s, accent)}</text>`;
}
const esc = s => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
/** `**word**` is emphasised in `accent` (text()'s `accent` option), `*word*` italic */
export function rich(s, accent = P.yellow) {
  return esc(s).replace(/\*\*(.+?)\*\*/g, `<tspan fill="${accent}" font-weight="640">$1</tspan>`).replace(/\*(.+?)\*/g, `<tspan font-style="italic">$1</tspan>`);
}
/** a name above a muted sub-line */
export const caption2 = (x, y, a, b, o = 1, { size = 25, color = P.base, sub = P.muted, mono = false, anchor = "middle" } = {}) =>
  text(x, y, a, { size, weight: 600, color, o, anchor }) + (b ? text(x, y + size * 1.15, b, { size: size * 0.72, weight: 450, color: sub, o, mono, anchor }) : "");

/** a pill-shaped chip with a label */
export function chip(x, y, s, { color = P.muted, fill = P.bg, size = 19, mono = false, o = 1, pad = 14, w } = {}) {
  if (o <= 0.001) return "";
  const width = w ?? s.length * size * (mono ? 0.62 : 0.56) + pad * 2, h = size * 1.75;
  return G(`<rect x="${n(x - width / 2)}" y="${n(y - h / 2)}" width="${n(width)}" height="${n(h)}" rx="${n(h / 2)}" fill="${fill}" stroke="${color}" stroke-width="${SW * 0.75}"/>` +
    text(x, y + size * 0.36, s, { size, weight: 500, color: P.base, mono }), { o });
}

// ── isometric ──
/** A projector placed at screen point (ox, oy) with scale S: 30° isometric, +x runs down-right, +y down-left, +z up */
export function iso(ox, oy, S = 1) {
  const C = Math.cos(Math.PI / 6) * S;
  const at = (x, y, z = 0) => [ox + (x - y) * C, oy + ((x + y) / 2 - z) * S];
  return {
    at, S, C, ox, oy,
    /** a plane lying flat at height z, centred on (x, y): u (the reading direction) runs up-right, v down-right */
    flat: (x = 0, y = 0, z = 0, deg = 0) => { const c = Math.cos(deg * Math.PI / 180), s = Math.sin(deg * Math.PI / 180); return (u, v) => at(x + u * s + v * c, y - u * c + v * s, z); },
    /** an upright plane facing down-right, top edge at z: u runs up-right, v downwards */
    wall: (x = 0, y = 0, z = 0) => (u, v) => at(x, y - u, z - v),
    /** an upright plane facing down-left, top edge at z: u runs down-right, v downwards */
    wallL: (x = 0, y = 0, z = 0) => (u, v) => at(x + u, y, z - v),
  };
}
const P2 = (pl, u, v) => pt(pl(u, v));
/** a rounded rectangle centred on (cx, cy) in a plane (the projection is affine, so projected Béziers are exact) */
export function rect(pl, cx, cy, w, h, r) {
  r = Math.min(r, w / 2, h / 2);
  const q = r * 0.5523, x0 = cx - w / 2, x1 = cx + w / 2, y0 = cy - h / 2, y1 = cy + h / 2;
  return `M${P2(pl, x0 + r, y0)}L${P2(pl, x1 - r, y0)}C${P2(pl, x1 - r + q, y0)} ${P2(pl, x1, y0 + r - q)} ${P2(pl, x1, y0 + r)}` +
    `L${P2(pl, x1, y1 - r)}C${P2(pl, x1, y1 - r + q)} ${P2(pl, x1 - r + q, y1)} ${P2(pl, x1 - r, y1)}` +
    `L${P2(pl, x0 + r, y1)}C${P2(pl, x0 + r - q, y1)} ${P2(pl, x0, y1 - r + q)} ${P2(pl, x0, y1 - r)}` +
    `L${P2(pl, x0, y0 + r)}C${P2(pl, x0, y0 + r - q)} ${P2(pl, x0 + r - q, y0)} ${P2(pl, x0 + r, y0)}Z`;
}
export const circle = (pl, cx, cy, r) => rect(pl, cx, cy, r * 2, r * 2, r);
export function poly(pl, pts, r) {
  let d = "";
  pts.forEach((q, i) => {
    const towards = o => { const dx = o[0] - q[0], dy = o[1] - q[1], l = Math.hypot(dx, dy); return [q[0] + dx / l * r, q[1] + dy / l * r]; };
    const a = towards(pts[(i + pts.length - 1) % pts.length]), b = towards(pts[(i + 1) % pts.length]);
    d += `${i ? "L" : "M"}${P2(pl, ...a)}Q${P2(pl, ...q)} ${P2(pl, ...b)}`;
  });
  return d + "Z";
}
export const hex = (pl, cx, cy, R, r) => poly(pl, [0, 1, 2, 3, 4, 5].map(i => [cx + R * Math.cos(Math.PI / 3 * i), cy + R * Math.sin(Math.PI / 3 * i)]), r);
export const line = (pl, ...pts) => pts.map((q, i) => `${i ? "L" : "M"}${P2(pl, ...q)}`).join("");
/** an arc of a circle in a plane, from angle a0 to a1 (radians) */
export const arcIn = (pl, cx, cy, r, a0, a1, steps = 24) => line(pl, ...Array.from({ length: steps + 1 }, (_, i) => { const a = a0 + (a1 - a0) * i / steps; return [cx + r * Math.cos(a), cy + r * Math.sin(a)]; }));

// ── the pieces (each drawn around its projector's origin) ──
/** a shape on a flat plane at z, with the two ghost copies it rests on (the onboarding stack) */
export const ghosts = (W, shape, z = 0, gap = 7) => face(shape(W.flat(0, gap * 2, z - gap * 2)), P.shade) + face(shape(W.flat(0, gap, z - gap)), P.border);
/** a slab: the shape's lower outline peeking out under its top face */
export const slab = (W, shape, z, t = P.base, under = P.faint, x = 0, y = 0, depth = 4) => face(shape(W.flat(x, y, z - depth)), under) + face(shape(W.flat(x, y, z)), t);

export const person = (pl, cx, cy, k, c = P.muted) => glyph(circle(pl, cx, cy - 5 * k, 4.6 * k), c) + glyph(rect(pl, cx, cy + 6.5 * k, 17 * k, 8 * k, 4 * k), c);

/** an issue card: a status dot, a title, two dotted lines */
export function issueCard(W, z = 0, t = P.base, dot = P.muted, x = 0, y = 0) {
  const pl = W.flat(x, y, z), ink = t === P.base ? P.muted : P.border;
  return face(rect(pl, 0, 0, 48, 56, 6), t) + face(circle(pl, -12, -15, 4), dot, dot === P.muted ? P.bg : dot) +
    dots(line(pl, [-4, -15], [14, -15]), ink) + dots(line(pl, [-14, -3], [14, -3])) + dots(line(pl, [-14, 8], [6, 8]));
}
/** a document: a heading bar and dotted lines */
export function docCard(W, z = 0, t = P.base, x = 0, y = 0) {
  const pl = W.flat(x, y, z);
  return face(rect(pl, 0, 0, 52, 66, 6), t) + bar(line(pl, [-16, -20], [10, -20]), P.muted) +
    [-8, 2, 12, 22].map((v, i) => dots(line(pl, [-16, v], [i % 2 ? 8 : 16, v]))).join("");
}
/** a stack of cards: primitives */
export function cardStack(W, z = 0, accent = P.muted) {
  const card = pl => rect(pl, 0, 0, 78, 60, 8), top = W.flat(0, 0, z);
  return ghosts(W, card, z) + slab(W, card, z, P.base) + face(circle(top, -22, -13, 5), accent, accent) +
    bar(line(top, [-10, -13], [22, -13])) + dots(line(top, [-26, 2], [26, 2])) + dots(line(top, [-26, 14], [12, 14]));
}
/** a hexagonal tile with a person glyph (the onboarding Teams tile) */
export const personTile = (W, z = 0, t = P.base, under = P.faint, R = 28, x = 0, y = 0) =>
  slab(W, pl => hex(pl, 0, 0, R, 6), z, t, under, x, y) + person(W.flat(x, y, z), 0, 0, R / 25.5);

/** a four-point spark (the triage empty state's sparkle) in screen space */
export const spark = ([cx, cy], r, c = P.base) => {
  const q = r * 0.16;
  return glyph(`M${n(cx)} ${n(cy - r)}Q${n(cx + q)} ${n(cy - q)} ${n(cx + r)} ${n(cy)}Q${n(cx + q)} ${n(cy + q)} ${n(cx)} ${n(cy + r)}Q${n(cx - q)} ${n(cy + q)} ${n(cx - r)} ${n(cy)}Q${n(cx - q)} ${n(cy - q)} ${n(cx)} ${n(cy - r)}Z`, c);
};
/** an upright window (a terminal when `term`), standing on its bottom edge at z: the onboarding Agent scene */
export function windowUp(W, { z = 60, w = 120, h = 72, t = P.base, term = true, ghosts: g = true, cursor = 1, x = 0, y = 0 } = {}) {
  const win = pl => rect(pl, 0, h / 2, w, h, 9), wl = W.wall(x, y, z);
  let s = g ? face(win(W.wall(x - 24, y, z)), P.shade) + face(win(W.wall(x - 12, y, z)), P.border) + face(win(W.wall(x - 4, y, z)), P.faint) : "";
  s += face(win(wl), t) + stroke(line(wl, [-w / 2, 13], [w / 2, 13]), P.faint);
  s += [0, 6, 12].map(d => glyph(circle(wl, -w / 2 + 9 + d, 6.5, 2.2), P.faint)).join("");
  if (term) {
    const L = -w / 2 + 9;
    s += stroke(line(wl, [L, 24], [L + 5, 28.5], [L, 33]), P.muted) + bar(line(wl, [L + 13, 28.5], [L + 47, 28.5])) +
      dots(line(wl, [L, 43], [L + 75, 43])) + dots(line(wl, [L, 53], [L + 57, 53]));
    if (h > 64) s += stroke(line(wl, [L, 59], [L + 5, 63.5], [L, 68]), P.muted) + (cursor > 0.5 ? glyph(rect(wl, L + 15, 63.5, 5, 9, 1), P.base) : "");
  } else {
    s += bar(line(wl, [-w / 2 + 12, 28], [-w / 2 + 52, 28])) + dots(line(wl, [-w / 2 + 12, 42], [w / 2 - 20, 42])) + dots(line(wl, [-w / 2 + 12, 54], [w / 2 - 40, 54]));
  }
  return s;
}
/** a laptop: a base slab and its screen standing at the back edge */
export function laptop(W, { t = P.base, screen = P.base, lines = true, z = 0 } = {}) {
  const sc = W.wall(-34, 0, z + 64);
  let s = face(rect(sc, 0, 32, 100, 64, 7), screen) + face(rect(sc, 0, 32, 88, 52, 4), P.border, P.shade);
  if (lines) s += bar(line(sc, [-36, 18], [-6, 18]), P.muted) + dots(line(sc, [-36, 30], [30, 30])) + dots(line(sc, [-36, 41], [14, 41]));
  return s + slab(W, pl => rect(pl, 0, 0, 104, 68, 8), z, t, P.faint, 0, 0, 5) + face(rect(W.flat(6, 0, z), 0, 0, 70, 32, 4), P.border, P.shade);
}
/** a box with its two visible sides (w along y, d along x, h up) */
export function box(W, { w = 80, d = 80, h = 30, z = 0, x = 0, y = 0, t = P.base, side = P.shade, r = 4 } = {}) {
  const top = W.flat(x, y, z + h), R = W.wall(x + d / 2, y, z + h), L = W.wallL(x, y + w / 2, z + h);
  return face(rect(L, 0, h / 2, d, h, Math.min(r, 3)), t, side) + face(rect(R, 0, h / 2, w, h, Math.min(r, 3)), t, side) + face(rect(top, 0, 0, w, d, r), t);
}
/** a server: stacked boxes, each with two status lights on its right face */
export function server(W, { units = 3, t = P.base, lights = [], w = 92, d = 72, h = 22, gap = 6 } = {}) {
  let s = "";
  for (let i = 0; i < units; i++) {
    const z = i * (h + gap);
    s += box(W, { w, d, h, z, t });
    const R = W.wall(d / 2, 0, z + h);
    s += glyph(circle(R, w / 2 - 12, h / 2, 2.6), lights[i] ?? P.faint) + glyph(circle(R, w / 2 - 21, h / 2, 2.6), P.faint) + dots(line(R, [-w / 2 + 10, h / 2], [w / 2 - 34, h / 2]));
  }
  return s;
}
/** a database cylinder: radius r, height h, bands across its front */
export function cylinder(W, { r = 44, h = 70, t = P.base, bands = 2, z = 0, fill = P.bg } = {}) {
  const rx = r * W.C * Math.SQRT2, ry = r * W.S / Math.SQRT2, [cx, top] = W.at(0, 0, z + h), [, bot] = W.at(0, 0, z);
  const arc = y => `M${n(cx - rx)} ${n(y)}A${n(rx)} ${n(ry)} 0 0 0 ${n(cx + rx)} ${n(y)}`;
  let s = `<path d="M${n(cx - rx)} ${n(top)}L${n(cx - rx)} ${n(bot)}A${n(rx)} ${n(ry)} 0 0 0 ${n(cx + rx)} ${n(bot)}L${n(cx + rx)} ${n(top)}Z" fill="${fill}" stroke="${t}" stroke-width="${SW}" stroke-linejoin="round"/>`;
  for (let i = 1; i <= bands; i++) s += stroke(arc(top + (bot - top) * i / (bands + 1)), P.faint);
  return s + `<ellipse cx="${n(cx)}" cy="${n(top)}" rx="${n(rx)}" ry="${n(ry)}" fill="${fill}" stroke="${t}" stroke-width="${SW}"/>`;
}
/** an upright clock whose hands turn with `a` (hours, fractional: 10.1 reads well; 1 puts both hands near 12) */
export function clock(W, a, { R = 34, z = 70, t = P.base, hand = P.base, x = 0, y = 0 } = {}) {
  const wl = W.wall(x, y, z), c = [0, R + 2];
  let s = face(circle(W.wall(x - 6, y, z), 0, R + 2, R), P.faint) + face(circle(wl, ...c, R), t);
  for (let i = 0; i < 12; i++) { const b = i / 12 * Math.PI * 2; s += stroke(line(wl, [c[0] + Math.cos(b) * R * 0.78, c[1] + Math.sin(b) * R * 0.78], [c[0] + Math.cos(b) * R * 0.86, c[1] + Math.sin(b) * R * 0.86]), P.faint); }
  const hA = a / 12 * Math.PI * 2 - Math.PI / 2, mA = a * Math.PI * 2 - Math.PI / 2;
  s += stroke(line(wl, c, [c[0] + Math.cos(hA) * R * 0.45, c[1] + Math.sin(hA) * R * 0.45]), hand, SW * 1.6);
  s += stroke(line(wl, c, [c[0] + Math.cos(mA) * R * 0.7, c[1] + Math.sin(mA) * R * 0.7]), hand, SW * 1.2);
  return s + glyph(circle(wl, ...c, 3), hand);
}
/** a padlock: a body box and its shackle */
export function padlock(W, { t = P.base, open = 0, z = 0, s = 1 } = {}) {
  const sh = W.wall(0, 0, z + 36 * s + 30 * s + open * 10 * s);
  return stroke(arcIn(sh, 0, 30 * s, 17 * s, Math.PI, 2 * Math.PI) + line(sh, [-17 * s, 30 * s], [-17 * s, 40 * s]) + line(sh, [17 * s, 30 * s], [17 * s, 40 * s - open * 10 * s]), t, SW * 2.4) +
    box(W, { w: 56 * s, d: 22 * s, h: 40 * s, z, t, r: 5 }) + glyph(circle(W.wall(11 * s, 0, z + 40 * s), 0, 15 * s, 4.5 * s), t) + glyph(rect(W.wall(11 * s, 0, z + 40 * s), 0, 23 * s, 3.5 * s, 10 * s, 1), t);
}
/** a key lying flat */
export const keyGlyph = (pl, c = P.base) => face(circle(pl, -16, 0, 9), c) + stroke(line(pl, [-7, 0], [22, 0]) + line(pl, [14, 0], [14, 7]) + line(pl, [20, 0], [20, 6]), c, SW * 1.6);
/** an envelope lying flat (the onboarding Invite scene) */
export const envelope = (pl, t = P.base, flap = P.muted, seal = P.muted) =>
  face(rect(pl, 0, 0, 88, 60, 9), t) + stroke(line(pl, [-40, -26], [0, 4], [40, -26]), flap) + (seal ? glyph(circle(pl, 0, 4, 5), seal) : "");
/** a branch that merges (the onboarding Code scene) on a card */
export function branchCard(W, { z = 0, t = P.base, merged = P.base } = {}) {
  const card = pl => rect(pl, 0, 0, 132, 88, 10), top = W.flat(0, 0, z), p2 = (u, v) => P2(top, u, v);
  const br = line(top, [-34, 12]) + `C${p2(-20, 12)} ${p2(-22, -14)} ${p2(-6, -14)}L${p2(14, -14)}C${p2(30, -14)} ${p2(28, 12)} ${p2(42, 12)}`;
  return ghosts(W, card, z) + slab(W, card, z, t) + stroke(line(top, [-54, 12], [54, 12]), P.muted) + stroke(br, P.base) +
    face(circle(top, -34, 12, 4.5), P.muted) + face(circle(top, -6, -14, 4.5), P.muted) + face(circle(top, 14, -14, 4.5), P.muted) +
    face(circle(top, 42, 12, 7.5), merged) + glyph(circle(top, 42, 12, 3), merged);
}
/** a done-list card (the onboarding Finish scene): three rows ticked as `p` goes 0 → 1 */
export function checkCard(W, p = 1, { z = 0, tick = P.green } = {}) {
  const card = pl => rect(pl, 0, 0, 120, 92, 10), top = W.flat(0, 0, z);
  let s = ghosts(W, card, z) + slab(W, card, z, P.base);
  [-24, 0, 24].forEach((v, i) => {
    s += face(rect(top, -38, v, 13, 13, 3.5), P.muted) + (i === 0 ? bar(line(top, [-22, v], [22, v])) : dots(line(top, [-22, v], [i === 1 ? 40 : 28, v])));
    if (p > i / 3 + 0.1) s += stroke(line(top, [-42, v - 0.5], [-39.5, v + 3], [-33.5, v - 4]), tick, SW * 1.5);
  });
  return s;
}
/** a ring that loops back on itself with an arrowhead, its dashes turning with `a` */
export function loopRing(W, a = 0, { R = 34, z = 0, c = P.base } = {}) {
  const pl = W.flat(0, 0, z), a0 = a, a1 = a + Math.PI * 1.6;
  const tip = [Math.cos(a1) * R, Math.sin(a1) * R], dir = [-Math.sin(a1), Math.cos(a1)], nrm = [Math.cos(a1), Math.sin(a1)];
  return stroke(arcIn(pl, 0, 0, R, a0, a1, 40), c, SW * 1.6) +
    glyph(line(pl, [tip[0] + dir[0] * 12, tip[1] + dir[1] * 12], [tip[0] + nrm[0] * 8, tip[1] + nrm[1] * 8], [tip[0] - nrm[0] * 8, tip[1] - nrm[1] * 8]) + "Z", c);
}
/** a sandbox: a dashed box around something */
export function dashedBox(W, { w = 120, d = 110, h = 90, z = 0, c = P.muted } = {}) {
  const T = W.flat(0, 0, z + h), B = W.flat(0, 0, z);
  let s = ring(rect(T, 0, 0, w, d, 6), c) + ring(rect(B, 0, 0, w, d, 6), c);
  // the three vertical edges that face the viewer: (u, v) = corners in the flat plane's coordinates
  [[-w / 2, d / 2], [w / 2, d / 2], [w / 2, -d / 2]].forEach(q => { s += ring(`M${pt(T(...q))}L${pt(B(...q))}`, c); });
  return s;
}

/** a row in screen space: a rounded box with a coloured dot and a label (a table row, a log line, a queue item) */
export function row(x, y, w, s, { dot: dc = P.muted, mono = false, size = 20, o = 1, edge = P.border, h = 46, fill = P.bg } = {}) {
  if (o <= 0.001) return "";
  return G(`<rect x="${n(x - w / 2)}" y="${n(y - h / 2)}" width="${w}" height="${h}" rx="11" fill="${fill}" stroke="${edge}" stroke-width="${SW * 0.8}"/>` +
    `<circle cx="${n(x - w / 2 + 22)}" cy="${n(y)}" r="6" fill="${dc}"/>` + text(x - w / 2 + 40, y + size * 0.36, s, { size, mono, anchor: "start", weight: mono ? 450 : 500 }), { o });
}
/** a failure mark and a success mark in screen space */
export const cross = (x, y, r = 12, c = P.red, o = 1) => G(stroke(`M${n(x - r)} ${n(y - r)}L${n(x + r)} ${n(y + r)}M${n(x + r)} ${n(y - r)}L${n(x - r)} ${n(y + r)}`, c, SW * 1.7), { o });
export const tick = (x, y, r = 12, c = P.green, o = 1) => G(stroke(`M${n(x - r)} ${n(y)}L${n(x - r * 0.3)} ${n(y + r * 0.7)}L${n(x + r)} ${n(y - r * 0.75)}`, c, SW * 1.7), { o });

/** a dashed rounded rectangle in screen space around a group: a boundary (a transaction, a trust zone, something planned) */
export const zone = (x, y, w, h, c = P.muted, { r = 18, label = "" } = {}) =>
  `<rect x="${n(x)}" y="${n(y)}" width="${n(w)}" height="${n(h)}" rx="${r}" fill="none" stroke="${c}" stroke-width="${SW}" stroke-dasharray="${SW * 3} ${SW * 3}"/>` +
  (label ? text(x + 20, y - 14, label.toUpperCase(), { size: 17, weight: 600, color: c, anchor: "start", ls: 2 }) : "");

// ── connectors (screen space) ──
/** a quadratic curve from a to b with arc-length lookups. `bend` moves the control point sideways by that many px, so the
 *  curve's apex is ~bend/2 off the straight line; negative bows up for a left→right curve (the sign flips with direction) */
export function curve(a, b, bend = 0) {
  const dx = b[0] - a[0], dy = b[1] - a[1], L = Math.hypot(dx, dy) || 1;
  const c = [(a[0] + b[0]) / 2 - dy / L * bend, (a[1] + b[1]) / 2 + dx / L * bend];
  const at = u => [(1 - u) ** 2 * a[0] + 2 * (1 - u) * u * c[0] + u * u * b[0], (1 - u) ** 2 * a[1] + 2 * (1 - u) * u * c[1] + u * u * b[1]];
  const tan = u => [2 * (1 - u) * (c[0] - a[0]) + 2 * u * (b[0] - c[0]), 2 * (1 - u) * (c[1] - a[1]) + 2 * u * (b[1] - c[1])];
  const N = 32, cum = [0];
  for (let i = 1; i <= N; i++) { const p = at(i / N), q = at((i - 1) / N); cum.push(cum[i - 1] + Math.hypot(p[0] - q[0], p[1] - q[1])); }
  const len = cum[N];
  /** the parameter at a fraction of the length */
  const u = f => { const L2 = clamp(f) * len; let i = 1; while (i < N && cum[i] < L2) i++; const s0 = cum[i - 1], s1 = cum[i]; return (i - 1 + (s1 > s0 ? (L2 - s0) / (s1 - s0) : 0)) / N; };
  return { d: `M${pt(a)}Q${pt(c)} ${pt(b)}`, at, tan, u, len, a, b, sub: (f0, f1) => sub(at, u, f0, f1) };
}
function sub(at, u, f0, f1) {
  const pts = Array.from({ length: 25 }, (_, i) => at(u(f0 + (f1 - f0) * i / 24)));
  return pts.map((q, i) => `${i ? "L" : "M"}${pt(q)}`).join("");
}
/** points of a polyline as a curve-like object (straight segments) */
export function path(...pts) {
  const seg = pts.slice(1).map((q, i) => Math.hypot(q[0] - pts[i][0], q[1] - pts[i][1])), len = seg.reduce((a, b) => a + b, 0);
  const atF = f => { let L2 = clamp(f) * len; for (let i = 0; i < seg.length; i++) { if (L2 <= seg[i] || i === seg.length - 1) { const w = seg[i] ? L2 / seg[i] : 0; return [lerp(pts[i][0], pts[i + 1][0], w), lerp(pts[i][1], pts[i + 1][1], w)]; } L2 -= seg[i]; } };
  const tanF = f => { let L2 = clamp(f) * len; for (let i = 0; i < seg.length; i++) { if (L2 <= seg[i] || i === seg.length - 1) return [pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1]]; L2 -= seg[i]; } };
  return { d: pts.map((q, i) => `${i ? "L" : "M"}${pt(q)}`).join(""), at: atF, tan: tanF, u: f => f, len, a: pts[0], b: pts[pts.length - 1], sub: (f0, f1) => sub(atF, f => f, f0, f1) };
}
const head = (c, f, color, size = 13) => {
  const q = c.at(c.u(f)), tg = c.tan(c.u(f)), L = Math.hypot(...tg) || 1, ux = tg[0] / L, uy = tg[1] / L;
  return glyph(`M${pt([q[0] + ux * 2, q[1] + uy * 2])}L${pt([q[0] - ux * size - uy * size * 0.55, q[1] - uy * size + ux * size * 0.55])}L${pt([q[0] - ux * size * 0.62, q[1] - uy * size * 0.62])}L${pt([q[0] - ux * size + uy * size * 0.55, q[1] - uy * size - ux * size * 0.55])}Z`, color);
};
/** draws a connector on from `at` over `d` seconds; dashed for feedback paths; `both` puts a head at each end */
export function arrow(t, at, c, { color = P.muted, d = 0.9, dashed = false, heads = 1, w = 2.4, o = 1, trim = [0, 0] } = {}) {
  const p = k(t, at, d);
  if (p <= 0 || o <= 0) return "";
  const f0 = trim[0] / c.len, f1 = 1 - trim[1] / c.len, f = lerp(f0, f1, p);
  let s = stroke(c.sub(f0, f), color, w, dashed ? `stroke-dasharray="${w * 3} ${w * 3}"` : "");
  if (heads >= 1) s += head(c, f, color);
  if (heads >= 2 && p > 0.05) s += head({ ...c, tan: u => c.tan(u).map(v => -v) }, f0, color);
  return G(s, { o });
}
/** packets travelling along a connector: `n` of them, one every `period` seconds, from `at` until `until`; `trim` px off each
 *  end (as the arrow's) so they don't ride over the pieces */
export function packets(t, c, { at = 0, until = Infinity, period = 1.6, travel = 1.4, color = P.yellow, r = 6, n: count = 99, reverse = false, trim = [0, 0] } = {}) {
  let s = "";
  for (let i = 0; i < count; i++) {
    const t0 = at + i * period;
    if (t0 > t || t0 > until) break;
    const f = (t - t0) / travel;
    if (f > 1) continue;
    const g = lerp(trim[0] / c.len, 1 - trim[1] / c.len, smooth(f)), q = c.at(c.u(reverse ? 1 - g : g)), o = Math.min(1, f * 6, (1 - f) * 6);
    s += `<circle cx="${n(q[0])}" cy="${n(q[1])}" r="${n(r * 2.4)}" fill="${color}" opacity="${n(0.16 * o)}"/><circle cx="${n(q[0])}" cy="${n(q[1])}" r="${r}" fill="${color}" opacity="${n(o)}"/>`;
  }
  return s;
}
/** one packet at fraction f of a connector (f runs between the trimmed ends) */
export const dot = (c, f, color = P.yellow, r = 6, o = 1, trim = [0, 0]) => {
  if (o <= 0) return "";
  const q = c.at(c.u(lerp(trim[0] / c.len, 1 - trim[1] / c.len, clamp(f))));
  return `<circle cx="${n(q[0])}" cy="${n(q[1])}" r="${n(r * 2.4)}" fill="${color}" opacity="${n(0.16 * o)}"/><circle cx="${n(q[0])}" cy="${n(q[1])}" r="${r}" fill="${color}" opacity="${n(o)}"/>`;
};
/** one token travelling leg after leg (request → server → back): `legs` are [curve, trim] pairs, `leg` seconds each, from `at`;
 *  it waits at the end of the last leg until `until` */
export function trip(t, at, legs, { leg = 1.2, color = P.yellow, r = 7, until = Infinity } = {}) {
  if (t < at || t > until) return "";
  const i = Math.min(legs.length - 1, Math.floor((t - at) / leg)), [c, trim = [0, 0]] = [].concat(legs[i]);
  return dot(c, smooth(Math.min(1, (t - at) / leg - i)), color, r, Math.min(1, (t - at) * 4, (until - t) * 4), trim);
}
/** a soft glow behind something, in one of the palette's colours (its name, "blue", or its value, P.blue) */
export const glow = (x, y, r, color, o = 1) => {
  const key = color in P ? color : Object.keys(P).find(c => P[c] === color);
  return o <= 0.001 || !key ? "" : `<circle cx="${n(x)}" cy="${n(y)}" r="${n(r)}" fill="url(#glow-${key})" opacity="${n(o)}"/>`;
};
/** the gradients `glow` uses */
export const defs = () => `<defs>${Object.entries(P).map(([key, c]) => `<radialGradient id="glow-${key}"><stop offset="0" stop-color="${c}" stop-opacity=".28"/><stop offset=".5" stop-color="${c}" stop-opacity=".08"/><stop offset="1" stop-color="${c}" stop-opacity="0"/></radialGradient>`).join("")}</defs>`;

/** a whole SVG document: the glow gradients, the background (`bg: null` for a transparent one) and the drawing */
export const svg = (w, h, inner, { bg = P.bg } = {}) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}">${defs()}${bg ? `<rect width="${w}" height="${h}" fill="${bg}"/>` : ""}${inner}</svg>`;
