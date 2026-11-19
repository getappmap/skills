/* The three use cases on one slide, each with the command that starts it.
 * All three produce the same kind of diagram, so the slides after this one
 * show the output once. The example is a bank: a transfer and a sign-in.
 * All three rows are on screen from the first frame, with no animation. */
const CMD = "/appmap-diagram";
const MONO = "ui-monospace, Menlo, monospace";

const USES = [
  { title: "Explain a review finding", rest: "of the improper authorization finding" },
  { title: "Show how a gold trace changed", rest: "of the changed transfer gold trace" },
  { title: "Compare traces of a test case across versions", rest: "of the sign-in comparison, 0.3.0 to 0.3.1" },
];

function Row({
  x,
  y,
  w,
  n,
  title,
  rest,
  tall,
}: {
  x: number;
  y: number;
  w: number;
  n: number;
  title: string;
  rest: string;
  tall: boolean;
}) {
  const h = tall ? 176 : 132;
  return (
    <g>
      <rect x={x} y={y} width={w} height={h} rx={18} fill="var(--secondary)" stroke="var(--border)" strokeWidth={1.5} />
      <circle cx={x + 58} cy={y + 58} r={28} fill="var(--primary)" />
      <text x={x + 58} y={y + 69} textAnchor="middle" fill="#fff" fontSize={32} fontWeight={700}>
        {n + 1}
      </text>
      <text x={x + 110} y={y + 54} fill="var(--foreground)" fontSize={tall ? 25 : 32} fontWeight={700}>
        {title}
      </text>
      {tall ? (
        <>
          <text x={x + 110} y={y + 100} fill="var(--primary)" fontSize={24} fontWeight={700} fontFamily={MONO}>
            {CMD}
          </text>
          <text x={x + 110} y={y + 138} fill="var(--muted-foreground)" fontSize={23}>
            {rest}
          </text>
        </>
      ) : (
        <text x={x + 110} y={y + 100} fill="var(--muted-foreground)" fontSize={24}>
          <tspan fill="var(--primary)" fontWeight={700} fontFamily={MONO}>
            {CMD}
          </tspan>
          <tspan dx={12}>{rest}</tspan>
        </text>
      )}
    </g>
  );
}

export default function ThreeUses() {
  return (
    <div className="h-full w-full" style={{ background: "var(--card)", containerType: "size" }}>
      <style>{`
        .tdtu-tall { display: block; }
        .tdtu-wide { display: none; }
        @container (min-aspect-ratio: 1/1) {
          .tdtu-tall { display: none; }
          .tdtu-wide { display: block; }
        }
      `}</style>
      <svg viewBox="0 0 1280 560" className="tdtu-wide" style={{ width: "100%", height: "74%", fontFamily: "var(--font-body)" }} preserveAspectRatio="xMidYMid meet">
        {USES.map((u, i) => (
          <Row key={u.title} x={70} y={40 + i * 154} w={1140} n={i} title={u.title} rest={u.rest} tall={false} />
        ))}
      </svg>
      <svg viewBox="0 0 760 950" className="h-full w-full tdtu-tall" style={{ fontFamily: "var(--font-body)" }} preserveAspectRatio="xMidYMid meet">
        {USES.map((u, i) => (
          <Row key={u.title} x={30} y={150 + i * 200} w={700} n={i} title={u.title} rest={u.rest} tall />
        ))}
      </svg>
    </div>
  );
}
