import { NextResponse } from "next/server";
import { classifyIntent } from "@/lib/intent-classifier";

type AnalyzeRequest = {
  message?: string;
  previousContext?: string;
};

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as AnalyzeRequest;

    if (!body.message?.trim()) {
      return NextResponse.json({ error: "Message is required." }, { status: 400 });
    }

    return NextResponse.json(classifyIntent(body.message, body.previousContext ?? ""));
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Analyze failed." },
      { status: 500 }
    );
  }
}
