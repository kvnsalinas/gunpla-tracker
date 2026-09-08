#!/usr/bin/env node
/**
 * Emit SQL that loads a handful of demo kits into one pilot's registry —
 * for screenshots and for poking at the UI before you've entered anything real.
 *
 *   node scripts/seed-demo.mjs kevin > /tmp/seed.sql
 *   npx wrangler d1 execute gunpla --local --file=/tmp/seed.sql
 *
 * Pass --reset to wipe that pilot's existing kits and photos first. That
 * deletes every kit they own, not just demo ones. Other pilots are untouched.
 *
 * Photo rows are left alone: they point at R2 objects this script can't create.
 */

const args = process.argv.slice(2);
const reset = args.includes('--reset');
const username = args.find((arg) => !arg.startsWith('--'));

if (!username) {
  console.error('usage: node scripts/seed-demo.mjs <username> [--reset]');
  process.exit(1);
}

// name, grade, scale, series, status, msrp, paid, store, date
const DEMO = [
  ['RX-78-2 Gundam Ver. Ka', 'MG', '1/100', 'Mobile Suit Gundam', 'built', 3200, 2950, 'ZeonHobby', '2026-03-14'],
  ['MBF-P02 Gundam Astray Red Frame', 'RG', '1/144', 'Gundam SEED Astray', 'building', 1850, 1750, 'Great Toys Davao', '2026-05-02'],
  ['ZGMF-X10A Freedom Gundam Ver. 2.0', 'MG', '1/100', 'Gundam SEED', 'owned', 3600, 3400, 'Lazada', '2026-06-21'],
  ['RX-93 Nu Gundam', 'RG', '1/144', "Char's Counterattack", 'owned', 2100, 1990, 'Shopee', '2026-07-08'],
  ['XXXG-01W Wing Gundam Zero EW', 'MG', '1/100', 'Endless Waltz', 'wishlist', 3900, null, '', ''],
  ['PF-78-1 Perfect Gundam', 'HG', '1/144', 'Plamo-Kyo Shiro', 'built', 950, 890, 'Hobbes', '2026-02-11'],
  ['MSN-04 Sazabi Ver. Ka', 'MG', '1/100', "Char's Counterattack", 'wishlist', 6800, null, '', ''],
  ['RX-0 Unicorn Gundam Ver. Ka', 'PG', '1/60', 'Gundam Unicorn', 'wishlist', 18500, null, '', ''],
  ["MS-06S Char's Zaku II", 'HG', '1/144', 'Mobile Suit Gundam', 'built', 780, 720, 'ZeonHobby', '2026-01-30'],
  ['Gundam Barbatos Lupus Rex', 'HG', '1/144', 'Iron-Blooded Orphans', 'building', 1100, 1050, 'Shopee', '2026-07-25'],
  ['SD Gundam EX-Standard Strike Freedom', 'SD', '', 'Gundam SEED Destiny', 'owned', 650, 600, 'Great Toys', '2026-06-02'],
  ["MSM-07S Z'Gok", 'HG', '1/144', 'Mobile Suit Gundam', 'owned', 820, 799, 'Lazada', '2026-07-30'],
];

const quote = (value) =>
  value === null || value === undefined ? 'NULL' : `'${String(value).replace(/'/g, "''")}'`;
const num = (value) => (value === null || value === undefined ? 'NULL' : String(value));

// The username is resolved inside SQL so this never needs the user's id.
const owner = `(SELECT id FROM users WHERE username = ${quote(username.toLowerCase())})`;

const lines = [`-- demo kits for '${username.toLowerCase()}'`];

if (reset) {
  lines.push(
    `DELETE FROM photos WHERE kit_id IN (SELECT id FROM kits WHERE user_id = ${owner});`,
    `DELETE FROM kits WHERE user_id = ${owner};`,
  );
}

for (const [name, grade, scale, series, status, msrp, paid, store, date] of DEMO) {
  lines.push(
    'INSERT INTO kits (user_id, name, grade, scale, series, status, price_msrp, ' +
      'price_paid, store, date_acquired) SELECT ' +
      [
        'id',
        quote(name),
        quote(grade),
        quote(scale),
        quote(series),
        quote(status),
        num(msrp),
        num(paid),
        quote(store),
        quote(date),
      ].join(', ') +
      ` FROM users WHERE username = ${quote(username.toLowerCase())};`,
  );
}

console.log(lines.join('\n'));
