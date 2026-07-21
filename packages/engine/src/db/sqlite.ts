import BetterSqlite3 from 'better-sqlite3-multiple-ciphers';

/**
 * Single place that adapts the CommonJS `better-sqlite3-multiple-ciphers`
 * default export to our ESM world. Import the constructor and the instance
 * type (`Db`) from here so the interop lives in exactly one file.
 */
export { BetterSqlite3 };
export type Db = InstanceType<typeof BetterSqlite3>;
export type Statement = ReturnType<Db['prepare']>;
