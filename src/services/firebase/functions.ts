import { httpsCallable } from "firebase/functions";
import { functions } from "../../../firebase";

export async function lookupUserByEmail(
  email: string
): Promise<{ uid?: string }> {
  const callable = httpsCallable<{ email: string }, { uid?: string }>(
    functions,
    "lookupUserByEmail"
  );
  const res = await callable({ email });
  return res.data;
}
