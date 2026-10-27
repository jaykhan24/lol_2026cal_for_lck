// 2026 LCK 1군 경기 일정 → 공개 Google 캘린더 미러 (script.google.com에 복붙)
//
// GitHub Pages의 lck.json(전체 경기)·teams.json(팀별 경기 ID)을 15분마다 한 번 읽어
// 전체 캘린더 1개 + 팀 캘린더(LCK 팀 수만큼)에 나눠 넣는다. Riot API는 호출하지 않는다.
//
// 설정 순서
// 1) 왼쪽 "서비스 +" → Google Calendar API 추가(식별자 Calendar) — 캘린더 공개 설정에 필요
// 2) setup 1회 실행(권한 승인) → 캘린더 생성·공개 설정·15분 트리거 설치, 로그에 구독 링크 출력
// 3) 첫 동기화는 일정이 많아 실행당 MAX_WRITES건씩 나눠 들어간다. 로그에 "이어서"가 안 나올 때까지 syncAll 수동 실행 또는 트리거에 맡김
const BASE_URL = 'https://jaykhan24.github.io/lol_2026cal_for_lck/';
const YEAR = 2026;
const ALL = 'ALL';                 // 전체 캘린더 키(팀 코드와 겹치지 않음)
const TAG = 'lolMatchId';
const MAX_WRITES = 150;            // 실행당 생성·수정·삭제 상한(실행 6분·캘린더 쓰기 속도 제한 대비)
const TIME_BUDGET_MS = 4.5 * 60e3;
const props = PropertiesService.getScriptProperties();

function setup() {
  const data = fetchData_();
  if (!data) throw new Error('lck.json·teams.json을 가져오지 못함 — BASE_URL과 Pages 상태 확인');
  ensureCalendar_(ALL, `${YEAR} LCK 1군 전체`);
  data.teams.forEach(t => ensureCalendar_(t.code, `${YEAR} LCK · ${t.code}`));
  installTrigger();
  logLinks();
  syncAll();
}

function syncAll() {
  const startedAt = Date.now();
  const data = fetchData_();
  if (!data) return;
  // 지난 실행과 데이터가 같고 남은 작업도 없으면 캘린더를 건드리지 않는다(트리거 일일 실행 시간 절약)
  if (data.hash === props.getProperty('lastHash') && props.getProperty('pending') !== '1') {
    Logger.log('변경 없음');
    return;
  }

  const byId = {};
  data.matches.forEach(m => { byId[m.id] = m; });
  const targets = [{ key: ALL, name: `${YEAR} LCK 1군 전체`, matches: data.matches }]
    .concat(data.teams.map(t => ({
      key: t.code, name: `${YEAR} LCK · ${t.code}`, matches: t.ids.map(id => byId[id]).filter(Boolean),
    })));

  const budget = { writes: 0, left: () => budget.writes < MAX_WRITES && Date.now() - startedAt < TIME_BUDGET_MS };
  const summary = [];
  let complete = true;
  for (const t of targets) {
    const cal = ensureCalendar_(t.key, t.name);
    const r = syncCalendar_(cal, t.matches, budget);
    if (r.created || r.updated || r.deleted) summary.push(`${t.key} +${r.created} ~${r.updated} -${r.deleted}`);
    if (!r.complete) { complete = false; break; }
  }

  props.setProperty('pending', complete ? '0' : '1');
  if (complete) props.setProperty('lastHash', data.hash);
  Logger.log('%s%s', summary.join(', ') || '수정 없음', complete ? '' : ' (상한 도달 — 다음 실행에서 이어서)');
}

// 15분 시간 기반 트리거 설치(중복 설치 방지)
function installTrigger() {
  ScriptApp.getProjectTriggers()
    .filter(t => ['syncAll', 'syncLck'].includes(t.getHandlerFunction()))
    .forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('syncAll').timeBased().everyMinutes(15).create();
}

// 안내 페이지(docs/index.html의 GOOGLE_LINKS)에 넣을 구독 링크를 로그로 출력
function logLinks() {
  const links = {};
  props.getKeys().filter(k => k.startsWith('cal:')).sort().forEach(k => {
    const id = props.getProperty(k);
    links[k.slice(4)] = 'https://calendar.google.com/calendar/u/0?cid=' + Utilities.base64Encode(id).replace(/=+$/, '');
  });
  Logger.log(JSON.stringify(links, null, 2));
}

// ── 내부 ──────────────────────────────────────────────────────────────

function fetchData_() {
  const get = path => {
    const res = UrlFetchApp.fetch(BASE_URL + path + '?t=' + Date.now(), { muteHttpExceptions: true });
    if (res.getResponseCode() !== 200) throw new Error(path + ' 응답 ' + res.getResponseCode());
    return res.getContentText();
  };
  let matchesText, teamsText;
  try {
    matchesText = get('lck.json');
    teamsText = get('teams.json');
  } catch (e) {
    Logger.log('데이터를 못 가져옴 — 건너뜀: %s', e.message);
    return null;
  }
  const matches = JSON.parse(matchesText), teams = JSON.parse(teamsText);
  if (!Array.isArray(matches) || !matches.length || !Array.isArray(teams)) return null;
  const digest = Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, matchesText + teamsText);
  return { matches, teams, hash: Utilities.base64Encode(digest) };
}

// 키(ALL 또는 팀 코드)에 해당하는 캘린더를 찾고, 없으면 만들어 공개로 설정한다
function ensureCalendar_(key, name) {
  const id = props.getProperty('cal:' + key);
  const existing = id && CalendarApp.getCalendarById(id);
  if (existing) return existing;

  const cal = CalendarApp.createCalendar(name, {
    timeZone: 'Asia/Seoul',
    summary: 'LCK 1군 경기 일정·스코어 자동 갱신 · ' + BASE_URL,
    selected: key === ALL,   // 내 캘린더 목록에는 전체만 기본 표시
  });
  props.setProperty('cal:' + key, cal.getId());
  try {
    Calendar.Acl.insert({ role: 'reader', scope: { type: 'default' } }, cal.getId());
  } catch (e) {
    Logger.log('%s 공개 설정 실패(서비스에 Google Calendar API 추가 필요): %s', name, e.message);
  }
  Logger.log('캘린더 생성: %s', name);
  return cal;
}

function syncCalendar_(cal, matches, budget) {
  const existing = {};
  cal.getEvents(new Date(YEAR, 0, 1), new Date(YEAR + 1, 0, 1)).forEach(ev => {
    const id = ev.getTag(TAG);
    if (id) existing[id] = ev;
  });

  const r = { created: 0, updated: 0, deleted: 0, complete: true };
  for (const m of matches) {
    const start = new Date(m.start), end = new Date(m.end);
    const ev = existing[m.id];
    delete existing[m.id];
    if (!ev) {
      if (!budget.left()) { r.complete = false; continue; }
      const newEv = cal.createEvent(m.title, start, end, { description: m.description, location: m.round });
      newEv.setTag(TAG, m.id);
      r.created++; budget.writes++;
      Utilities.sleep(200);
      continue;
    }
    // 바뀐 필드만 수정(불필요한 수정 알림 방지)
    const timeChanged = ev.getStartTime().getTime() !== start.getTime() || ev.getEndTime().getTime() !== end.getTime();
    const diff = ev.getTitle() !== m.title || ev.getDescription() !== m.description ||
      ev.getLocation() !== m.round || timeChanged;
    if (!diff) continue;
    if (!budget.left()) { r.complete = false; continue; }
    if (ev.getTitle() !== m.title) ev.setTitle(m.title);
    if (ev.getDescription() !== m.description) ev.setDescription(m.description);
    if (ev.getLocation() !== m.round) ev.setLocation(m.round);
    if (timeChanged) ev.setTime(start, end);
    r.updated++; budget.writes++;
  }
  // JSON에서 사라진 경기(취소, TBD가 다른 팀으로 확정 등)는 삭제
  for (const ev of Object.values(existing)) {
    if (!budget.left()) { r.complete = false; break; }
    ev.deleteEvent();
    r.deleted++; budget.writes++;
  }
  return r;
}
