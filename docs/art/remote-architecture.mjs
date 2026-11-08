// Hosted paper-remote-mcp: one MCP URL, an OAuth front door, a one-time "Link Paper" popup, and a pool of headless editors.
import { P, svg, iso, text, caption2, chip, glow, laptop, server, cylinder, windowUp, cardStack, zone, curve, arrow, dot, In } from "./iso.mjs";

const label = (x, y, a, b) => caption2(x, y, a, b, 1, { size: 26 });

export default t => {
  const A = [290, 430], S = [770, 410], E = [1200, 420], X = [1650, 430], L = [290, 740], D = [960, 740];
  const ly = 560, ly2 = 840;
  const AS = curve(A, S, -40), SE = curve(S, E, -30), EX = curve(E, X, -30), AL = curve([150, 470], [185, 700], 30), LD = curve(L, D, 30), DE = curve([D[0] + 30, D[1] - 40], [1150, 470], 20);
  return svg(1920, 1080,
    text(96, 92, "PAPER REMOTE MCP · VCA-470", { size: 17, weight: 600, color: P.muted, anchor: "start", ls: 2.2 }) +
    text(96, 136, "One URL, one sign-in, Paper in every agent", { size: 38, weight: 640, color: P.title, anchor: "start" }) +
    `<rect x="96" y="154" width="48" height="3" rx="1.5" fill="${P.yellow}"/>` +
    In(t, 0.3, zone(610, 250, 820, 640, P.blue, { label: "your server · docker + cloudflare tunnel" })) +
    arrow(t, 0.9, AS, { trim: [95, 95] }) + arrow(t, 1.1, SE, { trim: [90, 105] }) + arrow(t, 1.3, EX, { trim: [100, 95], heads: 2 }) +
    arrow(t, 1.5, AL, { trim: [0, 0], dashed: true }) + arrow(t, 1.7, LD, { trim: [110, 85] }) + arrow(t, 1.9, DE, { trim: [30, 10] }) +
    dot(AS, 0.5, P.yellow, 7, 1, [95, 95]) +
    In(t, 0.2, laptop(iso(A[0], A[1] + 10, 1.1)) + label(A[0], ly, "AI client", "Claude · Cursor · Codex")) +
    In(t, 0.4, glow(S[0], S[1] - 30, 170, "blue", 0.5) + server(iso(S[0], S[1] + 40, 1.1), { lights: [P.green, P.green, P.blue] }) +
      label(S[0], ly, "MCP front door", "/mcp · OAuth 2.1")) +
    In(t, 0.5, windowUp(iso(E[0], E[1] + 40, 1.1), { term: false }) + label(E[0], ly, "Editor pool", "a context per user")) +
    In(t, 0.6, cardStack(iso(X[0], X[1] + 20, 1.1)) + label(X[0], ly, "app.paper.design", "your account · your files")) +
    In(t, 0.7, windowUp(iso(L[0] + 10, L[1] + 22, 1.0), { term: false, ghosts: false }) +
      label(L[0], ly2, "Connect popup", "consent · Paper email code")) +
    In(t, 0.8, cylinder(iso(D[0], D[1] + 30, 1.0)) + label(D[0], ly2, "SQLite", "grants · sealed Paper sessions")) +
    In(t, 1.4, chip(500, 372, "Authorization: Bearer", { mono: true, color: P.yellow })) +
    In(t, 1.6, chip(1555, 372, "session cookie", { mono: true })) +
    In(t, 1.8, chip(330, 640, "first connect only", { mono: true })) +
    text(960, 1000, "One **URL** to add. Sign in to Paper once; the session stays sealed on your server.", { size: 32, weight: 480, accent: P.yellow }));
};
