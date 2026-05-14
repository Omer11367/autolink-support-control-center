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
  if (n === "deposit_funds") return "Deposits";
  if (["payment_issue", "refund_request"].includes(n)) return "Payment Issues";
  if (n === "process_account_creation") return "Account Creation";
  if (n === "verify_account") return "Verification";
  if (["check_account_status", "request_data_banned_accounts", "check_policy",
    "pause_campaigns", "appeal_review", "account_not_visible", "rename_account",
    "request_account_ids"].includes(n)) return "Account Issues";
  if (n === "replacement_request") return "Replacement";
  if (n === "site_issue") return "Site Issue";
  return "General";
}

function formatDate(iso: string): string {
  if (!iso) return "";
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: LOCAL_TZ,
    day: "2-digit", month: "short", year: "numeric",
    hour: "2-digit", minute: "2-digit"
  }).format(new Date(iso));
}

function extractSpreadsheetId(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const match = trimmed.match(/\/spreadsheets\/d\/([A-Za-z0-9_-]+)/);
  return match?.[1] ?? trimmed;
}

function quoteSheetName(name: string): string {
  return `'${name.replaceAll("'", "''")}'`;
}

const EXPORT_TAB = "📊 Daily Export";

const HEADERS = [
  "Date & Time",
  "Agency",
  "Client",
  "Category",
  "Issue Summary",
  "Original Message",
  "Status"
];

const CATEGORY_COLORS: Record<string, { red: number; green: number; blue: number }> = {
  Share:            { red: 0.18, green: 0.42, blue: 0.78 },
  Unshare:          { red: 0.92, green: 0.55, blue: 0.18 },
  Deposits:         { red: 0.22, green: 0.56, blue: 0.24 },
  "Payment Issues": { red: 0.78, green: 0.22, blue: 0.19 },
  Verification:     { red: 0.49, green: 0.28, blue: 0.74 },
  "Account Issues": { red: 0.42, green: 0.45, blue: 0.50 },
  "Site Issue":     { red: 0.95, green: 0.42, blue: 0.20 },
  General:          { red: 0.35, green: 0.39, blue: 0.45 }
};

const HEADER_BG = { red: 0.13, green: 0.13, blue: 0.18 };

export async function GET(request: Request) {
  // Validate cron secret
  const cronSecret = process.env.CRON_SECRET?.trim();
  if (cronSecret && request.headers.get("authorization") !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  const serviceJsonRaw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  const sheetsIdRaw = process.env.CLIENT_SHEETS_MAP ?? process.env.GOOGLE_SPREADSHEET_ID ?? "";
  if (!serviceJsonRaw?.trim() || !sheetsIdRaw?.trim()) {
    return NextResponse.json({ ok: false, error: "Missing Google Sheets env vars" }, { status: 400 });
  }

  // Extract spreadsheet ID from URL or raw value
  let spreadsheetId: string | null = null;
  try {
    const parsed = JSON.parse(sheetsIdRaw) as Record<string, string>;
    spreadsheetId = extractSpreadsheetId(Object.values(parsed)[0] ?? "");
  } catch {
    spreadsheetId = extractSpreadsheetId(sheetsIdRaw);
  }
  if (!spreadsheetId) {
    return NextResponse.json({ ok: false, error: "Could not determine spreadsheet ID" }, { status: 400 });
  }

  const supabase = createSupabaseAdminClient();

  // Load last 30 days of tickets with client + agency info
  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const [{ data: tickets }, { data: clientGroups }, { data: markGroups }] = await Promise.all([
    supabase
      .from("tickets")
      .select("id, ticket_code, client_chat_id, intent, status, client_original_message, internal_summary, created_at")
      .gte("created_at", since)
      .order("created_at", { ascending: false })
      .limit(2000),
    supabase.from("client_groups").select("telegram_chat_id, group_name, mark_group_id"),
    supabase.from("mark_groups").select("id, name")
  ]);

  const cgMap = new Map((clientGroups ?? []).map((cg) => [String(cg.telegram_chat_id), cg]));
  const mgMap = new Map((markGroups ?? []).map((mg) => [mg.id, mg.name]));

  // Build rows
  const rows = (tickets ?? []).map((t) => {
    const cg = cgMap.get(String(t.client_chat_id ?? ""));
    const clientName = cg?.group_name ?? String(t.client_chat_id ?? "");
    const agencyName = cg?.mark_group_id ? (mgMap.get(cg.mark_group_id) ?? "Unassigned") : "Unassigned";
    const category = intentToCategory(t.intent);
    const summary = (t.internal_summary ?? "")
      .replace(/^Detected intent:[^.]+\.\s*/i, "")
      .replace(/Requires Mark:[^.]+\.\s*/i, "")
      .replace(/Requested access level:[^.]+\.\s*/i, "")
      .trim()
      .slice(0, 200) || (t.client_original_message ?? "").slice(0, 200);
    const status = t.status ?? "unknown";
    const dateStr = formatDate(t.created_at ?? "");
    return { row: [dateStr, agencyName, clientName, category, summary, t.client_original_message ?? "", status], category };
  });

  // Auth + write
  let serviceAccount: { client_email: string; private_key: string };
  try {
    serviceAccount = JSON.parse(serviceJsonRaw) as { client_email: string; private_key: string };
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid GOOGLE_SERVICE_ACCOUNT_JSON" }, { status: 500 });
  }

  const auth = new google.auth.GoogleAuth({
    credentials: { client_email: serviceAccount.client_email, private_key: serviceAccount.private_key },
    scopes: ["https://www.googleapis.com/auth/spreadsheets"]
  });
  const sheets = google.sheets({ version: "v4", auth });

  // Ensure the export tab exists
  const meta = await sheets.spreadsheets.get({ spreadsheetId });
  let exportSheet = (meta.data.sheets ?? []).find((s) => s.properties?.title === EXPORT_TAB);
  let sheetId: number;

  if (!exportSheet) {
    const created = await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: { requests: [{ addSheet: { properties: { title: EXPORT_TAB } } }] }
    });
    sheetId = created.data.replies?.[0]?.addSheet?.properties?.sheetId ?? 0;
  } else {
    sheetId = exportSheet.properties?.sheetId ?? 0;
    // Clear existing content so we get a fresh daily snapshot
    await sheets.spreadsheets.values.clear({
      spreadsheetId,
      range: `${quoteSheetName(EXPORT_TAB)}!A:G`
    });
  }

  // Write header + all rows
  const allRows = [HEADERS, ...rows.map((r) => r.row)];
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `${quoteSheetName(EXPORT_TAB)}!A1`,
    valueInputOption: "RAW",
    requestBody: { values: allRows }
  });

  // Format: freeze header, color-code category column (D), auto-resize
  const colorRequests = rows.map((r, i) => {
    const color = CATEGORY_COLORS[r.category] ?? CATEGORY_COLORS.General;
    const rowIdx = i + 1; // +1 for header
    return {
      repeatCell: {
        range: { sheetId, startRowIndex: rowIdx, endRowIndex: rowIdx + 1, startColumnIndex: 3, endColumnIndex: 4 },
        cell: {
          userEnteredFormat: {
            backgroundColor: color,
            textFormat: { bold: true, foregroundColor: { red: 1, green: 1, blue: 1 } }
          }
        },
        fields: "userEnteredFormat(backgroundColor,textFormat)"
      }
    };
  });

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: {
      requests: [
        // Freeze header
        { updateSheetProperties: { properties: { sheetId, gridProperties: { frozenRowCount: 1 } }, fields: "gridProperties.frozenRowCount" } },
        // Header row style
        {
          repeatCell: {
            range: { sheetId, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: HEADERS.length },
            cell: {
              userEnteredFormat: {
                backgroundColor: HEADER_BG,
                textFormat: { bold: true, foregroundColor: { red: 1, green: 1, blue: 1 } },
                verticalAlignment: "MIDDLE"
              }
            },
            fields: "userEnteredFormat(backgroundColor,textFormat,verticalAlignment)"
          }
        },
        // Filter
        { setBasicFilter: { filter: { range: { sheetId, startRowIndex: 0, startColumnIndex: 0, endColumnIndex: HEADERS.length } } } },
        // Auto-resize all columns
        { autoResizeDimensions: { dimensions: { sheetId, dimension: "COLUMNS", startIndex: 0, endIndex: HEADERS.length } } },
        // Category cell colors
        ...colorRequests
      ]
    }
  });

  // Build a quick summary tab with counts per agency + category
  const SUMMARY_TAB = "📈 Summary";
  let summarySheet = (meta.data.sheets ?? []).find((s) => s.properties?.title === SUMMARY_TAB);
  let summarySheetId: number;
  if (!summarySheet) {
    const created2 = await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: { requests: [{ addSheet: { properties: { title: SUMMARY_TAB } } }] }
    });
    summarySheetId = created2.data.replies?.[0]?.addSheet?.properties?.sheetId ?? 0;
  } else {
    summarySheetId = summarySheet.properties?.sheetId ?? 0;
    await sheets.spreadsheets.values.clear({ spreadsheetId, range: `${quoteSheetName(SUMMARY_TAB)}!A:Z` });
  }

  // Build summary: agency → client → category counts
  const summaryMap = new Map<string, Map<string, Map<string, number>>>();
  for (const r of rows) {
    const [, agency, client, category] = r.row;
    if (!summaryMap.has(agency)) summaryMap.set(agency, new Map());
    const clientMap = summaryMap.get(agency)!;
    if (!clientMap.has(client)) clientMap.set(client, new Map());
    const catMap = clientMap.get(client)!;
    catMap.set(category, (catMap.get(category) ?? 0) + 1);
  }

  const exportDate = new Intl.DateTimeFormat("en-GB", { timeZone: LOCAL_TZ, dateStyle: "full" }).format(new Date());
  const summaryRows: string[][] = [
    [`Last exported: ${exportDate}`, "", "", ""],
    [],
    ["Agency", "Client", "Category", "# Requests"]
  ];

  for (const [agency, clients] of summaryMap.entries()) {
    let agencyTotal = 0;
    for (const [client, cats] of clients.entries()) {
      for (const [cat, count] of cats.entries()) {
        summaryRows.push([agency, client, cat, String(count)]);
        agencyTotal += count;
      }
    }
    summaryRows.push(["", `Total for ${agency}`, "", String(agencyTotal)]);
    summaryRows.push([]);
  }

  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `${quoteSheetName(SUMMARY_TAB)}!A1`,
    valueInputOption: "RAW",
    requestBody: { values: summaryRows }
  });

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: {
      requests: [
        { updateSheetProperties: { properties: { sheetId: summarySheetId, gridProperties: { frozenRowCount: 3 } }, fields: "gridProperties.frozenRowCount" } },
        { autoResizeDimensions: { dimensions: { sheetId: summarySheetId, dimension: "COLUMNS", startIndex: 0, endIndex: 4 } } }
      ]
    }
  });

  return NextResponse.json({ ok: true, rows: rows.length, spreadsheetId });
}

export async function POST(request: Request) {
  return GET(request);
}
