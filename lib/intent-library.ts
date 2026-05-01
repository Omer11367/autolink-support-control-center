export type IntentDefinition = {
  intent: string;
  label: string;
  whenToDetect: string;
  requiresMark: boolean;
  defaultHoldingResponse: string;
  defaultCompletionResponse: string;
};

export const HOLDING_RESPONSES = [
  "Hello! Let me check on this and I’ll get back to you shortly. 😊",
  "Hi! I’ll check this now and update you shortly.",
  "Hello! Checking this with the team, will update you soon.",
  "Good day! I’ll check this now and update you shortly. Thank you!",
  "Hello! Noted on this. Let me review this first and I’ll update you shortly.",
  "Hi! Received. We’ll check this and get back to you soon."
];

export const GLOBAL_RULES = [
  "Always send a holding message immediately.",
  "Never confirm manual action before Mark confirms.",
  "Bot never performs manual actions itself.",
  "Bot only replies, detects, forwards, waits, and responds after Mark.",
  "Share/unshare/transfer/replace/deposit/refund/spend/availability/status/policy/data requests require Mark.",
  "Do not ask for info if it already exists in the current message or previous 1-2 messages.",
  "Do not rely on number order. Detect by context.",
  "Number near BM or Business Manager = BM ID.",
  "Number near account/account name/acc/ad account = ad account ID.",
  "Account names may look like: 0376 - 70032 - 0226MT - NNVEU.",
  "Access level is not a separate intent. Extract it as full / partial / view / not specified.",
  "Emoji reactions 👍 ❤️ ✅ 🙏 close conversation with no reply.",
  "Do not guess financial, balance, availability, status, or policy decisions.",
  "If unclear, escalate."
];

export const INTENT_LIBRARY: IntentDefinition[] = [
  {
    intent: "share_ad_account",
    label: "Share ad account",
    whenToDetect: "Client wants to share, add, connect, grant, attach, or link ad accounts to a BM.",
    requiresMark: true,
    defaultHoldingResponse: HOLDING_RESPONSES[0],
    defaultCompletionResponse: "This is done. Kindly check on your end. Thank you!"
  },
  {
    intent: "unshare_ad_account",
    label: "Unshare ad account",
    whenToDetect: "Client wants to unbind, unshare, remove BM/access, disconnect, unlink, or revoke access.",
    requiresMark: true,
    defaultHoldingResponse: HOLDING_RESPONSES[1],
    defaultCompletionResponse: "This is done."
  },
  {
    intent: "transfer_ad_account",
    label: "Transfer ad account",
    whenToDetect: "Client wants to transfer, move, switch BM, or use a new BM.",
    requiresMark: true,
    defaultHoldingResponse: HOLDING_RESPONSES[2],
    defaultCompletionResponse: "All done. The new BM has been shared to the ad accounts mentioned. Kindly check on your end. Thank you!"
  },
  {
    intent: "verify_account",
    label: "Verify account",
    whenToDetect: "Client asks to verify an account or sends a screenshot showing a verification issue.",
    requiresMark: true,
    defaultHoldingResponse: HOLDING_RESPONSES[3],
    defaultCompletionResponse: "Hello again @client, we have verified the account [ACCOUNT]. We’ve completed the verification process and we will hear feedback from Meta within 4 days. Thank you!"
  },
  {
    intent: "deposit_funds",
    label: "Deposit funds",
    whenToDetect: "Client says they paid, deposited, sent funds, transferred money, or completed top up.",
    requiresMark: true,
    defaultHoldingResponse: HOLDING_RESPONSES[4],
    defaultCompletionResponse: "Hello @client! Funds have been successfully added to your dashboard wallet. 😊"
  },
  {
    intent: "refund_request",
    label: "Refund request",
    whenToDetect: "Client requests refund, withdrawal, money back, wallet address payout, or remaining balance.",
    requiresMark: true,
    defaultHoldingResponse: HOLDING_RESPONSES[5],
    defaultCompletionResponse: "Hello @client, this has been checked and handled on our end. Thank you for your patience."
  },
  {
    intent: "request_accounts",
    label: "Request accounts",
    whenToDetect: "Client asks for new ad accounts, more accounts, or sends a screenshot indicating new account request.",
    requiresMark: true,
    defaultHoldingResponse: HOLDING_RESPONSES[0],
    defaultCompletionResponse: "📣Good News 📣\n\nYour Meta Ad Accounts:\n\n[ACCOUNT_LIST]\n\nhave been successfully added to your dashboard and are now ready for use!\n\nWishing you a fantastic day ahead. 😊"
  },
  {
    intent: "check_availability",
    label: "Check availability",
    whenToDetect: "Client asks whether an account type is available, in stock, requestable, or not yet available.",
    requiresMark: true,
    defaultHoldingResponse: HOLDING_RESPONSES[1],
    defaultCompletionResponse: "At the moment we don’t have this available. However, we will update you once it becomes available. Thank you for your understanding 🙏"
  },
  {
    intent: "get_spend_report",
    label: "Get spend report",
    whenToDetect: "Client asks for daily spend, spend report, stats, data, or last N days financial information.",
    requiresMark: true,
    defaultHoldingResponse: HOLDING_RESPONSES[2],
    defaultCompletionResponse: "Manual spend report required from Mark. Do not generate numbers automatically."
  },
  {
    intent: "check_account_status",
    label: "Check account status",
    whenToDetect: "Client asks if accounts are active, blocked, disabled, usable, or can run ads.",
    requiresMark: true,
    defaultHoldingResponse: HOLDING_RESPONSES[3],
    defaultCompletionResponse: "All listed accounts are active and ready to run ads. Thank you!"
  },
  {
    intent: "check_policy",
    label: "Check policy",
    whenToDetect: "Client asks if an offer, link, website, domain, niche, or campaign is allowed or compliant.",
    requiresMark: true,
    defaultHoldingResponse: HOLDING_RESPONSES[4],
    defaultCompletionResponse: "Yes, this type of offer is allowed. You may proceed with running ads. Thank you!"
  },
  {
    intent: "payment_issue",
    label: "Payment issue",
    whenToDetect: "Client reports debt, balance issue, payment issue, launch block, or campaigns blocked by payment.",
    requiresMark: true,
    defaultHoldingResponse: HOLDING_RESPONSES[5],
    defaultCompletionResponse: "This is fixed now, can you please check it on your end for confirmation? Please let me know. Thank you!"
  },
  {
    intent: "request_data_banned_accounts",
    label: "Data from banned accounts",
    whenToDetect: "Client asks for spend, campaign, or account data from banned/down accounts.",
    requiresMark: true,
    defaultHoldingResponse: HOLDING_RESPONSES[0],
    defaultCompletionResponse: "The BM was down since November, so technically there is no data to be gathered between December and January."
  },
  {
    intent: "access_level",
    label: "Access level detail",
    whenToDetect: "Extract full, partial, view, limited, or admin access as a detail on another intent.",
    requiresMark: false,
    defaultHoldingResponse: "Not a standalone intent.",
    defaultCompletionResponse: "Include requested access level in the internal summary."
  }
];
