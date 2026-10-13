/**
 * Demo Seed Script - Juju
 * Fills the database with realistic demo content for screenshots/mockups,
 * in English or German.
 * Usage: node scripts/seed-demo.js [--db /path/to/yuvomi.db] [--locale en|de|zh]
 *
 * Requires a database already migrated to the current schema (open the app once,
 * or run the server, before seeding). Populates EVERY module:
 *   - Users: alex (admin/dad), linda (admin/mom), emma & leo (children), maria (housekeeper)
 *   - Tasks (categories, priorities, statuses, start/due dates, multi-assignment, tags, points)
 *   - Calendar events (appointments, activities, recurring, assignments)
 *   - Meals (full week, all slots) linked to recipes, plus a recurring meal template
 *   - Recipes with ingredients
 *   - Shopping list with items and tags
 *   - Pantry (stock across every location, expiring + low-stock items)
 *   - Contacts (family, medical, school, services)
 *   - Budget (accounts, per-category plans, income + expenses, loans incl. an
 *     annuity mortgage, receipts linked to entries)
 *   - Notes (pinned + regular)
 *   - Birthdays (family-linked + relatives)
 *   - Documents (folders + files across categories)
 *   - Housekeeping (worker, work sessions, recurring chores, supplies, log)
 *   - Split expenses (household + trip groups, expenses, receipts, comments,
 *     a recurring expense, ledger, settlement)
 *   - Health (vitals, activities, medications + schedules/logs, lab reports, cycle,
 *     plus caregiver grants: both parents may record for the two children)
 *   - Rewards (participants, catalog, points ledger, fulfilled + pending redemptions)
 *   - Budget subscriptions (streaming, storage, gym — mixed billing cycles, one ending)
 *   - Household preferences (EUR, dd.mm.yyyy, 24h, weather = Dortmund)
 *
 * Login for all demo users: <username> / demo1234
 */

import Database from 'better-sqlite3-multiple-ciphers';
import bcrypt from 'bcrypt';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeLoanSchedule } from '../server/services/loan-amortization.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const args = process.argv.slice(2);
const dbIdx = args.indexOf('--db');
const DB_PATH = dbIdx !== -1 ? args[dbIdx + 1] : resolve(__dirname, '..', 'yuvomi.db');

// ── Locale ───────────────────────────────────────────────────────────────────
// Der Demo-Inhalt existiert in drei Sprachen: die Screenshots zeigen immer eine
// App, deren UI UND deren Inhalt derselben Sprache entsprechen. `L(en, de, zh)`
// wählt pro String - die Paarung steht damit an Ort und Stelle und kann nicht,
// wie bei zwei getrennten Datenblöcken, gegeneinander verrutschen. Fehlt die
// chinesische Fassung, fällt L auf Englisch zurück. Default bleibt `en`: das
// ist der kanonische Screenshot-Satz.
const localeIdx = args.indexOf('--locale');
const LOCALE = (localeIdx !== -1 ? String(args[localeIdx + 1] || '') : 'en').toLowerCase();
if (!['en', 'de', 'zh'].includes(LOCALE)) {
  console.error(`Unknown locale "${LOCALE}" — expected "en", "de" or "zh".`);
  process.exit(1);
}
// `L(en, de, zh)` wählt pro String; fehlt die chinesische Fassung, fällt sie
// auf Englisch zurück (besser englischer Inhalt als gar kein Inhalt).
const L = (en, de, zh) => (LOCALE === 'zh' ? (zh ?? en) : LOCALE === 'de' ? de : en);
// Haushaltswährung und Datumsschema folgen der Sprache: der chinesische
// Demo-Haushalt lebt in Shanghai und rechnet in CNY (Beträge werden unten mit
// M ≈ 7 skaliert, damit Mieten und Gehälter plausibel bleiben).
const CUR = LOCALE === 'zh' ? 'CNY' : 'EUR';
const M   = LOCALE === 'zh' ? 7 : 1;
const DATE_FMT = LOCALE === 'zh' ? 'ymd' : 'dmy_dot';
const WEATHER = LOCALE === 'zh'
  ? { lat: '31.2304', lon: '121.4737', city: 'Shanghai' }
  : { lat: '51.5136', lon: '7.4653',  city: 'Dortmund' };

console.log(`Locale: ${LOCALE}`);

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

// ── Date helpers (local time, avoid UTC shift) ───────────────────────────────

function pad(n) { return String(n).padStart(2, '0'); }
function dateKey(d) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }

function daysFromNow(n) {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + n);
  return dateKey(d);
}
function dateTimeFromNow(days, hour, min = 0) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  d.setHours(hour, min, 0, 0);
  return `${dateKey(d)}T${pad(hour)}:${pad(min)}`;
}
function thisMonthDate(day) {
  const d = new Date();
  d.setDate(day);
  return dateKey(d);
}
function lastMonthDate(day) {
  const d = new Date();
  d.setDate(1);
  d.setMonth(d.getMonth() - 1);
  d.setDate(day);
  return dateKey(d);
}
function thisMonthKey(offset = 0) {
  const d = new Date();
  d.setDate(1);
  d.setMonth(d.getMonth() + offset);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
}
function isoFromNow(days, hour = 9, min = 0) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  d.setHours(hour, min, 0, 0);
  return d.toISOString().slice(0, 19) + 'Z';
}

// Tage bis zum Montag DIESER Woche (0 = heute ist Montag, -6 = heute ist Sonntag).
// Der Essensplan zeigt immer Mo-So; ein Plan, der wie alles andere relativ zu
// „heute" liegt, ist an jedem Tag außer Montag angeschnitten - an einem Sonntag
// standen fünf von sieben Spalten leer.
function mondayOffset() {
  const day = new Date().getDay(); // 0 = Sonntag
  return day === 0 ? -6 : 1 - day;
}

/** Datum des i-ten Wochentags dieser Woche. i: 0 = Montag … 6 = Sonntag. */
function weekDayKey(i) {
  return daysFromNow(mondayOffset() + i);
}

// ── Wipe existing data (keep category/migration tables) ──────────────────────

console.log('Clearing existing data…');
db.pragma('foreign_keys = OFF');
const WIPE = [
  'search_index',
  'shopping_item_tags', 'shopping_items', 'shopping_lists',
  'budget_entry_attachments',
  'budget_loan_payments', 'budget_loans', 'budget_recurrence_skipped', 'budget_entries',
  'budget_plans', 'budget_accounts',
  'contact_phones', 'contact_emails', 'contact_addresses', 'contacts',
  'notes',
  'meal_recurrence_ingredients', 'meal_recurrence_exceptions', 'meal_recurrence_templates',
  'meal_ingredients', 'meals', 'recipe_ingredients', 'recipes',
  // Nur der Bestand, NICHT pantry_locations: die Lagerorte sind Referenzdaten
  // aus der Migration (wie shopping_categories, das hier ebenfalls fehlt).
  // Sie zu leeren ließ den Haushalt ohne einen einzigen Lagerort zurück -
  // niemand legt sie danach wieder an.
  'pantry_items',
  'reminders',
  'event_assignments', 'task_assignments', 'task_tags', 'task_documents', 'calendar_events', 'tasks',
  'birthdays',
  'expense_activity', 'settlement_entries', 'settlements', 'recurring_expenses',
  'expense_attachments', 'expense_comments', 'expense_ledger_entries', 'expense_splits',
  'expenses', 'expense_group_members', 'split_expense_guest_users', 'expense_groups',
  'housekeeping_work_sessions', 'housekeeping_decay_tasks', 'housekeeping_supply_requests',
  'housekeeping_maintenance_log', 'housekeeping_workers',
  'family_document_access', 'family_documents', 'family_document_folders',
  'health_care_grants',
  'health_vitals', 'health_activities', 'health_lab_results', 'health_lab_reports',
  'medication_logs', 'medication_schedules', 'medications',
  'cycle_day_logs', 'cycle_periods', 'cycle_settings',
  'reward_ledger', 'reward_redemptions', 'reward_participants', 'reward_catalog',
  'budget_subscriptions',
  'users',
];
const wipe = db.transaction(() => {
  for (const t of WIPE) {
    try { db.prepare(`DELETE FROM ${t}`).run(); } catch (e) { /* table may not exist */ }
  }
  // sqlite_sequence existiert erst, wenn je eine AUTOINCREMENT-Tabelle Daten
  // hatte - auf einer frisch migrierten DB fehlt sie und der Seed bräche hier.
  try { db.prepare("DELETE FROM sqlite_sequence").run(); } catch (e) { /* fresh db */ }
});
wipe();
db.pragma('foreign_keys = ON');

// ── Household preferences ────────────────────────────────────────────────────

console.log('Setting household preferences…');
const cfgSet = db.prepare(`
  INSERT INTO sync_config (key, value) VALUES (?, ?)
  ON CONFLICT(key) DO UPDATE SET value = excluded.value
`);
cfgSet.run('currency', CUR);
cfgSet.run('date_format', DATE_FMT);
cfgSet.run('time_format', '24h');
cfgSet.run('app_name', 'Juju');
cfgSet.run('visible_meal_types', 'breakfast,lunch,dinner,snack');
// Weather widget — Dortmund / Shanghai via Open-Meteo (no API key required)
cfgSet.run('weather_provider', 'open-meteo');
cfgSet.run('weather_lat', WEATHER.lat);
cfgSet.run('weather_lon', WEATHER.lon);
cfgSet.run('weather_city', WEATHER.city);
cfgSet.run('weather_units', 'metric');

// Dashboard-Kacheln: kuratiert statt Vorgabe. Die Standardaufteilung ließ das
// Budget-Widget als 1x2 stehen, obwohl sein Inhalt nur die halbe Höhe füllt
// (209 px Loch), schob das Wetter als letztes Widget in eine eigene Zeile und
// ließ links daneben eine leere Fläche. Gemessen, nicht geraten: die Web-Ansicht
// hat vier Spalten, die beiden Zeilen unten gehen exakt auf (2+1+1 / 1+1+2).
// Auf schmalen Geräten fällt das Raster einspaltig - dort zählt allein die
// Reihenfolge, und das Wetter steht als erstes oben.
const dashboardWidgets = [
  { id: 'weather',   visible: true,  size: '2x1' },
  { id: 'family',    visible: true,  size: '1x1' },
  { id: 'budget',    visible: true,  size: '1x1' },
  { id: 'birthdays', visible: true,  size: '1x1' },
  { id: 'rewards',   visible: true,  size: '1x1' },
  { id: 'notes',     visible: true,  size: '2x1' },
  // Ausgeblendet, aber in der Liste: die Reihenfolge bleibt stabil, wenn ein
  // Haushalt sie im Anpassen-Modus wieder einblendet. tasks/calendar/shopping/
  // meals deckt das „Heute"-Cockpit oben bereits ab - doppelt gezeigt wäre Echo.
  { id: 'tasks',        visible: false, size: '1x2' },
  { id: 'calendar',     visible: false, size: '1x2' },
  { id: 'shopping',     visible: false, size: '2x1' },
  { id: 'meals',        visible: false, size: '2x1' },
  { id: 'housekeeping', visible: false, size: '1x1' },
  { id: 'health',       visible: false, size: '2x1' },
  { id: 'cycle',        visible: false, size: '2x1' },
].map((w, order) => ({ ...w, order }));
cfgSet.run('dashboard_widgets', JSON.stringify(dashboardWidgets));

// Einkaufskategorien sind freie Namen (kein label_key) - im Deutschen stehen die
// Migrationsvorgaben schon richtig, für Englisch werden sie an Ort und Stelle
// umbenannt. CAT ist danach die EINZIGE Quelle für diese Namen: Einkaufszettel,
// Rezeptzutaten, Mahlzeiten-Zutaten und Vorrat schreiben denselben String, sonst
// landen Positionen in einer Kategorie, die es in der Liste nicht gibt.
const CAT = {
  produce:   L('Fruit & Veg',      'Obst & Gemüse',    '果蔬'),
  bakery:    L('Bakery',           'Backwaren',        '烘焙'),
  dairy:     L('Dairy',            'Milchprodukte',    '乳制品'),
  meat:      L('Meat & Fish',      'Fleisch & Fisch',  '肉禽水产'),
  frozen:    L('Frozen',           'Tiefkühl',         '冷冻食品'),
  drinks:    L('Drinks',           'Getränke',         '饮品'),
  household: L('Household',        'Haushalt',         '日用百货'),
  beauty:    L('Health & Beauty',  'Drogerie',         '个护健康'),
  other:     L('Other',            'Sonstiges',        '其他'),
};
if (LOCALE !== 'de') {
  console.log(`Renaming shopping categories to ${LOCALE}…`);
  const renameCat = db.prepare('UPDATE shopping_categories SET name = ? WHERE id = ?');
  [
    [1, CAT.produce], [2, CAT.bakery], [3, CAT.dairy], [4, CAT.meat],
    [5, CAT.frozen], [6, CAT.drinks], [7, CAT.household], [8, CAT.beauty], [9, CAT.other],
  ].forEach(([id, name]) => renameCat.run(name, id));
}

// Lagerorte des Vorrats — dieselbe Lage wie die Einkaufskategorien: freie Namen
// aus der Migration, deutsch vorbelegt.
const LOC = {
  pantry:  L('Pantry cupboard', 'Vorratsschrank',  '干货柜'),
  fridge:  L('Fridge',          'Kühlschrank',     '冰箱'),
  freezer: L('Freezer',         'Gefrierschrank',  '冷冻柜'),
  cellar:  L('Cellar',          'Keller',          '储藏室'),
  other:   L('Other',           'Sonstiges',       '其他'),
};
if (LOCALE !== 'de') {
  console.log(`Renaming pantry locations to ${LOCALE}…`);
  const renameLoc = db.prepare('UPDATE pantry_locations SET name = ? WHERE id = ?');
  [[1, LOC.pantry], [2, LOC.fridge], [3, LOC.freezer], [4, LOC.cellar], [5, LOC.other]]
    .forEach(([id, name]) => renameLoc.run(name, id));
}

// Einnahmekategorien: `key` ist der deutsche Bestandsschlüssel (Migration),
// `name` der angezeigte Text. Nur der Name wird übersetzt, nie der Key - die
// Buchungen unten referenzieren ihn.
if (LOCALE !== 'de') {
  console.log(`Localising budget income categories to ${LOCALE}…`);
  const renameBudgetCat = db.prepare('UPDATE budget_categories SET name = ? WHERE key = ?');
  const incomeNames = {
    en: [
      ['Erwerbseinkommen', 'Salary & Wages'],
      ['Kapitalerträge', 'Investment Income'],
      ['Geschenke & Transfers', 'Gifts & Transfers'],
      ['Sozialleistungen', 'Benefits'],
      ['Sonstiges Einkommen', 'Other Income'],
    ],
    zh: [
      ['Erwerbseinkommen', '工资薪金'],
      ['Kapitalerträge', '投资收益'],
      ['Geschenke & Transfers', '礼金与转账'],
      ['Sozialleistungen', '社保补贴'],
      ['Sonstiges Einkommen', '其他收入'],
    ],
  };
  incomeNames[LOCALE].forEach(([key, name]) => renameBudgetCat.run(name, key));
}

// ── Users ────────────────────────────────────────────────────────────────────

console.log('Creating users…');
const pw = bcrypt.hashSync('demo1234', 12);
const insertUser = db.prepare(`
  INSERT INTO users (username, display_name, password_hash, role, family_role, avatar_color)
  VALUES (?, ?, ?, ?, ?, ?)
`);
// Nutzernamen (Login) bleiben sprachunabhängig, nur die Anzeigenamen werden
// übersetzt — der chinesische Haushalt heißt 王 (Wang).
const alexId  = insertUser.run('alex',  L('Alex Johnson',  'Alex Johnson',  '王志远'), pw, 'admin',  'dad',   '#2563EB').lastInsertRowid;
const lindaId   = insertUser.run('linda', L('Linda Johnson', 'Linda Johnson', '戴琼照'), pw, 'admin',  'mom',   '#DB2777').lastInsertRowid;
const emmaId  = insertUser.run('emma',  L('Emma Johnson',  'Emma Johnson',  '王思思'), pw, 'member', 'child', '#EC4899').lastInsertRowid;
const leoId   = insertUser.run('leo',   L('Leo Johnson',   'Leo Johnson',   '王乐乐'), pw, 'member', 'child', '#F97316').lastInsertRowid;
const mariaId = insertUser.run('maria', L('Maria Silva',   'Maria Silva',   '张阿姨'), pw, 'member', 'other', '#7C3AED').lastInsertRowid;
console.log(`  alex=${alexId} linda=${lindaId} emma=${emmaId} leo=${leoId} maria=${mariaId}`);

// ── Tasks ────────────────────────────────────────────────────────────────────

console.log('Inserting tasks…');
const insertTask = db.prepare(`
  INSERT INTO tasks (title, description, category, priority, status, start_date, due_date, assigned_to, created_by)
  VALUES (@title, @description, @category, @priority, @status, @start_date, @due_date, @assigned_to, @created_by)
`);
const insertTaskAssign = db.prepare('INSERT OR IGNORE INTO task_assignments (task_id, user_id) VALUES (?, ?)');
// Tags sind eine eigene n:m-Achse neben der Kategorie (#586). tag_key ist die
// normalisierte Form, unter der die UI zusammenfasst - dieselbe Regel wie im
// Route-Handler: getrimmt und kleingeschrieben.
const insertTaskTag = db.prepare('INSERT OR IGNORE INTO task_tags (task_id, tag, tag_key) VALUES (?, ?, ?)');
const tagKey = (tag) => tag.trim().toLowerCase();

const TAG = {
  urgent:   L('urgent',    'dringend',   '紧急'),
  car:      L('car',       'auto',       '汽车'),
  school:   L('school',    'schule',     '学校'),
  holiday:  L('holiday',   'urlaub',     '假期'),
  paperwork:L('paperwork', 'papierkram', '证件单据'),
  kids:     L('kids',      'kinder',     '孩子'),
  garden:   L('garden',    'garten',     '花园'),
};

const tasks = [
  [L('Book dentist appointment',    'Zahnarzttermin vereinbaren',    '预约牙医'),                    L('Annual check-up for the whole family',  'Jahreskontrolle für die ganze Familie', '全家年度口腔检查'),                    'health',    'high',   'open',        null,            daysFromNow(3),  alexId, alexId, [alexId],          []],
  [L('Pay electricity bill',        'Stromrechnung bezahlen',        '交电费'),                      L('Due end of month — online banking',     'Fällig zum Monatsende — Online-Banking', '月底到期 — 手机银行缴费'),           'finance',   'urgent', 'open',        null,            daysFromNow(2),  alexId, alexId, [alexId],          [TAG.urgent, TAG.paperwork]],
  [L('Renew car insurance',         'Kfz-Versicherung verlängern',   '续保车险'),                    L('Compare quotes first',                  'Vorher Angebote vergleichen',           '先比价再续保'),                        'finance',   'high',   'open',        null,            daysFromNow(10), alexId, alexId, [alexId],          [TAG.car, TAG.paperwork]],
  [L('Fix leaking bathroom faucet', 'Tropfenden Wasserhahn reparieren', '修理卫生间漏水的水龙头'),   L('Replace washer, tools in the basement', 'Dichtung tauschen, Werkzeug im Keller', '换密封垫，工具在储藏室'),              'repair',    'medium', 'open',        null,            daysFromNow(7),  lindaId, alexId, [lindaId],         []],
  [L('Order birthday cake',         'Geburtstagstorte bestellen',    '订生日蛋糕'),                  L("Emma's birthday — chocolate cake",      'Emmas Geburtstag — Schokoladentorte',   '思思生日 — 巧克力蛋糕'),               'household', 'high',   'open',        null,            daysFromNow(5),  lindaId, lindaId, [lindaId],        [TAG.kids]],
  [L('Clean out the garage',        'Garage ausmisten',              '清理车库'),                    L('Donate old things to charity',          'Altes an die Kleiderkammer spenden',    '旧物整理好捐出去'),                    'household', 'low',    'open',        daysFromNow(7),  daysFromNow(14), alexId, alexId, [alexId, lindaId], []],
  [L('Sign school permission slip', 'Einverständnis für Schulausflug', '签学校春游同意书'),          L('Field trip to the science museum',      'Ausflug ins Naturkundemuseum',          '科技馆一日游'),                        'school',    'urgent', 'open',        null,            daysFromNow(1),  lindaId, lindaId, [lindaId],        [TAG.urgent, TAG.school]],
  [L('Renew library cards',         'Büchereiausweise verlängern',   '续借书证'),                    L('All three cards expired last month',    'Alle drei sind letzten Monat abgelaufen','三个人的上个月都到期了'),             'household', 'low',    'open',        null,            daysFromNow(20), alexId, alexId, [alexId],          []],
  [L('Plan summer holiday',         'Sommerurlaub planen',           '规划暑假出游'),                L('Italy or Croatia — check flights',      'Italien oder Kroatien — Flüge prüfen',  '三亚或云南 — 先查机票'),               'leisure',   'medium', 'open',        daysFromNow(3),  daysFromNow(30), alexId, alexId, [alexId, lindaId], [TAG.holiday]],
  [L('Tax return 2025',             'Steuererklärung 2025',          '2025 年度个税汇算'),           L('Documents ready in the folder',         'Unterlagen liegen im Ordner bereit',    '材料都整理在文件夹里了'),              'finance',   'high',   'in_progress', null,            daysFromNow(18), alexId, alexId, [alexId],          [TAG.paperwork]],
  [L('Tidy bedroom',                'Kinderzimmer aufräumen',        '收拾房间'),                    L('Put away laundry & toys',               'Wäsche und Spielzeug wegräumen',        '衣服和玩具收好'),                      'household', 'low',    'open',        null,            daysFromNow(1),  emmaId, lindaId, [emmaId],          [TAG.kids]],
  [L('Practice piano',              'Klavier üben',                  '练钢琴'),                      L('20 minutes — recital piece',            '20 Minuten — Stück fürs Vorspiel',      '20 分钟 — 演奏会曲目'),                'school',    'medium', 'open',        null,            daysFromNow(2),  leoId,  lindaId, [leoId],           [TAG.kids, TAG.school]],
  [L('Grocery run',                 'Wocheneinkauf erledigen',       '采购本周食材'),                L('See the shopping list for details',     'Details stehen auf dem Einkaufszettel', '明细见购物清单'),                      'shopping',  'medium', 'done',        null,            daysFromNow(-1), lindaId, lindaId, [lindaId],        []],
  [L('Call insurance about claim',  'Versicherung wegen Schaden anrufen', '打电话问保险理赔进度'),  L('Reference: CLM-2025-0492',              'Vorgang: CLM-2025-0492',                '案件号：CLM-2025-0492'),               'finance',   'high',   'done',        null,            daysFromNow(-3), alexId, alexId, [alexId],          [TAG.paperwork]],
  [L('Oil change — VW Golf',        'Ölwechsel — VW Golf',           '换机油 — 大众高尔夫'),         L('Every 15,000 km / 12 months',           'Alle 15.000 km / 12 Monate',            '每 1.5 万公里 / 12 个月一次'),         'repair',    'medium', 'open',        null,            daysFromNow(6),  alexId, alexId, [alexId],          [TAG.car]],
  [L('Buy birthday gift for Mum',   'Geburtstagsgeschenk für Mama',  '给妈妈买生日礼物'),            L('Book voucher or wishlist item',         'Buchgutschein oder von der Wunschliste','购书卡或愿望清单里的东西'),            'shopping',  'medium', 'open',        null,            daysFromNow(8),  lindaId, lindaId, [lindaId],        []],
  [L('Water the plants',            'Pflanzen gießen',               '给花浇水'),                    L('Indoor plants + balcony herbs',         'Zimmerpflanzen + Kräuter auf dem Balkon','室内绿植 + 阳台香草'),                'household', 'none',   'done',        null,            daysFromNow(-2), leoId,  lindaId, [leoId],           [TAG.kids, TAG.garden]],
];
const taskIdByTitle = {};
for (const [title, description, category, priority, status, start_date, due_date, assigned_to, created_by, assignees, tags] of tasks) {
  const id = insertTask.run({ title, description, category, priority, status, start_date, due_date, assigned_to, created_by }).lastInsertRowid;
  taskIdByTitle[title] = id;
  for (const u of assignees) insertTaskAssign.run(id, u);
  for (const tag of tags) insertTaskTag.run(id, tag, tagKey(tag));
}
// Point values on the children's chores (drives the Rewards module)
const setTaskPoints = db.prepare('UPDATE tasks SET points = ? WHERE id = ?');
[
  [L('Tidy bedroom',   'Kinderzimmer aufräumen',  '收拾房间'), 10],
  [L('Practice piano', 'Klavier üben',            '练钢琴'),   15],
  [L('Water the plants', 'Pflanzen gießen',       '给花浇水'),  5],
].forEach(([title, p]) => setTaskPoints.run(p, taskIdByTitle[title]));

// ── Calendar Events ──────────────────────────────────────────────────────────

console.log('Inserting calendar events…');
const insertEvent = db.prepare(`
  INSERT INTO calendar_events (title, description, start_datetime, end_datetime, all_day, location, color, icon, recurrence_rule, assigned_to, created_by)
  VALUES (@title, @description, @start, @end, @all_day, @location, @color, @icon, @rrule, @assigned_to, @created_by)
`);
const insertEventAssign = db.prepare('INSERT OR IGNORE INTO event_assignments (event_id, user_id) VALUES (?, ?)');

const events = [
  [L("Emma's Birthday Party",     'Emmas Geburtstagsfeier',   '思思的生日会'),            L('Bouncy castle & cake at home',       'Hüpfburg und Kuchen zu Hause',            '家里充气城堡 + 切蛋糕'),             daysFromNow(5) + 'T14:00',  daysFromNow(5) + 'T17:00',  0, L('Home', 'Zu Hause', '家里'),                                          '#F59E0B', 'cake',     null,                      lindaId, lindaId, [lindaId, emmaId]],
  [L('Dentist — Family',          'Zahnarzt — Familie',       '全家看牙医'),              L('Dr. Müller, bring insurance cards',  'Dr. Müller, Versichertenkarten mitnehmen','王医生处就诊，带好医保卡'),          daysFromNow(3) + 'T10:00', daysFromNow(3) + 'T11:30', 0, L('Dental Practice Müller', 'Zahnarztpraxis Müller', '王医生口腔诊所'),              '#EF4444', 'tooth', null,                lindaId, alexId, [alexId, lindaId, emmaId, leoId]],
  [L('Parent–Teacher Evening',    'Elternabend',              '家长会'),                  L('Room 12, bring the report card',     'Raum 12, Zeugnis mitbringen',             '12 号教室，带成长手册'),             daysFromNow(9) + 'T18:30',  daysFromNow(9) + 'T20:00',  0, L('Westpark Primary School', 'Grundschule Westpark', '西城实验小学'),        '#8B5CF6', 'calendar', null,               lindaId, lindaId, [lindaId, alexId]],
  [L('Science Museum Field Trip', 'Ausflug ins Naturkundemuseum', '科技馆春游'),          L('Emma — permission slip signed',      'Emma — Einverständnis unterschrieben',    '思思 — 同意书已签字'),               daysFromNow(1) + 'T08:30',  daysFromNow(1) + 'T15:00',  0, L('Natural History Museum', 'Naturkundemuseum', '市科技馆'),                    '#06B6D4', 'calendar', null,                      emmaId, lindaId, [emmaId]],
  [L("Family BBQ at Grandma's",   'Grillen bei Oma',          '去奶奶家聚餐'),            L('Bring potato salad',                 'Kartoffelsalat mitbringen',               '带土豆沙拉'),                        daysFromNow(12) + 'T13:00', daysFromNow(12) + 'T19:00', 0, L("Grandma's Garden", 'Omas Garten', '奶奶家小院'),                   '#F59E0B', 'calendar', null,                      alexId, alexId, [alexId, lindaId, emmaId, leoId]],
  [L('Car Service Appointment',   'Werkstatttermin',          '汽车保养预约'),            L('VW Golf — oil change + tyre check',  'VW Golf — Ölwechsel + Reifencheck',       '大众高尔夫 — 换机油 + 胎检'),        daysFromNow(6) + 'T09:00',  daysFromNow(6) + 'T10:30',  0, 'AutoHaus König',                                                                                     '#6B7280', 'calendar', null,                      alexId, alexId, [alexId]],
  [L('Yoga Class',                'Yoga-Kurs',                '瑜伽课'),                  L('Weekly — bring a mat',               'Wöchentlich — Matte mitbringen',          '每周一次 — 自带瑜伽垫'),             daysFromNow(2) + 'T19:00',  daysFromNow(2) + 'T20:00',  0, 'FitLife Studio',                                                                                     '#10B981', 'calendar', 'FREQ=WEEKLY;BYDAY=TU',    lindaId, lindaId, [lindaId]],
  [L("Mum's Birthday",            'Mamas Geburtstag',         '妈妈的生日'),              '',                                                                                                                                              daysFromNow(8) + 'T00:00',  daysFromNow(8) + 'T00:00',  1, '',                                                                                                   '#EC4899', 'cake',     null,                      alexId, alexId, [alexId, lindaId]],
  [L('Company All-Hands',         'Betriebsversammlung',      '公司全员大会'),            L('Q2 results + roadmap presentation',  'Quartalszahlen + Roadmap-Vorstellung',    '季度业绩 + 产品路线图宣讲'),         daysFromNow(4) + 'T10:00',  daysFromNow(4) + 'T12:00',  0, L('Office — Conference Room B', 'Büro — Besprechungsraum B', '公司 — B 会议室'),           '#2563EB', 'calendar', null,          alexId, alexId, [alexId]],
  [L('Football Training — Leo',   'Fußballtraining — Leo',    '乐乐足球训练'),            L('Boots & water bottle',               'Schuhe und Trinkflasche',                 '带球鞋和水壶'),                      daysFromNow(2) + 'T17:00',  daysFromNow(2) + 'T18:30',  0, L('Sports Ground West', 'Sportplatz West', '城西体育场'),                 '#F97316', 'calendar', 'FREQ=WEEKLY;BYDAY=TU,SA', leoId, lindaId, [leoId]],
  [L('Piano Lesson — Leo',        'Klavierstunde — Leo',      '乐乐钢琴课'),              L('Weekly lesson with Ms. Klein',       'Wöchentlich bei Frau Klein',              '每周一次，陈老师授课'),              daysFromNow(3) + 'T16:00',  daysFromNow(3) + 'T16:45',  0, L('Music School Dortmund', 'Musikschule Dortmund', '市青少年宫琴房'),         '#8B5CF6', 'calendar', 'FREQ=WEEKLY;BYDAY=TH', leoId, lindaId, [leoId]],
  [L('Holiday Planning Evening',  'Urlaubsplanung',           '假期计划夜'),              L('Italy vs Croatia — laptops out',     'Italien oder Kroatien — Laptops raus',    '三亚还是云南 — 打开电脑比价'),       daysFromNow(3) + 'T21:00',  daysFromNow(3) + 'T22:00',  0, L('Home', 'Zu Hause', '家里'),                                                                          '#14B8A6', 'calendar', null,                      alexId, lindaId, [alexId, lindaId]],
  [L('GP Appointment — Alex',     'Hausarzttermin — Alex',    '志远体检预约'),            L('Annual health check',                'Jährlicher Gesundheits-Check',            '年度健康体检'),                      daysFromNow(15) + 'T11:00', daysFromNow(15) + 'T11:30', 0, L('Dr. Weber — City Practice', 'Dr. Weber — Praxis am Markt', '李医生 — 市第一医院'),    '#EF4444', 'stethoscope', null,   alexId, alexId, [alexId]],
  [L('Weekend City Break',        'Städtereise übers Wochenende', '周末短途游'),          L('Hotel booked — just pack the bags!', 'Hotel gebucht — nur noch packen!',        '酒店订好了 — 收拾行李出发！'),       daysFromNow(20) + 'T00:00', daysFromNow(22) + 'T00:00', 1, 'Amsterdam',                                                                                          '#0EA5E9', 'plane',    null,                      alexId, alexId, [alexId, lindaId]],
  [L('Swimming — Emma',           'Schwimmen — Emma',         '思思游泳课'),              L('Westbad — goggles & towel',          'Westbad — Brille und Handtuch',           '市游泳馆 — 带泳镜和毛巾'),           daysFromNow(4) + 'T16:00',  daysFromNow(4) + 'T17:00',  0, L('Westbad Pool', 'Westbad', '市游泳馆'),                          '#06B6D4', 'calendar', 'FREQ=WEEKLY;BYDAY=FR',    emmaId, lindaId, [emmaId]],
];
const eventIdByTitle = {};
for (const [title, description, start, end, all_day, location, color, icon, rrule, assigned_to, created_by, assignees] of events) {
  const id = insertEvent.run({ title, description, start, end, all_day, location, color, icon, rrule, assigned_to, created_by }).lastInsertRowid;
  eventIdByTitle[title] = id;
  for (const u of assignees) insertEventAssign.run(id, u);
}

// ── Recipes ──────────────────────────────────────────────────────────────────

console.log('Inserting recipes…');
const insertRecipe = db.prepare('INSERT INTO recipes (title, notes, recipe_url, created_by) VALUES (?, ?, ?, ?)');
const insertRecipeIng = db.prepare('INSERT INTO recipe_ingredients (recipe_id, name, quantity, category) VALUES (?, ?, ?, ?)');
const recipes = [
  [L('Spaghetti Bolognese', 'Spaghetti Bolognese', '番茄肉酱意面'), L('Family favourite — simmer the sauce for at least 45 minutes for the best flavour.', 'Familienklassiker — die Soße mindestens 45 Minuten ziehen lassen.', '全家最爱 — 肉酱小火慢炖 45 分钟以上最入味。'), 'https://www.bbcgoodfood.com/recipes/best-spaghetti-bolognese-recipe', [
    [L('Spaghetti', 'Spaghetti', '意大利面'), '500 g', CAT.other], [L('Minced beef', 'Rinderhack', '牛肉末'), '500 g', CAT.meat], [L('Onion', 'Zwiebel', '洋葱'), '1', CAT.produce],
    [L('Garlic', 'Knoblauch', '大蒜'), L('2 cloves', '2 Zehen', '2 瓣'), CAT.produce], [L('Tomato passata', 'Passierte Tomaten', '番茄泥'), '700 g', CAT.other], [L('Parmesan', 'Parmesan', '帕玛森芝士'), '50 g', CAT.dairy],
  ]],
  [L('Chicken Tikka Masala', 'Chicken Tikka Masala', '咖喱鸡'), L('Marinate the chicken overnight if you can. Serve with basmati rice and naan.', 'Das Hähnchen möglichst über Nacht marinieren. Dazu Basmatireis und Naan.', '鸡肉最好提前一晚腌制，配印度香米和馕饼。'), 'https://www.bbcgoodfood.com/recipes/chicken-tikka-masala', [
    [L('Chicken breast', 'Hähnchenbrust', '鸡胸肉'), '600 g', CAT.meat], [L('Natural yoghurt', 'Naturjoghurt', '原味酸奶'), '200 g', CAT.dairy], [L('Tikka paste', 'Tikka-Paste', '咖喱酱'), L('3 tbsp', '3 EL', '3 勺'), CAT.other],
    [L('Double cream', 'Sahne', '淡奶油'), '150 ml', CAT.dairy], [L('Basmati rice', 'Basmatireis', '印度香米'), '300 g', CAT.other], [L('Fresh coriander', 'Frischer Koriander', '香菜'), L('1 bunch', '1 Bund', '1 把'), CAT.produce],
  ]],
  [L('Homemade Pizza', 'Pizza selbst gemacht', '自制披萨'), L("Emma's favourite night! Let the dough rise for two hours.", 'Emmas Lieblingsabend! Den Teig zwei Stunden gehen lassen.', '思思的最爱！面团要醒两个小时。'), null, [
    [L('Pizza flour', 'Pizzamehl', '披萨粉'), '500 g', CAT.other], [L('Fresh yeast', 'Frische Hefe', '鲜酵母'), '7 g', CAT.other], [L('Mozzarella', 'Mozzarella', '马苏里拉芝士'), '250 g', CAT.dairy],
    [L('Tomato sauce', 'Tomatensoße', '番茄酱'), '200 g', CAT.other], [L('Fresh basil', 'Frisches Basilikum', '新鲜罗勒'), L('1 bunch', '1 Bund', '1 把'), CAT.produce],
  ]],
  [L('Grilled Salmon & Roasted Veg', 'Lachs mit Ofengemüse', '香煎三文鱼配烤时蔬'), L('Lemon butter sauce ties it all together. Ready in 30 minutes.', 'Die Zitronenbutter hält alles zusammen. In 30 Minuten fertig.', '淋上柠檬黄油汁就齐了，30 分钟搞定。'), null, [
    [L('Salmon fillets', 'Lachsfilets', '三文鱼柳'), '4', CAT.meat], [L('Courgette', 'Zucchini', '西葫芦'), '2', CAT.produce], [L('Bell peppers', 'Paprika', '彩椒'), '2', CAT.produce],
    [L('Lemon', 'Zitrone', '柠檬'), '1', CAT.produce], [L('Butter', 'Butter', '黄油'), '50 g', CAT.dairy],
  ]],
  [L('Sunday Roast Chicken', 'Hähnchen aus dem Ofen', '周日烤鸡'), L('Rest the chicken for 15 minutes before carving.', 'Das Hähnchen vor dem Tranchieren 15 Minuten ruhen lassen.', '烤好后静置 15 分钟再切。'), null, [
    [L('Whole chicken', 'Ganzes Hähnchen', '整鸡'), '1,5 kg', CAT.meat], [L('Potatoes', 'Kartoffeln', '土豆'), '1 kg', CAT.produce], [L('Carrots', 'Möhren', '胡萝卜'), '500 g', CAT.produce],
    [L('Rosemary', 'Rosmarin', '迷迭香'), L('2 sprigs', '2 Zweige', '2 枝'), CAT.produce], [L('Olive oil', 'Olivenöl', '橄榄油'), L('4 tbsp', '4 EL', '4 勺'), CAT.other],
  ]],
  [L('Fluffy Pancakes', 'Fluffige Pancakes', '松软松饼'), L('Weekend treat with maple syrup and a blueberry compote.', 'Wochenend-Frühstück mit Ahornsirup und Blaubeerkompott.', '周末早餐，配枫糖浆和蓝莓果酱。'), null, [
    [L('Plain flour', 'Mehl', '中筋面粉'), '200 g', CAT.other], [L('Milk', 'Milch', '牛奶'), '300 ml', CAT.dairy], [L('Eggs', 'Eier', '鸡蛋'), '2', CAT.dairy],
    [L('Blueberries', 'Blaubeeren', '蓝莓'), '125 g', CAT.produce], [L('Maple syrup', 'Ahornsirup', '枫糖浆'), L('1 bottle', '1 Flasche', '1 瓶'), CAT.other],
  ]],
];
const recipeIdByTitle = {};
for (const [title, notes, url, ings] of recipes) {
  const rid = insertRecipe.run(title, notes, url, alexId).lastInsertRowid;
  recipeIdByTitle[title] = rid;
  for (const [name, qty, cat] of ings) insertRecipeIng.run(rid, name, qty, cat);
}

// ── Meals (linked to recipes where titles match) ─────────────────────────────

console.log('Inserting meals…');
const insertMeal = db.prepare(`
  INSERT INTO meals (date, meal_type, title, notes, recipe_id, created_by)
  VALUES (?, ?, ?, ?, ?, ?)
`);
const insertMealIng = db.prepare('INSERT INTO meal_ingredients (meal_id, name, quantity, category, on_shopping_list) VALUES (?, ?, ?, ?, ?)');

// Erstes Feld = Wochentag dieser Woche (0 = Montag … 6 = Sonntag), NICHT Tage ab
// heute: die Ansicht zeigt immer Mo-So, ein relativ geplanter Satz wäre an sechs
// von sieben Wochentagen angeschnitten. Der Freitagabend (Index 4) fehlt hier
// bewusst - den bespielt die Serie weiter unten.
const STIR_FRY = L('Beef stir-fry', 'Rindfleisch-Pfanne', '青椒炒牛肉');
const mealPlan = [
  [ 0, 'breakfast', L('Scrambled eggs & toast',      'Rührei mit Toast',            '炒蛋配吐司'),            L('With smoked salmon',        'Mit Räucherlachs',       '加烟熏三文鱼')],
  [ 0, 'lunch',     L('Tomato soup',                 'Tomatensuppe',                '番茄浓汤'),              L('Served with sourdough bread','Dazu Sauerteigbrot',    '配酸面包')],
  [ 0, 'dinner',    L('Spaghetti Bolognese',         'Spaghetti Bolognese',         '番茄肉酱意面'),          L('Kids loved it',             'Kam bei den Kindern super an', '孩子们特别喜欢')],
  [ 0, 'snack',     L('Apple slices & peanut butter','Apfelspalten mit Erdnussmus', '苹果片蘸花生酱'),        ''],
  [ 1, 'breakfast', L('Overnight oats',              'Overnight Oats',              '隔夜燕麦'),              L('Blueberries & honey',       'Blaubeeren und Honig',  '蓝莓加蜂蜜')],
  [ 1, 'lunch',     L('Caesar salad with chicken',   'Caesar Salat mit Hähnchen',   '凯撒鸡肉沙拉'),          L('Homemade dressing',         'Dressing selbst gemacht', '酱汁自调')],
  [ 1, 'dinner',    L('Grilled Salmon & Roasted Veg','Lachs mit Ofengemüse',        '香煎三文鱼配烤时蔬'),    L('Lemon butter sauce',        'Mit Zitronenbutter',    '配柠檬黄油汁')],
  [ 1, 'snack',     L('Hummus with carrot sticks',   'Hummus mit Möhrensticks',     '鹰嘴豆泥配胡萝卜条'),    ''],
  [ 2, 'breakfast', L('Avocado toast',               'Avocadobrot',                 '牛油果吐司'),            L('Poached eggs on top',       'Mit pochiertem Ei',     '上面加水波蛋')],
  [ 2, 'lunch',     L('Lentil soup',                 'Linsensuppe',                 '扁豆汤'),                L('With crusty bread',         'Mit knusprigem Brot',   '配脆皮面包')],
  [ 2, 'dinner',    L('Chicken Tikka Masala',        'Chicken Tikka Masala',        '咖喱鸡'),                L('Basmati rice & naan',       'Basmatireis und Naan',  '配印度香米和馕')],
  [ 2, 'snack',     L('Yoghurt & granola',           'Joghurt mit Granola',         '酸奶配麦片'),            ''],
  [ 3, 'breakfast', L('Fluffy Pancakes',             'Fluffige Pancakes',           '松软松饼'),              L('Blueberry compote',         'Blaubeerkompott',       '蓝莓果酱')],
  [ 3, 'lunch',     L('Greek salad & pita',          'Griechischer Salat mit Pita', '希腊沙拉配皮塔饼'),      L('Extra feta',                'Extra Feta',            '多加菲达芝士')],
  [ 3, 'dinner',    STIR_FRY,                                                       L('Jasmine rice, pak choi',    'Jasminreis, Pak Choi',  '茉莉香米饭、小白菜')],
  [ 4, 'breakfast', L('Porridge with banana',        'Porridge mit Banane',         '香蕉燕麦粥'),            L('Cinnamon & honey',          'Zimt und Honig',        '肉桂加蜂蜜')],
  [ 4, 'lunch',     L('Tuna melt sandwich',          'Überbackenes Thunfischbrot',  '金枪鱼烤三明治'),        L('Toasted ciabatta',          'Getoastetes Ciabatta',  '恰巴塔烤脆')],
  [ 4, 'snack',     L('Fruit salad',                 'Obstsalat',                   '水果拼盘'),              ''],
  [ 5, 'breakfast', L('French toast',                'Arme Ritter',                 '法式吐司'),              L('Powdered sugar & berries',  'Puderzucker und Beeren','撒糖粉配莓果')],
  [ 5, 'lunch',     L('BLT sandwich',                'BLT-Sandwich',                '培根生菜番茄三明治'),    L('Wholemeal bread',           'Vollkornbrot',          '全麦面包')],
  [ 5, 'dinner',    L('Sunday Roast Chicken',        'Hähnchen aus dem Ofen',       '周日烤鸡'),              L('For the whole family',      'Für die ganze Familie', '全家一起吃')],
  [ 5, 'snack',     L('Yoghurt & granola',           'Joghurt mit Granola',         '酸奶配麦片'),            ''],
  [ 6, 'breakfast', L('Smoothie bowl',               'Smoothie Bowl',               '思慕雪碗'),              L('Banana, chia seeds',        'Banane, Chiasamen',     '香蕉、奇亚籽')],
  [ 6, 'lunch',     L('Caprese salad & focaccia',    'Caprese mit Focaccia',        '卡普里沙拉配佛卡夏'),    L('Fresh basil',               'Frisches Basilikum',    '新鲜罗勒')],
  [ 6, 'dinner',    L('Lamb chops & couscous',       'Lammkoteletts mit Couscous',  '煎羊排配库斯库斯'),      L('Mint yoghurt dressing',     'Minzjoghurt-Dressing',  '薄荷酸奶蘸酱')],
  [ 6, 'snack',     L('Fruit salad',                 'Obstsalat',                   '水果拼盘'),              ''],
];
for (const [weekday, type, title, notes] of mealPlan) {
  const recipeId = recipeIdByTitle[title] ?? null;
  const mid = insertMeal.run(weekDayKey(weekday), type, title, notes, recipeId, alexId).lastInsertRowid;
  // A couple of upcoming dinners get a few ingredients to populate the kitchen view
  if (title === STIR_FRY) {
    [
      [L('Beef strips', 'Rinderstreifen', '牛肉条'), '400 g', CAT.meat],
      [L('Pak choi', 'Pak Choi', '小白菜'), '2', CAT.produce],
      [L('Jasmine rice', 'Jasminreis', '茉莉香米'), '300 g', CAT.other],
      [L('Soy sauce', 'Sojasoße', '生抽酱油'), L('1 bottle', '1 Flasche', '1 瓶'), CAT.other],
    ].forEach(([n, q, c]) => insertMealIng.run(mid, n, q, c, 0));
  }
}

// Wiederkehrende Mahlzeit: der Freitagabend liegt fest. Ohne eine einzige Serie
// zeigte der Essensplan das Feature nie - es ist der Unterschied zwischen einer
// Wochenliste und einem Plan. weekday zählt 0 = Montag (meals.js:18), Freitag = 4.
// Die Mahlzeiten selbst legt der Server beim ersten Laden der Woche an.
console.log('Inserting recurring meal template…');
const pizzaTitle = L('Homemade Pizza', 'Pizza selbst gemacht', '自制披萨');
const pizzaTemplateId = db.prepare(`
  INSERT INTO meal_recurrence_templates (start_date, weekday, meal_type, title, notes, recipe_id, created_by)
  VALUES (?, 4, 'dinner', ?, ?, ?, ?)
`).run(
  daysFromNow(-56), pizzaTitle,
  L('Pizza night — every Friday', 'Pizzaabend — jeden Freitag', '披萨之夜 — 每周五'),
  recipeIdByTitle[pizzaTitle] ?? null, alexId,
).lastInsertRowid;
const insertTemplateIng = db.prepare(`
  INSERT INTO meal_recurrence_ingredients (template_id, name, quantity, category) VALUES (?, ?, ?, ?)
`);
[
  [L('Pizza flour', 'Pizzamehl', '披萨粉'), '500 g', CAT.other],
  [L('Mozzarella', 'Mozzarella', '马苏里拉芝士'), '250 g', CAT.dairy],
  [L('Tomato sauce', 'Tomatensoße', '番茄酱'), '200 g', CAT.other],
].forEach(([n, q, c]) => insertTemplateIng.run(pizzaTemplateId, n, q, c));

// ── Shopping List ─────────────────────────────────────────────────────────────

console.log('Inserting shopping list…');
const listId = db.prepare('INSERT INTO shopping_lists (name, created_by) VALUES (?, ?)')
  .run(L('Weekly Shop', 'Wocheneinkauf', '每周采购'), alexId).lastInsertRowid;
const insertItem = db.prepare('INSERT INTO shopping_items (list_id, name, quantity, category, is_checked) VALUES (?, ?, ?, ?, ?)');
const insertItemTag = db.prepare('INSERT OR IGNORE INTO shopping_item_tags (item_id, tag, tag_key) VALUES (?, ?, ?)');
const TAG_ORGANIC = L('organic', 'bio', '有机');
const TAG_OFFER   = L('offer',   'angebot', '特价');
[
  [L('Whole milk',          'Vollmilch',        '全脂牛奶'),        '2 l',                    CAT.dairy,     0, [TAG_ORGANIC]],
  [L('Greek yoghurt',       'Griechischer Joghurt', '希腊酸奶'),    '500 g',                  CAT.dairy,     0, []],
  [L('Cheddar cheese',      'Cheddar',          '车打芝士'),        '300 g',                  CAT.dairy,     0, []],
  [L('Free-range eggs',     'Freilandeier',     '散养鸡蛋'),        '12',                     CAT.dairy,     0, [TAG_ORGANIC]],
  [L('Sourdough bread',     'Sauerteigbrot',    '酸面包'),          L('1 loaf', '1 Laib', '1 条'),    CAT.bakery,    0, []],
  [L('Wholemeal bread',     'Vollkornbrot',     '全麦面包'),        L('1 loaf', '1 Laib', '1 条'),    CAT.bakery,    0, []],
  [L('Croissants',          'Croissants',       '牛角包'),          '4',                      CAT.bakery,    0, []],
  [L('Chicken breast',      'Hähnchenbrust',    '鸡胸肉'),          '800 g',                  CAT.meat,      0, []],
  [L('Minced beef',         'Rinderhack',       '牛肉末'),          '500 g',                  CAT.meat,      0, [TAG_OFFER]],
  [L('Salmon fillets',      'Lachsfilets',      '三文鱼柳'),        '2',                      CAT.meat,      0, []],
  [L('Smoked salmon',       'Räucherlachs',     '烟熏三文鱼'),      '100 g',                  CAT.meat,      1, []],
  [L('Frozen peas',         'Tiefkühlerbsen',   '冷冻豌豆'),        '1 kg',                   CAT.frozen,    0, []],
  [L('Fish fingers',        'Fischstäbchen',    '鱼排'),            L('1 box', '1 Packung', '1 盒'),  CAT.frozen,    0, []],
  [L('Broccoli',            'Brokkoli',         '西兰花'),          L('1 head', '1 Kopf', '1 颗'),   CAT.produce,   0, []],
  [L('Cherry tomatoes',     'Kirschtomaten',    '圣女果'),          '250 g',                  CAT.produce,   0, []],
  [L('Avocados',            'Avocados',         '牛油果'),          '3',                      CAT.produce,   0, []],
  [L('Baby spinach',        'Babyspinat',       '菠菜苗'),          '150 g',                  CAT.produce,   1, []],
  [L('Bananas',             'Bananen',          '香蕉'),            '6',                      CAT.produce,   0, [TAG_ORGANIC]],
  [L('Blueberries',         'Blaubeeren',       '蓝莓'),            '125 g',                  CAT.produce,   0, []],
  [L('Lemons',              'Zitronen',         '柠檬'),            '4',                      CAT.produce,   0, []],
  [L('Orange juice',        'Orangensaft',      '橙汁'),            '1 l',                    CAT.drinks,    0, []],
  [L('Sparkling water',     'Sprudelwasser',    '气泡水'),          '6 × 1 l',                CAT.drinks,    1, [TAG_OFFER]],
  [L('Washing-up liquid',   'Spülmittel',       '洗洁精'),          '1',                      CAT.household, 0, []],
  [L('Kitchen roll',        'Küchenrolle',      '厨房纸巾'),        L('4 pack', '4er-Pack', '4 连包'), CAT.household, 0, []],
  [L("Children's vitamins", 'Kindervitamine',   '儿童维生素'),      L('1 pack', '1 Packung', '1 盒'), CAT.beauty,    0, []],
  [L('Toothpaste',          'Zahnpasta',        '牙膏'),            '2',                      CAT.beauty,    0, []],
].forEach(([name, qty, cat, checked, tags]) => {
  const itemId = insertItem.run(listId, name, qty, cat, checked).lastInsertRowid;
  for (const tag of tags) insertItemTag.run(itemId, tag, tagKey(tag));
});

// ── Pantry ────────────────────────────────────────────────────────────────────
// Der Vorrat schließt den Küchen-Kreislauf (planen → kochen → einkaufen →
// lagern). Er braucht drei Zustände, sonst zeigen die Filter ins Leere:
// haltbar, bald ablaufend und unter Mindestbestand.

console.log('Inserting pantry stock…');
const locId = Object.fromEntries(
  db.prepare('SELECT id, name FROM pantry_locations').all().map((r) => [r.name, r.id])
);
const insertPantry = db.prepare(`
  INSERT INTO pantry_items (name, quantity, unit, location_id, category, expires_on, min_quantity, notes, created_by)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
// unit MUSS aus PANTRY_UNITS stammen (public/utils/pantry-units.js) - alles
// andere fällt beim Speichern still auf 'pcs' zurück.
[
  // name, qty, unit, location, category, expires in days (null = unbegrenzt), min, note
  [L('Spaghetti',        'Spaghetti',           '意大利面'),            3,   'pkg',    LOC.pantry,  CAT.other,     240,  2,    null],
  [L('Passata',          'Passierte Tomaten',   '番茄泥'),              4,   'can',    LOC.pantry,  CAT.other,     300,  2,    null],
  [L('Basmati rice',     'Basmatireis',         '印度香米'),            1.5, 'kg',     LOC.pantry,  CAT.other,     400,  1,    null],
  [L('Olive oil',        'Olivenöl',            '橄榄油'),              1,   'bottle', LOC.pantry,  CAT.other,     500,  1,    null],
  [L('Plain flour',      'Mehl',                '中筋面粉'),            0.5, 'kg',     LOC.pantry,  CAT.other,     180,  1,    L('Running low — pizza night', 'Wird knapp — Pizzaabend', '快用完了 — 周五披萨夜')],
  [L('Coffee beans',     'Kaffeebohnen',        '咖啡豆'),              2,   'pkg',    LOC.pantry,  CAT.drinks,    120,  1,    null],
  [L('Tinned chickpeas', 'Kichererbsen',        '鹰嘴豆罐头'),          6,   'can',    LOC.pantry,  CAT.other,     540,  3,    null],
  [L('Whole milk',       'Vollmilch',           '全脂牛奶'),            1,   'l',      LOC.fridge,  CAT.dairy,     3,    2,    null],
  [L('Butter',           'Butter',              '黄油'),                1,   'pcs',    LOC.fridge,  CAT.dairy,     14,   1,    null],
  [L('Greek yoghurt',    'Griechischer Joghurt','希腊酸奶'),            2,   'jar',    LOC.fridge,  CAT.dairy,     6,    2,    null],
  [L('Parmesan',         'Parmesan',            '帕玛森芝士'),          1,   'pcs',    LOC.fridge,  CAT.dairy,     21,   1,    null],
  [L('Eggs',             'Eier',                '鸡蛋'),                8,   'pcs',    LOC.fridge,  CAT.dairy,     11,   6,    null],
  [L('Baby spinach',     'Babyspinat',          '菠菜苗'),              1,   'bag',    LOC.fridge,  CAT.produce,   2,    null, L('Use for the curry', 'Für das Curry verwenden', '留着做咖喱')],
  [L('Frozen peas',      'Tiefkühlerbsen',      '冷冻豌豆'),            2,   'pkg',    LOC.freezer, CAT.frozen,    365,  1,    null],
  [L('Fish fingers',     'Fischstäbchen',       '鱼排'),                1,   'pkg',    LOC.freezer, CAT.frozen,    200,  1,    null],
  [L('Berry mix',        'Beerenmischung',      '混合莓果'),            3,   'pkg',    LOC.freezer, CAT.frozen,    280,  2,    null],
  [L('Sparkling water',  'Sprudelwasser',       '气泡水'),              4,   'bottle', LOC.cellar,  CAT.drinks,    null, 6,    L('Crate in the cellar', 'Kasten steht im Keller', '整箱放在储藏室')],
  [L('Apple juice',      'Apfelsaft',           '苹果汁'),              6,   'bottle', LOC.cellar,  CAT.drinks,    150,  4,    null],
  [L('Potatoes',         'Kartoffeln',          '土豆'),                4,   'kg',     LOC.cellar,  CAT.produce,   40,   2,    null],
  [L('Kitchen roll',     'Küchenrolle',         '厨房纸巾'),            2,   'pkg',    LOC.other,   CAT.household, null, 2,    null],
  [L('Washing powder',   'Waschmittel',         '洗衣粉'),              1,   'pkg',    LOC.other,   CAT.household, null, 1,    null],
].forEach(([name, qty, unit, loc, cat, expiresInDays, min, note]) =>
  insertPantry.run(name, qty, unit, locId[loc] ?? null, cat,
    expiresInDays === null ? null : daysFromNow(expiresInDays), min, note, alexId));

// ── Contacts ─────────────────────────────────────────────────────────────────

// Die Demo nutzt zwei Kategorien, die der Standardsatz nicht kennt. Sie werden
// hier angelegt, wie ein Haushalt sie anlegen würde - sonst tragen die Kontakte
// Keys ohne Eintrag in contact_categories, und der Bearbeiten-Dialog hätte für
// sie keine Option (das Select fiele stumm auf die erste Kategorie zurück).
console.log('Adding custom contact categories…');
const insertContactCat = db.prepare(`
  INSERT OR IGNORE INTO contact_categories (key, name, label_key, icon, sort_order)
  VALUES (?, ?, NULL, ?, ?)
`);
[
  ['family',   L('Family',   'Familie',           '亲人'),     'heart',     10],
  ['services', L('Services', 'Dienstleistungen',  '生活服务'), 'briefcase', 11],
].forEach(row => insertContactCat.run(...row));

console.log('Inserting contacts…');
const insertContact = db.prepare(`
  INSERT INTO contacts (name, category, phone, email, address, notes, organization, job_title)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`);
[
  [L('Dr. Anna Weber', 'Dr. Anna Weber', '李秀英 医生'),                       'doctor',   L('+49 231 445 2210', '+49 231 445 2210', '021-6433 2210'),  'praxis@dr-weber.de',            L('Bürgerstraße 12, Dortmund',    'Bürgerstraße 12, Dortmund',    '静安区南京西路 1218 号'),           L('GP — appointments Mon–Thu',                 'Hausärztin — Termine Mo–Do',               '全科医生 — 周一至周四门诊'),               L('City Practice', 'Praxis am Markt',                   '市第一医院全科'),                       L('General Practitioner', 'Allgemeinmedizin', '全科医生')],
  [L('Dr. Thomas Müller', 'Dr. Thomas Müller', '王建国 医生'),                     'doctor',   L('+49 231 887 0034', '+49 231 887 0034', '021-5388 0034'),  'info@zahnarzt-mueller.de',      L('Hansastraße 55, Dortmund',     'Hansastraße 55, Dortmund',     '徐家汇路 550 号'),                  L('Family dentist',                            'Zahnarzt der Familie',                     '全家固定牙医'),                            L('Dental Practice Müller', 'Zahnarztpraxis Müller',    '王医生口腔诊所'),                       L('Dentist', 'Zahnarzt', '牙科医生')],
  [L('Grandma & Grandpa Johnson', 'Oma & Opa Johnson', '爷爷奶奶'),                      'family',   L('+49 2304 78 221',  '+49 2304 78 221',  '021-6478 2210'),  'oma.johnson@gmail.com',         L('Ahornweg 4, Castrop-Rauxel',   'Ahornweg 4, Castrop-Rauxel',   '苏州工业园区枫情水岸 4 号'),        L("Emma & Leo's grandparents",                 'Emmas und Leos Großeltern',                '思思和乐乐的爷爷奶奶'),                    null,                                                    null],
  [L('Westpark Primary School', 'Grundschule Westpark', '西城实验小学'),               'school',   L('+49 231 556 8810', '+49 231 556 8810', '021-5566 8810'),  'office@westpark-grundschule.de',L('Westparkstraße 20, Dortmund',  'Westparkstraße 20, Dortmund',  '徐汇区西岸路 20 号'),               L("Emma's school — Mrs Bauer is class teacher",'Emmas Schule — Klassenlehrerin Frau Bauer','思思的学校 — 班主任是陈老师'),             L('Westpark Primary School', 'Grundschule Westpark', '西城实验小学'), null],
  ['AutoHaus König',                                                                                   'services', '+49 231 997 1100', 'service@autohaus-koenig.de',    'Industriestraße 88, Dortmund', L('VW service partner — Ref: Golf TDI 2021',   'VW-Servicepartner — Kunde: Golf TDI 2021', '大众 4S 店 — 客户档案：高尔夫 TDI 2021'), 'AutoHaus König',                                        L('Service Centre', 'Werkstatt', '汽车维修中心')],
  ['FitLife Studio',                                                                                   'services', '+49 231 340 5060', 'hello@fitlife-dortmund.de',     'Rheinlanddamm 14, Dortmund',   L("Linda's yoga — Tuesdays 19:00",             'Lindas Yoga — dienstags 19:00',            '琼照的瑜伽课 — 每周二 19:00'),            'FitLife Studio',                                        null],
  [L('Uncle Mike Johnson', 'Onkel Mike Johnson', '大伯 志强'),                         'family',   L('+49 172 3340 551', '+49 172 3340 551', '138 1723 3455'),  'mike.j@outlook.com',            'Hamburg',                      L("Alex's brother — lives in Hamburg",         'Alex’ Bruder — wohnt in Hamburg',          '志远的哥哥 — 人在 Hamburg'),               null,                                                    null],
  [L('Aunt Claire Becker', 'Tante Claire Becker', '姨妈 淑华'),                         'family',   L('+49 151 2234 8876','+49 151 2234 8876','139 2234 8876'),  'claire.becker@web.de',          L('Fichtenweg 7, Bochum',         'Fichtenweg 7, Bochum',         '浦东新区世纪大道 100 号'),          L("Linda's sister",                            'Lindas Schwester',                         '琼照的妹妹'),                              null,                                                    null],
  [L("Leo's Football Coach", 'Leos Fußballtrainer', '乐乐的足球教练'),                  'school',   L('+49 176 5512 4490','+49 176 5512 4490','137 5512 4490'),  'trainer@svwest-dortmund.de',    L('Sportplatz West, Dortmund',    'Sportplatz West, Dortmund',    '城西体育场'),                       L('Training Tue & Sat 17:00',                  'Training Di und Sa 17:00',                 '每周二、周六 17:00 训练'),                 'SV West Dortmund',                                      L('Coach', 'Trainer', '足球教练')],
  [L('City Library', 'Stadtbibliothek', '市图书馆'),                                     'services', '+49 231 502 6600', 'stadtbibliothek@dortmund.de',   'Königswall 18, Dortmund',      L('Family cards — renew every 2 years',        'Familienausweise — alle 2 Jahre verlängern','全家借书证 — 每两年续办一次'),            L('Dortmund City Library', 'Stadtbibliothek Dortmund', '市图书馆'),                       null],
  [L('Landlord — Mr Groß', 'Vermieter — Herr Groß', '房东 — 葛先生'),                     'services', L('+49 231 112 7743', '+49 231 112 7743', '021-6612 7743'),  'vermieter.gross@gmail.com',     null,                           L('Emergency maintenance: same number',        'Notfall-Hausmeisterdienst: gleiche Nummer','紧急维修：同一号码'),                      null,                                                    L('Landlord', 'Vermieter', '房东')],
  [L("Emma's friend — Lena", 'Emmas Freundin — Lena', '思思的同学 — 小雅'),               'family',   L('+49 231 774 3309', '+49 231 774 3309', '021-6774 3309'),  null,                            null,                           L('Lena Braun — mum Katrin +49 231 774 3308',  'Lena Braun — Mutter Katrin +49 231 774 3308','小雅 — 妈妈王女士 021-6774 3308'),        null,                                                    null],
].forEach(row => insertContact.run(...row));

// ── Budget ───────────────────────────────────────────────────────────────────

// Konten tragen die Buchungen — ohne sie ist der Konten-Tab leer und jede
// Buchung kontolos. Die Salden entstehen aus starting_balance plus Buchungen.
console.log('Inserting budget accounts…');
const insertAccount = db.prepare(`
  INSERT INTO budget_accounts (name, type, starting_balance, color, sort_order, created_by)
  VALUES (?, ?, ?, ?, ?, ?)
`);
// Sechs Konten decken vier der sechs Kontoarten ab. Vier waren zu wenig: die
// Liste endete auf halber Höhe, und `investment` kam in keinem Datensatz vor.
const accountId = {};
[
  ['current',  L('Joint Current Account', 'Gemeinsames Girokonto', '家庭日常账户'), 'checking',   2480.00*M, '#2563EB', 0, alexId],
  ['savings',  L('Savings — Holiday',     'Sparkonto — Urlaub',    '储蓄 — 旅行基金'), 'savings',    5200.00*M, '#10B981', 1, lindaId],
  ['kids',     L('Savings — Emma & Leo',  'Sparen für Emma & Leo', '储蓄 — 思思和乐乐'), 'savings',    1850.00*M, '#EC4899', 2, lindaId],
  ['cash',     L('Housekeeping cash',     'Haushaltskasse',        '家庭备用现金'), 'cash',        180.00*M, '#F59E0B', 3, lindaId],
  ['credit',   L('Visa Credit Card',      'Visa Kreditkarte',      '信用卡'),       'credit',     -340.00*M, '#8B5CF6', 4, alexId],
  ['depot',    L('Investment Account',    'Wertpapierdepot',       '证券投资账户'), 'investment', 9420.00*M, '#0EA5E9', 5, alexId],
].forEach(([slug, name, type, balance, color, sort, by]) => {
  accountId[slug] = insertAccount.run(name, type, balance, color, sort, by).lastInsertRowid;
});

console.log('Inserting budget entries…');
const insertBudget = db.prepare(`
  INSERT INTO budget_entries (title, amount, category, subcategory, date, is_recurring, account_id, created_by)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`);
const budget = [
  // Income (category = income key, no subcategory)
  [L('Alex — Monthly Salary',    'Alex — Gehalt',               '志远 — 月工资'),               3850.00*M, 'Erwerbseinkommen', '',                       thisMonthDate(1),  1, 'current', alexId],
  [L('Linda — Part-time Work',   'Linda — Teilzeit',            '琼照 — 兼职收入'),             1200.00*M, 'Erwerbseinkommen', '',                       thisMonthDate(1),  1, 'current', lindaId],
  [L('Child Benefit',            'Kindergeld',                  '育儿补贴'),                     500.00*M, 'Sozialleistungen', '',                       thisMonthDate(5),  1, 'current', alexId],
  // Fixed expenses
  [L('Rent',                     'Miete',                       '房租'),                      -1450.00*M, 'housing',           'rent_mortgage',          thisMonthDate(1),  1, 'current', alexId],
  [L('Car Insurance — VW Golf',  'Kfz-Versicherung — VW Golf',  '车险 — 大众高尔夫'),            -89.50*M, 'transport',         'maintenance_insurance',  thisMonthDate(1),  1, 'current', alexId],
  [L('Health Insurance',         'Krankenversicherung',         '医保社保'),                    -310.00*M, 'personal_health',   'health_insurance',       thisMonthDate(1),  1, 'current', alexId],
  [L('Internet & Phone Bundle',  'Internet & Telefon',          '宽带和手机话费'),               -49.99*M, 'housing',           'internet_tv_phone',      thisMonthDate(5),  1, 'current', alexId],
  [L('Electricity',              'Strom',                       '电费'),                         -78.00*M, 'housing',           'utilities',              thisMonthDate(15), 1, 'current', alexId],
  [L('Netflix',                  'Netflix',                     'Netflix 会员'),                 -17.99*M, 'leisure',           'streaming',              thisMonthDate(10), 1, 'credit',  alexId],
  [L('Spotify Family',           'Spotify Family',              'Spotify 家庭组'),               -16.99*M, 'leisure',           'streaming',              thisMonthDate(10), 1, 'credit',  alexId],
  [L('Gym — FitLife',            'Fitnessstudio — FitLife',     '健身房 — FitLife'),             -39.00*M, 'personal_health',   'gym_sports',             thisMonthDate(1),  1, 'current', lindaId],
  // Variable, this month
  [L('Weekly Groceries — Wk 1',  'Wocheneinkauf — KW 1',        '每周食材采购 — 第 1 周'),       -142.30*M, 'food',              'groceries',              thisMonthDate(4),  0, 'current', lindaId],
  [L('Weekly Groceries — Wk 2',  'Wocheneinkauf — KW 2',        '每周食材采购 — 第 2 周'),       -118.75*M, 'food',              'groceries',              thisMonthDate(11), 0, 'current', lindaId],
  [L('Weekly Groceries — Wk 3',  'Wocheneinkauf — KW 3',        '每周食材采购 — 第 3 周'),       -134.20*M, 'food',              'groceries',              thisMonthDate(18), 0, 'cash',    lindaId],
  [L('School Trip Payment',      'Zahlung Schulausflug',        '春游费用'),                     -25.00*M, 'education',         'school_supplies',        thisMonthDate(3),  0, 'cash',    lindaId],
  [L('Birthday Gift — Mum',      'Geburtstagsgeschenk — Mama',  '生日礼物 — 妈妈'),              -60.00*M, 'shopping_clothing', 'gifts',                  thisMonthDate(7),  0, 'credit',  alexId],
  [L('Restaurant — Date Night',  'Restaurant — Paarabend',      '餐厅 — 纪念日晚餐'),            -87.50*M, 'food',              'restaurants_bars',       thisMonthDate(9),  0, 'credit',  alexId],
  [L('Fuel — VW Golf',           'Tanken — VW Golf',            '加油 — 大众高尔夫'),            -68.00*M, 'transport',         'fuel',                   thisMonthDate(6),  0, 'current', alexId],
  [L('Pharmacy',                 'Apotheke',                    '药店'),                         -22.40*M, 'personal_health',   'pharmacy',               thisMonthDate(8),  0, 'cash',    lindaId],
  [L("Leo's Football Boots",     'Fußballschuhe für Leo',       '乐乐的足球鞋'),                 -54.99*M, 'shopping_clothing', 'clothes_shoes',          thisMonthDate(12), 0, 'current', lindaId],
  [L('Tools — Home Improvement', 'Werkzeug — Heimwerken',       '工具 — 家居维修'),              -43.00*M, 'housing',           'renovation_maintenance', thisMonthDate(14), 0, 'current', alexId],
  [L('Clothes — Emma',           'Kleidung — Emma',             '衣服 — 思思'),                  -38.50*M, 'shopping_clothing', 'clothes_shoes',          thisMonthDate(16), 0, 'credit',  lindaId],
  [L('Weekend Trip Deposit',     'Anzahlung Kurzurlaub',        '周末游订金'),                  -200.00*M, 'leisure',           'travel',                 thisMonthDate(19), 0, 'savings', alexId],
  // Last month (trend comparison)
  [L('Alex — Monthly Salary',    'Alex — Gehalt',               '志远 — 月工资'),               3850.00*M, 'Erwerbseinkommen', '',                        lastMonthDate(1),  0, 'current', alexId],
  [L('Linda — Part-time Work',   'Linda — Teilzeit',            '琼照 — 兼职收入'),             1200.00*M, 'Erwerbseinkommen', '',                        lastMonthDate(1),  0, 'current', lindaId],
  [L('Rent',                     'Miete',                       '房租'),                      -1450.00*M, 'housing',           'rent_mortgage',          lastMonthDate(1),  0, 'current', alexId],
  [L('Weekly Groceries',         'Wocheneinkauf',               '每周食材采购'),                -489.00*M, 'food',              'groceries',              lastMonthDate(10), 0, 'current', lindaId],
  [L('Electricity',              'Strom',                       '电费'),                         -82.00*M, 'housing',           'utilities',              lastMonthDate(15), 0, 'current', alexId],
  [L('Fuel — VW Golf',           'Tanken — VW Golf',            '加油 — 大众高尔夫'),            -71.00*M, 'transport',         'fuel',                   lastMonthDate(8),  0, 'current', alexId],
];
const budgetEntryIdByTitle = {};
budget.forEach(([title, amount, category, subcategory, date, recurring, acct, by]) => {
  const id = insertBudget.run(title, amount, category, subcategory, date, recurring, accountId[acct], by).lastInsertRowid;
  // Für die Belege unten reicht der erste Treffer je Titel (Miete steht zweimal).
  if (!(title in budgetEntryIdByTitle)) budgetEntryIdByTitle[title] = id;
});

// Kategoriebudgets: ohne sie zeigt der Plan-Tab nur Leerzustand, und die
// Fortschrittsbalken auf der Budget-Übersicht haben keinen Bezugswert.
console.log('Inserting budget plans…');
const insertPlan = db.prepare('INSERT INTO budget_plans (category, amount, created_by) VALUES (?, ?, ?)');
[
  ['housing',           1700*M],
  ['food',               650*M],
  ['transport',          220*M],
  ['personal_health',    400*M],
  ['leisure',            300*M],
  ['shopping_clothing',  180*M],
  ['education',           80*M],
].forEach(([cat, amount]) => insertPlan.run(cat, amount, String(alexId)));

// Darlehen: eines ohne Zinsen (privat geliehenes Geld) und eines als
// Annuität mit Zinsbindung (#569). total_amount/installment_count sind bei
// verzinsten Darlehen abgeleitete Größen - sie kommen aus derselben Rechnung,
// die auch der Route-Handler nutzt, statt aus einer Schätzung hier.
console.log('Inserting budget loans…');
const insertLoan = db.prepare(`
  INSERT INTO budget_loans (title, borrower, total_amount, installment_count, start_month, notes, status, created_by,
                            interest_mode, principal, fixed_rate, initial_repayment_rate, fixed_period_months, followup_rate)
  VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?)
`);
const loanId = insertLoan.run(
  L('Loan to Uncle Mike', 'Darlehen an Onkel Mike', '借给大伯的钱'), L('Uncle Mike Johnson', 'Onkel Mike Johnson', '大伯 志强'),
  1200.00*M, 6, thisMonthKey(-2),
  L('Helping with his car repair — €200/month', 'Hilfe bei der Autoreparatur — 200 € im Monat', '帮他修车 — 每月还 1,400 元'),
  alexId, 'none', null, null, null, null, null,
).lastInsertRowid;

const mortgage = computeLoanSchedule({
  principal: 180000*M, fixedRate: 3.65, initialRepaymentRate: 2.5,
  interestMode: 'fixed_then_variable', fixedPeriodMonths: 120, followupRate: 4.5,
});
if (!mortgage.ok) throw new Error(`Mortgage schedule failed: ${mortgage.reason}`);
const mortgageId = insertLoan.run(
  L('Mortgage — Bürgerstraße', 'Baufinanzierung — Bürgerstraße', '房贷 — 南京西路公寓'), L('Sparkasse Dortmund', 'Sparkasse Dortmund', '市公积金贷款'),
  mortgage.totalRepayment, mortgage.totalMonths, thisMonthKey(-14),
  L('10-year fixed rate, 2.5% initial repayment', '10 Jahre Zinsbindung, 2,5 % Anfangstilgung', '30 年等额本息，已还 14 期'),
  alexId, 'fixed_then_variable', 180000*M, 3.65, 2.5, 120, 4.5,
).lastInsertRowid;

const insertLoanPayment = db.prepare(`
  INSERT INTO budget_loan_payments (loan_id, installment_number, amount, paid_date, created_by)
  VALUES (?, ?, ?, ?, ?)
`);
insertLoanPayment.run(loanId, 1, 200.00*M, lastMonthDate(2), alexId);
insertLoanPayment.run(loanId, 2, 200.00*M, thisMonthDate(2), alexId);
// 14 Monatsraten der Baufinanzierung sind bezahlt — genug für einen sichtbaren
// Tilgungsfortschritt, weit vor dem Ende der Zinsbindung. Rate i gehört zum
// Monat, in dem sie fällig war (Start: 14 Monate zurück).
for (let i = 1; i <= 14; i++) {
  insertLoanPayment.run(mortgageId, i, mortgage.monthlyPayment, `${thisMonthKey(-14 + i - 1)}-01`, alexId);
}

// ── Notes ────────────────────────────────────────────────────────────────────

console.log('Inserting notes…');
const insertNote = db.prepare('INSERT INTO notes (title, content, color, pinned, created_by) VALUES (?, ?, ?, ?, ?)');
[
  [L('Holiday Checklist 🌍', 'Urlaubs-Checkliste 🌍', '出游清单 🌍'),
   L('Passports (exp. 2028)\nTravel insurance — check!\nEuro cash — €300\nBook airport parking\nAsk Mike to water the plants\nPack sunscreen SPF 50',
     'Reisepässe (gültig bis 2028)\nAuslandskrankenschein — prüfen!\nBargeld — 300 €\nParkplatz am Flughafen buchen\nMike wegen Blumengießen fragen\nSonnencreme LSF 50 einpacken',
     '身份证和护照（2028 年到期）\n旅游保险 — 记得确认！\n现金 — 备 3,000 元\n订好机场停车场\n让大伯帮忙浇花\n防晒霜 SPF50 装包里'), '#0EA5E9', 1, alexId],
  [L('WiFi & Smart Home', 'WLAN & Smart Home', 'WiFi 与智能家居'),
   L('WiFi: Juju_Home_5G (password in the router app)\nPhilips Hue: bridge 192.168.1.42\nThermostat: eco mode 18°C\nRouter admin: fritz.box',
     'WLAN: Juju_Home_5G (Passwort in der Router-App)\nPhilips Hue: Bridge 192.168.1.42\nThermostat: Eco-Modus 18 °C\nRouter-Verwaltung: fritz.box',
     'WiFi：Juju_Home_5G（密码在路由器 App 里）\n智能灯：网关 192.168.1.42\n空调：节能模式 26°C\n路由器管理：192.168.1.1'), '#F59E0B', 1, alexId],
  [L("Emma's School Info", 'Emmas Schulinfos', '思思的学校信息'),
   L('Class: 3b — Mrs Bauer\nSchool starts: 08:10\nCollection: 13:30 (Tue/Thu 15:00)\nAllergy: mild lactose intolerance\nBest friends: Lena, Sophie, Tim',
     'Klasse: 3b — Frau Bauer\nSchulbeginn: 08:10\nAbholung: 13:30 (Di/Do 15:00)\nUnverträglichkeit: leichte Laktoseintoleranz\nBeste Freunde: Lena, Sophie, Tim',
     '班级：三（2）班 — 班主任陈老师\n到校时间：08:10\n放学接：13:30（周二/周四 15:00）\n忌口：轻微乳糖不耐受\n好朋友：小雅、朵朵、天天'), '#EC4899', 1, lindaId],
  [L("Leo's Activities", 'Leos Termine', '乐乐的兴趣班'),
   L('Football: Tue & Sat 17:00 — SV West\nSwimming: Fri 16:00 — Westbad\nNeeds: boots size 35, goggles\nCoach: Herr Krüger',
     'Fußball: Di und Sa 17:00 — SV West\nSchwimmen: Fr 16:00 — Westbad\nBraucht: Schuhe Größe 35, Schwimmbrille\nTrainer: Herr Krüger',
     '足球：周二、周六 17:00 — 城西体育场\n游泳：周五 16:00 — 市游泳馆\n装备：35 码球鞋、泳镜\n教练：刘教练'), '#F97316', 1, lindaId],
  [L('Emergency Numbers', 'Notrufnummern', '紧急电话'),
   L('Police: 110\nFire / Ambulance: 112\nPoison Control: 0800 192 11 10\nGP out-of-hours: 116 117\nNearest A&E: Klinikum Dortmund',
     'Polizei: 110\nFeuerwehr / Rettungsdienst: 112\nGiftnotruf: 0800 192 11 10\nÄrztlicher Bereitschaftsdienst: 116 117\nNächste Notaufnahme: Klinikum Dortmund',
     '报警：110\n火警：119\n急救：120\n物业急修：021-6612 7743\n最近急诊：市第一人民医院'), '#EF4444', 1, alexId],
  [L('Car — Important Dates', 'Auto — wichtige Termine', '爱车 — 重要日期'),
   L('Next service: this June (60,000 km)\nMOT due: September\nWinter tyres: stored at AutoHaus König\nInsurance renewal: October',
     'Nächste Inspektion: im Juni (60.000 km)\nTÜV fällig: September\nWinterreifen: eingelagert beim AutoHaus König\nVersicherungswechsel: Oktober',
     '下次保养：今年 6 月（6 万公里）\n年检到期：9 月\n雪地胎：寄存在 4S 店\n保险续保：10 月'), '#6B7280', 0, alexId],
  [L('Book Recommendations', 'Buchempfehlungen', '书单推荐'),
   L('Reading: "Atomic Habits" — James Clear\nWishlist:\n• The Thursday Murder Club\n• Lessons in Chemistry\n• Tomorrow, and Tomorrow, and Tomorrow',
     'Gerade dabei: „Die 1%-Methode" — James Clear\nWunschliste:\n• Der Donnerstagsmordclub\n• Eine Frage der Chemie\n• Morgen, morgen und wieder morgen',
     '在读：《掌控习惯》— 詹姆斯·克利尔\n想买：\n• 《周四推理俱乐部》\n• 《化学课》\n• 《明日传奇》'), '#8B5CF6', 0, lindaId],
  [L('Garden To-Do', 'Garten-Aufgaben', '阳台待办'),
   L('□ Re-pot herbs (basil, rosemary)\n□ Fix fence panel (3rd from gate)\n□ Order mulch for the flower beds\n□ Plant tulip bulbs before November',
     '□ Kräuter umtopfen (Basilikum, Rosmarin)\n□ Zaunfeld reparieren (3. vom Tor)\n□ Rindenmulch für die Beete bestellen\n□ Tulpenzwiebeln vor November setzen',
     '□ 给香草换盆（罗勒、迷迭香）\n□ 修栅栏（从门口数第三块）\n□ 给花坛买营养土\n□ 11 月前种下郁金香种球'), '#10B981', 0, alexId],
].forEach(row => insertNote.run(...row));

// ── Birthdays ────────────────────────────────────────────────────────────────

console.log('Inserting birthdays…');
const insertBirthday = db.prepare(`
  INSERT INTO birthdays (name, birth_date, notes, family_user_id, reminder_offset, created_by)
  VALUES (?, ?, ?, ?, ?, ?)
`);
[
  [L('Emma Johnson', 'Emma Johnson', '王思思'),                  '2018-06-14', L('Turning 8 — chocolate cake & bouncy castle', 'Wird 8 — Schokotorte und Hüpfburg', '满 8 岁 — 巧克力蛋糕和充气城堡'), emmaId, '1w', lindaId],
  [L('Leo Johnson', 'Leo Johnson', '王乐乐'),                    '2016-03-22', L('Loves football & LEGO',                      'Liebt Fußball und LEGO',            '最爱足球和乐高'),                 leoId,  '1w', lindaId],
  [L('Margaret Johnson', 'Margaret Johnson', '王秀兰（奶奶）'),   '1958-06-19', L("Alex's mum — 'Grandma'",                     'Alex’ Mutter — „Oma"',              '志远的妈妈 — 家里人叫她"奶奶"'),   null,   '3d', alexId],
  [L('Uncle Mike Johnson', 'Onkel Mike Johnson', '王志强（大伯）'), '1985-11-02', L("Alex's brother in Hamburg",                  'Alex’ Bruder in Hamburg',           '志远的哥哥，在外地工作'),          null,   '1d', alexId],
  [L('Aunt Claire Becker', 'Tante Claire Becker', '戴淑华（姨妈）'), '1989-08-30', L("Linda's sister",                             'Lindas Schwester',                  '琼照的妹妹'),                      null,   '1d', lindaId],
  [L('Lena Braun', 'Lena Braun', '李小雅'),                      '2018-09-12', L("Emma's best friend",                         'Emmas beste Freundin',              '思思最好的朋友'),                  null,   '1d', lindaId],
  [L('Alex Johnson', 'Alex Johnson', '王志远'),                   '1986-02-08', '',                                                                                                                   alexId, '3d', lindaId],
  [L('Linda Johnson', 'Linda Johnson', '戴琼照'),                 '1988-04-25', '',                                                                                                                   lindaId,'3d', alexId],
].forEach(row => insertBirthday.run(...row));

// ── Documents ────────────────────────────────────────────────────────────────

console.log('Inserting documents…');
const insertFolder = db.prepare('INSERT INTO family_document_folders (name, created_by) VALUES (?, ?)');
const folderId = {};
for (const [slug, name] of [
  ['medical',   L('Medical',   'Gesundheit',      '医疗')],
  ['school',    L('School',    'Schule',          '学校')],
  ['insurance', L('Insurance', 'Versicherungen',  '保险')],
  ['home',      L('Home',      'Wohnung',         '房产')],
  ['travel',    L('Travel',    'Reisen',          '出行')],
  ['vehicle',   L('Vehicle',   'Fahrzeug',        '车辆')],
  ['receipts',  L('Receipts',  'Belege',          '票据')],
]) {
  folderId[slug] = insertFolder.run(name, alexId).lastInsertRowid;
}
// Build a base64 payload of a given byte size so file sizes look realistic.
function payload(bytes) {
  const text = 'OIKOS DEMO DOCUMENT — placeholder content. '.repeat(Math.ceil(bytes / 44)).slice(0, bytes);
  const buf = Buffer.from(text, 'utf8');
  return { base64: buf.toString('base64'), size: buf.length };
}
const insertDoc = db.prepare(`
  INSERT INTO family_documents (name, description, category, status, visibility, folder_id, original_name, mime_type, file_size, content_data, created_by)
  VALUES (@name, @description, @category, 'active', @visibility, @folder, @original, @mime, @size, @content, @created_by)
`);
const documents = [
  [L('Vaccination Record — Emma',  'Impfpass — Emma',            '思思的疫苗接种本'),            L('Up to date as of last check-up',       'Beim letzten Check-up aktualisiert',   '上次体检时已更新'),                 'medical',   'family',     'medical',   'emma_vaccinations.pdf',   'application/pdf', 124000, alexId],
  [L('Health Insurance Card',      'Versichertenkarte',          '医保卡'),                      L('Scan of the family insurance card',    'Scan der Familien-Versichertenkarte',  '全家医保卡的扫描件'),               'medical',   'restricted', 'medical',   'insurance_card.jpg',      'image/jpeg',      86000,  alexId],
  [L('School Report — Emma',       'Zeugnis — Emma',             '思思的成绩单'),                L('Spring term report',                   'Halbjahreszeugnis',                    '上学期成绩单'),                     'school',    'family',     'school',    'emma_report_spring.pdf',  'application/pdf', 210000, lindaId],
  [L('Field Trip Permission Slip', 'Einverständnis Schulausflug','春游同意书'),                  L('Signed — science museum',              'Unterschrieben — Naturkundemuseum',    '已签字 — 科技馆春游'),              'school',    'family',     'school',    'permission_slip.pdf',     'application/pdf', 48000,  lindaId],
  [L('Tenancy Agreement',          'Mietvertrag',                '房屋租赁合同'),                L('Signed lease — flat on Bürgerstraße',  'Unterschrieben — Wohnung Bürgerstraße','已签约 — 南京西路公寓'),            'home',      'restricted', 'home',      'tenancy_agreement.pdf',   'application/pdf', 320000, alexId],
  [L('Home Insurance Policy',      'Hausratversicherung',        '家财险保单'),                  L('Policy documents 2025',                'Versicherungsunterlagen 2025',         '2025 年保单资料'),                  'insurance', 'family',     'insurance', 'home_insurance_2025.pdf', 'application/pdf', 180000, alexId],
  [L('Car Insurance — VW Golf',    'Kfz-Versicherung — VW Golf', '车险 — 大众高尔夫'),           L('Comprehensive cover',                  'Vollkasko',                            '全险'),                             'insurance', 'family',     'vehicle',   'car_insurance.pdf',       'application/pdf', 156000, alexId],
  [L('Vehicle Registration',       'Fahrzeugschein',             '车辆行驶证'),                  L('VW Golf TDI — registration papers',    'VW Golf TDI — Zulassungspapiere',      '大众高尔夫 TDI — 行驶证'),          'vehicle',   'restricted', 'vehicle',   'vw_golf_registration.pdf','application/pdf', 96000,  alexId],
  [L('Passports (scans)',          'Reisepässe (Scans)',         '证件扫描件'),                  L('All four family passports',            'Alle vier Reisepässe der Familie',     '全家四口人的证件'),                 'travel',    'private',    'travel',    'passports.pdf',           'application/pdf', 410000, alexId],
  [L('Flight Confirmation',        'Flugbestätigung',            '机票确认单'),                  L('Amsterdam city break',                 'Städtereise Amsterdam',                '周末短途游行程'),                   'travel',    'family',     'travel',    'flights_amsterdam.pdf',   'application/pdf', 64000,  alexId],
  // Belege: hängen unten an Buchungen bzw. an einer geteilten Ausgabe (#583).
  [L('Receipt — Weekly Groceries', 'Kassenbon — Wocheneinkauf',  '小票 — 每周采购'),             L('REWE — week 1',                        'REWE — KW 1',                          '盒马 — 第 1 周'),                   'finance',     'family',     'receipts',  'receipt_rewe.jpg',        'image/jpeg',      92000,  lindaId],
  [L('Invoice — Electricity',      'Rechnung — Strom',           '账单 — 电费'),                 L('Monthly instalment',                   'Monatlicher Abschlag',                 '每月自动扣费'),                     'finance',     'family',     'receipts',  'invoice_electricity.pdf', 'application/pdf', 71000,  alexId],
  [L('Receipt — Football Boots',   'Kassenbon — Fußballschuhe',  '小票 — 足球鞋'),               L('Sports shop — size 35',                'Sportgeschäft — Größe 35',             '运动品店 — 35 码'),                 'finance',     'family',     'receipts',  'receipt_boots.jpg',       'image/jpeg',      68000,  lindaId],
];
const documentIdByName = {};
for (const [name, description, category, visibility, folder, original, mime, size, created_by] of documents) {
  const p = payload(Math.min(size, 4096)); // store a small placeholder, report a realistic size
  documentIdByName[name] = insertDoc.run({
    name, description, category, visibility, folder: folderId[folder],
    original, mime, size, content: p.base64, created_by,
  }).lastInsertRowid;
}

// Belege an Buchungen (#583). Erst hier möglich: die Dokumente entstehen oben,
// die Buchungen weiter vorn - die Verknüpfung braucht beide Seiten.
console.log('Linking receipts to budget entries…');
const insertEntryAttachment = db.prepare(`
  INSERT OR IGNORE INTO budget_entry_attachments (entry_id, document_id, created_by) VALUES (?, ?, ?)
`);
[
  [L('Weekly Groceries — Wk 1', 'Wocheneinkauf — KW 1',        '每周食材采购 — 第 1 周'), L('Receipt — Weekly Groceries', 'Kassenbon — Wocheneinkauf', '小票 — 每周采购'), lindaId],
  [L('Electricity',             'Strom',                       '电费'),                   L('Invoice — Electricity',      'Rechnung — Strom',          '账单 — 电费'),     alexId],
  [L("Leo's Football Boots",    'Fußballschuhe für Leo',       '乐乐的足球鞋'),           L('Receipt — Football Boots',   'Kassenbon — Fußballschuhe', '小票 — 足球鞋'),   lindaId],
].forEach(([entryTitle, docName, by]) => {
  const entryId = budgetEntryIdByTitle[entryTitle];
  const docId = documentIdByName[docName];
  if (entryId && docId) insertEntryAttachment.run(entryId, docId, by);
});

// Dokument an einer Aufgabe: der unterschriebene Zettel hängt an der Aufgabe,
// die ihn verlangt.
const insertTaskDoc = db.prepare(`
  INSERT OR IGNORE INTO task_documents (task_id, document_id, created_by) VALUES (?, ?, ?)
`);
{
  const taskId = taskIdByTitle[L('Sign school permission slip', 'Einverständnis für Schulausflug', '签学校春游同意书')];
  const docId = documentIdByName[L('Field Trip Permission Slip', 'Einverständnis Schulausflug', '春游同意书')];
  if (taskId && docId) insertTaskDoc.run(taskId, docId, lindaId);
}

// ── Housekeeping ─────────────────────────────────────────────────────────────

console.log('Inserting housekeeping data…');
const workerId = db.prepare(`
  INSERT INTO housekeeping_workers (user_id, daily_rate, payment_schedule, notes, calendar_color)
  VALUES (?, ?, ?, ?, ?)
`).run(mariaId, 45.00*M, 'twice_monthly',
  L('Comes Mon, Wed & Fri mornings', 'Kommt Mo, Mi und Fr vormittags', '每周一、三、五上午来'), '#7C3AED').lastInsertRowid;

const insertSession = db.prepare(`
  INSERT INTO housekeeping_work_sessions (check_in, check_out, daily_rate, extras, worker_id, paid_at, created_by)
  VALUES (?, ?, ?, ?, ?, ?, ?)
`);
// Past few weeks of sessions; earlier ones paid, recent ones unpaid.
const sessionDays = [-23, -21, -18, -16, -14, -11, -9, -7, -4, -2, 0];
sessionDays.forEach((d, i) => {
  const checkIn = isoFromNow(d, 8, 30);
  const checkOut = d === 0 ? null : isoFromNow(d, 12, 0); // today still open
  const extras = i % 4 === 0 ? 10.00*M : 0;
  const paidAt = d <= -14 ? isoFromNow(-13, 18, 0) : null;
  insertSession.run(checkIn, checkOut, 45.00*M, extras, workerId, paidAt, alexId);
});

const insertDecay = db.prepare(`
  INSERT INTO housekeeping_decay_tasks (name, area, frequency_days, last_completed, created_by)
  VALUES (?, ?, ?, ?, ?)
`);
[
  [L('Clean bathrooms',    'Bäder putzen',           '清洁卫生间'),       L('Bathrooms',   'Bäder',         '卫生间'),       7,  isoFromNow(-3)],
  [L('Mop kitchen floor',  'Küchenboden wischen',   '拖厨房地板'),       L('Kitchen',     'Küche',         '厨房'),         7,  isoFromNow(-6)],
  [L('Dust living room',   'Wohnzimmer abstauben',  '客厅除尘'),         L('Living room', 'Wohnzimmer',    '客厅'),         14, isoFromNow(-10)],
  [L('Change bed linens',  'Bettwäsche wechseln',   '换床单被套'),       L('Bedrooms',    'Schlafzimmer',  '卧室'),         14, isoFromNow(-16)],   // overdue
  [L('Clean refrigerator', 'Kühlschrank reinigen',  '清洁冰箱'),         L('Kitchen',     'Küche',         '厨房'),         30, isoFromNow(-20)],
  [L('Clean windows',      'Fenster putzen',        '擦玻璃'),           L('Whole house', 'Ganze Wohnung', '全屋'),         30, isoFromNow(-35)],   // overdue
  [L('Deep clean oven',    'Backofen gründlich reinigen', '深度清洁烤箱'), L('Kitchen',     'Küche',         '厨房'),         60, isoFromNow(-40)],
  [L('Wash balcony/patio', 'Balkon kehren',         '清扫阳台'),         L('Outdoor',     'Außenbereich',  '户外'),         30, isoFromNow(-12)],
].forEach(row => insertDecay.run(...row, alexId));

const insertSupply = db.prepare('INSERT INTO housekeeping_supply_requests (name, quantity, created_by) VALUES (?, ?, ?)');
[
  [L('Dish soap',       'Spülmittel',        '洗洁精'),           L('2 bottles', '2 Flaschen', '2 瓶'),    mariaId],
  [L('Paper towels',    'Küchenrolle',       '厨房纸巾'),         L('6 rolls',   '6 Rollen',   '6 卷'),    mariaId],
  [L('Glass cleaner',   'Glasreiniger',      '玻璃清洁剂'),       '1',                                      mariaId],
  [L('Bin bags (60 l)', 'Müllbeutel (60 l)', '垃圾袋（大号）'),   L('1 pack',    '1 Packung',  '1 卷'),    mariaId],
].forEach(row => insertSupply.run(...row));

const insertMaint = db.prepare('INSERT INTO housekeeping_maintenance_log (description, created_by) VALUES (?, ?)');
[
  [L('Reported a dripping tap in the main bathroom',      'Tropfenden Wasserhahn im Bad gemeldet',             '主卫水龙头滴水，已经报修'),                    mariaId],
  [L('Replaced the kitchen sponge and refilled hand soap','Küchenschwamm getauscht und Seife nachgefüllt',     '换了厨房海绵，补了洗手液'),                    mariaId],
  [L('Living-room blind is sticking — needs a look',      'Rollo im Wohnzimmer klemmt — sollte jemand ansehen', '客厅卷帘有点卡住 — 得找时间看看'),            mariaId],
].forEach(row => insertMaint.run(...row));

// ── Split Expenses ───────────────────────────────────────────────────────────

console.log('Inserting split expenses…');
const insertGroup = db.prepare(`
  INSERT INTO expense_groups (name, description, type, avatar_color, default_currency, created_by)
  VALUES (?, ?, ?, ?, '${CUR}', ?)
`);
const insertMember = db.prepare(`
  INSERT INTO expense_group_members (group_id, user_id, role, invited_by) VALUES (?, ?, ?, ?)
`);
const insertExpenseRow = db.prepare(`
  INSERT INTO expenses (group_id, title, description, amount_minor, currency, converted_amount_minor, converted_currency, payer_id, category, split_method, expense_date, created_by)
  VALUES (@group, @title, @description, @amount, '${CUR}', @amount, '${CUR}', @payer, @category, 'equal', @date, @created_by)
`);
const insertSplit = db.prepare('INSERT INTO expense_splits (expense_id, user_id, amount_minor, currency) VALUES (?, ?, ?, ?)');
const insertLedger = db.prepare(`
  INSERT INTO expense_ledger_entries (group_id, source_type, source_id, user_id, counterparty_id, amount_minor, currency, memo, created_by)
  VALUES (?, 'expense', ?, ?, ?, ?, '${CUR}', ?, ?)
`);
const insertActivity = db.prepare(`
  INSERT INTO expense_activity (group_id, actor_id, type, entity_type, entity_id, metadata)
  VALUES (?, ?, ?, ?, ?, ?)
`);

function addExpense(groupId, payerId, memberIds, title, description, euros, category, date) {
  const amount = Math.round(euros * 100);
  const n = memberIds.length;
  const base = Math.floor(amount / n);
  let remainder = amount - base * n;
  const shares = memberIds.map((uid) => {
    let s = base;
    if (remainder > 0) { s += 1; remainder -= 1; }
    return { uid, amount_minor: s };
  });
  const expId = insertExpenseRow.run({
    group: groupId, title, description, amount, payer: payerId, category, date, created_by: payerId,
  }).lastInsertRowid;
  for (const s of shares) insertSplit.run(expId, s.uid, s.amount_minor, CUR);
  // Ledger: payer +full, each member -their share
  insertLedger.run(groupId, expId, payerId, null, amount, title, payerId);
  for (const s of shares) insertLedger.run(groupId, expId, s.uid, payerId, -s.amount_minor, title, payerId);
  // Typ muss exakt einer der Typen sein, die server/routes/split-expenses.js
  // schreibt — der Feed übersetzt über splitExpenses.activityType.<type>, ein
  // erfundener Typ rendert als roher Key.
  insertActivity.run(groupId, payerId, 'expense_created', 'expense', expId, JSON.stringify({ title, amount_minor: amount }));
  return expId;
}

// Group 1: Household (alex + linda)
const houseGroupName = L('Household', 'Haushalt', '家庭日常');
const houseGroup = insertGroup.run(houseGroupName,
  L('Shared bills, groceries and family costs', 'Gemeinsame Rechnungen, Einkäufe und Familienkosten', '水电、食材和全家共同开销'),
  'household', '#0F766E', alexId).lastInsertRowid;
insertMember.run(houseGroup, alexId, 'owner', alexId);
insertMember.run(houseGroup, lindaId, 'admin', alexId);
insertActivity.run(houseGroup, alexId, 'group_created', 'group', houseGroup, JSON.stringify({ name: houseGroupName }));
const groceriesExpenseId =
  addExpense(houseGroup, alexId,  [alexId, lindaId], L('Weekly groceries',  'Wocheneinkauf',        '每周食材采购'),        L('Big shop at REWE',      'Großeinkauf bei REWE',      '盒马大采购'),                142.30*M, 'groceries',     thisMonthDate(4));
addExpense(houseGroup, lindaId, [alexId, lindaId], L('Electricity bill',  'Stromrechnung',        '电费账单'),            L('Monthly direct debit',  'Monatlicher Abschlag',       '每月自动扣费'),               78.00*M, 'utilities',     thisMonthDate(15));
const dinnerExpenseId =
  addExpense(houseGroup, alexId,  [alexId, lindaId], L('Date-night dinner', 'Abendessen zu zweit',  '两人纪念日晚餐'),      L('Italian on the corner', 'Italiener um die Ecke',      '街角的意大利餐厅'),           87.50*M, 'general',       thisMonthDate(9));
addExpense(houseGroup, lindaId, [alexId, lindaId], L("Emma's new shoes",  'Neue Schuhe für Emma', '思思的新鞋'),          L('Back-to-school',        'Für den Schulstart',         '开学装备'),                   38.50*M, 'shopping',      thisMonthDate(16));
addExpense(houseGroup, alexId,  [alexId, lindaId], L('Streaming bundle',  'Streaming-Paket',      '视频音乐会员'),        L('Netflix + Spotify',     'Netflix und Spotify',        'Netflix 和 Spotify'),         34.98*M, 'subscriptions', thisMonthDate(10));

// Group 2: Italy Trip 2026 (alex + linda)
const tripGroupName = L('Italy Trip 2026', 'Italienurlaub 2026', '三亚之旅 2026');
const tripGroup = insertGroup.run(tripGroupName,
  L('Summer holiday planning & costs', 'Planung und Kosten des Sommerurlaubs', '暑假出游的计划和开销'),
  'travel', '#0EA5E9', alexId).lastInsertRowid;
insertMember.run(tripGroup, alexId, 'owner', alexId);
insertMember.run(tripGroup, lindaId, 'admin', alexId);
insertActivity.run(tripGroup, alexId, 'group_created', 'group', tripGroup, JSON.stringify({ name: tripGroupName }));
addExpense(tripGroup, alexId,  [alexId, lindaId], L('Flights (×4)',      'Flüge (×4)',          '机票（×4）'),           L('Dortmund → Naples',   'Dortmund → Neapel',      '上海 → 三亚'),             648.00*M, 'travel',  thisMonthDate(2));
addExpense(tripGroup, lindaId, [alexId, lindaId], L('Apartment deposit', 'Anzahlung Ferienwohnung', '民宿订金'),         L('Sorrento — 7 nights', 'Sorrent — 7 Nächte',     '海棠湾 — 7 晚'),           400.00*M, 'travel',  thisMonthDate(6));
addExpense(tripGroup, alexId,  [alexId, lindaId], L('Travel insurance',  'Reiseversicherung',   '旅游保险'),             L('Family annual policy','Jahrespolice für die Familie', '全家年度保单'),            96.00*M, 'general', thisMonthDate(8));

// Beleg + Kommentar an einer geteilten Ausgabe: beides gab es im Seed nie, und
// beide Ansichten (Beleg-Chip, Kommentarfaden) blieben dadurch unsichtbar.
const receiptDocId = documentIdByName[L('Receipt — Weekly Groceries', 'Kassenbon — Wocheneinkauf', '小票 — 每周采购')];
if (receiptDocId) {
  db.prepare(`
    INSERT INTO expense_attachments (expense_id, document_id, kind, created_by) VALUES (?, ?, 'receipt', ?)
  `).run(groceriesExpenseId, receiptDocId, alexId);
}
const insertExpenseComment = db.prepare(`
  INSERT INTO expense_comments (expense_id, user_id, comment) VALUES (?, ?, ?)
`);
insertExpenseComment.run(dinnerExpenseId, lindaId, L('Worth every cent — let us go again.', 'Jeden Cent wert — da gehen wir wieder hin.', '花得值 — 下次还来。'));
insertExpenseComment.run(dinnerExpenseId, alexId,  L('Agreed. Next time we book a table.',  'Finde ich auch. Nächstes Mal reservieren wir.',  '同意。下次提前订位。'));

// Wiederkehrende geteilte Ausgabe: der Mietanteil läuft monatlich weiter.
db.prepare(`
  INSERT INTO recurring_expenses (group_id, title, description, amount_minor, currency, payer_id, category,
                                  split_method, split_snapshot, frequency, next_run_date, created_by)
  VALUES (?, ?, ?, ?, '${CUR}', ?, 'housing', 'equal', ?, 'monthly', ?, ?)
`).run(
  houseGroup, L('Rent share', 'Mietanteil', '房租均摊'), L('Split 50/50 each month', 'Jeden Monat hälftig geteilt', '每月五五分摊'),
  145000*M, alexId,
  JSON.stringify([{ user_id: alexId, amount_minor: 72500*M }, { user_id: lindaId, amount_minor: 72500*M }]),
  thisMonthDate(1) > daysFromNow(0) ? thisMonthDate(1) : `${thisMonthKey(1)}-01`,
  alexId,
);

// A settlement in the household group: Linda pays Alex back a round amount
const settlementId = db.prepare(`
  INSERT INTO settlements (group_id, payer_id, payee_id, amount_minor, currency, notes, created_by)
  VALUES (?, ?, ?, ?, '${CUR}', ?, ?)
`).run(houseGroup, lindaId, alexId, 5000*M,
  L('Partial settle-up via bank transfer', 'Teilausgleich per Überweisung', '转账部分结清'), lindaId).lastInsertRowid;
db.prepare(`
  INSERT INTO settlement_entries (settlement_id, from_user_id, to_user_id, amount_minor, currency)
  VALUES (?, ?, ?, ?, '${CUR}')
`).run(settlementId, lindaId, alexId, 5000*M);
// Ledger for settlement: payer (linda) +amount toward payee, payee (alex) -amount
db.prepare(`
  INSERT INTO expense_ledger_entries (group_id, source_type, source_id, user_id, counterparty_id, amount_minor, currency, memo, created_by)
  VALUES (?, 'settlement', ?, ?, ?, ?, '${CUR}', ?, ?)
`).run(houseGroup, settlementId, lindaId, alexId, 5000*M, L('Settle-up', 'Ausgleich', '结清'), lindaId);
db.prepare(`
  INSERT INTO expense_ledger_entries (group_id, source_type, source_id, user_id, counterparty_id, amount_minor, currency, memo, created_by)
  VALUES (?, 'settlement', ?, ?, ?, ?, '${CUR}', ?, ?)
`).run(houseGroup, settlementId, alexId, lindaId, -5000*M, L('Settle-up', 'Ausgleich', '结清'), lindaId);
insertActivity.run(houseGroup, lindaId, 'payment_registered', 'settlement', settlementId, JSON.stringify({ amount_minor: 5000 }));

// ── Health: Vitals ───────────────────────────────────────────────────────────
// All health data belongs to Linda (the demo login) so it renders on her own
// Health page. visibility stays at the DEFAULT 'private' (own data always shows).

console.log('Inserting health vitals…');
const insertVital = db.prepare(`
  INSERT INTO health_vitals (user_id, type, value_num, value_num2, value_num3, unit, measured_at, note)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`);
// Weight trend (kg) — a gentle downward trend over ~8 weeks
[[-56, 66.9], [-49, 66.6], [-42, 66.4], [-35, 66.1], [-28, 65.9], [-21, 65.6], [-14, 65.4], [-7, 65.2], [-1, 65.0]]
  .forEach(([d, kg]) => insertVital.run(lindaId, 'weight', kg, null, null, 'kg', dateTimeFromNow(d, 7, 30), null));
// Blood pressure (systolic / diastolic / pulse)
[[-42, 122, 79, 68], [-28, 118, 76, 64], [-14, 120, 78, 66], [-3, 116, 74, 61]]
  .forEach(([d, sys, dia, pul]) => insertVital.run(lindaId, 'bp', sys, dia, pul, 'mmHg', dateTimeFromNow(d, 8, 0), null));
// Fasting glucose (mg/dL)
[[-30, 92], [-14, 88], [-2, 90]].forEach(([d, v]) =>
  insertVital.run(lindaId, 'glucose', v, null, null, 'mg/dL', dateTimeFromNow(d, 7, 0), L('Fasting', 'Nüchtern', '空腹')));
// SpO₂ (%) and temperature (°C)
[[-10, 98], [-2, 99]].forEach(([d, v]) => insertVital.run(lindaId, 'spo2', v, null, null, '%', dateTimeFromNow(d, 8, 30), null));
insertVital.run(lindaId, 'temp', 36.7, null, null, '°C', dateTimeFromNow(-5, 20, 0), null);
// Sleep (decimal hours, measured_at = the morning the night ended)
[[-13, 7.5], [-12, 6.75], [-11, 7.25], [-10, 8.0], [-9, 6.5], [-8, 7.0], [-7, 7.75],
 [-6, 7.25], [-5, 6.25], [-4, 7.5], [-3, 8.25], [-2, 7.0], [-1, 7.5]]
  .forEach(([d, hours]) => insertVital.run(lindaId, 'sleep', hours, null, null, 'h', dateTimeFromNow(d, 7, 0), null));
// Mood on the 1-5 scale — no unit, the number is a step
[[-13, 4], [-11, 3], [-9, 2], [-7, 4], [-5, 3], [-3, 5], [-1, 4]]
  .forEach(([d, step]) => insertVital.run(lindaId, 'mood', step, null, null, null, dateTimeFromNow(d, 20, 30), null));

// ── Health: Caregiver grants (#584) ──────────────────────────────────────────
// Both parents may record for both children. Without a grant the feature is
// invisible, and a demo that never shows it is a demo of the old behaviour.

console.log('Granting health caregiver rights…');
const insertCareGrant = db.prepare(`
  INSERT INTO health_care_grants (subject_id, caregiver_id) VALUES (?, ?)
`);
for (const childId of [emmaId, leoId]) {
  for (const parentId of [alexId, lindaId]) insertCareGrant.run(childId, parentId);
}

// ── Health: Activities ───────────────────────────────────────────────────────

console.log('Inserting health activities…');
const insertActivity2 = db.prepare(`
  INSERT INTO health_activities (user_id, type, duration_min, distance_km, intensity, calories, performed_at, note)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`);
[
  ['running',  32, 5.2, 'high',     410, -1,  L('Morning run in the park',   'Morgenlauf im Park',   '清晨公园慢跑')],
  ['yoga',     40, null, 'low',     150, -2,  L('Evening flow',              'Abend-Flow',           '晚间瑜伽流')],
  ['cycling',  48, 15.4, 'moderate', 395, -3, L('River loop',                'Runde an der Ruhr',    '沿江骑行一圈')],
  ['walking',  55, 4.3, 'low',      190, -4,  L('Walk with the kids',        'Spaziergang mit den Kindern', '带孩子们散步')],
  ['strength', 35, null, 'high',    230, -6,  L('Full-body session',         'Ganzkörper-Einheit',   '全身力量训练')],
  ['running',  28, 4.6, 'moderate', 360, -8,  ''],
  ['swimming', 30, 1.2, 'moderate', 300, -10, L('Lane swimming at Westbad',  'Bahnen im Westbad',    '游泳馆刷圈')],
  ['cycling',  60, 19.0, 'high',    520, -12, L('Weekend ride',              'Wochenendtour',        '周末长途骑行')],
].forEach(([type, dur, dist, inten, cal, d, note]) =>
  insertActivity2.run(lindaId, type, dur, dist, inten, cal, dateTimeFromNow(d, 7, 0), note || null));

// ── Health: Medications ──────────────────────────────────────────────────────

console.log('Inserting medications…');
const insertMed = db.prepare(`
  INSERT INTO medications (user_id, name, dosage_text, form, active, prn, stock_qty, stock_unit, refill_threshold, note)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
const insertMedSched = db.prepare(`
  INSERT INTO medication_schedules (medication_id, time_of_day, days_mask, dose_qty, start_date, active)
  VALUES (?, ?, ?, ?, ?, 1)
`);
const insertMedLog = db.prepare(`
  INSERT INTO medication_logs (medication_id, schedule_id, scheduled_at, status, taken_at, dose_qty)
  VALUES (?, ?, ?, ?, ?, ?)
`);
// Daily supplements with a schedule + a week of adherence logs (today still pending)
const vitDId = insertMed.run(lindaId, L('Vitamin D3', 'Vitamin D3', '维生素 D3'), L('1000 IU', '1000 IE', '1000 国际单位'), 'tablet', 1, 0, 42,
  L('tablets', 'Tabletten', '片'), 10, L('With breakfast', 'Zum Frühstück', '随早餐服用')).lastInsertRowid;
const vitDSched = insertMedSched.run(vitDId, '08:00', 127, 1, daysFromNow(-40)).lastInsertRowid;
const ironId = insertMed.run(lindaId, L('Iron (Ferrous bisglycinate)', 'Eisen (Eisenbisglycinat)', '铁剂（甘氨酸亚铁）'), '25 mg', 'capsule', 1, 0, 18,
  L('capsules', 'Kapseln', '粒'), 14, L('Low ferritin — evening, away from dairy', 'Niedriges Ferritin — abends, nicht mit Milchprodukten', '铁蛋白偏低 — 晚上服，别和奶制品同服')).lastInsertRowid;
const ironSched = insertMedSched.run(ironId, '20:00', 127, 1, daysFromNow(-25)).lastInsertRowid;
// As-needed medication (no schedule)
insertMed.run(lindaId, 'Ibuprofen', '400 mg', 'tablet', 1, 1, 20,
  L('tablets', 'Tabletten', '片'), 5, L('For headaches — max 3/day', 'Bei Kopfschmerzen — höchstens 3 pro Tag', '头痛时用 — 每天最多 3 次'));
// Adherence logs: last 6 days taken, today pending
for (let d = -6; d <= 0; d++) {
  const status = d === 0 ? 'pending' : 'taken';
  const takenAt = d === 0 ? null : dateTimeFromNow(d, 8, 12);
  insertMedLog.run(vitDId, vitDSched, dateTimeFromNow(d, 8, 0), status, takenAt, 1);
}
for (let d = -6; d <= 0; d++) {
  const taken = d < 0 && d !== -3;                 // one missed dose for realism
  insertMedLog.run(ironId, ironSched, dateTimeFromNow(d, 20, 0), taken ? 'taken' : (d === 0 ? 'pending' : 'skipped'), taken ? dateTimeFromNow(d, 20, 18) : null, 1);
}

// ── Health: Lab Reports ──────────────────────────────────────────────────────

console.log('Inserting lab reports…');
const insertLabReport = db.prepare(`
  INSERT INTO health_lab_reports (user_id, report_date, lab_name, note) VALUES (?, ?, ?, ?)
`);
const insertLabResult = db.prepare(`
  INSERT INTO health_lab_results (report_id, analyte, value_num, unit, ref_low, ref_high, flag) VALUES (?, ?, ?, ?, ?, ?, ?)
`);
const LAB_NAME = L('City Practice Laboratory', 'Labor der Praxis am Markt', '市第一医院检验科');
const ANALYTE = {
  haemoglobin: L('Haemoglobin',       'Hämoglobin',         '血红蛋白'),
  ferritin:    L('Ferritin',          'Ferritin',           '铁蛋白'),
  vitaminD:    L('Vitamin D',         'Vitamin D',          '维生素 D'),
  tsh:         L('TSH',               'TSH',                '促甲状腺激素'),
  cholesterol: L('Total Cholesterol', 'Gesamtcholesterin',  '总胆固醇'),
  hdl:         L('HDL',               'HDL',                '高密度脂蛋白'),
  ldl:         L('LDL',               'LDL',                '低密度脂蛋白'),
  glucose:     L('Fasting Glucose',   'Nüchternblutzucker', '空腹血糖'),
};
const labReportNow = insertLabReport.run(lindaId, daysFromNow(-18), LAB_NAME,
  L('Annual blood panel', 'Jährliches Blutbild', '年度血液检查')).lastInsertRowid;
[
  [ANALYTE.haemoglobin, 13.2, 'g/dL',  12.0, 16.0, null],
  [ANALYTE.ferritin,    24,   'ng/mL', 15,   150,  null],
  [ANALYTE.vitaminD,    22,   'ng/mL', 30,   100,  'low'],
  [ANALYTE.tsh,         2.1,  'mIU/L', 0.4,  4.0,  null],
  [ANALYTE.cholesterol, 195,  'mg/dL', 0,    200,  null],
  [ANALYTE.hdl,         62,   'mg/dL', 40,   100,  null],
  [ANALYTE.ldl,         118,  'mg/dL', 0,    130,  null],
  [ANALYTE.glucose,     91,   'mg/dL', 70,   100,  null],
].forEach(([a, v, u, lo, hi, flag]) => insertLabResult.run(labReportNow, a, v, u, lo, hi, flag));
// An older panel for trend comparison
const labReportOld = insertLabReport.run(lindaId, daysFromNow(-200), LAB_NAME,
  L('Routine check', 'Routinekontrolle', '常规复查')).lastInsertRowid;
[
  [ANALYTE.haemoglobin, 12.8, 'g/dL',  12.0, 16.0, null],
  [ANALYTE.ferritin,    18,   'ng/mL', 15,   150,  null],
  [ANALYTE.vitaminD,    18,   'ng/mL', 30,   100,  'low'],
].forEach(([a, v, u, lo, hi, flag]) => insertLabResult.run(labReportOld, a, v, u, lo, hi, flag));

// ── Health: Cycle ────────────────────────────────────────────────────────────

console.log('Inserting cycle data…');
// Demo-Zyklus familienweit sichtbar seeden: sonst sind die Perioden aus jeder
// anderen Account-Perspektive unsichtbar und die Vorhersage rechnet auf Lücken
// (Discussion #550). default_visibility bleibt 'private' - nur die Beispieldaten
// selbst sind bewusst geteilt.
db.prepare(`
  INSERT INTO cycle_settings (user_id, cycle_length_avg, period_length_avg, luteal_length, track_fertility)
  VALUES (?, 28, 5, 14, 1)
`).run(lindaId);
const insertPeriod = db.prepare('INSERT INTO cycle_periods (user_id, start_date, end_date, note, visibility) VALUES (?, ?, ?, ?, ?)');
[[-6, -2, L('Current cycle', 'Aktueller Zyklus', '当前周期')], [-34, -30, null], [-62, -58, null], [-90, -86, null]]
  .forEach(([s, e, note]) => insertPeriod.run(lindaId, daysFromNow(s), daysFromNow(e), note, 'family'));
const insertCycleLog = db.prepare('INSERT INTO cycle_day_logs (user_id, log_date, flow, symptoms, mood, note, visibility) VALUES (?, ?, ?, ?, ?, ?, ?)');
[
  [-6, 'heavy',    'cramps,fatigue',       'sensitive', null],
  [-5, 'heavy',    'cramps,backache',      'irritable', L('Tough day', 'Anstrengender Tag', '今天比较累')],
  [-4, 'medium',   'headache',             'neutral',   null],
  [-3, 'light',    'fatigue',              'good',      null],
  [-2, 'spotting', '',                     'good',      null],
].forEach(([d, flow, symptoms, mood, note]) => insertCycleLog.run(lindaId, daysFromNow(d), flow, symptoms, mood, note, 'family'));

// ── Rewards ──────────────────────────────────────────────────────────────────

console.log('Inserting rewards…');
const insertRewardParticipant = db.prepare('INSERT INTO reward_participants (user_id, enabled) VALUES (?, 1)');
insertRewardParticipant.run(emmaId);
insertRewardParticipant.run(leoId);

const insertRewardItem = db.prepare(`
  INSERT INTO reward_catalog (name, cost, icon, description, is_active, sort_order, created_by)
  VALUES (?, ?, ?, ?, 1, ?, ?)
`);
const REWARD_ICE_CREAM = L('Ice cream trip',  'Eis essen gehen',  '去吃冰淇淋');
const REWARD_GAMING    = L('Video game hour', 'Eine Stunde zocken', '打游戏一小时');
[
  [L('Extra 30 min screen time', '30 Minuten extra Bildschirmzeit', '屏幕时间 +30 分钟'), 20, '📺', L('One extra half-hour of tablet or TV',   'Eine halbe Stunde mehr Tablet oder Fernsehen', '平板或电视多看半小时')],
  [REWARD_ICE_CREAM,                                                 25, '🍦', L('A visit to the ice cream parlour',      'Ein Besuch in der Eisdiele',                   '全家去一趟冰淇淋店')],
  [L('Choose movie night film',  'Filmabend aussuchen',             '电影夜选片权'),       30, '🎬', L('Pick what the family watches on Friday','Aussuchen, was die Familie freitags schaut',   '周五全家看什么由你挑')],
  [REWARD_GAMING,                                                    40, '🎮', L('A full hour of gaming',                 'Eine ganze Stunde Videospiele',                '痛快玩一小时游戏')],
  [L('€5 pocket money',          '5 € Taschengeld',                 '35 元零花钱'),        50, '💶', L('Five euros added to your savings',      'Fünf Euro fürs Sparschwein',                   '35 元存进自己的储蓄罐')],
  [L('Friend sleepover',         'Übernachtungsbesuch',             '请朋友来家过夜'),     60, '🛌', L('Invite a friend to stay over',          'Eine Freundin oder einen Freund einladen',     '邀请好朋友来家里住一晚')],
].forEach((r, i) => insertRewardItem.run(r[0], r[1], r[2], r[3], i, alexId));

const insertRewardLedger = db.prepare(`
  INSERT INTO reward_ledger (user_id, delta, type, reason, task_id, redemption_id, created_by, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`);
// Emma earns points, then redeems an ice cream trip
[
  [10, 'earn',  L('Tidied her bedroom',      'Zimmer aufgeräumt',             '收拾了自己的房间'),          -9],
  [15, 'earn',  L('Helped with the dishes',  'Beim Abwasch geholfen',         '帮忙洗碗'),                  -7],
  [20, 'bonus', L('Great school week 🎉',    'Tolle Schulwoche 🎉',           '这周在学校表现超棒 🎉'),     -5],
  [10, 'earn',  L('Fed the cat all week',    'Die ganze Woche Katze gefüttert', '喂了一整周的小猫'),        -2],
].forEach(([delta, type, reason, d]) => insertRewardLedger.run(emmaId, delta, type, reason, null, null, alexId, isoFromNow(d, 18, 0)));
// Leo earns points (has a pending redemption, not yet deducted)
[
  [15, 'earn',  L('Practised piano',          'Klavier geübt',                    '练了钢琴'),                  -8],
  [10, 'earn',  L('Watered the plants',       'Pflanzen gegossen',                '给花浇了水'),                -6],
  [20, 'bonus', L('Kept his room tidy all week','Zimmer die ganze Woche ordentlich','房间保持了一整周整洁'),     -4],
  [15, 'earn',  L('Homework done on time',    'Hausaufgaben pünktlich erledigt',  '作业按时完成'),              -1],
].forEach(([delta, type, reason, d]) => insertRewardLedger.run(leoId, delta, type, reason, null, null, alexId, isoFromNow(d, 18, 0)));

const insertRedemption = db.prepare(`
  INSERT INTO reward_redemptions (user_id, catalog_id, reward_name, reward_icon, cost, status, note, requested_by, decided_by, decided_at, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
// Emma: fulfilled ice cream trip (catalog id 2) — creates a matching spend in the ledger
const emmaRedemptionId = insertRedemption.run(
  emmaId, 2, REWARD_ICE_CREAM, '🍦', 25, 'fulfilled', null, emmaId, alexId, isoFromNow(-3, 19, 0), isoFromNow(-3, 16, 0)
).lastInsertRowid;
insertRewardLedger.run(emmaId, -25, 'redeem', REWARD_ICE_CREAM, null, emmaRedemptionId, alexId, isoFromNow(-3, 19, 0));
// Leo: pending request awaiting a parent's approval (no ledger entry yet)
insertRedemption.run(leoId, 4, REWARD_GAMING, '🎮', 40, 'pending',
  L('Please? Finished all my homework!', 'Bitte? Ich habe alle Hausaufgaben fertig!', '可以吗？作业全部写完啦！'),
  leoId, null, null, isoFromNow(-1, 17, 30));

// ── Budget: Subscriptions ────────────────────────────────────────────────────

console.log('Inserting subscriptions…');
db.prepare('UPDATE subscription_settings SET monthly_budget = ?, base_currency = ? WHERE id = 1').run(90*M, CUR);
const insertSub = db.prepare(`
  INSERT INTO budget_subscriptions
    (name, description, amount, currency, billing_cycle, cycle_interval, next_payment_date,
     category_id, payment_method_id, reminder_days, enabled, website_url, brand_color, notes,
     end_type, end_date, created_by)
  VALUES (@name, @desc, @amount, '${CUR}', @cycle, 1, @next, @cat, @pm, 3, 1, @url, @color, @notes,
          @endType, @endDate, @by)
`);
// category ids: 1 Entertainment · 2 Productivity · 3 Utilities · 4 Health · 5 Education · 6 Other
// payment methods: 1 Credit Card · 3 PayPal · 4 Apple Pay · 6 Bank Transfer
// end_type: 'never' | 'on_date' | 'after_count' (#594)
[
  ['Netflix',             L('Standard plan',           'Standard-Abo',           '标准档会员'),          17.99, 'monthly', 8,   1, 1, 'https://netflix.com',    '#E50914', L('Shared family profile', 'Gemeinsames Familienprofil', '全家共用的会员档案'), 'never',   null],
  ['Spotify Family',      L('Up to 6 accounts',        'Bis zu 6 Konten',        '最多 6 个账号'),        16.99, 'monthly', 3,   1, 3, 'https://spotify.com',    '#1DB954', null,                                                     'never',   null],
  ['Disney+',             L('Standard with ads',       'Standard mit Werbung',   '含广告标准档'),          8.99, 'monthly', 21,  1, 1, 'https://disneyplus.com', '#113CCF', L("Kids' favourites", 'Lieblingsfilme der Kinder', '孩子们的最爱'),       'never',   null],
  ['iCloud+ 2 TB',        L('Family photo & backup',   'Familienfotos & Backup', '全家照片和备份'),        9.99, 'monthly', 12,  3, 4, 'https://icloud.com',     '#3693F3', null,                                                     'never',   null],
  [L('FitLife Gym', 'FitLife Fitnessstudio', 'FitLife 健身房'), L("Linda's membership", 'Lindas Mitgliedschaft', '琼照的会员卡'), 39.00, 'monthly', 1, 4, 6, null,         '#10B981', L('Yoga + classes', 'Yoga und Kurse', '瑜伽和团课'),                    'never',   null],
  ['Microsoft 365 Family',L('Office + 1 TB each',      'Office + je 1 TB',       'Office + 每人 1 TB'),   99.00, 'yearly',  60,  2, 6, 'https://microsoft.com',  '#D83B01', L('Renews annually', 'Verlängert sich jährlich', '每年自动续费'),         'never',   null],
  ['Amazon Prime',        L('Delivery + Prime Video',  'Versand + Prime Video',  '免邮 + Prime Video'),   89.90, 'yearly',  140, 6, 1, 'https://amazon.de',      '#FF9900', null,                                                     'never',   null],
  // Ein Abo mit Ende (#594): läuft in gut vier Monaten aus und zeigt damit die
  // Ende-Bedingung, die sonst in keinem Datensatz vorkam.
  [L('Kids magazine', 'Kindermagazin', '儿童画报'), L('12-month subscription', '12-Monats-Abo', '12 个月订阅'), 4.90, 'monthly', 16, 5, 6, null, '#F97316', L('Ends after the school year', 'Endet nach dem Schuljahr', '这学期结束后到期'), 'on_date', daysFromNow(128)],
].forEach(([name, desc, amount, cycle, nextDays, cat, pm, url, color, notes, endType, endDate]) =>
  insertSub.run({ name, desc, amount: amount*M, cycle, next: daysFromNow(nextDays), cat, pm, url, color, notes, endType, endDate, by: alexId }));

// ── Reminders ────────────────────────────────────────────────────────────────

console.log('Inserting reminders…');
const insertReminder = db.prepare(`
  INSERT INTO reminders (entity_type, entity_id, remind_at, dismissed, created_by)
  VALUES (?, ?, ?, 0, ?)
`);
// Erinnerung an die dringende Stromrechnung und an den Schulausflug. Bewusst
// über die Titel-Maps statt über feste IDs: die Reihenfolge der Einfügungen
// oben darf sich ändern, ohne dass die Erinnerung still am falschen Eintrag hängt.
const reminderTaskId = taskIdByTitle[L('Pay electricity bill', 'Stromrechnung bezahlen', '交电费')];
const reminderEventId = eventIdByTitle[L('Science Museum Field Trip', 'Ausflug ins Naturkundemuseum', '科技馆春游')];
if (reminderTaskId) insertReminder.run('task', reminderTaskId, isoFromNow(2, 8, 0), alexId);
if (reminderEventId) insertReminder.run('event', reminderEventId, isoFromNow(1, 7, 30), lindaId);

// ── Done ─────────────────────────────────────────────────────────────────────

db.pragma('wal_checkpoint(TRUNCATE)');
db.close();
console.log('\n✓ Demo data inserted successfully!');
console.log('  Admin login:  alex  / demo1234   (dad)');
console.log('  Admin login:  linda / demo1234   (mom — screenshot persona, has health/cycle data)');
console.log('  Member login: emma, leo, maria   / demo1234');
