import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { loadConfig } from './config.ts';

process.umask(0o077);
const config = loadConfig(resolve(process.argv[2] ?? process.env.ADAPTOR_CONFIG ?? 'localdeploy/adaptor/config.json'));
if (existsSync(config.sqlite_path)) throw new Error('数据库已存在，不会修改现有结构');
mkdirSync(dirname(config.sqlite_path), { recursive: true, mode: 0o700 });
const db = new DatabaseSync(config.sqlite_path);
db.exec(readFileSync(new URL('../sql/schema.sql', import.meta.url), 'utf8'));
db.close();
console.log('Adaptor SQLite 已初始化');
