import { GLOBAL_RULES, HOLDING_RESPONSES } from "@/lib/intent-library";

export type PlaybookSeedEntry = {
  intent: string;
  title: string;
  description: string;
  detection_rules: string;
  first_response_examples: string[];
  completion_examples: string[];
  escalation_rules: string;
  is_active: boolean;
};

const globalEscalationRules = [
  ...GLOBAL_RULES,
  "Escalate to Mark whenever money, balance, account status, availability, policy, or manual platform action is involved."
].join("\n");

export const PLAYBOOK_SEED: PlaybookSeedEntry[] = [
  {
    intent: "share_ad_account",
    title: "Share or grant ad account access to BM",
    description: "Client wants Autolink to share, add, connect, attach, link, or grant ad account access to a Business Manager.",
    detection_rules: [
      "Detect words such as share, add, connect, give access, grant access, attach, link, add acc to BM.",
      "Extract BM ID, ad account IDs/names, and requested access level if mentioned.",
      "Number near BM or Business Manager is the BM ID.",
      "Number near account, acc, ad account, or account name is an ad account ID.",
      "Account names may look like: 0376 - 70032 - 0226MT - NNVEU."
    ].join("\n"),
    first_response_examples: HOLDING_RESPONSES,
    completion_examples: [
      "This is done. Kindly check on your end. Thank you!",
      "Hi @client, this is already shared. Kindly check on your end. Thank you."
    ],
    escalation_rules: globalEscalationRules,
    is_active: true
  },
  {
    intent: "unshare_ad_account",
    title: "Unshare or remove BM access",
    description: "Client wants to unbind, unshare, remove, disconnect, unlink, or revoke BM access from ad accounts.",
    detection_rules: [
      "Detect unbind, unshare, remove BM, remove access, disconnect, unlink, revoke access.",
      "Extract BM ID to remove and account IDs/names.",
      "Do not confirm removal until Mark confirms."
    ].join("\n"),
    first_response_examples: HOLDING_RESPONSES,
    completion_examples: [
      "This is done.",
      "The BM has already been removed from the mentioned account(s). Kindly check on your end."
    ],
    escalation_rules: globalEscalationRules,
    is_active: true
  },
  {
    intent: "transfer_ad_account",
    title: "Transfer accounts to a new BM",
    description: "Client wants to transfer, move, switch, or replace the current BM with a new BM.",
    detection_rules: [
      "Detect transfer, move accounts, new BM, switch BM.",
      "If BM ID is missing, ask for BM ID.",
      "If unclear whether current BM should be removed, ask: Just to clarify, would you like us to remove the current BM and replace it with the new one you provided?"
    ].join("\n"),
    first_response_examples: HOLDING_RESPONSES,
    completion_examples: [
      "All done. The new BM has been shared to the ad accounts mentioned. Kindly check on your end. Thank you!",
      "All good now, @client. The current BM has been removed, and the new BM has been successfully shared on the ad accounts mentioned. Thank you so much!"
    ],
    escalation_rules: globalEscalationRules,
    is_active: true
  },
  {
    intent: "verify_account",
    title: "Verify ad account",
    description: "Client asks for verification or sends a screenshot showing a verification issue.",
    detection_rules: [
      "Detect verify, verification, screenshot showing verification issue.",
      "If account name or ID is provided, do not ask again.",
      "If missing, ask: Hello @client, may we have the ad account name please to verify on our end. Thank you!"
    ].join("\n"),
    first_response_examples: HOLDING_RESPONSES,
    completion_examples: [
      "Hello again @client, we have verified the account [ACCOUNT]. We’ve completed the verification process and we will hear feedback from Meta within 4 days. Thank you!"
    ],
    escalation_rules: globalEscalationRules,
    is_active: true
  },
  {
    intent: "deposit_funds",
    title: "Deposit or top-up funds",
    description: "Client says payment, deposit, or funds were sent.",
    detection_rules: [
      "Detect we paid, paid, deposit, funds sent, payment done, transferred money, top up paid.",
      "Always requires Mark.",
      "Never confirm funds before Mark confirms."
    ].join("\n"),
    first_response_examples: HOLDING_RESPONSES,
    completion_examples: ["Hello @client! Funds have been successfully added to your dashboard wallet. 😊"],
    escalation_rules: globalEscalationRules,
    is_active: true
  },
  {
    intent: "refund_request",
    title: "Refund or withdrawal request",
    description: "Client requests refund, withdrawal, money back, or remaining balance payout.",
    detection_rules: [
      "Detect refund, withdraw, return money, wallet address, USDT TRC20, all balance.",
      "Ask if unclear: Would you like a refund for all your balance?",
      "Never approve or promise refund automatically."
    ].join("\n"),
    first_response_examples: HOLDING_RESPONSES,
    completion_examples: ["Hello @client, this has been checked and handled on our end. Thank you for your patience."],
    escalation_rules: globalEscalationRules,
    is_active: true
  },
  {
    intent: "request_accounts",
    title: "Request new ad accounts",
    description: "Client requests new accounts, more accounts, or sends a screenshot indicating a new account request.",
    detection_rules: [
      "Detect request accounts, need accounts, new accounts, more accounts, pls check plus screenshot.",
      "Use singular grammar for one account and plural grammar for multiple accounts.",
      "Never claim accounts were added until Mark confirms."
    ].join("\n"),
    first_response_examples: HOLDING_RESPONSES,
    completion_examples: [
      "📣Good News 📣\n\nYour Meta Ad Accounts:\n\n[ACCOUNT_LIST]\n\nhave been successfully added to your dashboard and are now ready for use!\n\nWishing you a fantastic day ahead. 😊"
    ],
    escalation_rules: globalEscalationRules,
    is_active: true
  },
  {
    intent: "check_availability",
    title: "Check account type availability",
    description: "Client asks if a certain account type is available or in stock.",
    detection_rules: [
      "Detect available, availability, do you have, GH accounts, can we request, not yet, stock.",
      "Always requires Mark.",
      "Do not guess availability."
    ].join("\n"),
    first_response_examples: HOLDING_RESPONSES,
    completion_examples: [
      "At the moment we don’t have this available. However, we will update you once it becomes available. Thank you for your understanding 🙏",
      "Yes, this account type is currently available. You may proceed with the request. Thank you!"
    ],
    escalation_rules: globalEscalationRules,
    is_active: true
  },
  {
    intent: "get_spend_report",
    title: "Get spend report",
    description: "Client asks for daily spend, spend report, stats, financial data, or recent period performance.",
    detection_rules: [
      "Detect daily spend, spend, report, data, stats, last 3 days.",
      "Always requires Mark.",
      "Never generate or invent numbers."
    ].join("\n"),
    first_response_examples: HOLDING_RESPONSES,
    completion_examples: ["Manual spend report required from Mark. Do not generate numbers automatically."],
    escalation_rules: globalEscalationRules,
    is_active: true
  },
  {
    intent: "check_account_status",
    title: "Check account status",
    description: "Client asks if accounts are active, blocked, disabled, usable, or can run ads.",
    detection_rules: [
      "Detect status, active, blocked, disabled, usable, can run ads.",
      "Requires Mark.",
      "For mixed status, show account list with each account status."
    ].join("\n"),
    first_response_examples: HOLDING_RESPONSES,
    completion_examples: [
      "All the ad accounts are disabled and can’t run any ads. Thank you!",
      "All listed accounts are active and ready to run ads. Thank you!"
    ],
    escalation_rules: globalEscalationRules,
    is_active: true
  },
  {
    intent: "check_policy",
    title: "Check policy or offer compliance",
    description: "Client asks if an offer, domain, niche, or website can run.",
    detection_rules: [
      "Detect can we run this, offer, link, website, domain, allowed, compliant, policy.",
      "Always requires Mark.",
      "Never decide policy automatically."
    ].join("\n"),
    first_response_examples: HOLDING_RESPONSES,
    completion_examples: [
      "Unfortunately, we cannot allow this type of ad to run for now, as it involves financial services such as money, loans, or compensation. Thank you for your understanding! 🙏",
      "Yes, this type of offer is allowed. You may proceed with running ads. Thank you!"
    ],
    escalation_rules: globalEscalationRules,
    is_active: true
  },
  {
    intent: "payment_issue",
    title: "Payment issue blocking campaigns",
    description: "Debt or payment issue blocks launches or campaign delivery.",
    detection_rules: [
      "Detect debt, balance issue, payment issue, cannot launch campaigns, campaigns blocked.",
      "Requires Mark.",
      "Do not say fixed until Mark confirms."
    ].join("\n"),
    first_response_examples: HOLDING_RESPONSES,
    completion_examples: [
      "This is fixed now, can you please check it on your end for confirmation? Please let me know. Thank you!"
    ],
    escalation_rules: globalEscalationRules,
    is_active: true
  },
  {
    intent: "request_data_banned_accounts",
    title: "Request data from banned accounts",
    description: "Client asks for spend, campaign, or account data from banned or down accounts.",
    detection_rules: [
      "Detect need data, account ID, campaign name, amount expenses, banned accounts, December/January report.",
      "If client does not specify data, ask: May we ask what information you need from these accounts?",
      "If account IDs are not found, ask for account names."
    ].join("\n"),
    first_response_examples: HOLDING_RESPONSES,
    completion_examples: [
      "May we ask what information you need from these accounts?",
      "We can’t seem to find these accounts using the IDs. Could you please share the account names?",
      "The BM was down since November, so technically there is no data to be gathered between December and January."
    ],
    escalation_rules: globalEscalationRules,
    is_active: true
  },
  {
    intent: "access_level",
    title: "Access level extraction detail",
    description: "Not a standalone intent. Extract requested access level as a detail on account sharing and transfer requests.",
    detection_rules: [
      "Detect full access, partial management access, partial access, view access, limited access, admin access.",
      "Extract as full, partial, view, or not specified.",
      "Always include requested access level in the internal summary to Mark."
    ].join("\n"),
    first_response_examples: ["No standalone holding response. Use the parent intent holding response."],
    completion_examples: ["No standalone completion response. Use the parent intent completion response."],
    escalation_rules: "Attach this detail to the active ticket. Do not create an independent access_level ticket unless no parent intent can be detected.",
    is_active: true
  }
];

export const ACTION_COMPLETION_MESSAGES = {
  done: "This is done. Kindly check on your end. Thank you!",
  already_shared: "Hi @client, this is already shared. Kindly check on your end. Thank you.",
  only_view_access:
    "Upon checking, the BM has already been granted view-access to these accounts. Since these accounts were already offboarded, only view-access can be granted. Thank you for your understanding 🙏",
  funds_arrived: "Hello @client! Funds have been successfully added to your dashboard wallet. 😊",
  not_available:
    "At the moment we don’t have this available. However, we will update you once it becomes available. Thank you for your understanding 🙏",
  handled: "Hello @client, this has been checked and handled on our end. Thank you for your patience."
} as const;

export type MarkActionType = keyof typeof ACTION_COMPLETION_MESSAGES | "close" | "custom_reply";

export function actionLabel(action: MarkActionType) {
  return action
    .split("_")
    .map((part) => part[0]?.toUpperCase() + part.slice(1))
    .join(" ");
}

export function resolveCompletionMessage(action: MarkActionType, username?: string | null, customText?: string) {
  if (action === "close") return "";
  if (action === "custom_reply") return customText?.trim() ?? "";

  const handle = username ? `@${username.replace(/^@/, "")}` : "@client";
  return ACTION_COMPLETION_MESSAGES[action].replaceAll("@client", handle);
}
