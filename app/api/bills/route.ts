const unavailable = () => Response.json(
  { error: "Legacy device-only sharing is unavailable online. Sign in to create a secure cloud sharing link." },
  { status: 410 },
);

export async function POST() { return unavailable(); }
export async function GET() { return unavailable(); }
export async function PUT() { return unavailable(); }
