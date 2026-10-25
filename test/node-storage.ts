import { DatabaseSync, type SQLInputValue, type SQLOutputValue } from "node:sqlite";
import { StorageFS, type SqlExec, type SqlValue } from "../src/storage-fs.ts";

const toInput = (value: SqlValue): SQLInputValue => (value instanceof ArrayBuffer ? new Uint8Array(value) : value);
const toOutput = (value: SQLOutputValue): SqlValue => (typeof value === "bigint" ? Number(value) : value);

export function openStorage(file: string) {
  const db = new DatabaseSync(file);
  const sql: SqlExec = (query, ...bindings) => {
    const statement = db.prepare(query);
    if (!statement.columns().length) {
      statement.run(...bindings.map(toInput));
      return [];
    }
    return statement.all(...bindings.map(toInput)).map((row) => Object.fromEntries(Object.entries(row).map(([key, value]) => [key, toOutput(value)])));
  };
  return { db, fs: new StorageFS(sql) };
}
