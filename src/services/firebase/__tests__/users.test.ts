// Tests for the profile-chunking additions to src/services/firebase/
// users.ts (Checkpoint 4D.1B): chunkUids (pure) and
// subscribeToPublicUsersByIdsChunked (Firestore-SDK-dependent wiring).
//
// "firebase/firestore" is mocked so Jest never attempts to parse the real
// "firebase" package's ESM build (see the identical, more-detailed comment
// in expenses.test.ts for why) - the imports here follow the same
// import-first-then-jest.mock ordering for the same import/first-lint
// reason; jest.mock() calls are hoisted above every import in this file
// regardless of their own textual position.
import {
  chunkUids,
  subscribeToPublicUsersByIdsChunked,
} from "../users";
import {
  collection as mockCollection,
  onSnapshot as mockOnSnapshot,
  where as mockWhere,
} from "firebase/firestore";
import type { PublicProfile } from "../../../types/domain";

jest.mock("firebase/firestore", () => ({
  collection: jest.fn((..._args: unknown[]) => ({__type: "collection"})),
  doc: jest.fn((..._args: unknown[]) => ({__type: "docRef"})),
  onSnapshot: jest.fn(),
  query: jest.fn((...args: unknown[]) => ({__type: "query", args})),
  serverTimestamp: jest.fn(() => ({__type: "serverTimestamp"})),
  setDoc: jest.fn(),
  where: jest.fn((...args: unknown[]) => ({__type: "where", args})),
}));

jest.mock("../../../../firebase", () => ({
  db: {__type: "db"},
}));

const mockCollectionFn = mockCollection as unknown as jest.Mock;
const mockOnSnapshotFn = mockOnSnapshot as unknown as jest.Mock;
const mockWhereFn = mockWhere as unknown as jest.Mock;

beforeEach(() => {
  jest.clearAllMocks();
});

function profile(uid: string): PublicProfile {
  return {uid, displayName: `User ${uid}`, photoURL: ""};
}

function fakeSnap(profiles: PublicProfile[]) {
  return {
    forEach: (cb: (docSnap: {id: string; data: () => Record<string, unknown>}) => void) => {
      profiles.forEach((p) =>
        cb({id: p.uid, data: () => ({displayName: p.displayName, photoURL: p.photoURL})})
      );
    },
  };
}

describe("chunkUids", () => {
  it("dedupes uids before chunking", () => {
    expect(chunkUids(["a", "b", "a", "c", "b"])).toEqual([["a", "b", "c"]]);
  });

  it("returns exactly one chunk for exactly 30 ids", () => {
    const uids = Array.from({length: 30}, (_, i) => `uid-${i}`);
    const chunks = chunkUids(uids);
    expect(chunks.length).toBe(1);
    expect(chunks[0].length).toBe(30);
  });

  it("returns two chunks for 31 ids", () => {
    const uids = Array.from({length: 31}, (_, i) => `uid-${i}`);
    const chunks = chunkUids(uids);
    expect(chunks.length).toBe(2);
    expect(chunks[0].length).toBe(30);
    expect(chunks[1].length).toBe(1);
  });

  it("returns an empty array of chunks for an empty input", () => {
    expect(chunkUids([])).toEqual([]);
  });
});

describe("subscribeToPublicUsersByIdsChunked", () => {
  it("emits [] synchronously with zero Firestore queries/listeners for an empty uid list", () => {
    const onChange = jest.fn();
    const unsubscribe = subscribeToPublicUsersByIdsChunked([], onChange);
    expect(onChange).toHaveBeenCalledWith([]);
    expect(mockCollectionFn).not.toHaveBeenCalled();
    expect(mockOnSnapshotFn).not.toHaveBeenCalled();
    expect(() => unsubscribe()).not.toThrow();
  });

  it("issues exactly one chunk query for 31 uids split 30/1", () => {
    const onChange = jest.fn();
    mockOnSnapshotFn.mockImplementation((_q, onNext) => {
      onNext(fakeSnap([]));
      return () => {};
    });
    const uids = Array.from({length: 31}, (_, i) => `uid-${i}`);
    subscribeToPublicUsersByIdsChunked(uids, onChange);
    expect(mockOnSnapshotFn).toHaveBeenCalledTimes(2);
    const chunkSizes = mockWhereFn.mock.calls.map(
      (call: unknown[]) => (call[2] as string[]).length
    );
    expect(chunkSizes.sort((a, b) => a - b)).toEqual([1, 30]);
  });

  it("does not emit a merged result until EVERY chunk has delivered its first snapshot", () => {
    const onChange = jest.fn();
    const listeners: ((snap: ReturnType<typeof fakeSnap>) => void)[] = [];
    mockOnSnapshotFn.mockImplementation((_q, onNext) => {
      listeners.push(onNext);
      return () => {};
    });
    const uids = Array.from({length: 31}, (_, i) => `uid-${i}`);
    subscribeToPublicUsersByIdsChunked(uids, onChange);

    expect(listeners.length).toBe(2);
    listeners[0](fakeSnap([profile("uid-0")]));
    expect(onChange).not.toHaveBeenCalled(); // chunk 2 hasn't delivered yet

    listeners[1](fakeSnap([profile("uid-30")]));
    expect(onChange).toHaveBeenCalledTimes(1);
    const merged = onChange.mock.calls[0][0] as PublicProfile[];
    expect(merged.map((p) => p.uid).sort()).toEqual(["uid-0", "uid-30"]);
  });

  it("a later snapshot on one chunk REPLACES that chunk's prior result, not appends to it", () => {
    const onChange = jest.fn();
    const listeners: ((snap: ReturnType<typeof fakeSnap>) => void)[] = [];
    mockOnSnapshotFn.mockImplementation((_q, onNext) => {
      listeners.push(onNext);
      return () => {};
    });
    subscribeToPublicUsersByIdsChunked(["a", "b"], onChange);

    listeners[0](fakeSnap([profile("a"), profile("b")]));
    expect(onChange).toHaveBeenCalledTimes(1);
    expect((onChange.mock.calls[0][0] as PublicProfile[]).map((p) => p.uid).sort()).toEqual(["a", "b"]);

    // "b" disappears in a later snapshot of the SAME chunk listener.
    listeners[0](fakeSnap([profile("a")]));
    expect(onChange).toHaveBeenCalledTimes(2);
    expect((onChange.mock.calls[1][0] as PublicProfile[]).map((p) => p.uid)).toEqual(["a"]);
  });

  it("a terminal error on one chunk fails the whole subscription and tears down every chunk listener", () => {
    const onChange = jest.fn();
    const onError = jest.fn();
    const unsubscribeChunk0 = jest.fn();
    const unsubscribeChunk1 = jest.fn();
    let call = 0;
    let errorCb: ((error: unknown) => void) | undefined;
    mockOnSnapshotFn.mockImplementation((_q, _onNext, onErr) => {
      call++;
      if (call === 1) {
        errorCb = onErr;
        return unsubscribeChunk0;
      }
      return unsubscribeChunk1;
    });
    const uids = Array.from({length: 31}, (_, i) => `uid-${i}`);
    subscribeToPublicUsersByIdsChunked(uids, onChange, onError);

    const boom = new Error("permission-denied");
    errorCb?.(boom);

    expect(onError).toHaveBeenCalledWith(boom);
    expect(onChange).not.toHaveBeenCalled();
    expect(unsubscribeChunk0).toHaveBeenCalledTimes(1);
    expect(unsubscribeChunk1).toHaveBeenCalledTimes(1);
  });

  it("never emits a partial aggregate mixing a successful chunk with a failed one", () => {
    const onChange = jest.fn();
    const onError = jest.fn();
    const listeners: ((snap: ReturnType<typeof fakeSnap>) => void)[] = [];
    const errorCbs: ((error: unknown) => void)[] = [];
    mockOnSnapshotFn.mockImplementation((_q, onNext, onErr) => {
      listeners.push(onNext);
      errorCbs.push(onErr);
      return () => {};
    });
    const uids = Array.from({length: 31}, (_, i) => `uid-${i}`);
    subscribeToPublicUsersByIdsChunked(uids, onChange, onError);

    listeners[0](fakeSnap([profile("uid-0")])); // chunk 0 succeeds
    errorCbs[1](new Error("boom")); // chunk 1 fails

    expect(onChange).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it("the combined unsubscribe tears down every underlying chunk listener", () => {
    const unsubscribeChunk0 = jest.fn();
    const unsubscribeChunk1 = jest.fn();
    let call = 0;
    mockOnSnapshotFn.mockImplementation(() => {
      call++;
      return call === 1 ? unsubscribeChunk0 : unsubscribeChunk1;
    });
    const uids = Array.from({length: 31}, (_, i) => `uid-${i}`);
    const unsubscribe = subscribeToPublicUsersByIdsChunked(uids, jest.fn());
    unsubscribe();
    expect(unsubscribeChunk0).toHaveBeenCalledTimes(1);
    expect(unsubscribeChunk1).toHaveBeenCalledTimes(1);
  });

  it("falls back to console.error when no onError is supplied on a chunk failure", () => {
    const consoleErrorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    let errorCb: ((error: unknown) => void) | undefined;
    mockOnSnapshotFn.mockImplementation((_q, _onNext, onErr) => {
      errorCb = onErr;
      return () => {};
    });
    subscribeToPublicUsersByIdsChunked(["a"], jest.fn());
    errorCb?.(new Error("boom"));
    expect(consoleErrorSpy).toHaveBeenCalled();
    consoleErrorSpy.mockRestore();
  });
});
