import { NextResponse } from "next/server";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { google } from "googleapis";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const LOCAL_TZ = "Asia/Jerusalem";

function intentToCategory(intent: string | null): string {
  const n = String(intent ?? "").toLowerCase();
  if (["share_ad_account", "transfer_ad_account"].includes(n)) return "Share";
  if (n === "unshare_ad_account") return "Unshare";
  if (n === "deposit_funds") return "Deposit";
  if (["payment_issue", "refund_request"].includes(n)) return "Payment Issue";
  if (n === "process_account_creation") return "Account Creation";
  if (n === "verify_account") return "Verification";
  if (["check_account_status", "pause_campaigns", "appeal_review",
    "account_not_visible", "rename_account", "request_account_ids",
    "request_data_banned_accounts", "check_policy"].includes(n)) return "Account Issue";
  if (n === "replacement_request") return "Replacement";
  if (n === "site_issue") return "Site Issue";
  return "General";
}

function formatDateHuman(iso: string): string {
  if (!iso) return "—";
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: LOCAL_TZ, day: "2-digit", month: "short", year: "numeric",
    hour: "2-digit", minute: "2-digit"
  }).format(new Date(iso));
}

function formatDateShort(iso: string): string {
  if (!iso) return "";
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: LOCAL_TZ, day: "2-digit", month: "short", year: "numeric"
  }).format(new Date(iso));
}

function extractSpreadsheetId(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const match = trimmed.match(/\/spreadsheets\/d\/([A-Za-z0-9_-]+)/);
  return match?.[1] ?? trimmed;
}

function quoteTab(name: string): string {
  return `'${name.replaceAll("'", "''")}'`;
}

function sanitizeTabName(name: string): string {
  return name.replace(/[:\\/?*[\]']/g, " ").replace(/\s+/g, " ").trim().slice(0, 80);
}

type RGB = { red: number; green: number; blue: number };

const DARK_HEADER: RGB = { red: 0.09, green: 0.09, blue: 0.12 };
const WHITE: RGB       = { red: 1,    green: 1,    blue: 1    };
const LIGHT_GRAY: RGB  = { red: 0.96, green: 0.97, blue: 0.98 };
const MID_GRAY: RGB    = { red: 0.88, green: 0.89, blue: 0.91 };
const SECTION_BG: RGB  = { red: 0.15, green: 0.18, blue: 0.22 };

const CAT_COLOR: Record<string, RGB> = {
  Deposit:           { red: 0.22, green: 0.56, blue: 0.24 },
  Share:             { red: 0.18, green: 0.42, blue: 0.78 },
  Unshare:           { red: 0.92, green: 0.55, blue: 0.18 },
  "Payment Issue":   { red: 0.78, green: 0.22, blue: 0.19 },
  "Account Creation":{ red: 0.55, green: 0.27, blue: 0.07 },
  Verification:      { red: 0.49, green: 0.28, blue: 0.74 },
  "Account Issue":   { red: 0.42, green: 0.45, blue: 0.50 },
  Replacement:       { red: 0.62, green: 0.32, blue: 0.18 },
  "Site Issue":      { red: 0.95, green: 0.42, blue: 0.12 },
  General:           { red: 0.35, green: 0.39, blue: 0.45 }
};

const STATUS_COLOR: Record<string, RGB> = {
  closed:       { red: 0.22, green: 0.56, blue: 0.24 },
  resolved:     { red: 0.22, green: 0.56, blue: 0.24 },
  done:         { red: 0.22, green: 0.56, blue: 0.24 },
  waiting_mark: { red: 0.92, green: 0.55, blue: 0.18 },
  open:         { red: 0.18, green: 0.42, blue: 0.78 },
  new:          { red: 0.49, green: 0.28, blue: 0.74 }
};

function cellFmt(opts: { bg?: RGB; bold?: boolean; fg?: RGB; italic?: boolean; fontSize?: number; hAlign?: string; vAlign?: string; wrap?: boolean }) {
  return {
    userEnteredFormat: {
      ...(opts.bg ? { backgroundColor: opts.bg } : {}),
      textFormat: {
        ...(opts.bold !== undefined ? { bold: opts.bold } : {}),
        ...(opts.italic ? { italic: true } : {}),
        ...(opts.fontSize ? { fontSize: opts.fontSize } : {}),
        ...(opts.fg ? { foregroundColor: opts.fg } : {})
      },
      ...(opts.hAlign ? { horizontalAlignment: opts.hAlign } : {}),
      verticalAlignment: opts.vAlign ?? "MIDDLE",
      ...(opts.wrap !== undefined ? { wrapStrategy: opts.wrap ? "WRAP" : "CLIP" } : {})
    }
  };
}

export async function POST(request: Request) {
  const { searchParams } = new URL(request.url);
  const chatId = searchParams.get("chatId");
  const from   = searchParams.get("from");   // ISO date string or null (= no lower bound)
  const to     = searchParams.get("to");     // ISO date string or null (= now)

  if (!chatId) return NextResponse.json({ ok: false, error: "missing chatId" }, { status: 400 });

  const serviceJsonRaw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  const sheetsRaw = process.env.CLIENT_SHEETS_MAP ?? process.env.GOOGLE_SPREADSHEET_ID ?? "";
  if (!serviceJsonRaw?.trim() || !sheetsRaw?.trim()) {
    return NextResponse.json({ ok: false, error: "Missing Google Sheets env vars" }, { status: 400 });
  }

  let spreadsheetId: string | null = null;
  try {
    const parsed = JSON.parse(sheetsRaw) as Record<string, string>;
    spreadsheetId = extractSpreadsheetId(Object.values(parsed)[0] ?? "");
  } catch {
    spreadsheetId = extractSpreadsheetId(sheetsRaw);
  }
  if (!spreadsheetId) return NextResponse.json({ ok: false, error: "Cannot determine spreadsheet ID" }, { status: 400 });

  const supabase = createSupabaseAdminClient();

  const [{ data: clientGroupData }, { data: markGroupsData }] = await Promise.all([
    supabase.from("client_groups").select("group_name, mark_group_id").eq("telegram_chat_id", chatId).maybeSingle(),
    supabase.from("mark_groups").select("id, name")
  ]);

  const clientName = clientGroupData?.group_name ?? chatId;
  const agencyName = clientGroupData?.mark_group_id
    ? ((markGroupsData ?? []).find((m) => m.id === clientGroupData.mark_group_id)?.name ?? "Unassigned")
    : "Unassigned";

  let query = supabase
    .from("tickets")
    .select("id, ticket_code, intent, status, client_original_message, internal_summary, created_at")
    .eq("client_chat_id", chatId)
    .order("created_at", { ascending: false })
    .limit(3000);

  if (from) query = query.gte("created_at", new Date(from).toISOString());
  if (to)   query = query.lte("created_at", new Date(to + "T23:59:59").toISOString());

  const { data: tickets, error: ticketError } = await query;
  if (ticketError) return NextResponse.json({ ok: false, error: ticketError.message }, { status: 500 });

  const rows = (tickets ?? []).map((t) => ({
    date:     formatDateHuman(t.created_at ?? ""),
    category: intentToCategory(t.intent),
    status:   t.status ?? "unknown",
    message:  t.client_original_message ?? "",
    ticket:   t.ticket_code ?? t.id
  }));

  // Category breakdown for the summary header
  const catCounts: Record<string, number> = {};
  let openCount = 0;
  for (const r of rows) {
    catCounts[r.category] = (catCounts[r.category] ?? 0) + 1;
    if (!["closed", "resolved", "done"].includes(r.status.toLowerCase())) openCount++;
  }
  const topCats = Object.entries(catCounts).sort((a, b) => b[1] - a[1]);

  // Date range label for the tab name and header
  const rangeLabel = from && to
    ? `${formatDateShort(from)} – ${formatDateShort(to)}`
    : from
      ? `From ${formatDateShort(from)}`
      : to
        ? `Until ${formatDateShort(to)}`
        : "All Time";

  const exportedOn = new Intl.DateTimeFormat("en-GB", {
    timeZone: LOCAL_TZ, dateStyle: "full", timeStyle: "short"
  }).format(new Date());

  // Auth
  let serviceAccount: { client_email: string; private_key: string };
  try { serviceAccount = JSON.parse(serviceJsonRaw) as { client_email: string; private_key: string }; }
  catch { return NextResponse.json({ ok: false, error: "Invalid GOOGLE_SERVICE_ACCOUNT_JSON" }, { status: 500 }); }

  const auth = new google.auth.GoogleAuth({
    credentials: { client_email: serviceAccount.client_email, private_key: serviceAccount.private_key },
    scopes: ["https://www.googleapis.com/auth/spreadsheets"]
  });
  const sheets = google.sheets({ version: "v4", auth });

  // Get or create the tab (named: "ClientName — Apr 1–20")
  const tabName = sanitizeTabName(`${clientName} — ${rangeLabel}`);
  const meta = await sheets.spreadsheets.get({ spreadsheetId });
  const existingSheets = meta.data.sheets ?? [];
  let sheetObj = existingSheets.find((s) => s.properties?.title === tabName);
  let sheetId: number;

  if (!sheetObj) {
    const created = await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: { requests: [{ addSheet: { properties: { title: tabName } } }] }
    });
    sheetId = created.data.replies?.[0]?.addSheet?.properties?.sheetId ?? 0;
  } else {
    sheetId = sheetObj.properties?.sheetId ?? 0;
    await sheets.spreadsheets.values.clear({ spreadsheetId, range: `${quoteTab(tabName)}!A:Z` });
  }

  // ── Build sheet content ──────────────────────────────────────────────────
  //
  // Row 1: Big title
  // Row 2: Client | Agency | Date range
  // Row 3: Exported on
  // Row 4: blank
  // Row 5: Stat pills — Total: 47  |  Open: 3  |  Top: Deposit (12), Share (8) …
  // Row 6: blank
  // Row 7: Column headers
  // Row 8+: Data rows

  const statLine = [
    `Total requests: ${rows.length}`,
    `Open: ${openCount}`,
    topCats.slice(0, 4).map(([c, n]) => `${c}: ${n}`).join("   ·   ")
  ].filter(Boolean).join("     |     ");

  const sheetRows: (string | number)[][] = [
    [clientName],                             // row 0 (index)
    [`Agency: ${agencyName}   ·   Period: ${rangeLabel}`], // row 1
    [`Exported: ${exportedOn}`],              // row 2
    [],                                       // row 3 blank
    [statLine],                               // row 4 stats
    [],                                       // row 5 blank
    ["#", "Date & Time", "Category", "Status", "Ticket Code", "Full Message"], // row 6 headers
    ...rows.map((r, i) => [i + 1, r.date, r.category, r.status.replace(/_/g, " "), r.ticket, r.message])
  ];

  await sheets.spreadsheets.values.update({
    spreadsheetId, range: `${quoteTab(tabName)}!A1`,
    valueInputOption: "RAW", requestBody: { values: sheetRows }
  });

  // ── Formatting ───────────────────────────────────────────────────────────
  const HEADER_ROW = 6; // 0-indexed
  const DATA_START = 7;

  const fmtRequests: object[] = [
    // Title row — large, dark background
    { repeatCell: { range: { sheetId, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: 6 }, cell: cellFmt({ bg: DARK_HEADER, bold: true, fg: WHITE, fontSize: 16, vAlign: "MIDDLE" }), fields: "userEnteredFormat" } },
    // Subtitle rows
    { repeatCell: { range: { sheetId, startRowIndex: 1, endRowIndex: 2, startColumnIndex: 0, endColumnIndex: 6 }, cell: cellFmt({ bg: DARK_HEADER, fg: MID_GRAY, italic: true }), fields: "userEnteredFormat" } },
    { repeatCell: { range: { sheetId, startRowIndex: 2, endRowIndex: 3, startColumnIndex: 0, endColumnIndex: 6 }, cell: cellFmt({ bg: DARK_HEADER, fg: { red: 0.5, green: 0.5, blue: 0.5 }, italic: true }), fields: "userEnteredFormat" } },
    // Stats row
    { repeatCell: { range: { sheetId, startRowIndex: 4, endRowIndex: 5, startColumnIndex: 0, endColumnIndex: 6 }, cell: cellFmt({ bg: SECTION_BG, fg: WHITE, bold: true }), fields: "userEnteredFormat" } },
    // Column headers
    { repeatCell: { range: { sheetId, startRowIndex: HEADER_ROW, endRowIndex: HEADER_ROW + 1, startColumnIndex: 0, endColumnIndex: 6 }, cell: cellFmt({ bg: SECTION_BG, bold: true, fg: WHITE, hAlign: "CENTER" }), fields: "userEnteredFormat" } },
    // Freeze header rows and # column
    { updateSheetProperties: { properties: { sheetId, gridProperties: { frozenRowCount: HEADER_ROW + 1, frozenColumnCount: 1 } }, fields: "gridProperties.frozenRowCount,gridProperties.frozenColumnCount" } },
    // Filter row
    { setBasicFilter: { filter: { range: { sheetId, startRowIndex: HEADER_ROW, startColumnIndex: 0, endColumnIndex: 6 } } } },
    // Auto-resize all except message column
    { autoResizeDimensions: { dimensions: { sheetId, dimension: "COLUMNS", startIndex: 0, endIndex: 5 } } },
    // Set message column width to 400px
    { updateDimensionProperties: { range: { sheetId, dimension: "COLUMNS", startIndex: 5, endIndex: 6 }, properties: { pixelSize: 400 }, fields: "pixelSize" } },
    // Message column wraps
    { repeatCell: { range: { sheetId, startRowIndex: DATA_START, startColumnIndex: 5, endColumnIndex: 6 }, cell: cellFmt({ wrap: true, vAlign: "MIDDLE" }), fields: "userEnteredFormat.wrapStrategy,userEnteredFormat.verticalAlignment" } },
    // # column center
    { repeatCell: { range: { sheetId, startRowIndex: DATA_START, startColumnIndex: 0, endColumnIndex: 1 }, cell: cellFmt({ hAlign: "CENTER", fg: { red: 0.6, green: 0.6, blue: 0.6 } }), fields: "userEnteredFormat.horizontalAlignment,userEnteredFormat.textFormat.foregroundColor" } }
  ];

  // Per-row: alternating bg, category color badge, status color
  const rowColorRequests: object[] = [];
  for (let i = 0; i < rows.length; i++) {
    const rowIdx = DATA_START + i;
    const rowBg = i % 2 === 0 ? WHITE : LIGHT_GRAY;
    const r = rows[i]!;
    const catColor = CAT_COLOR[r.category] ?? CAT_COLOR.General;
    const statusColor = STATUS_COLOR[r.status.toLowerCase()] ?? { red: 0.6, green: 0.6, blue: 0.6 };

    // Row background (all non-special columns)
    rowColorRequests.push(
      { repeatCell: { range: { sheetId, startRowIndex: rowIdx, endRowIndex: rowIdx + 1, startColumnIndex: 0, endColumnIndex: 2 }, cell: cellFmt({ bg: rowBg }), fields: "userEnteredFormat.backgroundColor" } },
      { repeatCell: { range: { sheetId, startRowIndex: rowIdx, endRowIndex: rowIdx + 1, startColumnIndex: 4, endColumnIndex: 6 }, cell: cellFmt({ bg: rowBg }), fields: "userEnteredFormat.backgroundColor" } },
      // Category cell (col 2) — colored badge
      { repeatCell: { range: { sheetId, startRowIndex: rowIdx, endRowIndex: rowIdx + 1, startColumnIndex: 2, endColumnIndex: 3 }, cell: cellFmt({ bg: catColor, bold: true, fg: WHITE, hAlign: "CENTER" }), fields: "userEnteredFormat" } },
      // Status cell (col 3) — colored text
      { repeatCell: { range: { sheetId, startRowIndex: rowIdx, endRowIndex: rowIdx + 1, startColumnIndex: 3, endColumnIndex: 4 }, cell: cellFmt({ bg: rowBg, fg: statusColor, bold: true, hAlign: "CENTER" }), fields: "userEnteredFormat" } }
    );
  }

  // Batch in chunks of 200
  const all = [...fmtRequests, ...rowColorRequests];
  for (let i = 0; i < all.length; i += 200) {
    await sheets.spreadsheets.batchUpdate({ spreadsheetId, requestBody: { requests: all.slice(i, i + 200) } });
  }

  const sheetUrl = `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit#gid=${sheetId}`;
  return NextResponse.json({ ok: true, rows: rows.length, tabName, sheetUrl });
}
