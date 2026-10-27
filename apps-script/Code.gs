// 2026 LCK 1군 경기 일정 → 공유 Google 캘린더 미러 (script.google.com에 복붙)
// 1) JSON_URL, CALENDAR_ID 채우기  2) syncLck 수동 실행(권한 승인)  3) installTrigger 1회 실행(15분 트리거)
// 첫 동기화는 경기가 많아(250건 안팎) 한 번에 MAX_WRITES건씩 나눠 진행된다. 남은 건 다음 실행에서 이어서 처리.
const JSON_URL = 'https://<user>.github.io/lol_2026cal_for_lck/lck.json';
const CALENDAR_ID = '<전용 캘린더 ID>';
const TAG = 'lolMatchId';
const YEAR = 2026;
const MAX_WRITES = 100;            // 실행당 생성·수정·삭제 상한(실행 시간 6분·캘린더 쓰기 속도 제한 대비)
const TIME_BUDGET_MS = 4.5 * 60e3;

function syncLck() {
  const startedAt = Date.now();
  const res = UrlFetchApp.fetch(JSON_URL, { muteHttpExceptions: true });
  if (res.getResponseCode() !== 200) {
    Logger.log('JSON 응답 %s — 건너뜀', res.getResponseCode());
    return;
  }
  const matches = JSON.parse(res.getContentText());
  if (!Array.isArray(matches) || !matches.length) return;

  const cal = CalendarApp.getCalendarById(CALENDAR_ID);
  if (!cal) throw new Error('캘린더를 찾을 수 없음: ' + CALENDAR_ID);
  const existing = {};
  cal.getEvents(new Date(YEAR, 0, 1), new Date(YEAR + 1, 0, 1)).forEach(ev => {
    const id = ev.getTag(TAG);
    if (id) existing[id] = ev;
  });

  let created = 0, updated = 0, deleted = 0, writes = 0;
  const budgetLeft = () => writes < MAX_WRITES && Date.now() - startedAt < TIME_BUDGET_MS;

  for (const m of matches) {
    const start = new Date(m.start), end = new Date(m.end);
    const ev = existing[m.id];
    delete existing[m.id];
    if (!ev) {
      if (!budgetLeft()) continue;
      const newEv = cal.createEvent(m.title, start, end, { description: m.description, location: m.round });
      newEv.setTag(TAG, m.id);
      created++; writes++;
      Utilities.sleep(200);
      continue;
    }
    // 바뀐 필드만 수정(불필요한 수정 알림 방지)
    const diff = ev.getTitle() !== m.title || ev.getDescription() !== m.description ||
      ev.getLocation() !== m.round ||
      ev.getStartTime().getTime() !== start.getTime() || ev.getEndTime().getTime() !== end.getTime();
    if (!diff || !budgetLeft()) continue;
    if (ev.getTitle() !== m.title) ev.setTitle(m.title);
    if (ev.getDescription() !== m.description) ev.setDescription(m.description);
    if (ev.getLocation() !== m.round) ev.setLocation(m.round);
    if (ev.getStartTime().getTime() !== start.getTime() || ev.getEndTime().getTime() !== end.getTime())
      ev.setTime(start, end);
    updated++; writes++;
  }
  // JSON에서 사라진 경기(취소, TBD가 LCK 외 팀으로 확정 등)는 삭제
  for (const ev of Object.values(existing)) {
    if (!budgetLeft()) break;
    ev.deleteEvent();
    deleted++; writes++;
  }
  Logger.log('created=%s updated=%s deleted=%s total=%s%s', created, updated, deleted, matches.length,
    budgetLeft() ? '' : ' (상한 도달 — 다음 실행에서 이어서)');
}

// 15분 시간 기반 트리거 설치(중복 설치 방지). 1회만 실행.
function installTrigger() {
  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === 'syncLck')
    .forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('syncLck').timeBased().everyMinutes(15).create();
}
