// Read-only Firestore access for the savingsTransactions ledger
// (Milestone 2B). Resource-scoped only - no global or member-filtered
// query, matching the exact query shape firestore.rules authorizes (see
// Checkpoint 2's rules tests: resourceType == ..., resourceId == ...,
// orderBy createdAt desc). Write paths (recording a contribution/
// withdrawal, reversals) are a separate future checkpoint; this file
// only turns Firestore documents into canonical SavingsTransaction[]
// values. No balance calculation happens here - that is
// src/domain/savingsBalance.ts's job, deliberately kept separate and not
// imported from this file.
import {
  collection,
  getDocs,
  onSnapshot,
  orderBy,
  query,
  where,
} from "firebase/firestore";
import type { DocumentData, Unsubscribe } from "firebase/firestore";
import { db } from "../../../firebase";
import type {
  CurrencyCode,
  PersistedTimestamp,
  ResourceType,
  SavingsTransaction,
} from "../../types/domain";

// Builds a SavingsTransaction field-by-field from a raw Firestore
// document, matching trips.ts's mapTripDocument convention rather than
// spreading the whole document plus a trailing cast. Every field is
// read and typed individually; nothing is coerced or defaulted to a
// fabricated value - amountMinor/currency/memberUid/recordedBy/
// resourceId/type are trusted as-is from the persisted representation
// (firestore.rules's savingsTransactions create rule, not this mapper,
// is what guarantees their shape on write).
//
// reversalOf is the one deliberate exception: the domain type requires
// it to always be present (`string | null`, no `?`), but the write
// rules intentionally allow the key to be omitted entirely for an
// ordinary (non-reversal) transaction - an absent key and an explicit
// null both mean "no reversal". Normalizing an absent key to null here
// fulfills the canonical type's own contract without fabricating any
// new information.
function mapSavingsTransactionDocument(
  id: string,
  data: DocumentData
): SavingsTransaction {
  const base = {
    id,
    resourceType: data.resourceType as ResourceType,
    resourceId: data.resourceId as string,
    memberUid: data.memberUid as string,
    recordedBy: data.recordedBy as string,
    amountMinor: data.amountMinor as number,
    currency: data.currency as CurrencyCode,
    note: data.note as string | undefined,
    occurredAt: data.occurredAt as PersistedTimestamp | undefined,
    createdAt: data.createdAt as PersistedTimestamp,
    reversalOf: (data.reversalOf ?? null) as string | null,
  };

  // type is intentionally NOT cast-and-trusted like the other fields
  // above: it is the discriminant the pure calculation layer
  // (src/domain/savingsBalance.ts) uses to decide a transaction's sign.
  // A malformed/admin-seeded value here (e.g. "deposit") must fail
  // visibly rather than silently pass through as a fabricated
  // contribution or withdrawal and reach that calculation.
  if (data.type === "contribution") {
    return { ...base, type: "contribution" };
  }
  if (data.type === "withdrawal") {
    return { ...base, type: "withdrawal" };
  }
  throw new Error(
    `Invalid persisted savingsTransactions type "${data.type}" on document ${id}`
  );
}

function resourceTransactionsQuery(
  resourceType: ResourceType,
  resourceId: string
) {
  return query(
    collection(db, "savingsTransactions"),
    where("resourceType", "==", resourceType),
    where("resourceId", "==", resourceId),
    orderBy("createdAt", "desc")
  );
}

export async function fetchSavingsTransactionsForResource(
  resourceType: ResourceType,
  resourceId: string
): Promise<SavingsTransaction[]> {
  const snap = await getDocs(
    resourceTransactionsQuery(resourceType, resourceId)
  );
  return snap.docs.map((d) =>
    mapSavingsTransactionDocument(d.id, d.data() as DocumentData)
  );
}

export function subscribeToSavingsTransactionsForResource(
  resourceType: ResourceType,
  resourceId: string,
  onChange: (transactions: SavingsTransaction[]) => void,
  onError?: (error: unknown) => void
): Unsubscribe {
  return onSnapshot(
    resourceTransactionsQuery(resourceType, resourceId),
    (snap) => {
      const next: SavingsTransaction[] = [];
      snap.forEach((docSnap) => {
        next.push(
          mapSavingsTransactionDocument(docSnap.id, docSnap.data() as DocumentData)
        );
      });
      onChange(next);
    },
    onError
  );
}
