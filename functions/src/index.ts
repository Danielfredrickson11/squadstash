import {initializeApp} from "firebase-admin/app";

initializeApp();

export {createBucket} from "./callables/createBucket";
export {lookupUserByEmail} from "./callables/lookupUserByEmail";
export {recordSavingsTransaction} from "./callables/recordSavingsTransaction";
