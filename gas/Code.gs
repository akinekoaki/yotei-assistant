/**
 * メール予定アシスタント — Google Apps Script 本体
 *
 * - 一定間隔（既定 1 時間）で Gmail と Google Classroom を確認
 * - 「ルール」（差出人・キーワード・読み取り方・追加先など）ごとにメール／お知らせを読み取る
 *     読み取り方 date  … 本文から日付・時刻を自動で拾う
 *     読み取り方 kyuko … 「■ 専攻」「【休講】【補講】」形式の案内を読む（変更前／変更後も区別）
 * - アプリ（PWA）と Scriptable ウィジェット用の JSON API を提供
 */

// ▼▼▼ 中継GASを使う人だけ ▼▼▼
// 中継GASの URL と SYNC_KEY を、それぞれ '' の中に貼り付けて保存 → setupRelay を実行
// （setupRelay を実行すると保存されるので、そのあとは消しても、Code.gs を新しくしても大丈夫）
const RELAY_URL = '';
const RELAY_KEY = '';
// ▲▲▲ ここまで ▲▲▲

const TZ = 'Asia/Tokyo';
const MAX_ITEMS = 80;
const SEARCH_DAYS = 7;   // Gmail は直近この日数を検索（処理済みはメール 1 通ごとに記録）

/** 休講・補講ルールのひな形（アプリの「休講・補講のルールを追加」と同じ） */
const KYUKO_TEMPLATE = {
  name: '休講・補講', mode: 'kyuko', keywords: [], from: '',
  gmail: true, classroom: true, autoAdd: true, remind: true, major: '', periods: ''
};

const DEFAULT_SETTINGS = {
  rules: null,                              // null のときは getSettings_ で初期ルールを作る
  courseWork: { on: true, autoAdd: false }, // Classroom の期限付き課題を拾う
  calendarId: '',                           // 既定の追加先（空なら既定のカレンダー）
  interval: 60,                             // 分（30 / 60 / 180）
  notify: true                              // ウィジェット（Scriptable）で新着を通知
};

function defaultRules_() {
  return [normalizeRule_({
    id: 'r_default', name: '締切・テスト', mode: 'date',
    keywords: ['締切', '提出期限', 'テスト', '面談', '説明会']
  })];
}

/** ルールの項目をそろえる（アプリから届いた値の整形にも使う） */
function normalizeRule_(r) {
  r = r || {};
  const list = v => Array.isArray(v) ? v.map(x => String(x).trim()).filter(Boolean) : splitList_(v);
  return {
    id: String(r.id || ('r' + Utilities.getUuid().replace(/-/g, '').slice(0, 8))),
    name: String(r.name || 'ルール').slice(0, 40),
    on: r.on !== false,
    mode: r.mode === 'kyuko' ? 'kyuko' : 'date',
    from: list(r.from).join(', '),
    keywords: list(r.keywords),
    gmail: r.gmail !== false,
    classroom: r.classroom !== false,
    calendarId: String(r.calendarId || ''),
    autoAdd: !!r.autoAdd,
    remind: r.remind !== false,
    major: String(r.major || '').trim(),
    periods: String(r.periods || '')
  };
}

// ================================================================
// 初回セットアップ（エディタから 1 回だけ実行）
// ================================================================
function setup() {
  const p = PropertiesService.getScriptProperties();
  if (!p.getProperty('TOKEN')) p.setProperty('TOKEN', Utilities.getUuid().replace(/-/g, ''));
  saveJson_('settings', getSettings_());
  setTrigger_(getSettings_().interval);
  checkMail();
  Logger.log('TOKEN: ' + p.getProperty('TOKEN'));
  Logger.log('アプリの接続画面に、デプロイした URL と上の TOKEN を入れてください');
}

// ================================================================
// 中継GAS（公開用のアカウント）との同期
//   メインのアカウント（学校・会社など）で Web アプリを「全員」に公開できないときに使う。
//   プロジェクトの設定 > スクリプト プロパティ に RELAY_URL と RELAY_KEY を入れてから setupRelay を実行。
// ================================================================
function setupRelay() {
  const p = PropertiesService.getScriptProperties();
  // Code.gs の一番上に貼られた値を保存する（前後の空白は取り除く）
  const url = String(RELAY_URL || '').trim(), key = String(RELAY_KEY || '').trim();
  if (url) {
    if (!/^https:\/\/script\.google\.com\/.+\/exec$/.test(url)) {
      throw new Error('RELAY_URL の形が違います。中継GASをデプロイしたときの「…/exec」で終わる URL を貼ってください');
    }
    p.setProperty('RELAY_URL', url);
  }
  if (key) {
    if (!/^[0-9a-f]{32}$/.test(key)) {
      throw new Error('RELAY_KEY の形が違います。中継GASのログの「本体GAS用 SYNC_KEY:」のあとの32文字だけを貼ってください');
    }
    p.setProperty('RELAY_KEY', key);
  }
  if (!p.getProperty('RELAY_URL') || !p.getProperty('RELAY_KEY')) {
    throw new Error('Code.gs の一番上の RELAY_URL と RELAY_KEY の \'\' の中に、中継GASの URL と SYNC_KEY を貼って保存してから実行してください');
  }
  if (!p.getProperty('TOKEN')) throw new Error('先に setup を実行してください');
  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === 'syncRelay')
    .forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('syncRelay').timeBased().everyMinutes(5).create();
  syncRelay();
  Logger.log('中継GASと同期できました。以後 5 分ごとに同期します');
}

function syncRelay() {
  const p = PropertiesService.getScriptProperties();
  const url = p.getProperty('RELAY_URL'), key = p.getProperty('RELAY_KEY');
  if (!url || !key) return;
  const commands = pushToRelay_(url, key);
  if (!commands.length) return;

  const token = p.getProperty('TOKEN');
  const errors = [];
  commands.forEach(c => {
    try {
      if (c.op === 'add') api_add(token, c.id, c.patch || {});
      else if (c.op === 'ignore') api_ignore(token, c.id);
      else if (c.op === 'saveSettings') api_saveSettings(token, c.settings || {});
      else if (c.op === 'checkNow') checkMail();
    } catch (e) {
      errors.push('アプリからの操作（' + c.op + '）: ' + e.message);
    }
  });
  if (errors.length) saveJson_('errors', loadJson_('errors', []).concat(errors).slice(-10));
  pushToRelay_(url, key); // 実行結果をすぐ反映
}

/** 状態を中継GASに送り、たまっている操作を受け取る */
function pushToRelay_(url, key) {
  const token = PropertiesService.getScriptProperties().getProperty('TOKEN');
  const res = UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'text/plain;charset=utf-8',
    payload: JSON.stringify({ op: 'sync', key: key, state: api_getState(token), widget: widgetData_() }),
    followRedirects: true,
    muteHttpExceptions: true
  });
  let j;
  try { j = JSON.parse(res.getContentText()); }
  catch (e) { throw new Error('中継GASから正しい返事がありません（' + res.getResponseCode() + '）。RELAY_URL と中継GASのデプロイ設定を確認してください'); }
  if (!j.ok) throw new Error('中継GAS: ' + j.error);
  return j.data.commands || [];
}

// ================================================================
// 定期実行：メール確認
// ================================================================
function checkMail() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) return;
  try {
    const s = getSettings_();
    const rules = s.rules.filter(r => r.on);
    const items = loadJson_('items', []);
    const now = Date.now();
    const since = new Date(loadJson_('lastCheck', now - 7 * 864e5));
    const errors = [];
    const found = [];

    if (rules.some(r => r.gmail)) {
      try { found.push.apply(found, scanGmail_(rules, errors)); }
      catch (e) { errors.push('Gmail: ' + e.message); }
    }
    if (s.courseWork.on || rules.some(r => r.classroom)) {
      try { found.push.apply(found, scanClassroom_(s, rules, since, errors)); }
      catch (e) { errors.push('Classroom: ' + e.message); }
    }

    found.forEach(f => upsert_(items, f, s));
    saveItems_(items);
    saveJson_('lastCheck', now);
    saveJson_('errors', errors);
  } finally {
    lock.releaseLock();
  }
}

// ---------------- Gmail ----------------
// 毎日同じ件名のメールは 1 つのスレッドにまとまるため、処理済みはメール 1 通ごとに記録する
function scanGmail_(rules, errors) {
  const seen = loadJson_('seen', []);
  const seenSet = new Set(seen);
  const oldest = Date.now() - (SEARCH_DAYS + 1) * 864e5;
  const out = [];

  rules.filter(r => r.gmail).forEach(r => {   // 上のルールが優先
    const q = gmailQuery_(r);
    if (!q) return;
    let threads;
    try { threads = GmailApp.search(q, 0, 30); }
    catch (e) { errors.push('Gmail（' + r.name + '）: ' + e.message); return; }

    threads.forEach(th => th.getMessages().forEach(m => {
      const id = m.getId();
      if (seenSet.has(id) || m.getDate().getTime() < oldest) return;
      if (!fromMatches_(r, m.getFrom())) return;
      const subject = m.getSubject() || '';
      const text = normalize_(subject + '\n' + (m.getPlainBody() || '').slice(0, 20000));
      const res = readByRule_(r, text, m.getDate(), cleanSubject_(subject));
      if (res === null) return;          // このルールには当てはまらない
      seenSet.add(id); seen.push(id);
      res.forEach(f => out.push(Object.assign(f, { id: f.id || 'gm_' + id }, ruleOpt_(r), {
        source: 'gmail', from: m.getFrom(),
        link: 'https://mail.google.com/mail/u/0/#all/' + th.getId(),
        receivedAt: m.getDate().getTime()
      })));
    }));
  });
  saveJson_('seen', seen.slice(-1000));
  return out;
}

function gmailQuery_(r) {
  const parts = ['newer_than:' + SEARCH_DAYS + 'd', '-in:sent', '-in:chats'];
  const froms = splitList_(r.from).map(x => x.replace(/^@/, ''));
  if (froms.length) parts.push('from:(' + froms.join(' OR ') + ')');
  const kws = r.keywords.map(k => '"' + k.replace(/"/g, '') + '"');
  if (r.mode === 'kyuko') {
    parts.push('"休講" "補講"');
  } else if (kws.length) {
    parts.push('(' + kws.join(' OR ') + ')');
  } else if (!froms.length) {
    return null; // 差出人もキーワードもないルールは広すぎるので読まない
  }
  return parts.join(' ');
}

function fromMatches_(r, from) {
  const list = splitList_(r.from);
  if (!list.length) return true;
  const f = String(from || '').toLowerCase();
  return list.some(x => f.indexOf(x.toLowerCase()) >= 0);
}

/**
 * ルールで本文を読む。当てはまらなければ null、当てはまれば予定の配列（0 件もありうる）
 */
function readByRule_(r, text, base, fallbackTitle) {
  if (r.mode === 'kyuko') {
    if (!isKyukoNotice_(text)) return null;
    return parseKyuko_(text, r, base);
  }
  if (isKyukoNotice_(text)) return null; // 休講・補講の案内は休講・補講ルールに任せる
  let kw = null;
  if (r.keywords.length) {
    kw = r.keywords.find(k => text.indexOf(k) >= 0);
    if (!kw) return null;
  }
  const dt = findDateNear_(text, kw ? text.indexOf(kw) : 0, base);
  return [{
    title: fallbackTitle || kw || r.name,
    keyword: kw || r.name,
    snippet: excerpt_(text, kw || ''),
    date: dt.date,
    time: dt.time
  }];
}

function ruleOpt_(r) {
  return { ruleId: r.id, ruleName: r.name, calendarId: r.calendarId, autoAdd: r.autoAdd, remind: r.remind };
}

// ---------------- 休講・補講（■ 専攻 /【休講】【補講】形式） ----------------
function isKyukoNotice_(text) {
  return /■/.test(text) && /【(休講|補講)】/.test(text);
}

/**
 * 例：
 *   ■ 〇〇専攻1年
 *   科目：プログラミング基礎 (山田 先生)
 *   ・【休講】10/20 (1限, 2限) 教室: 101
 *   ⬇️
 *   ・【補講】10/21 (1限, 2限) 教室: 201
 * rule.major が空ならすべての専攻の欄を読む
 */
function parseKyuko_(text, rule, base) {
  const out = [];
  const major = String(rule.major || '').replace(/\s/g, '');
  const baseStr = Utilities.formatDate(base, TZ, 'yyyy-MM-dd');
  const [by, bm, bd] = baseStr.split('-').map(Number);
  const periodTable = parsePeriods_(rule.periods);

  let inMajor = false, section = '', subject = '', teacher = '', lastKyuko = '';
  text.split('\n').forEach(raw => {
    const line = raw.trim();
    if (/^■/.test(line)) {
      section = line.replace(/^■\s*/, '');
      inMajor = !major || line.replace(/[■\s]/g, '').indexOf(major) >= 0;
      subject = ''; teacher = ''; lastKyuko = '';
      return;
    }
    if (!inMajor) return;

    const sm = line.match(/^科目[:：]\s*(.+?)\s*(?:[（(]\s*([^（()）]*?)\s*先生\s*[)）])?\s*$/);
    if (sm) { subject = sm[1]; teacher = sm[2] || ''; lastKyuko = ''; return; }

    const em = line.match(/【(休講|補講)】\s*(\d{1,2})\s*\/\s*(\d{1,2})\s*(?:[（(]([^)）]*)[)）])?\s*(?:教室[:：]\s*(.+))?/);
    if (!em || !subject || /テスト配信/.test(subject)) return;

    const type = em[1], mo = Number(em[2]), da = Number(em[3]);
    let y = by;
    if (new Date(y, mo - 1, da) < new Date(by, bm - 1, bd - 60)) y += 1; // 年またぎ
    const periods = (em[4] || '').match(/\d+/g) || [];
    const room = (em[5] || '').trim();
    const date = ymd_(y, mo, da);

    // 「同じ予定」を見分けるための枠：休講は科目＋日付、補講は科目＋どの休講の振替か
    let slot;
    if (type === '休講') { slot = '休講|' + section + '|' + subject + '|' + date; lastKyuko = date; }
    else slot = '補講|' + section + '|' + subject + '|' + (lastKyuko ? 'after:' + lastKyuko : date);

    // 時限表があれば時間帯の予定、なければ終日
    let time = null, endTime = null;
    if (periods.length && periods.every(p => periodTable[p])) {
      time = periodTable[periods[0]].start;
      endTime = periodTable[periods[periods.length - 1]].end;
    }
    const pLabel = periods.length ? periods.join('・') + '限' : '';
    out.push({
      id: 'kk_' + Utilities.base64EncodeWebSafe(Utilities.computeDigest(Utilities.DigestAlgorithm.MD5,
        [type, section, subject, date, periods.join(','), room].join('|'), Utilities.Charset.UTF_8)).replace(/=+$/, ''),
      kind: 'kyuko',
      slot: slot,
      title: '【' + type + '】' + subject + '（' + [pLabel, room].filter(Boolean).join('・') + '）',
      keyword: type,
      snippet: (major ? '' : section + ' / ') + '科目：' + subject + (teacher ? '（' + teacher + ' 先生）' : '') + ' / ' + line.replace(/^・/, ''),
      date: date, time: time, endTime: endTime
    });
  });
  return out;
}

/** 「1限 9:10-10:40」形式の時限表 → { '1': {start:'09:10', end:'10:40'} } */
function parsePeriods_(s) {
  const t = {};
  const re = /(\d+)\s*限\s*(\d{1,2})\s*:\s*(\d{2})\s*[-~〜～ー－]\s*(\d{1,2})\s*:\s*(\d{2})/g;
  let m;
  while ((m = re.exec(normalize_(s || '')))) {
    t[m[1]] = { start: pad_(Number(m[2])) + ':' + m[3], end: pad_(Number(m[4])) + ':' + m[5] };
  }
  return t;
}

// ---------------- Google Classroom ----------------
function scanClassroom_(s, rules, since, errors) {
  const out = [];
  const crRules = rules.filter(r => r.classroom);
  const courses = Classroom.Courses.list({ courseStates: ['ACTIVE'], pageSize: 50 }).courses || [];
  courses.forEach(c => {
    // 期限つきの課題
    if (s.courseWork.on) {
      try {
        const works = Classroom.Courses.CourseWork.list(c.id, { pageSize: 20, orderBy: 'updateTime desc' }).courseWork || [];
        works.forEach(w => {
          if (!w.dueDate || new Date(w.updateTime) <= since) return;
          const dt = dueToJst_(w.dueDate, w.dueTime);
          const text = normalize_((w.title || '') + '\n' + (w.description || ''));
          out.push({
            id: 'cw_' + w.id, source: 'classroom',
            title: c.name + ' ' + (w.title || '課題'),
            from: c.name, keyword: '課題の期限', snippet: excerpt_(text, ''),
            date: dt.date, time: dt.time, link: w.alternateLink,
            receivedAt: new Date(w.updateTime).getTime(),
            ruleName: 'Classroom の課題', calendarId: s.calendarId, autoAdd: !!s.courseWork.autoAdd, remind: true
          });
        });
      } catch (e) { errors.push('Classroom 課題（' + c.name + '）: ' + e.message); }
    }

    // お知らせ：上のルールから順に当てはめる
    if (!crRules.length) return;
    try {
      const anns = Classroom.Courses.Announcements.list(c.id, { pageSize: 20 }).announcements || [];
      anns.forEach(a => {
        if (new Date(a.updateTime) <= since) return;
        const text = normalize_(a.text || '');
        for (let i = 0; i < crRules.length; i++) {
          const r = crRules[i];
          const res = readByRule_(r, text, new Date(a.creationTime), c.name + ' ' + firstLine_(text));
          if (res === null) continue;
          res.forEach(f => out.push(Object.assign(f, { id: f.id || 'an_' + a.id }, ruleOpt_(r), {
            source: 'classroom', from: c.name, link: a.alternateLink,
            receivedAt: new Date(a.updateTime).getTime()
          })));
          break;
        }
      });
    } catch (e) { errors.push('Classroom お知らせ（' + c.name + '）: ' + e.message); }
  });
  return out;
}

function dueToJst_(dueDate, dueTime) {
  if (!dueTime) {
    return { date: ymd_(dueDate.year, dueDate.month, dueDate.day), time: null };
  }
  const d = new Date(Date.UTC(dueDate.year, dueDate.month - 1, dueDate.day, dueTime.hours || 0, dueTime.minutes || 0));
  return { date: Utilities.formatDate(d, TZ, 'yyyy-MM-dd'), time: Utilities.formatDate(d, TZ, 'HH:mm') };
}

// ================================================================
// 日付・時刻のルール抽出
// ================================================================
function normalize_(s) {
  return String(s)
    .replace(/[０-９]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
    .replace(/／/g, '/').replace(/：/g, ':').replace(/　/g, ' ');
}

/** テキスト中の日付をすべて拾う → [{index, date:'yyyy-MM-dd', time:'HH:mm'|null}] */
function findDates_(text, base) {
  const res = [];
  const baseStr = Utilities.formatDate(base, TZ, 'yyyy-MM-dd');
  const [by, bm, bd] = baseStr.split('-').map(Number);
  const baseDay = new Date(by, bm - 1, bd);

  // 2026年11月28日 / 2026/11/28 / 11月28日 / 11/28（土）
  const re = /(?:(\d{4})\s*[年\/\-.]\s*)?(\d{1,2})\s*(?:月|\/)\s*(\d{1,2})\s*日?(?:\s*[（(][日月火水木金土祝・]+[)）])?/g;
  let m;
  while ((m = re.exec(text))) {
    const mo = Number(m[2]), da = Number(m[3]);
    if (mo < 1 || mo > 12 || da < 1 || da > 31) continue;
    let y = m[1] ? Number(m[1]) : by;
    if (!m[1] && new Date(y, mo - 1, da) < new Date(by, bm - 1, bd - 60)) y += 1; // 年またぎ
    res.push({ index: m.index, date: ymd_(y, mo, da), time: timeAfter_(text, m.index + m[0].length) });
  }

  // 今日・本日・明日・明後日
  const rel = { '本日': 0, '今日': 0, '明日': 1, '明後日': 2, 'あさって': 2 };
  const re2 = /(明後日|あさって|本日|今日|明日)/g;
  while ((m = re2.exec(text))) {
    const d = new Date(baseDay.getFullYear(), baseDay.getMonth(), baseDay.getDate() + rel[m[1]]);
    res.push({ index: m.index, date: ymd_(d.getFullYear(), d.getMonth() + 1, d.getDate()), time: timeAfter_(text, m.index + m[0].length) });
  }
  return res;
}

/** 日付の直後（10 文字以内）にある時刻：23:59 / 16時 / 午後4時30分 / 9時半 */
function timeAfter_(text, from) {
  const rest = text.slice(from, from + 24);
  const m = rest.match(/^[^\n\d]{0,10}?(午前|午後|AM|PM)?\s*(\d{1,2})(?:\s*:\s*(\d{2})|\s*時\s*(?:(\d{1,2})\s*分|(半))?)/i);
  if (!m) return null;
  let h = Number(m[2]);
  const min = m[3] ? Number(m[3]) : m[4] ? Number(m[4]) : m[5] ? 30 : 0;
  if (/午後|PM/i.test(m[1] || '') && h < 12) h += 12;
  if (h > 24 || min > 59) return null;
  if (h === 24) return '23:59';
  return pad_(h) + ':' + pad_(min);
}

/** キーワードの位置にいちばん近い日付を返す */
function findDateNear_(text, pos, base) {
  const all = findDates_(text, base);
  if (!all.length) return { date: null, time: null };
  all.sort((a, b) => Math.abs(a.index - pos) - Math.abs(b.index - pos));
  return { date: all[0].date, time: all[0].time };
}

// ================================================================
// アイテム管理・カレンダー
// ================================================================
function upsert_(items, f, s) {
  const ex = items.find(i => i.id === f.id);
  if (ex) {
    if (ex.status === 'pending' && ex.kind !== 'kyuko') Object.assign(ex, { title: f.title, date: f.date, time: f.time, snippet: f.snippet });
    return;
  }
  const auto = !!f.autoAdd;
  const it = Object.assign({ status: 'pending', foundAt: Date.now(), isNew: true }, f);
  delete it.autoAdd;

  // 休講・補講の変更：同じ枠（slot）で内容が違うものが届いたら、前の予定を「変更前」にする
  if (it.kind === 'kyuko' && it.slot) {
    const prev = items.find(i => i.kind === 'kyuko' && i.slot === it.slot && i.status !== 'replaced');
    if (prev) {
      it.title = '【変更後】' + it.title;
      it.changedFrom = prev.title.replace(/^【変更後】/, '') + ' ' + prev.date;
      markReplaced_(prev, it);
    }
  }
  items.unshift(it);
  if (auto && it.date) {
    try { addToCalendar_(it, { calendarId: it.calendarId || s.calendarId, remind: it.remind !== false }); }
    catch (e) { it.error = e.message; }
  }
}

/** 前の予定を「変更前」にする（カレンダー登録済みならタイトル・色・説明も変える） */
function markReplaced_(prev, next) {
  const wasPending = prev.status === 'pending';
  prev.status = 'replaced';
  prev.isNew = false;
  prev.replacedBy = next.id;
  prev.addedAt = prev.addedAt || Date.now();
  if (wasPending || !prev.eventId) return;
  try {
    const cal = (prev.calendarId && CalendarApp.getCalendarById(prev.calendarId)) || CalendarApp.getDefaultCalendar();
    const ev = cal.getEventById(prev.eventId) || CalendarApp.getEventById(prev.eventId);
    if (!ev) return;
    ev.setTitle('【変更前】' + ev.getTitle().replace(/^【変更(前|後)】/, ''));
    ev.setColor(CalendarApp.EventColor.GRAY);
    ev.setDescription('⚠️ この予定は変更されました。\n変更後: ' + next.title.replace(/^【変更後】/, '') + ' ' + next.date +
      '\n\n' + (ev.getDescription() || ''));
  } catch (e) {
    prev.error = '変更前の予定を更新できませんでした: ' + e.message;
  }
}

function saveItems_(items) {
  const pending = items.filter(i => i.status === 'pending');
  const done = items.filter(i => i.status !== 'pending')
    .sort((a, b) => (b.addedAt || b.foundAt) - (a.addedAt || a.foundAt));
  saveJson_('items', pending.concat(done).slice(0, MAX_ITEMS));
}

function addToCalendar_(it, opt) {
  const cal = (opt.calendarId && CalendarApp.getCalendarById(opt.calendarId)) || CalendarApp.getDefaultCalendar();
  const [y, m, d] = it.date.split('-').map(Number);
  const desc = (it.changedFrom ? '🔁 変更後の予定です（変更前: ' + it.changedFrom + '）\n\n' : '') + [
    '出典: ' + (it.source === 'gmail' ? 'Gmail' : 'Google Classroom') + ' / ' + (it.from || ''),
    'ルール: ' + (it.ruleName || '') + ' / 一致: ' + it.keyword, '', it.snippet || '', '', it.link || ''
  ].join('\n');

  let ev, start;
  if (it.time) {
    const [hh, mm] = it.time.split(':').map(Number);
    start = new Date(y, m - 1, d, hh, mm);
    let end = new Date(start.getTime() + 30 * 60000);
    if (it.endTime) {
      const [eh, em] = it.endTime.split(':').map(Number);
      const e = new Date(y, m - 1, d, eh, em);
      if (e > start) end = e;
    }
    ev = cal.createEvent(it.title, start, end, { description: desc });
  } else {
    start = new Date(y, m - 1, d);
    ev = cal.createAllDayEvent(it.title, start, { description: desc });
  }
  if (it.changedFrom) ev.setColor(CalendarApp.EventColor.ORANGE);
  if (opt.remind) {
    const minutes = Math.round((start - new Date(y, m - 1, d - 1, 20, 0)) / 60000); // 前日 20:00
    ev.removeAllReminders();
    if (minutes > 0 && minutes <= 40320) ev.addPopupReminder(minutes);
  }
  it.status = 'added';
  it.isNew = false;
  it.eventId = ev.getId();
  it.calendarId = cal.getId();
  it.calendarName = cal.getName();
  it.addedAt = Date.now();
}

// ================================================================
// Web アプリ（API のみ。画面はアプリ＝PWA）
// ================================================================
function doGet(e) {
  const p = (e && e.parameter) || {};
  if (!validToken_(p.t)) return ContentService.createTextOutput('アクセスできません');
  if (p.api === 'widget') return json_(widgetData_());
  return ContentService.createTextOutput('この URL はアプリ用です。アプリ（PWA）の接続画面に入れてください');
}

// ---- アプリ・ウィジェットから呼ぶ API（POST、本文は JSON 文字列）----
function doPost(e) {
  let req;
  try { req = JSON.parse(e.postData.contents); }
  catch (err) { return json_({ ok: false, error: 'リクエストの形式が正しくありません' }); }
  try {
    assertToken_(req.t);
    let data;
    switch (req.op) {
      case 'state':        data = api_getState(req.t); break;
      case 'add':          data = api_add(req.t, req.id, req.patch || {}); break;
      case 'ignore':       data = api_ignore(req.t, req.id); break;
      case 'saveSettings': data = api_saveSettings(req.t, req.settings || {}); break;
      case 'checkNow':     data = api_checkNow(req.t); break;
      default: throw new Error('不明な操作です: ' + req.op);
    }
    return json_({ ok: true, data: data });
  } catch (err) {
    return json_({ ok: false, error: err.message });
  }
}
function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function api_getState(token) {
  assertToken_(token);
  const s = getSettings_();
  const lastCheck = loadJson_('lastCheck', null);
  let calendars = [];
  try { calendars = CalendarApp.getAllOwnedCalendars().map(c => ({ id: c.getId(), name: c.getName() })); } catch (e) {}
  return {
    settings: s,
    items: loadJson_('items', []),
    lastCheck: lastCheck,
    nextCheck: lastCheck ? lastCheck + s.interval * 60000 : null,
    errors: loadJson_('errors', []),
    account: Session.getEffectiveUser().getEmail(),
    defaultCalendarId: CalendarApp.getDefaultCalendar().getId(),
    calendars: calendars,
    kyukoTemplate: KYUKO_TEMPLATE,
    widgetUrl: ScriptApp.getService().getUrl() + '?t=' + token + '&api=widget'
  };
}

function api_add(token, id, patch) {
  assertToken_(token);
  patch = patch || {};
  return withItems_(items => {
    const it = items.find(i => i.id === id);
    if (!it) throw new Error('予定が見つかりません');
    if (it.status === 'added') return it;
    ['title', 'date', 'time'].forEach(k => { if (patch[k] !== undefined) it[k] = patch[k] || null; });
    if (!it.date) throw new Error('日付が読み取れていません。アプリで日付を入力してから追加してください');
    const s = getSettings_();
    addToCalendar_(it, {
      calendarId: patch.calendarId !== undefined ? patch.calendarId : (it.calendarId || s.calendarId),
      remind: patch.remind !== undefined ? patch.remind : it.remind !== false
    });
    return it;
  });
}

function api_ignore(token, id) {
  assertToken_(token);
  return withItems_(items => {
    const it = items.find(i => i.id === id);
    if (!it) throw new Error('予定が見つかりません');
    it.status = 'ignored';
    it.isNew = false;
    it.addedAt = Date.now();
    return it;
  });
}

function api_saveSettings(token, patch) {
  assertToken_(token);
  const old = getSettings_();
  const next = Object.assign({}, old, patch || {});
  next.interval = [30, 60, 180].indexOf(Number(next.interval)) >= 0 ? Number(next.interval) : 60;
  next.rules = (Array.isArray(next.rules) ? next.rules : old.rules).map(normalizeRule_);
  next.courseWork = Object.assign({}, DEFAULT_SETTINGS.courseWork, next.courseWork || {});
  saveJson_('settings', next);
  if (next.interval !== old.interval) setTrigger_(next.interval);
  return next;
}

function api_checkNow(token) {
  assertToken_(token);
  checkMail();
  return api_getState(token);
}

// ---- ウィジェット用データ ----
function widgetData_() {
  const s = getSettings_();
  const items = loadJson_('items', []);
  const today = Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd');
  const week = Utilities.formatDate(new Date(Date.now() + 7 * 864e5), TZ, 'yyyy-MM-dd');
  const byDate = (a, b) => (a.date || '9999') + (a.time || '') < (b.date || '9999') + (b.time || '') ? -1 : 1;
  const pick = i => ({ id: i.id, title: i.title, date: i.date, time: i.time, source: i.source, keyword: i.keyword });
  const lastCheck = loadJson_('lastCheck', null);
  return {
    lastCheck: lastCheck,
    nextCheck: lastCheck ? lastCheck + s.interval * 60000 : null,
    notify: s.notify,
    pending: items.filter(i => i.status === 'pending').sort(byDate).map(pick),
    upcoming: items.filter(i => i.status === 'added' && i.date >= today && i.date <= week).sort(byDate).map(pick)
  };
}

// ================================================================
// 設定（旧バージョンの設定は自動でルールに置き換える）
// ================================================================
function getSettings_() {
  const s = loadJson_('settings', {}) || {};
  const merged = Object.assign({}, DEFAULT_SETTINGS, s);
  merged.courseWork = Object.assign({}, DEFAULT_SETTINGS.courseWork, s.courseWork || {});

  if (!Array.isArray(s.rules)) {
    const rules = [];
    if (Array.isArray(s.keywords)) {
      const src = s.sources || {};
      rules.push(normalizeRule_({
        id: 'r_default', name: 'キーワード', mode: 'date',
        keywords: s.keywords.filter(k => k.on).map(k => k.text),
        from: src.gmailAll ? '' : (src.schoolDomain || ''),
        gmail: !!(src.gmailAll || (src.gmailSchool && src.schoolDomain)),
        classroom: src.classroom !== false,
        calendarId: s.calendarId || '', autoAdd: !!s.autoAdd, remind: s.remind !== false
      }));
      merged.courseWork.on = src.classroom !== false;
    } else {
      rules.push.apply(rules, defaultRules_());
    }
    if (s.kyuko && s.kyuko.on) {
      rules.push(normalizeRule_(Object.assign({}, KYUKO_TEMPLATE, {
        id: 'r_kyuko', major: s.kyuko.major || '', periods: s.kyuko.periods || '', autoAdd: s.kyuko.autoAdd !== false
      })));
    }
    merged.rules = rules;
  } else {
    merged.rules = s.rules.map(normalizeRule_);
  }
  ['keywords', 'sources', 'autoAdd', 'remind', 'kyuko'].forEach(k => delete merged[k]);
  return merged;
}

// ================================================================
// ユーティリティ
// ================================================================
function withItems_(fn) {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const items = loadJson_('items', []);
    const r = fn(items);
    saveItems_(items);
    return r;
  } finally { lock.releaseLock(); }
}

function setTrigger_(interval) {
  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === 'checkMail')
    .forEach(t => ScriptApp.deleteTrigger(t));
  const b = ScriptApp.newTrigger('checkMail').timeBased();
  if (interval === 30) b.everyMinutes(30);
  else if (interval === 180) b.everyHours(3);
  else b.everyHours(1);
  b.create();
}

function validToken_(t) {
  const tok = PropertiesService.getScriptProperties().getProperty('TOKEN');
  return !!tok && t === tok;
}
function assertToken_(t) { if (!validToken_(t)) throw new Error('アクセスできません'); }

/** スクリプトプロパティは 1 値 9KB までなので、分割して保存する */
function saveJson_(key, obj) {
  const p = PropertiesService.getScriptProperties();
  const s = JSON.stringify(obj);
  const size = 2000;
  const n = Math.max(1, Math.ceil(s.length / size));
  const old = Number(p.getProperty(key + '#n') || 0);
  const props = {};
  props[key + '#n'] = String(n);
  for (let i = 0; i < n; i++) props[key + '#' + i] = s.slice(i * size, (i + 1) * size);
  p.setProperties(props);
  for (let i = n; i < old; i++) p.deleteProperty(key + '#' + i);
}
function loadJson_(key, def) {
  const p = PropertiesService.getScriptProperties();
  const n = Number(p.getProperty(key + '#n') || 0);
  if (!n) return def;
  let s = '';
  for (let i = 0; i < n; i++) s += p.getProperty(key + '#' + i) || '';
  try { return JSON.parse(s); } catch (e) { return def; }
}

function splitList_(s) { return String(s || '').split(/[,、，\s]+/).map(x => x.trim()).filter(Boolean); }
function cleanSubject_(s) { return String(s).replace(/^\s*((re|fw|fwd)\s*:\s*)+/i, '').trim(); }
function firstLine_(s) { const l = String(s).split('\n').find(x => x.trim()) || 'お知らせ'; return l.trim().slice(0, 40); }
function excerpt_(text, kw) {
  const i = Math.max(0, kw ? text.indexOf(kw) : 0);
  return text.slice(Math.max(0, i - 40), i + 80).replace(/\s+/g, ' ').trim();
}
function pad_(n) { return ('0' + n).slice(-2); }
function ymd_(y, m, d) { return y + '-' + pad_(m) + '-' + pad_(d); }
