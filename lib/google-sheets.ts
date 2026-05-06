import { google } from "googleapis";

type WriteClientRequestRowInput = {
  telegramGroup: string;
  username: string;
  originalMessage: string;
  parsedMessage: string;
  intent: string;
  status?: string;
  now?: Date;
};

function mapIntentToCategory(intent: string): string {
  const normalized = String(intent || "").toLowerCase();
  if (["share_ad_account", "transfer_ad_account"].includes(normalized)) return "Share";
  if (["unshare_ad_account"].includes(normalized)) return "Unshare";
  if (["deposit_funds"].includes(normalized)) return "Deposits";
  if (["payment_issue"].includes(normalized)) return "Payment Issues";
  if (["verify_account"].includes(normalized)) return "Verification";
  if (["check_account_status", "request_data_banned_accounts"].includes(normalized)) return "Account Issues";
  if (["request_accounts", "check_availability", "refund_request", "check_policy", "general_support"].includes(normalized)) return "General";
  return "General";
}

function parseClientSheetsMap(raw: string | undefined): Record<string, string> {
  if (!raw?.trim()) return {};
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  return Object.fromEntries(
    Object.entries(parsed as Record<string, unknown>)
      .filter(([key, value]) => typeof key === "string" && typeof value === "string" && key.trim() && value.trim())
      .map(([key, value]) => [key.trim(), (value as string).trim()])
  );
}

function getSpreadsheetIdForClient(map: Record<string, string>, groupName: string): string | null {
  if (!groupName.trim()) return null;
  const exact = map[groupName];
  if (exact) return exact;
  const normalized = groupName.trim().toLowerCase();
  const foundEntry = Object.entries(map).find(([name]) => name.trim().toLowerCase() === normalized);
  return foundEntry?.[1] ?? null;
}

async function ensureSheetTabExists(
  sheets: ReturnType<typeof google.sheets>,
  spreadsheetId: string,
  tabName: string
) {
  const meta = await sheets.spreadsheets.get({ spreadsheetId });
  const titles = (meta.data.sheets ?? []).map((sheet) => sheet.properties?.title).filter(Boolean);
  if (titles.includes(tabName)) return;
  console.log("google-sheets-tab-create-start", { spreadsheetId, tabName });
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: {
      requests: [
        {
          addSheet: {
            properties: {
              title: tabName
            }
          }
        }
      ]
    }
  });
}

export async function writeClientRequestRowToGoogleSheet(input: WriteClientRequestRowInput) {
  const serviceJsonRaw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  const sheetsMapRaw = process.env.CLIENT_SHEETS_MAP;
  console.log("google-sheets-env-loaded", {
    hasServiceAccountJson: Boolean(serviceJsonRaw?.trim()),
    hasClientSheetsMap: Boolean(sheetsMapRaw?.trim())
  });

  if (!serviceJsonRaw?.trim() || !sheetsMapRaw?.trim()) {
    console.log("google-sheets-no-client-map", { reason: "missing_env" });
    return;
  }

  let serviceAccount: { client_email: string; private_key: string };
  let clientSheetsMap: Record<string, string>;
  try {
    serviceAccount = JSON.parse(serviceJsonRaw) as { client_email: string; private_key: string };
    clientSheetsMap = parseClientSheetsMap(sheetsMapRaw);
  } catch (error) {
    console.log("google-sheets-row-write-failed", {
      stage: "env_parse",
      error: error instanceof Error ? error.message : "Failed to parse Google Sheets env."
    });
    return;
  }

  const spreadsheetId = getSpreadsheetIdForClient(clientSheetsMap, input.telegramGroup);
  if (!spreadsheetId) {
    console.log("google-sheets-no-client-map", { telegramGroup: input.telegramGroup });
    return;
  }
  console.log("google-sheets-spreadsheet-found", { telegramGroup: input.telegramGroup, spreadsheetId });

  try {
    const auth = new google.auth.GoogleAuth({
      credentials: {
        client_email: serviceAccount.client_email,
        private_key: serviceAccount.private_key
      },
      scopes: ["https://www.googleapis.com/auth/spreadsheets"]
    });

    const sheets = google.sheets({ version: "v4", auth });
    console.log("google-sheets-client-created", { telegramGroup: input.telegramGroup });

    const category = mapIntentToCategory(input.intent);
    await ensureSheetTabExists(sheets, spreadsheetId, category);

    const now = input.now ?? new Date();
    const date = now.toISOString().slice(0, 10);
    const time = now.toTimeString().slice(0, 8);
    const row = [
      date,
      time,
      input.telegramGroup,
      input.username,
      category,
      input.originalMessage,
      input.parsedMessage,
      input.status ?? "Pending"
    ];

    console.log("google-sheets-row-write-start", { spreadsheetId, tab: category });
    await sheets.spreadsheets.values.append({
      spreadsheetId,
      range: `${category}!A:H`,
      valueInputOption: "RAW",
      requestBody: { values: [row] }
    });
    console.log("google-sheets-row-write-success", { spreadsheetId, tab: category });
  } catch (error) {
    console.log("google-sheets-row-write-failed", {
      stage: "append",
      error: error instanceof Error ? error.message : "Google Sheets write failed."
    });
  }
}
