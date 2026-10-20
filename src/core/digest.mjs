// Content digests over a canonical JSON form, so the same value always has
// the same digest regardless of key order.
import { createHash } from "node:crypto";

export function canonicalJson(value) {
  if (value === null || typeof value !== "object") {
    if (typeof value === "number" && !Number.isFinite(value)) throw new TypeError("canonicalJson: numbers must be finite");
    if (value === undefined) throw new TypeError("canonicalJson: undefined has no JSON form");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const keys = Object.keys(value)
    .filter((k) => value[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(",")}}`;
}

export const sha256 = (data) => `sha256:${createHash("sha256").update(data).digest("hex")}`;

export const digestOf = (value) => sha256(canonicalJson(value));
