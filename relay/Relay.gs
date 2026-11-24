/**
 * メール予定アシスタント — 中継用 GAS（「全員」に公開できる別の Google アカウント＝公開用のアカウントで動かす）
 *
 * メインのアカウント（学校・会社など）で Web アプリを「全員」に公開できないときに使う。
 * アプリ（PWA）とウィジェットはこの中継 GAS とだけ通信する。
 *
 *   本体GAS ──(5分ごと sync: 状態を送る／操作を受け取る)──▶ 中継GAS ◀── アプリ・ウィジェット
 *
 * - 状態（予定一覧・設定）は本体 GAS から届いたものを保存して返すだけ
 * - アプリでの「追加」「無視」「設定変更」「今すぐチェック」は queue にためて、次の sync で本体 GAS が実行する
 */

// ================================================================
// 初回セットアップ（エディタから 1 回だけ実行）
// ================================================================
function setup() {
  const p = PropertiesService.getScriptProperties();
  if (!p.getProperty('TOKEN')) p.setProperty('TOKEN', Utilities.getUuid().replace(/-/g, ''));
  if (!p.getProperty('SYNC_KEY')) p.setProperty('SYNC_KEY', Utilities.getUuid().replace(/-/g, ''));
  Logger.log('アプリ用 TOKEN: ' + p.getProperty('TOKEN'));
  Logger.log('本体GAS用 SYNC_KEY: ' + p.getProperty('SYNC_KEY'));
  Logger.log('↑ SYNC_KEY は、本体GASの Code.gs の一番上「const RELAY_KEY = \'\';」の \'\' の中に貼ります');
}

// ================================================================
// ウィジェット用（GET）
// ================================================================
function doGet(e) {
  const p = (e && e.parameter) || {};
  if (!validToken_(p.t)) return ContentService.createTextOutput('アクセスできません');
  if (p.api === 'widget') return json_(loadJson_('widget', { pending: [], upcoming: [], lastCheck: null, nextCheck: null, notify: false }));
  return ContentService.createTextOutput('中継GASは動いています');
}

// ================================================================
// アプリ・ウィジェット・本体GASから（POST、本文は JSON 文字列）
// ================================================================
function doPost(e) {
  let req;
  try { req = JSON.parse(e.postData.contents); }
  catch (err) { return json_({ ok: false, error: 'リクエストの形式が正しくありません' }); }

  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    // ---- 本体GASからの同期 ----
    if (req.op === 'sync') {
      if (!req.key || req.key !== PropertiesService.getScriptProperties().getProperty('SYNC_KEY')) {
        throw new Error('SYNC_KEY が違います');
      }
      const st = req.state || {};
      st.widgetUrl = ScriptApp.getService().getUrl() + '?t=' + PropertiesService.getScriptProperties().getProperty('TOKEN') + '&api=widget';
      st.syncedAt = Date.now();
      saveJson_('state', st);
      saveJson_('widget', req.widget || {});
      const commands = loadJson_('queue', []);
      saveJson_('queue', []);
      return json_({ ok: true, data: { commands: commands } });
    }

    // ---- アプリ・ウィジェットから ----
    assertToken_(req.t);
    const st = loadJson_('state', null);
    if (!st) throw new Error('まだ本体のGASから同期されていません。メインのアカウントの本体GASで setupRelay を実行してください');
    st.items = st.items || [];

    let data;
    switch (req.op) {
      case 'state':
        data = st;
        break;
      case 'add':
      case 'ignore': {
        const it = st.items.find(i => i.id === req.id);
        if (!it) throw new Error('予定が見つかりません');
        enqueue_({ op: req.op, id: req.id, patch: req.patch || {} });
        // 本体GASが実行するまでの見た目（次の同期で正しい状態に置き換わる）
        if (req.op === 'add') {
          ['title', 'date', 'time'].forEach(k => { if (req.patch && req.patch[k] !== undefined) it[k] = req.patch[k] || null; });
          it.status = 'added';
          it.calendarName = '反映待ち';
        } else {
          it.status = 'ignored';
        }
        it.isNew = false;
        saveJson_('state', st);
        const w = loadJson_('widget', null);
        if (w && w.pending) { w.pending = w.pending.filter(p => p.id !== req.id); saveJson_('widget', w); }
        data = it;
        break;
      }
      case 'saveSettings':
        enqueue_({ op: 'saveSettings', settings: req.settings || {} });
        st.settings = Object.assign({}, st.settings, req.settings || {});
        saveJson_('state', st);
        data = st.settings;
        break;
      case 'checkNow':
        enqueue_({ op: 'checkNow' });
        data = st;
        break;
      default:
        throw new Error('不明な操作です: ' + req.op);
    }
    data = data === st ? Object.assign({}, st, { queued: loadJson_('queue', []).length }) : data;
    return json_({ ok: true, data: data });
  } catch (err) {
    return json_({ ok: false, error: err.message });
  } finally {
    lock.releaseLock();
  }
}

// ================================================================
// ユーティリティ
// ================================================================
function enqueue_(cmd) {
  const q = loadJson_('queue', []);
  cmd.at = Date.now();
  q.push(cmd);
  saveJson_('queue', q.slice(-50));
}

function validToken_(t) {
  const tok = PropertiesService.getScriptProperties().getProperty('TOKEN');
  return !!tok && t === tok;
}
function assertToken_(t) { if (!validToken_(t)) throw new Error('アクセスできません'); }

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

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
