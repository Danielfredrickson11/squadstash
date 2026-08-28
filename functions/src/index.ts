import {initializeApp} from "firebase-admin/app";

initializeApp();

export {lookupUserByEmail} from "./callables/lookupUserByEmail";
export {recordSavingsTransaction} from "./callables/recordSavingsTransaction";
