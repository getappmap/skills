/* What this skill adds to the diagrams AppMap already draws. The editor
 * extensions and the CLI show a whole trace to the developer who has it
 * open; the skill makes a page to send to someone else. Three differences,
 * all from the skill's SKILL.md: trimmed (hide, collapse, setup band),
 * annotated (the notes file), and standalone (one HTML page, or a PNG).
 * CSS animation only; resting state shows both columns. */
const SIDES = [
  {
    title: "AppMap IDE plugin",
    sub: "for the developer exploring a trace",
    lines: ["The whole trace, to click through", "Everything that was recorded", "Needs the plugin, in your IDE"],
    hot: false,
  },
  {
    title: "appmap-diagram skill",
    sub: "for the person you send it to",
    lines: ["Only the calls that tell the story", "Notes explain what the trace can't show", "An image, ZIP, or PDF\nthat you can share anywhere"],
    hot: true,
  },
];

function Column({
  x,
  y,
  w,
  side,
  delay,
}: {
  x: number;
  y: number;
  w: number;
  side: (typeof SIDES)[number];
  delay: number;
}) {
  const mark = side.hot ? "var(--primary)" : "var(--support)";
  return (
    <g className={delay > 0 ? "tdau-s" : undefined} style={delay > 0 ? { animationDelay: `${delay}s` } : undefined}>
      <rect
        x={x}
        y={y}
        width={w}
        height={412}
        rx={18}
        fill="var(--secondary)"
        stroke={side.hot ? "var(--primary)" : "var(--border)"}
        strokeWidth={side.hot ? 3 : 1.5}
      />
      <text x={x + 30} y={y + 58} fill="var(--foreground)" fontSize={34} fontWeight={700}>
        {side.title}
      </text>
      <text x={x + 30} y={y + 100} fill="var(--muted-foreground)" fontSize={26}>
        {side.sub}
      </text>
      <line x1={x + 30} y1={y + 128} x2={x + w - 30} y2={y + 128} stroke="var(--border)" />
      {side.lines.map((l, i) => (
        <g key={l}>
          <circle cx={x + 42} cy={y + 180 + i * 76} r={8} fill={mark} />
          {l.split("\n").map((part, j) => (
            <text key={part} x={x + 66} y={y + 189 + i * 76 + j * 34} fill="var(--foreground)" fontSize={26}>
              {part}
            </text>
          ))}
        </g>
      ))}
    </g>
  );
}

export default function Audience() {
  return (
    <div className="h-full w-full" style={{ background: "var(--card)", containerType: "size" }}>
      <style>{`
        @keyframes tdau-in {
          from { opacity: 0; transform: translateY(8px); }
          to { opacity: 1; transform: none; }
        }
        .tdau-s { animation: tdau-in 0.6s ease-out both; }
        .tdau-tall { display: block; }
        .tdau-wide { display: none; }
        @container (min-aspect-ratio: 1/1) {
          .tdau-tall { display: none; }
          .tdau-wide { display: block; }
        }
      `}</style>

      <svg
        viewBox="0 0 1280 560"
        className="tdau-wide"
        style={{ width: "100%", height: "74%", fontFamily: "var(--font-body)" }}
        preserveAspectRatio="xMidYMid meet"
      >
        <Column x={40} y={60} w={590} side={SIDES[0]} delay={0} />
        <Column x={650} y={60} w={590} side={SIDES[1]} delay={4} />
      </svg>

      <svg
        viewBox="0 0 760 950"
        className="h-full w-full tdau-tall"
        style={{ fontFamily: "var(--font-body)" }}
        preserveAspectRatio="xMidYMid meet"
      >
        <Column x={30} y={40} w={700} side={SIDES[0]} delay={0} />
        <Column x={30} y={470} w={700} side={SIDES[1]} delay={4} />
      </svg>
    </div>
  );
}
