// Firestore user-profile writes (users/{uid} and publicUsers/{uid}).
// Extracted from app/(auth)/register.tsx so the same writes can be
// reused by app/(auth)/login.tsx's self-heal writes later.
import {
  collection,
  doc,
  onSnapshot,
  query,
  serverTimestamp,
  setDoc,
  where,
} from "firebase/firestore";
import type { DocumentData, Unsubscribe } from "firebase/firestore";
import { db } from "../../../firebase";
import type {
  PublicProfile,
  UpsertPublicProfileInput,
  UpsertUserProfileInput,
} from "../../types/domain";

export async function upsertUserProfile(
  input: UpsertUserProfileInput
): Promise<void> {
  const { uid, displayName, email, photoURL, includeCreatedAt } = input;

  const payload: Record<string, unknown> = {
    uid,
    displayName,
    email,
    photoURL,
    updatedAt: serverTimestamp(),
  };

  if (includeCreatedAt) {
    payload.createdAt = serverTimestamp();
  }

  await setDoc(doc(db, "users", uid), payload, { merge: true });
}

export async function upsertPublicProfile(
  input: UpsertPublicProfileInput
): Promise<void> {
  const { uid, displayName, photoURL } = input;

  await setDoc(
    doc(db, "publicUsers", uid),
    {
      uid,
      displayName,
      photoURL,
      updatedAt: serverTimestamp(),
    },
    { merge: true }
  );
}

export function subscribeToPublicUsersByIds(
  uids: string[],
  onChange: (users: PublicProfile[]) => void,
  onError?: (error: unknown) => void
): Unsubscribe {
  const qRef = query(
    collection(db, "publicUsers"),
    where("__name__", "in", uids)
  );

  return onSnapshot(
    qRef,
    (snap) => {
      const next: PublicProfile[] = [];
      snap.forEach((docSnap) => {
        const d = docSnap.data() as DocumentData;
        next.push({
          uid: docSnap.id,
          displayName: String(d.displayName ?? ""),
          photoURL: String(d.photoURL ?? ""),
        });
      });
      onChange(next);
    },
    onError
  );
}

// Firestore's own `in`-operator cap. subscribeToPublicUsersByIds above has
// no internal chunking - its one existing call site
// (app/(tabs)/buckets/index.tsx) chunks ad hoc itself. This is the same
// chunk size, extracted into one canonical, reusable implementation for
// Expense member resolution (Checkpoint 4D.1B), which can need profiles
// for a Trip's entire membership - uncapped in this codebase - well past
// this limit.
const PUBLIC_USERS_CHUNK_SIZE = 30;

// Pure, exported for direct testing: dedupes uids, then splits into
// chunks of at most `chunkSize`. Never issues a query itself.
export function chunkUids(
  uids: string[],
  chunkSize: number = PUBLIC_USERS_CHUNK_SIZE
): string[][] {
  const deduped = Array.from(new Set(uids));
  const chunks: string[][] = [];
  for (let i = 0; i < deduped.length; i += chunkSize) {
    chunks.push(deduped.slice(i, i + chunkSize));
  }
  return chunks;
}

// Chunked variant of subscribeToPublicUsersByIds, for a uid set that may
// exceed Firestore's 30-item `in`-query cap (Checkpoint 4D.1B). Does NOT
// change subscribeToPublicUsersByIds's own behavior/signature - existing
// callers (Buckets) are untouched.
//
// Behavior, frozen exactly:
// - `uids` is deduplicated before querying; an empty array synchronously
//   emits `[]` via a zero-query, no-op-unsubscribe subscription.
// - Each chunk gets its own `onSnapshot` listener; that chunk's LATEST
//   snapshot wholesale REPLACES its prior result (never appended), so a
//   profile that disappears from a later snapshot is correctly removed
//   from the next merged emission.
// - No merged aggregate is emitted until EVERY chunk has delivered its
//   first successful snapshot - otherwise a member belonging to a
//   not-yet-resolved chunk would incorrectly read as "confirmed absent"
//   rather than "still loading" (this distinction is the caller's own
//   "Loading member…" vs. "Trip member" UI copy, §9 of the UI preflight).
// - A terminal error on ANY chunk fails the WHOLE combined subscription:
//   every remaining chunk listener is torn down immediately, and the
//   error is surfaced through the single combined `onError` - never a
//   partial aggregate mixing successful and failed chunks.
// - The single returned `Unsubscribe` tears down every underlying chunk
//   listener together.
export function subscribeToPublicUsersByIdsChunked(
  uids: string[],
  onChange: (users: PublicProfile[]) => void,
  onError?: (error: unknown) => void
): Unsubscribe {
  const chunks = chunkUids(uids);

  if (chunks.length === 0) {
    onChange([]);
    return () => {};
  }

  const chunkResults: (PublicProfile[] | undefined)[] = new Array(
    chunks.length
  ).fill(undefined);
  let failed = false;
  let unsubscribes: Unsubscribe[] = [];

  const unsubscribeAll: Unsubscribe = () => {
    unsubscribes.forEach((unsub) => unsub());
  };

  const emitIfComplete = () => {
    if (failed) return;
    if (chunkResults.some((result) => result === undefined)) return;
    const merged: PublicProfile[] = [];
    for (const result of chunkResults) {
      merged.push(...(result as PublicProfile[]));
    }
    onChange(merged);
  };

  unsubscribes = chunks.map((chunk, index) =>
    onSnapshot(
      query(collection(db, "publicUsers"), where("__name__", "in", chunk)),
      (snap) => {
        if (failed) return;
        const next: PublicProfile[] = [];
        snap.forEach((docSnap) => {
          const d = docSnap.data() as DocumentData;
          next.push({
            uid: docSnap.id,
            displayName: String(d.displayName ?? ""),
            photoURL: String(d.photoURL ?? ""),
          });
        });
        chunkResults[index] = next;
        emitIfComplete();
      },
      (error) => {
        if (failed) return;
        failed = true;
        unsubscribeAll();
        if (onError) {
          onError(error);
        } else {
          console.error(
            "subscribeToPublicUsersByIdsChunked: chunk subscription failed",
            error
          );
        }
      }
    )
  );

  return unsubscribeAll;
}
