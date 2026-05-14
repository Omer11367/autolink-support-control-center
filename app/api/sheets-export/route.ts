import { NextResponse } from "next/server";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { google } from "googleapis";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const LOCAL_TZ = "Asia/Jerusalem";

// ── Helpers ─────────────────────────────────────────────────────────────────

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

const ALL_CATEGORIES = ["Deposit", "Share", "Unshare", "Payment Issue", "Account Creation",
  "Verification", "Account Issue", "Replacement", "Site Issue", "General"] as const;

function formatDateHuman(iso: string): string {
  if (!iso) return "—";
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: LOCAL_TZ,
    day: "2-digit", month: "short", year: "numeric",
    hour: "2-digit", minute: "2-digit"
  }).format(new Date(iso));
}

function formatDateOnly(iso: string): string {
  if (!iso) return "—";
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: LOCAL_TZ,
    day: "2-digit", month: "short", year: "numeric"
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

// ── Color palette ────────────────────────────────────────────────────────────

type RGB = { red: number; green: number; blue: number };

const DARK_HEADER: RGB    = { red: 0.09, green: 0.09, blue: 0.12 };
const SECTION_BG: RGB     = { red: 0.15, green: 0.18, blue: 0.22 };
const WHITE: RGB           = { red: 1,    green: 1,    blue: 1    };
const LIGHT_GRAY: RGB      = { red: 0.96, green: 0.97, blue: 0.98 };
const MID_GRAY: RGB        = { red: 0.88, green: 0.89, blue: 0.91 };

const CAT_COLOR: Record<string, RGB> = {
  Deposit:          { red: 0.22, green: 0.56, blue: 0.24 },
  Share:            { red: 0.18, green: 0.42, blue: 0.78 },
  Unshare:          { red: 0.92, green: 0.55, blue: 0.18 },
  "Payment Issue":  { red: 0.78, green: 0.22, blue: 0.19 },
  "Account Creation":{ red: 0.55, green: 0.27, blue: 0.07 },
  Verification:     { red: 0.49, green: 0.28, blue: 0.74 },
  "Account Issue":  { red: 0.42, green: 0.45, blue: 0.50 },
  Replacement:      { red: 0.62, green: 0.32, blue: 0.18 },
  "Site Issue":     { red: 0.95, green: 0.42, blue: 0.12 },
  General:          { red: 0.35, green: 0.39, blue: 0.45 }
};

function cellFmt(opts: {
  bg?: RGB; bold?: boolean; fg?: RGB; italic?: boolean;
  fontSize?: number; hAlign?: string; vAlign?: string; wrap?: boolean;
}) {
  return {
    userEnteredFormat: {
      ...(opts.bg ? { backgroundColor: opts.bg } : {}),
      textFormat: {
        ...(opts.bold !== undefined ? { bold: opts.bold } : {}),
        ...(opts.italic !== undefined ? { italic: opts.italic } : {}),
        ...(opts.fontSize !== undefined ? { fontSize: opts.fontSize } : {}),
        ...(opts.fg ? { foregroundColor: opts.fg } : {})
      },
      ...(opts.hAlign ? { horizontalAlignment: opts.hAlign } : {}),
      ...(opts.vAlign ? { verticalAlignment: opts.vAlign } : { verticalAlignment: "MIDDLE" }),
      ...(opts.wrap !== undefined ? { wrapStrategy: opts.wrap ? "WRAP" : "CLIP" } : {})
    }
  };
}

// ── Sheet helpers ────────────────────────────────────────────────────────────

async function getOrCreateTab(
  sheets: ReturnType<typeof google.sheets>,
  spreadsheetId: string,
  title: string,
  existingSheets: Array<{ properties?: { sheetId?: number | null; title?: string | null } }>
): Promise<number> {
  const found = existingSheets.find((s) => s.properties?.title === title);
  if (found?.properties?.sheetId != null) return found.properties.sheetId;
  const res = await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: { requests: [{ addSheet: { properties: { title } } }] }
  });
  return res.data.replies?.[0]?.addSheet?.properties?.sheetId ?? 0;
}

async function clearAndWrite(
  sheets: ReturnType<typeof google.sheets>,
  spreadsheetId: string,
  tabName: string,
  rows: (string | number)[][]
) {
  await sheets.spreadsheets.values.clear({ spreadsheetId, range: `${quoteTab(tabName)}!A:Z` });
  if (rows.length > 0) {
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `${quoteTab(tabName)}!A1`,
      valueInputOption: "RAW",
      requestBody: { values: rows }
    });
  }
}

// ── Main handler ─────────────────────────────────────────────────────────────

export async function GET(request: Request) {
  const cronSecret = process.env.CRON_SECRET?.trim();
  if (cronSecret && request.headers.get("authorization") !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  const serviceJsonRaw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  const sheetsRaw = process.env.CLIENT_SHEETS_MAP ?? process.env.GOOGLE_SPREADSHEET_ID ?? "";
  if (!serviceJsonRaw?.trim() || !sheetsRaw?.trim()) {
    return NextResponse.json({ ok: false, error: "Missing GOOGLE_SERVICE_ACCOUNT_JSON or spreadsheet ID env var" }, { status: 400 });
  }

  let spreadsheetId: string | null = null;
  try {
    const parsed = JSON.parse(sheetsRaw) as Record<string, string>;
    spreadsheetId = extractSpreadsheetId(Object.values(parsed)[0] ?? "");
  } catch {
    spreadsheetId = extractSpreadsheetId(sheetsRaw);
  }
  if (!spreadsheetId) {
    return NextResponse.json({ ok: false, error: "Cannot determine spreadsheet ID" }, { status: 400 });
  }

  const supabase = createSupabaseAdminClient();
  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

  const [{ data: tickets }, { data: clientGroups }, { data: markGroups }] = await Promise.all([
    supabase
      .from("tickets")
      .select("id, client_chat_id, intent, status, client_original_message, created_at")
      .gte("created_at", since)
      .order("created_at", { ascending: false })
      .limit(3000),
    supabase.from("client_groups").select("telegram_chat_id, group_name, mark_group_id"),
    supabase.from("mark_groups").select("id, name")
  ]);

  const cgMap = new Map((clientGroups ?? []).map((cg) => [String(cg.telegram_chat_id), cg]));
  const mgMap = new Map((markGroups ?? []).map((mg) => [mg.id, mg.name]));

  type TicketRow = {
    agency: string;
    client: string;
    category: string;
    message: string;
    status: string;
    createdAt: string;
    isOpen: boolean;
  };

  const allRows: TicketRow[] = (tickets ?? []).map((t) => {
    const cg = cgMap.get(String(t.client_chat_id ?? ""));
    const client = cg?.group_name ?? String(t.client_chat_id ?? "Unknown");
    const agency = cg?.mark_group_id ? (mgMap.get(cg.mark_group_id) ?? "Unassigned") : "Unassigned";
    const category = intentToCategory(t.intent);
    const status = t.status ?? "unknown";
    const isOpen = !["closed", "resolved", "done"].includes(status.toLowerCase());
    return { agency, client, category, message: t.client_original_message ?? "", status, createdAt: t.created_at ?? "", isOpen };
  });

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
  const meta = await sheets.spreadsheets.get({ spreadsheetId });
  const existingSheets = meta.data.sheets ?? [];

  const exportedOn = new Intl.DateTimeFormat("en-GB", {
    timeZone: LOCAL_TZ, dateStyle: "full", timeStyle: "short"
  }).format(new Date());

  // ══════════════════════════════════════════════════════════════
  // TAB 1: 📋 Overview  (one row per client, easy to scan)
  // ══════════════════════════════════════════════════════════════
  const TAB_OVERVIEW = "📋 Overview";
  const ovSheetId = await getOrCreateTab(sheets, spreadsheetId, TAB_OVERVIEW, existingSheets);

  // Build per-client aggregation
  type ClientStat = {
    agency: string; client: string; lastActivity: string;
    open: number; total: number; cats: Record<string, number>;
  };
  const statMap = new Map<string, ClientStat>();
  for (const r of allRows) {
    const key = `${r.agency}||${r.client}`;
    if (!statMap.has(key)) {
      statMap.set(key, { agency: r.agency, client: r.client, lastActivity: r.createdAt, open: 0, total: 0, cats: {} });
    }
    const s = statMap.get(key)!;
    s.total++;
    if (r.isOpen) s.open++;
    s.cats[r.category] = (s.cats[r.category] ?? 0) + 1;
    if (r.createdAt > s.lastActivity) s.lastActivity = r.createdAt;
  }
  const stats = Array.from(statMap.values()).sort((a, b) => {
    if (a.agency !== b.agency) return a.agency.localeCompare(b.agency);
    return b.total - a.total;
  });

  const ovHeaders = ["Agency", "Client", "Last Request", "Open", "Total", ...ALL_CATEGORIES];
  const ovRows: (string | number)[][] = [
    [`Autolink Support — Client Overview`],
    [`Exported: ${exportedOn}  |  Last 30 days`],
    [],
    ovHeaders
  ];
  let lastAgency = "";
  for (const s of stats) {
    if (s.agency !== lastAgency) {
      if (lastAgency) ovRows.push([]); // blank line between agencies
      lastAgency = s.agency;
    }
    ovRows.push([
      s.agency,
      s.client,
      formatDateOnly(s.lastActivity),
      s.open,
      s.total,
      ...ALL_CATEGORIES.map((c) => s.cats[c] ?? 0)
    ]);
  }

  await clearAndWrite(sheets, spreadsheetId, TAB_OVERVIEW, ovRows);

  // Format Overview tab
  const ovFmtRequests: object[] = [
    // Title row
    { repeatCell: { range: { sheetId: ovSheetId, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: ovHeaders.length + 2 }, cell: cellFmt({ bg: DARK_HEADER, bold: true, fg: WHITE, fontSize: 14, vAlign: "MIDDLE" }), fields: "userEnteredFormat" } },
    // Subtitle row
    { repeatCell: { range: { sheetId: ovSheetId, startRowIndex: 1, endRowIndex: 2, startColumnIndex: 0, endColumnIndex: ovHeaders.length + 2 }, cell: cellFmt({ bg: DARK_HEADER, fg: MID_GRAY, italic: true, vAlign: "MIDDLE" }), fields: "userEnteredFormat" } },
    // Column headers row (row index 3)
    { repeatCell: { range: { sheetId: ovSheetId, startRowIndex: 3, endRowIndex: 4, startColumnIndex: 0, endColumnIndex: ovHeaders.length }, cell: cellFmt({ bg: SECTION_BG, bold: true, fg: WHITE, vAlign: "MIDDLE", hAlign: "CENTER" }), fields: "userEnteredFormat" } },
    // Freeze first 4 rows and first 2 columns
    { updateSheetProperties: { properties: { sheetId: ovSheetId, gridProperties: { frozenRowCount: 4, frozenColumnCount: 2 } }, fields: "gridProperties.frozenRowCount,gridProperties.frozenColumnCount" } },
    // Filter on header row
    { setBasicFilter: { filter: { range: { sheetId: ovSheetId, startRowIndex: 3, startColumnIndex: 0, endColumnIndex: ovHeaders.length } } } },
    // Auto resize
    { autoResizeDimensions: { dimensions: { sheetId: ovSheetId, dimension: "COLUMNS", startIndex: 0, endIndex: ovHeaders.length } } }
  ];
  // Color-code Open column (index 3) — red if > 0
  for (let i = 0; i < stats.length; i++) {
    const rowIdx = ovRows.indexOf(ovRows.find((r, ri) => ri > 3 && r[1] === stats[i].client && r[0] === stats[i].agency) ?? []);
    if (rowIdx < 0) continue;
    const openCount = stats[i].open;
    if (openCount > 0) {
      ovFmtRequests.push({
        repeatCell: {
          range: { sheetId: ovSheetId, startRowIndex: rowIdx, endRowIndex: rowIdx + 1, startColumnIndex: 3, endColumnIndex: 4 },
          cell: cellFmt({ bg: { red: 0.78, green: 0.22, blue: 0.19 }, bold: true, fg: WHITE }),
          fields: "userEnteredFormat"
        }
      });
    }
  }
  await sheets.spreadsheets.batchUpdate({ spreadsheetId, requestBody: { requests: ovFmtRequests } });

  // ══════════════════════════════════════════════════════════════
  // TAB 2: 📊 All Requests  (full log, newest first, color-coded)
  // ══════════════════════════════════════════════════════════════
  const TAB_LOG = "📊 All Requests";
  const logSheetId = await getOrCreateTab(sheets, spreadsheetId, TAB_LOG, existingSheets);

  const logHeaders = ["Date & Time", "Agency", "Client", "Category", "Status", "Message"];
  const logRows: (string | number)[][] = [
    [`Autolink Support — Full Request Log`],
    [`Exported: ${exportedOn}  |  Last 30 days  |  ${allRows.length} requests total`],
    [],
    logHeaders,
    ...allRows.map((r) => [
      formatDateHuman(r.createdAt),
      r.agency,
      r.client,
      r.category,
      r.status.replace(/_/g, " "),
      r.message.slice(0, 500)
    ])
  ];

  await clearAndWrite(sheets, spreadsheetId, TAB_LOG, logRows);

  const logFmtRequests: object[] = [
    { repeatCell: { range: { sheetId: logSheetId, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: logHeaders.length }, cell: cellFmt({ bg: DARK_HEADER, bold: true, fg: WHITE, fontSize: 14 }), fields: "userEnteredFormat" } },
    { repeatCell: { range: { sheetId: logSheetId, startRowIndex: 1, endRowIndex: 2, startColumnIndex: 0, endColumnIndex: logHeaders.length }, cell: cellFmt({ bg: DARK_HEADER, fg: MID_GRAY, italic: true }), fields: "userEnteredFormat" } },
    { repeatCell: { range: { sheetId: logSheetId, startRowIndex: 3, endRowIndex: 4, startColumnIndex: 0, endColumnIndex: logHeaders.length }, cell: cellFmt({ bg: SECTION_BG, bold: true, fg: WHITE, hAlign: "CENTER" }), fields: "userEnteredFormat" } },
    { updateSheetProperties: { properties: { sheetId: logSheetId, gridProperties: { frozenRowCount: 4 } }, fields: "gridProperties.frozenRowCount" } },
    { setBasicFilter: { filter: { range: { sheetId: logSheetId, startRowIndex: 3, startColumnIndex: 0, endColumnIndex: logHeaders.length } } } },
    // Wrap message column, clip others
    { repeatCell: { range: { sheetId: logSheetId, startRowIndex: 4, startColumnIndex: 5, endColumnIndex: 6 }, cell: cellFmt({ wrap: true }), fields: "userEnteredFormat.wrapStrategy" } },
    { repeatCell: { range: { sheetId: logSheetId, startRowIndex: 4, startColumnIndex: 0, endColumnIndex: 5 }, cell: cellFmt({ wrap: false, vAlign: "MIDDLE" }), fields: "userEnteredFormat.wrapStrategy,userEnteredFormat.verticalAlignment" } },
    { autoResizeDimensions: { dimensions: { sheetId: logSheetId, dimension: "COLUMNS", startIndex: 0, endIndex: 5 } } }
  ];

  // Color-code the Category column (index 3) for each data row
  for (let i = 0; i < allRows.length; i++) {
    const rowIdx = i + 4; // header is row index 3, data starts at 4
    const cat = allRows[i]?.category ?? "General";
    const color = CAT_COLOR[cat] ?? CAT_COLOR.General;
    logFmtRequests.push({
      repeatCell: {
        range: { sheetId: logSheetId, startRowIndex: rowIdx, endRowIndex: rowIdx + 1, startColumnIndex: 3, endColumnIndex: 4 },
        cell: cellFmt({ bg: color, bold: true, fg: WHITE, hAlign: "CENTER" }),
        fields: "userEnteredFormat"
      }
    });
    // Alternate row background for readability
    const rowBg = i % 2 === 0 ? WHITE : LIGHT_GRAY;
    logFmtRequests.push({
      repeatCell: {
        range: { sheetId: logSheetId, startRowIndex: rowIdx, endRowIndex: rowIdx + 1, startColumnIndex: 0, endColumnIndex: 3 },
        cell: cellFmt({ bg: rowBg }),
        fields: "userEnteredFormat.backgroundColor"
      }
    });
    logFmtRequests.push({
      repeatCell: {
        range: { sheetId: logSheetId, startRowIndex: rowIdx, endRowIndex: rowIdx + 1, startColumnIndex: 4, endColumnIndex: logHeaders.length },
        cell: cellFmt({ bg: rowBg }),
        fields: "userEnteredFormat.backgroundColor"
      }
    });
  }

  // Batch format in chunks (Sheets API has a request limit per call)
  const CHUNK = 200;
  for (let i = 0; i < logFmtRequests.length; i += CHUNK) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: { requests: logFmtRequests.slice(i, i + CHUNK) }
    });
  }

  return NextResponse.json({ ok: true, rows: allRows.length, clients: statMap.size, spreadsheetId });
}

export async function POST(request: Request) {
  return GET(request);
}
