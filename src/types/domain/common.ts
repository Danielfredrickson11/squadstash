// Shared primitives for the Milestone 2A canonical domain types.
import type { Timestamp } from "firebase/firestore";

// A timestamp field as read back from a persisted Firestore document.
// Never use this for a field being *written* with serverTimestamp() -
// that value is a FieldValue sentinel, not a Timestamp, until the write
// resolves and the document is read back.
export type PersistedTimestamp = Timestamp;

export type ResourceType = "bucket" | "trip";

export type CurrencyCode = string;
