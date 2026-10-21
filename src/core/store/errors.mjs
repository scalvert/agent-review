// Every store failure has a code, so callers and tests can tell them apart
// without matching message text.
export class StoreError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "StoreError";
    this.code = code;
    this.details = details;
  }
}

export const BUSY = "store/busy";
export const CONFLICT = "store/conflict";
export const OP_ID_REUSED = "store/op-id-reused";
export const CORRUPT = "store/corrupt";
export const INVALID = "store/invalid";
