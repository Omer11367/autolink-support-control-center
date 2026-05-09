import { google } from "googleapis";

type WriteClientRequestRowInput = {
  telegramGroup: string;
  username: string;
  originalMessage: string;
  parsedMessage: string;
  intent: string;
  status?: string;
  extractedData?: Record<string, unknown>;
  now?: Date;
};

const SHEET_HEADERS = [
  "Date",
  "Time",
  "Category",
  "Telegram Group",
  "Username",
  "Original Message",
  "Parsed Summary",
  "Status",
  "Notes"
];

const STATUS_OPTIONS = ["Pending", "In Progress", "Waiting Client", "Completed", "Rejected"];
const LOCAL_TIME_ZONE = "Asia/Jerusalem";

const CATEGORY_COLORS: Record<string, { red: number; green: number; blue: number }> = {
  Share: { red: 0.18, green: 0.42, blue: 0.78 },
  Unshare: { red: 0.92, green: 0.55, blue: 0.18 },
  Deposits: { red: 0.22, green: 0.56, blue: 0.24 },
  "Payment Issues": { red: 0.78, green: 0.22, blue: 0.19 },
  Verification: { red: 0.49, green: 0.28, blue: 0.74 },
  "Account Issues": { red: 0.42, green: 0.45, blue: 0.50 },
  General: { red: 0.35, green: 0.39, blue: 0.45 }
};

function mapIntentToCategory(intent: string): string {
  const normalized = String(intent || "").toLowerCase();
  if (["share_ad_account", "transfer_ad_account"].includes(normalized)) return "Share";
  if (["unshare_ad_account"].includes(normalized)) return "Unshare";
  if (["deposit_funds"].includes(normalized)) return "Deposits";
  if (["payment_issue", "refund_request"].includes(normalized)) return "Payment Issues";
  if (["verify_account"].includes(normalized)) return "Verification";
  if (["check_account_status", "request_data_banned_accounts", "check_policy"].includes(normalized)) return "Account Issues";
  if (["request_accounts", "check_availability", "get_spend_report", "general_support", "no_action"].includes(normalized)) return "General";
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

function extractSpreadsheetId(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const match = trimmed.match(/\/spreadsheets\/d\/([A-Za-z0-9_-]+)/);
  return match?.[1] ?? trimmed;
}

function getCentralSpreadsheetId(raw: string | undefined, map: Record<string, string>): string | null {
  const firstMappedId = Object.values(map).find((value) => value.trim());
  if (firstMappedId) return extractSpreadsheetId(firstMappedId);
  return raw?.trim().startsWith("{") ? null : extractSpreadsheetId(raw ?? "");
}

function sanitizeSheetTitle(title: string): string {
  const cleanTitle = title.replace(/[:\\/?*[\]]/g, " ").replace(/\s+/g, " ").trim();
  return (cleanTitle || "Unknown Group").slice(0, 100);
}

function isHeaderRow(values: string[]): boolean {
  return SHEET_HEADERS.every((header, index) => values[index] === header);
}

function hasAnyCellValue(values: string[]): boolean {
  return values.some((value) => value.trim().length > 0);
}

function quoteSheetName(tabName: string): string {
  return `'${tabName.replaceAll("'", "''")}'`;
}

function normalizeMoney(value: string): string {
  return value.replace(/\s+/g, "").replace(/^usd/i, "").replace(/usdt$/i, "USDT");
}

function extractAmount(message: string): string | null {
  const match = message.match(/(?:\$|usd\s*)?\d+(?:[,.]\d+)?\s*(?:k|K)?\s*(?:usdt|usd|dollars?|\$)?/i);
  if (!match?.[0]) return null;
  const value = normalizeMoney(match[0].trim());
  if (/\$|usd|usdt|dollars?/i.test(match[0])) return value.replace(/dollars?/i, "$").replace(/usd/i, "$");
  return value;
}

function extractEntityAfter(text: string, labels: string[]): string | null {
  const labelPattern = labels.map((label) => label.replace(/\s+/g, "\\s+")).join("|");
  const match = text.match(new RegExp(`\\b(?:${labelPattern})\\b\\s*[:#-]?\\s*([A-Za-z0-9_-]+)`, "i"));
  return match?.[1] ?? null;
}

type SheetAction = {
  type?: string;
  account?: string;
  accounts?: string[];
  bm?: string;
  amount?: string;
};

function getSheetActions(extractedData: Record<string, unknown> | undefined): SheetAction[] {
  const actions = extractedData?.actions;
  if (!Array.isArray(actions)) return [];
  return actions.filter((action): action is SheetAction => Boolean(action) && typeof action === "object");
}

function firstAccountFromAction(action: SheetAction | undefined): string | null {
  return action?.account ?? action?.accounts?.[0] ?? null;
}

function accountsFromAction(action: SheetAction | undefined): string | null {
  if (!action) return null;
  if (Array.isArray(action.accounts) && action.accounts.length > 0) return action.accounts.join(", ");
  return action.account ?? null;
}

function formatBm(value: string | undefined): string | null {
  if (!value) return null;
  return value.toUpperCase() === "ALL BMS" ? "all BMs" : value;
}

function formatLocalDateTime(value: Date): { date: string; time: string } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: LOCAL_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
    hourCycle: "h23"
  }).formatToParts(value);
  const part = (type: string) => parts.find((item) => item.type === type)?.value ?? "";

  return {
    date: `${part("year")}-${part("month")}-${part("day")}`,
    time: `${part("hour")}:${part("minute")}:${part("second")}`
  };
}

function generateParsedSummary(
  intent: string,
  originalMessage: string,
  fallback: string,
  extractedData?: Record<string, unknown>
): string {
  const category = mapIntentToCategory(intent);
  const message = originalMessage.trim();
  const actions = getSheetActions(extractedData);
  const shareAction = actions.find((action) => action.type === "share_account");
  const unshareAction = actions.find((action) => action.type === "unshare_account");
  const paymentAction = actions.find((action) => action.type === "payment_check");
  const verifyAction = actions.find((action) => action.type === "verify_account");
  const accountStatusAction = actions.find((action) => action.type === "account_status_check");
  const account = extractEntityAfter(message, ["account", "accounts", "acc", "ad account", "ad accounts"]);
  const bm = extractEntityAfter(message, ["bm", "business manager"]);
  const amount = paymentAction?.amount ?? extractAmount(message);

  if (category === "Deposits") {
    return amount ? `Deposit check request for ${amount}` : "Deposit check request";
  }
  if (category === "Share") {
    const actionAccount = accountsFromAction(shareAction) ?? account;
    const actionBm = formatBm(shareAction?.bm) ?? bm;
    if (actionAccount && actionBm) return `Share account ${actionAccount} to BM ${actionBm}`;
    if (actionAccount) return `Share account ${actionAccount}`;
    return "Share account request";
  }
  if (category === "Unshare") {
    const actionAccount = accountsFromAction(unshareAction) ?? account;
    const actionBm = formatBm(unshareAction?.bm) ?? bm;
    if (actionAccount && actionBm) return `Unshare accounts ${actionAccount} from ${actionBm}`;
    if (actionAccount) return `Unshare accounts ${actionAccount}`;
    return "Unshare account request";
  }
  if (category === "Payment Issues") {
    const actionAccount = firstAccountFromAction(accountStatusAction) ?? account;
    return actionAccount ? `Payment issue reported on account ${actionAccount}` : "Payment issue reported";
  }
  if (category === "Verification") {
    const actionAccount = firstAccountFromAction(verifyAction) ?? account;
    return actionAccount ? `Verification request submitted for account ${actionAccount}` : "Verification request submitted";
  }

  const cleanFallback = fallback.trim();
  if (cleanFallback && !/^detected intent:/i.test(cleanFallback)) return cleanFallback;
  return "General support request";
}

async function ensureSheetTabReady(
  sheets: ReturnType<typeof google.sheets>,
  spreadsheetId: string,
  tabName: string
) {
  const meta = await sheets.spreadsheets.get({ spreadsheetId });
  let sheet = (meta.data.sheets ?? []).find((item) => item.properties?.title === tabName);

  if (!sheet) {
    const created = await sheets.spreadsheets.batchUpdate({
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
    const sheetId = created.data.replies?.[0]?.addSheet?.properties?.sheetId;
    sheet = { properties: { sheetId, title: tabName } };
    console.log("sheets-tab-created", { tabName });
  }

  const sheetId = sheet.properties?.sheetId;
  if (typeof sheetId !== "number") throw new Error(`Missing Google Sheet ID for tab: ${tabName}`);

  const headerResponse = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${quoteSheetName(tabName)}!A1:I1`
  });
  const currentHeader = (headerResponse.data.values?.[0] ?? []).map((value) => String(value ?? ""));
  const shouldWriteHeaders = !isHeaderRow(currentHeader);
  const shouldInsertHeaderRow = shouldWriteHeaders && hasAnyCellValue(currentHeader);
  console.log("google-sheets-format-start", { spreadsheetId, tabName });

  const headerColor = CATEGORY_COLORS[tabName] ?? CATEGORY_COLORS.General;
  const hasBanding = Boolean(sheet.bandedRanges?.length);
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: {
      requests: [
        ...(shouldInsertHeaderRow
          ? [
              {
                insertDimension: {
                  range: {
                    sheetId,
                    dimension: "ROWS",
                    startIndex: 0,
                    endIndex: 1
                  },
                  inheritFromBefore: false
                }
              }
            ]
          : []),
        {
          updateSheetProperties: {
            properties: {
              sheetId,
              gridProperties: { frozenRowCount: 1 }
            },
            fields: "gridProperties.frozenRowCount"
          }
        },
        {
          repeatCell: {
            range: { sheetId, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: SHEET_HEADERS.length },
            cell: {
              userEnteredFormat: {
                backgroundColor: headerColor,
                textFormat: { bold: true, foregroundColor: { red: 1, green: 1, blue: 1 } },
                verticalAlignment: "MIDDLE",
                wrapStrategy: "WRAP"
              }
            },
            fields: "userEnteredFormat(backgroundColor,textFormat,verticalAlignment,wrapStrategy)"
          }
        },
        {
          repeatCell: {
            range: { sheetId, startRowIndex: 1, startColumnIndex: 0, endColumnIndex: SHEET_HEADERS.length },
            cell: {
              userEnteredFormat: {
                verticalAlignment: "MIDDLE",
                wrapStrategy: "WRAP"
              }
            },
            fields: "userEnteredFormat(verticalAlignment,wrapStrategy)"
          }
        },
        {
          setDataValidation: {
            range: { sheetId, startRowIndex: 1, startColumnIndex: 7, endColumnIndex: 8 },
            rule: {
              condition: {
                type: "ONE_OF_LIST",
                values: STATUS_OPTIONS.map((userEnteredValue) => ({ userEnteredValue }))
              },
              inputMessage: "Select ticket status",
              strict: true,
              showCustomUi: true
            }
          }
        },
        {
          setBasicFilter: {
            filter: {
              range: {
                sheetId,
                startRowIndex: 0,
                startColumnIndex: 0,
                endColumnIndex: SHEET_HEADERS.length
              }
            }
          }
        },
        {
          autoResizeDimensions: {
            dimensions: { sheetId, dimension: "COLUMNS", startIndex: 0, endIndex: SHEET_HEADERS.length }
          }
        },
        ...(!hasBanding
          ? [
              {
                addBanding: {
                  bandedRange: {
                    range: { sheetId, startRowIndex: 0, startColumnIndex: 0, endColumnIndex: SHEET_HEADERS.length },
                    rowProperties: {
                      headerColor,
                      firstBandColor: { red: 1, green: 1, blue: 1 },
                      secondBandColor: { red: 0.96, green: 0.97, blue: 0.98 }
                    }
                  }
                }
              }
            ]
          : [])
      ]
    }
  });

  if (shouldWriteHeaders) {
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `${quoteSheetName(tabName)}!A1:I1`,
      valueInputOption: "RAW",
      requestBody: { values: [SHEET_HEADERS] }
    });
  }
  console.log("google-sheets-format-success", { spreadsheetId, tabName });
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
  let clientSheetsMap: Record<string, string> = {};
  try {
    serviceAccount = JSON.parse(serviceJsonRaw) as { client_email: string; private_key: string };
    if (sheetsMapRaw?.trim().startsWith("{")) {
      clientSheetsMap = parseClientSheetsMap(sheetsMapRaw);
    }
  } catch (error) {
    console.log("google-sheets-row-write-failed", {
      stage: "env_parse",
      error: error instanceof Error ? error.message : "Failed to parse Google Sheets env."
    });
    return;
  }

  const spreadsheetId = getCentralSpreadsheetId(sheetsMapRaw, clientSheetsMap);
  if (!spreadsheetId) {
    console.log("google-sheets-no-client-map", { reason: "missing_central_spreadsheet" });
    return;
  }
  console.log("google-sheets-spreadsheet-found", { telegramGroup: input.telegramGroup });

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
    const tabName = sanitizeSheetTitle(input.telegramGroup);
    console.log("sheets-category-selected", { category, intent: input.intent });
    await ensureSheetTabReady(sheets, spreadsheetId, tabName);

    const now = input.now ?? new Date();
    const { date, time } = formatLocalDateTime(now);
    const parsedSummary = generateParsedSummary(input.intent, input.originalMessage, input.parsedMessage, input.extractedData);
    console.log("google-sheets-summary-generated", { tab: tabName, category, parsedSummary });

    const row = [
      date,
      time,
      category,
      input.telegramGroup,
      input.username,
      input.originalMessage,
      parsedSummary,
      input.status ?? "Pending",
      ""
    ];

    console.log("google-sheets-row-write-start", { tab: tabName, category });
    await sheets.spreadsheets.values.append({
      spreadsheetId,
      range: `${quoteSheetName(tabName)}!A:I`,
      valueInputOption: "RAW",
      requestBody: { values: [row] }
    });
    console.log("google-sheets-row-write-success", { tab: tabName, category });
    console.log("sheets-row-written", { tab: tabName, category });
  } catch (error) {
    console.log("google-sheets-row-write-failed", {
      stage: "append",
      error: error instanceof Error ? error.message : "Google Sheets write failed."
    });
  }
}
