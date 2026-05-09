import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function formatDate(value?: string | null) {
  if (!value) return "Unknown";
  return new Intl.DateTimeFormat("en", {
    timeZone: "Asia/Jerusalem",
    dateStyle: "medium",
    timeStyle: "short"
  }).format(new Date(value));
}

export function truncate(value: string | null | undefined, length = 96) {
  if (!value) return "No message";
  return value.length > length ? `${value.slice(0, length - 1)}...` : value;
}

export function prettyJson(value: unknown) {
  if (value === null || value === undefined || value === "") return "No extracted data";
  return JSON.stringify(value, null, 2);
}

export function booleanStatus(value: boolean) {
  return value ? "yes" : "no";
}
