// 2026 LCK 1군 경기 일정 → 공개 Google 캘린더 미러 + GitHub Actions 깨우기 (script.google.com에 복붙)
//
// 1분 트리거 tick()이 모든 일을 한다.
// - 경기 중(시작 3분 전 ~ 완료 확인)에는 매분: GitHub 워크플로 실행(workflow_dispatch) + lolesports API에서 스코어를 직접 읽어
//   Google 캘린더 일정을 바로 고친다(Pages 배포를 기다리지 않음). lck.json도 매분 다시 읽는다.
// - 경기 없는 시간에는 5분마다 lck.json·teams.json·intl.json을 읽어 바뀐 것만 캘린더에 반영하고, 15분마다 GitHub 워크플로를 깨운다.
// - 시즌 마지막 경기 종료 +3일이 지나면 트리거를 스스로 지우고 GitHub 워크플로를 Disable 한다.
//
// 설정 순서
// 1) 왼쪽 "서비스 +" → Google Calendar API 추가(식별자 Calendar) — 캘린더 공개 설정에 필요
// 2) 프로젝트 설정 › 스크립트 속성에 GITHUB_TOKEN 추가(README "GitHub 토큰" 참고). 없어도 캘린더 미러는 돌지만 Actions를 깨우지 못한다
// 3) setup 1회 실행(권한 승인) → 캘린더 생성·공개 설정·1분 트리거 설치, 로그에 구독 링크 출력
// 3-1) 로그에 "공개 설정 실패"가 있으면 서비스 추가 확인 후 makePublic 1회 실행
// 4) 첫 동기화는 일정이 많아 실행당 MAX_WRITES건씩 나눠 들어간다. 로그에 "이어서"가 안 나올 때까지 syncAll 수동 실행 또는 트리거에 맡김
const BASE_URL = 'https://jaykhan24.github.io/lol_2026cal_for_lck/';
const GITHUB_REPO = 'jaykhan24/lol_2026cal_for_lck';
const WORKFLOW_FILE = 'update.yml';
const WORKFLOW_REF = 'main';
const YEAR = 2026;
const ALL = 'ALL';                 // 전체 캘린더 키(팀 코드와 겹치지 않음)
const INTL = 'INTL';               // 국제대회 전 경기 캘린더 키
const NAMES = { [ALL]: `${YEAR} LCK 1군 전체`, [INTL]: `${YEAR} LoL 국제대회 전 경기` };
const TAG = 'lolMatchId';
const MAX_WRITES = 150;            // 실행당 생성·수정·삭제 상한(실행 6분·캘린더 쓰기 속도 제한 대비)
const TIME_BUDGET_MS = 4.5 * 60e3;

// fetch_schedule.py와 같은 값·같은 문구여야 한다(여기서 고친 제목을 lck.json이 다시 덮어쓰지 않게)
const API_BASE = 'https://esports-api.lolesports.com/persisted/gw';
const API_KEY = '0TvQnueqKa5mxJntVWt0w4LpLfEkrV1Ta8rQBb9Z';
const LEAGUES = { lck: 'LCK', first_stand: 'FST', msi: 'MSI', ewc_lol: 'EWC', worlds: 'Worlds' };
const DURATION_MS = { 1: 90 * 60e3, 3: 150 * 60e3, 5: 240 * 60e3 };
const SCHEDULE_URL = 'https://lolesports.com/ko-KR/schedule';

const LIVE_LEAD_MS = 3 * 60e3;          // 경기 시작 몇 분 전부터 실시간 모드
const LIVE_MAX_MS = 7 * 3600e3;         // 시작 후 이만큼 지나도 완료가 안 보이면 실시간 모드 해제(일일 실행 시간 보호)
const IDLE_SYNC_MS = 5 * 60e3;          // 경기 없을 때 lck.json 확인 간격
const IDLE_DISPATCH_MS = 15 * 60e3;     // 경기 없을 때 GitHub 깨우기 간격
const GRACE_AFTER_END_MS = 3 * 86400e3; // 시즌 마지막 경기 종료 후 이만큼 지나면 종료
const props = PropertiesService.getScriptProperties();

function setup() {
  const data = fetchData_();
  if (!data) throw new Error('lck.json·teams.json을 가져오지 못함 — BASE_URL과 Pages 상태 확인');
  ensureCalendar_(ALL, NAMES[ALL]);
  data.teams.forEach(t => ensureCalendar_(t.code, `${YEAR} LCK · ${t.code}`));
  ensureCalendar_(INTL, NAMES[INTL]);
  if (!githubToken_()) Logger.log('스크립트 속성 GITHUB_TOKEN이 없음 — Actions 깨우기는 건너뛴다(README "GitHub 토큰")');
  installTrigger();
  logLinks();
  syncAll();
}

// 1분 트리거 본체
function tick() {
  const now = Date.now();
  let watch = JSON.parse(props.getProperty('watch') || 'null');
  const live = watch && watch.matches.some(m => isLive_(m, now));

  if (live) {
    dispatchWorkflow_();
    const touched = patchLive_(watch);
    const data = fetchData_();                       // 봇 커밋이 Pages에 반영됐으면 전체 동기화(해시 다를 때만)
    if (data) { syncAll(data); watch = saveWatch_(data); }
    Logger.log('LIVE: 즉시 반영 %s건, 감시 %s경기', touched, watch ? watch.matches.length : '?');
    return;
  }

  if (!watch || now - Number(props.getProperty('lastIdleSync') || 0) >= IDLE_SYNC_MS) {
    const data = fetchData_();
    if (data) { syncAll(data); watch = saveWatch_(data); }
    props.setProperty('lastIdleSync', String(now));
  }
  if (now - Number(props.getProperty('lastDispatch') || 0) >= IDLE_DISPATCH_MS) dispatchWorkflow_();

  if (watch && !watch.matches.length && now > watch.lastEnd + GRACE_AFTER_END_MS) shutdown_();
}

function syncAll(data) {
  const startedAt = Date.now();
  data = data || fetchData_();
  if (!data) return;
  // 지난 실행과 데이터가 같고 남은 작업도 없으면 캘린더를 건드리지 않는다(트리거 일일 실행 시간 절약)
  if (data.hash === props.getProperty('lastHash') && props.getProperty('pending') !== '1') return;

  const byId = {};
  data.matches.forEach(m => { byId[m.id] = m; });
  const targets = [{ key: ALL, name: NAMES[ALL], matches: data.matches }]
    .concat(data.teams.map(t => ({
      key: t.code, name: `${YEAR} LCK · ${t.code}`, matches: t.ids.map(id => byId[id]).filter(Boolean),
    })))
    .concat(data.intl ? [{ key: INTL, name: NAMES[INTL], matches: data.intl }] : []);

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

// 1분 시간 기반 트리거 설치(옛 트리거 정리 포함, 중복 설치 방지)
function installTrigger() {
  ScriptApp.getProjectTriggers()
    .filter(t => ['tick', 'syncAll', 'syncLck'].includes(t.getHandlerFunction()))
    .forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('tick').timeBased().everyMinutes(1).create();
}

// 만든 캘린더 전부에 공개(모든 사람 읽기) 설정을 다시 건다. 여러 번 실행해도 안전.
// 서비스에 Google Calendar API(식별자 Calendar)가 추가되어 있어야 한다.
function makePublic() {
  if (typeof Calendar === 'undefined') {
    throw new Error('왼쪽 "서비스 +"에서 Google Calendar API를 추가한 뒤 다시 실행하세요');
  }
  props.getKeys().filter(k => k.startsWith('cal:')).sort().forEach(k => {
    const id = props.getProperty(k);
    try {
      Calendar.Acl.insert({ role: 'reader', scope: { type: 'default' } }, id);
      Logger.log('%s 공개 설정 완료', k.slice(4));
    } catch (e) {
      Logger.log('%s 공개 설정 실패: %s', k.slice(4), e.message);
    }
  });
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

// 시즌 종료 처리를 지금 바로 실행(트리거 삭제 + GitHub 워크플로 Disable). 되돌리려면 installTrigger + GitHub에서 Enable.
function shutdownNow() { shutdown_(); }

// GitHub 토큰·API 연결 점검: 워크플로 정보가 로그에 나오면 정상
function checkGithub() {
  const res = github_('GET', `/actions/workflows/${WORKFLOW_FILE}`);
  Logger.log('%s %s', res.getResponseCode(), res.getContentText().slice(0, 300));
}

// ── 내부 ──────────────────────────────────────────────────────────────

function fetchData_() {
  const get = path => {
    const res = UrlFetchApp.fetch(BASE_URL + path + '?t=' + Date.now(), { muteHttpExceptions: true });
    if (res.getResponseCode() !== 200) throw new Error(path + ' 응답 ' + res.getResponseCode());
    return res.getContentText();
  };
  let matchesText, teamsText, intlText;
  try {
    matchesText = get('lck.json');
    teamsText = get('teams.json');
    intlText = get('intl.json');
  } catch (e) {
    Logger.log('데이터를 못 가져옴 — 건너뜀: %s', e.message);
    return null;
  }
  const matches = JSON.parse(matchesText), teams = JSON.parse(teamsText), intl = JSON.parse(intlText);
  if (!Array.isArray(matches) || !matches.length || !Array.isArray(teams)) return null;
  const digest = Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, matchesText + teamsText + intlText);
  // intl.json이 비면(리그 조회 실패 등) 국제대회 캘린더는 건드리지 않는다(전부 지워지지 않게)
  return { matches, teams, intl: Array.isArray(intl) && intl.length ? intl : null, hash: Utilities.base64Encode(digest) };
}

// 아직 안 끝난 경기 목록(실시간 모드 판단·즉시 반영 대상)을 스크립트 속성에 저장
function saveWatch_(data) {
  const teamOf = {};
  data.teams.forEach(t => t.ids.forEach(id => { (teamOf[id] = teamOf[id] || []).push(t.code); }));
  const lckIds = new Set(data.matches.map(m => m.id));
  const seen = new Set();
  const matches = [];
  let lastEnd = 0;
  data.matches.concat(data.intl || []).forEach(m => {
    lastEnd = Math.max(lastEnd, Date.parse(m.end));
    if (m.state === 'completed' || seen.has(m.id)) return;
    seen.add(m.id);
    const cals = (lckIds.has(m.id) ? [ALL].concat(teamOf[m.id] || []) : []).concat(m.league !== 'LCK' ? [INTL] : []);
    matches.push({ id: m.id, start: Date.parse(m.start), league: m.league, cals });
  });
  const watch = { matches, lastEnd, savedAt: Date.now() };
  props.setProperty('watch', JSON.stringify(watch));
  return watch;
}

function isLive_(m, now) { return m.start - LIVE_LEAD_MS <= now && now <= m.start + LIVE_MAX_MS; }

// 진행 중인 리그의 일정을 lolesports API에서 직접 읽어 감시 중인 경기의 Google 일정을 바로 고친다. 고친 일정 수를 돌려준다.
function patchLive_(watch) {
  const now = Date.now();
  const targets = watch.matches.filter(m => isLive_(m, now) && m.cals.length);
  if (!targets.length) return 0;
  const byId = {};
  targets.forEach(m => { byId[m.id] = m; });
  const slugs = Object.keys(LEAGUES).filter(slug => targets.some(m => m.league === LEAGUES[slug]));

  let events;
  try {
    const leagues = lolesports_('getLeagues').data.leagues;
    events = [];
    slugs.forEach(slug => {
      const league = leagues.find(l => l.slug === slug);
      if (league) events = events.concat(lolesports_('getSchedule', { leagueId: league.id }).data.schedule.events);
    });
  } catch (e) {
    Logger.log('lolesports API 실패 — 건너뜀: %s', e.message);
    return 0;
  }

  let touched = 0;
  events.filter(e => e.match && byId[e.match.id]).forEach(e => {
    const m = formatMatch_(e);
    byId[m.id].cals.forEach(key => {
      const id = props.getProperty('cal:' + key);
      const cal = id && CalendarApp.getCalendarById(id);
      if (!cal) return;
      const ev = cal.getEvents(new Date(m.start.getTime() - 60e3), new Date(m.start.getTime() + 60e3)).find(x => x.getTag(TAG) === m.id);
      if (!ev) return;
      let changed = false;
      if (ev.getTitle() !== m.title) { ev.setTitle(m.title); changed = true; }
      if (ev.getDescription() !== m.description) { ev.setDescription(m.description); changed = true; }
      if (ev.getLocation() !== m.round) { ev.setLocation(m.round); changed = true; }
      if (changed) touched++;
    });
  });
  return touched;
}

// fetch_schedule.py의 to_match와 같은 결과(제목·설명·라운드)를 만든다
function formatMatch_(e) {
  const m = e.match;
  const slug = e.league.slug;
  const tag = LEAGUES[slug];
  const leagueName = e.league.name || tag;
  const teams = (m.teams || []).concat([{}, {}]);
  const t1 = teams[0], t2 = teams[1];
  const code1 = t1.code || 'TBD', code2 = t2.code || 'TBD';
  const name1 = t1.name || code1, name2 = t2.name || code2;
  const wins1 = (t1.result || {}).gameWins || 0, wins2 = (t2.result || {}).gameWins || 0;
  const bestOf = (m.strategy || {}).count || 1;
  const state = e.state || 'unstarted';
  const block = e.blockName || '';

  let title;
  if (state === 'completed') title = `[${tag}] ${code1} vs ${code2} (${wins1} : ${wins2})`;
  else if (state === 'inProgress') title = `[${tag}] ${code1} vs ${code2} 🔴 ${wins1}:${wins2}`;
  else title = `[${tag}] ${code1} vs ${code2} (Bo${bestOf})`;

  const round = block ? `${leagueName} · ${block}` : leagueName;
  const lines = [round, `${name1} vs ${name2}`, SCHEDULE_URL];
  if (state === 'completed') {
    const winner = [t1, t2].find(t => (t.result || {}).outcome === 'win');
    if (winner && winner.code) lines.unshift(`승: ${winner.code}`);
  }
  const start = new Date(e.startTime);
  const end = new Date(start.getTime() + (DURATION_MS[bestOf] || DURATION_MS[1]));
  return { id: m.id, start, end, title, description: lines.join('\n'), round, state };
}

function lolesports_(endpoint, params) {
  const q = Object.entries(Object.assign({ hl: 'ko-KR' }, params || {})).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
  const res = UrlFetchApp.fetch(`${API_BASE}/${endpoint}?${q}`, { headers: { 'x-api-key': API_KEY }, muteHttpExceptions: true });
  if (res.getResponseCode() !== 200) throw new Error(`${endpoint} 응답 ${res.getResponseCode()}`);
  return JSON.parse(res.getContentText());
}

function githubToken_() { return props.getProperty('GITHUB_TOKEN'); }

function github_(method, path, payload) {
  const token = githubToken_();
  if (!token) return null;
  return UrlFetchApp.fetch(`https://api.github.com/repos/${GITHUB_REPO}${path}`, {
    method, muteHttpExceptions: true, contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + token, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
    payload: payload ? JSON.stringify(payload) : undefined,
  });
}

// GitHub Actions 워크플로를 지금 실행시킨다(workflow_dispatch). 토큰이 없으면 아무것도 안 함.
function dispatchWorkflow_() {
  const res = github_('POST', `/actions/workflows/${WORKFLOW_FILE}/dispatches`, { ref: WORKFLOW_REF });
  if (!res) return;
  props.setProperty('lastDispatch', String(Date.now()));
  if (res.getResponseCode() !== 204) Logger.log('workflow_dispatch 실패 %s: %s', res.getResponseCode(), res.getContentText().slice(0, 200));
}

// 시즌 종료: 트리거 삭제 + GitHub 워크플로 Disable
function shutdown_() {
  ScriptApp.getProjectTriggers().filter(t => t.getHandlerFunction() === 'tick').forEach(t => ScriptApp.deleteTrigger(t));
  const res = github_('PUT', `/actions/workflows/${WORKFLOW_FILE}/disable`);
  Logger.log('시즌 종료 — 트리거 삭제, 워크플로 Disable %s', res ? res.getResponseCode() : '(토큰 없음, GitHub에서 직접 Disable)');
}

// 키(ALL 또는 팀 코드)에 해당하는 캘린더를 찾고, 없으면 만들어 공개로 설정한다
function ensureCalendar_(key, name) {
  const id = props.getProperty('cal:' + key);
  const existing = id && CalendarApp.getCalendarById(id);
  if (existing) return existing;

  const cal = CalendarApp.createCalendar(name, {
    timeZone: 'Asia/Seoul',
    summary: (key === INTL ? 'LoL 국제대회 전 경기' : 'LCK 1군 경기') + ' 일정·스코어 자동 갱신 · ' + BASE_URL,
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
