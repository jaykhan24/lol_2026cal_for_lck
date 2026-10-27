# lol_2026cal_for_lck — 2026 LCK 1군 경기 캘린더

2026년 LCK 1군 경기 일정·스코어를 15분마다 갱신하는 무료 공유 캘린더.

**포함 경기**
- LCK 리그 경기 전부(LCK Cup·정규 시즌·플레이오프 등 lolesports `lck` 리그)
- 국제대회 First Stand·MSI·EWC·Worlds 중 LCK 팀이 나오는 경기
- 국제대회의 TBD 경기(LCK 팀이 들어갈 수 있는 자리). 상대가 확정되어 LCK 팀이 없으면 자동으로 빠진다
- LCK 팀 = 그 해 LCK 리그 경기에 나온 팀 코드. LCK CL(2군)은 제외

**팀별 캘린더**: `docs/teams/<팀코드 소문자>.ics`(목록 `docs/teams.json`). 그 팀 경기 + 그 팀이 나선 대회의 TBD 경기.
안내 페이지에서 팀마다 애플 구독(webcal) / Google "URL로 추가" / 주소 복사 버튼을 제공한다.
- Google·갤럭시(삼성 캘린더는 Google 계정 캘린더로 표시)는 URL 구독이라 Google이 몇 시간~하루 간격으로만 갱신한다. 빠른 갱신이 필요하면 안드로이드 ICSx⁵ 같은 구독 앱 사용
- 팀 코드가 바뀌면(리브랜딩) 새 파일이 생기고 옛 파일은 지우지 않고 마지막 상태로 남는다. 구독자는 새 주소로 다시 구독해야 한다

```
lolesports API ─(15분 cron)→ GitHub Actions → docs/lck.ics + lck.json → GitHub Pages
                                                애플/Outlook: webcal 구독 ←──────┤
                                                Apps Script(15분) → 공유 Google 캘린더 ←┘
```

| 파일 | 역할 |
|---|---|
| `fetch_schedule.py` | API 수집 → `docs/lck.ics`, `docs/lck.json`, `docs/teams/*.ics`, `docs/teams.json` 생성. 실패 시 기존 파일 보존(exit 1), 변경 없으면 `NO_CHANGE` |
| `.github/workflows/update.yml` | 15분 cron + 수동 실행. 변경 시에만 커밋·푸시 |
| `docs/index.html` | 구독 안내 페이지(Pages 루트) |
| `apps-script/Code.gs` | `lck.json` → Google 캘린더 미러(복붙용) |

일정 제목 형식: `[LCK] T1 vs GEN (Bo3)` / `[MSI] T1 vs GEN 🔴 1:0` / `[Worlds] T1 vs GEN (3 : 1)`

## 로컬 실행

```bash
pip install -r requirements.txt
python fetch_schedule.py   # UPDATED: N경기 … 또는 NO_CHANGE
```

## 설정 체크리스트 (사람이 할 일)

- [ ] 1. GitHub **공개** 레포 `lol_2026cal_for_lck` 생성 → 이 폴더 push → Settings › Pages › Source: `Deploy from a branch`, `main` / `/docs`
- [ ] 2. Actions 탭에서 `update-lck-calendar`를 **Run workflow**로 1회 실행 → `https://<user>.github.io/lol_2026cal_for_lck/lck.ics` 열리는지 확인
- [ ] 3. Google 캘린더에서 새 캘린더 "2026 LCK" 생성 → 설정 › 액세스 권한 › "공개 사용 설정" 체크(모든 일정 세부정보 보기) → "캘린더 통합"의 캘린더 ID 복사
- [ ] 4. script.google.com 새 프로젝트 → `apps-script/Code.gs` 붙여넣기 → `JSON_URL`, `CALENDAR_ID` 채움 → `syncLck` 수동 실행(권한 승인) → `installTrigger` 1회 실행(또는 트리거 메뉴에서 시간 기반·15분마다 직접 추가)
  - 첫 동기화는 250건 안팎이라 실행당 100건씩 나눠 들어간다. 로그에 `상한 도달`이 안 나올 때까지 `syncLck`를 몇 번 더 수동 실행하거나 트리거에 맡긴다
- [ ] 5. 캘린더 설정 › "캘린더 통합"의 공개 URL(`?cid=`) 복사 → `docs/index.html`의 `GOOGLE_CAL_URL` placeholder 교체 → push
- [ ] 6. 아이폰에서 webcal 구독 → 설정 › 캘린더 › 계정 › 구독 캘린더 › 새로고침 "15분마다"로 변경(기본값이 더 길 수 있음). 공유할 때 이 안내도 같이

## 검증

- [ ] `docs/lck.ics`를 `icalendar`로 재파싱: 이벤트 수·UID 유일성·DTSTART 정렬
- [ ] https://icalendar.org/validator.html 에 Pages URL을 넣어 경고 0건
- [ ] 완료된 경기 하나를 골라 SUMMARY 스코어가 lolesports.com 표시와 일치
- [ ] Apps Script 첫 동기화 완료 후 `syncLck` 2회 연속 실행 → 두 번째 로그가 `created=0`

## 운영 메모

- GitHub cron은 부하 시 5~15분 늦을 수 있다. 중요한 경기 날은 Actions에서 수동 실행.
- 반영 지연 = cron 15분 + Pages 배포 1분 내외 + 캘린더 앱 갱신 주기.
- 시즌 마지막 경기(보통 Worlds 결승) 종료 +3일이 지나면 스크립트가 `NO_CHANGE`만 낸다. 시즌이 끝나면 Actions 워크플로를 직접 Disable.
- 연도는 `fetch_schedule.py`·`Code.gs`의 `YEAR = 2026` 상수. 다른 해에 쓰려면 레포를 복제해 상수를 바꾼다.
- 대상 리그는 `fetch_schedule.py`의 `LEAGUES`(lolesports slug). 리그 ID는 매 실행 `getLeagues`에서 slug로 찾고, `lck`가 없으면 실패(기존 파일 유지), 국제대회 slug가 없으면 경고 후 건너뛴다.
- API 키는 lolesports.com이 쓰는 공용 키. Riot이 바꾸면 lolesports.com 네트워크 탭에서 `x-api-key`를 확인해 상수 교체.
- TODO: 게임 단위 실시간 점수가 필요하면 `getEventDetails?id=<matchId>` 추가 호출(현재 범위 밖).
