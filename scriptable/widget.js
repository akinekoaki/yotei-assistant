// メール予定アシスタント — iPhone ウィジェット（Scriptable 用）
//
// 使い方：アプリの「設定 > ウィジェット」にある URL を下の WIDGET_URL に貼り付ける。
// ウィジェットのパラメータ（長押し > ウィジェットを編集 > Parameter）
//   空欄  … 次の予定（小）／新しく見つかった予定（中・大）
//   count … 未確認の件数（小）

const WIDGET_URL = 'ここに設定画面の URL を貼り付け（…/exec?t=…&api=widget）';

// ------------------------------------------------------------
const EXEC_URL = WIDGET_URL.split('?')[0];
const TOKEN = (WIDGET_URL.match(/[?&]t=([^&#]+)/) || [])[1] || '';
const C = {
  bg:        Color.dynamic(new Color('#F4FBFA'), new Color('#0E1514')),
  primary:   Color.dynamic(new Color('#006A6A'), new Color('#4CDADA')),
  text:      Color.dynamic(new Color('#161D1D'), new Color('#DDE4E3')),
  sub:       Color.dynamic(new Color('#3F4948'), new Color('#BEC9C8')),
  container: Color.dynamic(new Color('#CCE8E7'), new Color('#324B4B')),
};
const WD = ['日', '月', '火', '水', '木', '金', '土'];
const fm = FileManager.local();
const CACHE = fm.joinPath(fm.documentsDirectory(), 'mail-schedule-cache.json');
const SEEN = fm.joinPath(fm.documentsDirectory(), 'mail-schedule-seen.json');

function parseDate(d) { const [y, m, day] = d.split('-').map(Number); return new Date(y, m - 1, day); }
function fmtDate(d, t) {
  if (!d) return '日付不明';
  const dt = parseDate(d);
  return `${dt.getMonth() + 1}/${dt.getDate()}(${WD[dt.getDay()]})${t ? ' ' + t : ''}`;
}
function daysLeft(d) {
  if (!d) return '';
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const n = Math.round((parseDate(d) - today) / 864e5);
  return n < 0 ? '期限切れ' : n === 0 ? '今日' : n === 1 ? '明日' : `あと${n}日`;
}
function hm(ms) { if (!ms) return '—'; const d = new Date(ms); return `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`; }
// ボタンは Safari ではなく Scriptable でこのスクリプトを実行して処理する
function actionUrl(action, id) {
  return `scriptable:///run/${encodeURIComponent(Script.name())}?action=${action}&id=${encodeURIComponent(id)}`;
}

async function load() {
  try {
    const r = new Request(WIDGET_URL);
    r.timeoutInterval = 20;
    const d = await r.loadJSON();
    if (!d || !Array.isArray(d.pending)) throw new Error('bad response');
    fm.writeString(CACHE, JSON.stringify(d));
    return d;
  } catch (e) {
    if (fm.fileExists(CACHE)) { const d = JSON.parse(fm.readString(CACHE)); d.offline = true; return d; }
    return null;
  }
}

// 新しく見つかった予定があればローカル通知
async function notifyNew(d) {
  if (!d.notify || d.offline) return;
  const seen = fm.fileExists(SEEN) ? JSON.parse(fm.readString(SEEN)) : null;
  const ids = d.pending.map(p => p.id);
  fm.writeString(SEEN, JSON.stringify(ids));
  if (!seen) return; // 初回は通知しない
  const fresh = d.pending.filter(p => !seen.includes(p.id));
  if (!fresh.length) return;
  try {
    const n = new Notification();
    n.title = `新しい予定が${fresh.length}件見つかりました`;
    n.body = fresh.slice(0, 3).map(p => `${p.title}（${fmtDate(p.date, p.time)}）`).join('\n');
    await n.schedule();
  } catch (e) { /* 通知が使えない環境では何もしない */ }
}

function addText(stack, str, size, color, bold = false, lines = 1) {
  const t = stack.addText(str);
  t.font = bold ? Font.boldSystemFont(size) : Font.systemFont(size);
  t.textColor = color;
  t.lineLimit = lines;
  return t;
}
function header(w, icon, label) {
  const h = w.addStack(); h.centerAlignContent();
  const img = h.addImage(SFSymbol.named(icon).image);
  img.imageSize = new Size(14, 14); img.tintColor = C.primary;
  h.addSpacer(4);
  addText(h, label, 12, C.primary, true);
  return h;
}
function button(stack, label, url, filled) {
  const b = stack.addStack();
  b.setPadding(4, 12, 4, 12); b.cornerRadius = 12;
  b.backgroundColor = filled ? C.primary : C.container;
  b.url = url;
  addText(b, label, 12, filled ? Color.white() : C.text, true);
}

function build(d) {
  const fam = config.widgetFamily || 'medium';
  const param = (args.widgetParameter || '').trim();
  const w = new ListWidget();

  if (!d) {
    if (fam.startsWith('accessory')) { addText(w, '予定：取得できません', 12, C.text); return w; }
    w.backgroundColor = C.bg;
    addText(w, 'データを取得できませんでした', 13, C.text, true, 2);
    addText(w, 'WIDGET_URL を確認してください', 11, C.sub, false, 2);
    return w;
  }

  const next = d.pending[0] || d.upcoming[0];
  const n = d.pending.length;

  // ----- ロック画面 -----
  if (fam === 'accessoryInline') {
    w.addText(`未確認 ${n} ・ 次 ${hm(d.nextCheck)}`);
    return w;
  }
  if (fam === 'accessoryCircular') {
    w.addSpacer();
    const t = w.addText(String(n)); t.font = Font.boldSystemFont(22); t.centerAlignText();
    const s = w.addText('未確認'); s.font = Font.systemFont(9); s.centerAlignText();
    w.addSpacer();
    return w;
  }
  if (fam === 'accessoryRectangular') {
    if (next) {
      addText(w, next.title, 13, Color.white(), true);
      addText(w, fmtDate(next.date, next.time), 12, Color.white());
      if (n > 1) addText(w, `他${n - 1}件`, 11, Color.white());
    } else {
      addText(w, '新しい予定はありません', 12, Color.white());
    }
    return w;
  }

  // ----- ホーム画面 -----
  w.backgroundColor = C.bg;
  w.setPadding(14, 14, 14, 14);

  if (fam === 'small') {
    if (param === 'count') {
      header(w, 'envelope.badge', '未確認');
      w.addSpacer();
      addText(w, `${n}件`, 34, C.text, true);
      w.addSpacer();
      addText(w, `最終 ${hm(d.lastCheck)}`, 11, C.sub);
      addText(w, `次回 ${hm(d.nextCheck)}`, 11, C.sub);
    } else {
      header(w, 'calendar', '次の予定');
      w.addSpacer(6);
      if (next) {
        addText(w, next.title, 15, C.text, true, 3);
        w.addSpacer(4);
        addText(w, fmtDate(next.date, next.time), 12, C.sub);
        w.addSpacer();
        addText(w, daysLeft(next.date), 13, C.primary, true);
      } else {
        addText(w, '予定はありません', 13, C.sub, false, 2);
        w.addSpacer();
      }
    }
  } else {
    // medium / large
    header(w, 'sparkles', `新しく見つかった予定（${n}件）`);
    w.addSpacer(6);
    const first = d.pending[0];
    const showButtons = fam === 'medium' && first && first.date;
    const max = fam === 'large' ? 7 : showButtons ? 2 : 3;
    if (!n) addText(w, '新しい予定はありません', 13, C.sub);
    d.pending.slice(0, max).forEach(p => {
      const row = w.addStack(); row.centerAlignContent();
      const img = row.addImage(SFSymbol.named(p.source === 'gmail' ? 'envelope' : 'graduationcap').image);
      img.imageSize = new Size(14, 14); img.tintColor = C.sub;
      row.addSpacer(6);
      addText(row, p.title, 13, C.text, true);
      row.addSpacer();
      addText(row, fmtDate(p.date, p.time), 12, C.sub);
      w.addSpacer(4);
    });
    w.addSpacer();
    if (showButtons) {
      const b = w.addStack(); b.centerAlignContent();
      addText(b, `先頭：${first.title}`, 11, C.sub);
      b.addSpacer();
      button(b, '無視', actionUrl('ignore', first.id), false);
      b.addSpacer(6);
      button(b, '追加', actionUrl('add', first.id), true);
    } else {
      addText(w, `最終チェック ${hm(d.lastCheck)}${d.offline ? '（オフライン）' : ''}`, 10, C.sub);
    }
  }
  return w;
}

// ウィジェットの「追加」「無視」から呼ばれたとき
async function runAction(q) {
  const a = new Alert();
  try {
    const r = new Request(EXEC_URL);
    r.method = 'POST';
    r.headers = { 'Content-Type': 'text/plain;charset=utf-8' };
    r.body = JSON.stringify({ t: TOKEN, op: q.action === 'add' ? 'add' : 'ignore', id: q.id });
    const j = await r.loadJSON();
    if (!j.ok) throw new Error(j.error);
    a.title = q.action === 'add' ? 'カレンダーに追加しました' : '無視しました';
    a.message = (j.data.title || '') + (j.data.calendarName === '反映待ち' ? '\n（数分でカレンダーに反映されます）' : '');
  } catch (e) {
    a.title = 'うまくいきませんでした';
    a.message = String(e.message || e);
  }
  a.addAction('OK');
  await a.present();
}

const q = args.queryParameters || {};
if (q.action && q.id) {
  await runAction(q);
} else {
  const data = await load();
  if (data) await notifyNew(data);
  const widget = build(data);
  widget.refreshAfterDate = new Date(Date.now() + 30 * 60 * 1000);
  if (config.runsInWidget) Script.setWidget(widget);
  else await widget.presentMedium();
}
Script.complete();
