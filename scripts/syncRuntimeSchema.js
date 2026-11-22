const fs = require('fs');
const path = require('path');
const db = require('../config/database');
const { defaults } = require('../config/defaultRolePermissions');

const migrationPath = path.join(__dirname, '..', 'database', 'migration_express_runtime.sql');

function splitTopLevel(source) {
  const parts = [];
  let start = 0;
  let depth = 0;
  let quote = '';

  for (let i = 0; i < source.length; i += 1) {
    const char = source[i];
    if (quote) {
      if (char === quote && source[i - 1] !== '\\') quote = '';
      continue;
    }
    if (char === "'" || char === '"' || char === '`') {
      quote = char;
    } else if (char === '(') {
      depth += 1;
    } else if (char === ')') {
      depth -= 1;
    } else if (char === ',' && depth === 0) {
      parts.push(source.slice(start, i).trim());
      start = i + 1;
    }
  }

  const last = source.slice(start).trim();
  if (last) parts.push(last);
  return parts;
}

function cleanIdentifier(value) {
  return value.replace(/[`;]/g, '').trim();
}

async function hasColumn(table, column) {
  const [rows] = await db.query(
    `SELECT 1 FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ? LIMIT 1`,
    [table, column],
  );
  return rows.length > 0;
}

async function applyMissingColumns(sql) {
  const alterPattern = /ALTER\s+TABLE\s+(`?[\w]+`?)\s+([\s\S]*?);/gi;
  let match;
  while ((match = alterPattern.exec(sql))) {
    const table = cleanIdentifier(match[1]);
    for (const fragment of splitTopLevel(match[2])) {
      const addColumn = fragment.match(/^ADD\s+COLUMN\s+IF\s+NOT\s+EXISTS\s+(`?[\w]+`?)\s+([\s\S]+)$/i);
      if (addColumn) {
        const column = cleanIdentifier(addColumn[1]);
        if (await hasColumn(table, column)) continue;
        await db.query(`ALTER TABLE ?? ADD COLUMN ?? ${addColumn[2]}`, [table, column]);
        console.log(`Ditambahkan: ${table}.${column}`);
        continue;
      }

      const modifyColumn = fragment.match(/^MODIFY\s+COLUMN\s+(`?[\w]+`?)\s+([\s\S]+)$/i);
      if (modifyColumn) {
        const column = cleanIdentifier(modifyColumn[1]);
        if (!await hasColumn(table, column)) continue;
        await db.query(`ALTER TABLE ?? MODIFY COLUMN ?? ${modifyColumn[2]}`, [table, column]);
        console.log(`Diselaraskan: ${table}.${column}`);
      }
    }
  }
}

async function applyMissingTables(sql) {
  const createPattern = /CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+`?[\w]+`?[\s\S]*?ENGINE\s*=\s*InnoDB\s*;/gi;
  for (const statement of sql.match(createPattern) || []) {
    await db.query(statement);
  }
}

async function seedDefaultRolePermissions() {
  for (const permission of defaults) {
    await db.query(`
      INSERT IGNORE INTO role_permissions
        (role_name, resource_key, can_create, can_read, can_update, can_delete)
      VALUES (?, ?, ?, ?, ?, ?)
    `, [
      permission.role_name,
      permission.resource_key,
      permission.can_create,
      permission.can_read,
      permission.can_update,
      permission.can_delete,
    ]);
  }
}

async function main() {
  const sql = fs.readFileSync(migrationPath, 'utf8')
    .replace(/^\s*--.*$/gm, '')
    .replace(/^\s*USE\s+`?[\w]+`?\s*;\s*$/gim, '');

  const [databaseRows] = await db.query('SELECT DATABASE() AS database_name');
  console.log(`Menyelaraskan skema runtime pada database ${databaseRows[0].database_name}.`);
  await applyMissingTables(sql);
  await applyMissingColumns(sql);
  await seedDefaultRolePermissions();
  console.log('Penyelarasan skema selesai.');
}

main()
  .catch((error) => {
    console.error('Penyelarasan skema gagal:', error.code || error.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await db.end();
  });
