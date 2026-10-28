# lol_2026cal_for_lck — 2026 LCK 1군 경기 캘린더

2026년 LCK 1군 경기 일정·스코어를 자동 갱신하는 무료 공유 캘린더. 경기 중에는 1분 간격, 평소에는 15분 간격.

**포함 경기**
- LCK 리그 경기 전부(LCK Cup·정규 시즌·플레이오프 등 lolesports `lck` 리그)
- 국제대회 First Stand·MSI·EWC·Worlds 중 LCK 팀이 나오는 경기
- 국제대회의 TBD 경기(LCK 팀이 들어갈 수 있는 자리). 상대가 확정되어 LCK 팀이 없으면 자동으로 빠진다
- LCK 팀 = 그 해 LCK 리그 경기에 나온 팀 코드. LCK CL(2군)은 제외

**팀별 캘린더**: `docs/teams/<팀코드 소문자>.ics`(목록 `docs/teams.json`). 그 팀 경기 + 그 팀이 나선 대회의 TBD 경기.
안내 페이지에서 팀마다 애플 구독(webcal) / Google / 주소 복사 버튼을 제공한다.
- Google·갤럭시(삼성 캘린더는 Google 계정 캘린더로 표시): Apps Script가 전체 1개 + 팀별 캘린더를 공개 Google 캘린더로 미러링한다. 데이터는 `lck.json` 한 번 읽어 `teams.json`의 팀별 `ids`대로 나눠 넣고, 경기 중에는 lolesports API를 직접 읽어 스코어를 1분 안에 고친다
- `GOOGLE_LINKS`가 비어 있는 동안 Google 버튼은 ICS를 Google "URL로 추가"하는 링크로 대신한다(Google이 몇 시간~하루 간격으로만 갱신)
- 팀 코드가 바뀌면(리브랜딩) 새 파일이 생기고 옛 파일은 지우지 않고 마지막 상태로 남는다. 구독자는 새 주소로 다시 구독해야 한다

**국제대회 전 경기 캘린더**: `docs/intl.ics`(데이터 `docs/intl.json`). First Stand·MSI·EWC·Worlds의 모든 경기(LCK 팀 여부 무관, TBD 포함).
LCK 캘린더와 따로 구독하며 UID 접미사 `-intl`로 분리한다. Google 미러 키는 `INTL`.

```
Apps Script tick(1분) ─ workflow_dispatch(경기 중 1분 · 평소 15분) ─→ GitHub Actions(fetch_schedule.py) → docs/*.ics + *.json → GitHub Pages
        │                                                                                     애플/Outlook: webcal 구독 ←──┤
        ├─ lck.json + teams.json + intl.json(경기 중 1분 · 평소 5분) ──→ 공개 Google 캘린더(전체 + 팀별 + 국제대회) ←──┘
        └─ 경기 중: lolesports API 직접 → 위 Google 캘린더 스코어 즉시 수정(Pages 배포를 안 기다림)
GitHub cron(*/15)은 예비. 시즌 마지막 경기 +3일 → tick이 트리거 삭제 + 워크플로 Disable
```

| 파일 | 역할 |
|---|---|
| `fetch_schedule.py` | API 수집 → `docs/lck.ics`, `docs/lck.json`, `docs/teams/*.ics`, `docs/teams.json`, `docs/intl.ics`, `docs/intl.json` 생성. 실패 시 기존 파일 보존(exit 1), 변경 없으면 `NO_CHANGE` |
| `.github/workflows/update.yml` | `workflow_dispatch`(Apps Script가 호출) + 예비 15분 cron. 변경 시에만 커밋·푸시. `cancel-in-progress: false`(1분 간격 호출이 진행 중 실행을 끊지 않게) |
| `docs/index.html` | 구독 안내 페이지(Pages 루트) |
| `apps-script/Code.gs` | 1분 트리거 `tick`: GitHub 깨우기 + `lck.json`·`teams.json`·`intl.json` → Google 캘린더 미러 + 경기 중 스코어 즉시 반영 + 시즌 종료 자동 정리(복붙용). `formatMatch_`는 `fetch_schedule.py`의 `to_match`와 같은 문구를 내야 한다 |

일정 제목 형식: `[LCK] T1 vs GEN (Bo3)` / `[MSI] T1 vs GEN 🔴 1:0` / `[Worlds] T1 vs GEN (3 : 1)`

## 로컬 실행

```bash
pip install -r requirements.txt
python fetch_schedule.py   # UPDATED: N경기 … 또는 NO_CHANGE
```

## 설정 체크리스트 (사람이 할 일)

- [ ] 1. GitHub **공개** 레포 `lol_2026cal_for_lck` 생성 → 이 폴더 push → Settings › Pages › Source: `Deploy from a branch`, `main` / `/docs`
- [ ] 2. Actions 탭에서 `update-lck-calendar`를 **Run workflow**로 1회 실행 → `https://<user>.github.io/lol_2026cal_for_lck/lck.ics` 열리는지 확인
- [ ] 3. script.google.com 새 프로젝트 → `apps-script/Code.gs` 붙여넣기(`BASE_URL`·`GITHUB_REPO` 확인) → 왼쪽 **서비스 +** › **Google Calendar API** 추가
- [ ] 3-1. GitHub 토큰 발급 → Apps Script **프로젝트 설정 › 스크립트 속성**에 `GITHUB_TOKEN` 추가(아래 "GitHub 토큰")
- [ ] 4. `setup` 1회 실행(권한 승인) → 캘린더(전체 + LCK 팀 수) 생성·공개 설정·1분 트리거 설치. 내 캘린더 목록에는 전체만 기본 표시. `checkGithub` 실행 → 로그에 `200 {"id":…}`면 토큰 정상
  - 첫 동기화는 700건 안팎이라 실행당 150건씩 나눠 들어간다. 로그에 `이어서`가 안 나올 때까지 `syncAll`을 몇 번 더 수동 실행하거나 트리거에 맡긴다(1~2시간)
- [ ] 5. `logLinks` 실행 → 로그의 JSON을 `docs/index.html`의 `GOOGLE_LINKS = {}`에 붙여 넣기 → push
- [ ] 6. 아이폰에서 webcal 구독 → 설정 › 캘린더 › 계정 › 구독 캘린더 › 새로고침 "15분마다"로 변경(기본값이 더 길 수 있음). 공유할 때 이 안내도 같이

## 검증

- [ ] `docs/lck.ics`를 `icalendar`로 재파싱: 이벤트 수·UID 유일성·DTSTART 정렬
- [ ] https://icalendar.org/validator.html 에 Pages URL을 넣어 경고 0건
- [ ] 완료된 경기 하나를 골라 SUMMARY 스코어가 lolesports.com 표시와 일치
- [ ] Apps Script 첫 동기화 완료 후 `syncAll` 실행 → `변경 없음`(데이터 같으면 캘린더를 건드리지 않음)
- [ ] 다른 Google 계정(또는 시크릿 창)에서 Google 버튼 → 캘린더 추가 → 일정 보이는지

## GitHub 토큰 (Apps Script가 Actions를 깨우는 데 사용)

1. GitHub › Settings › Developer settings › **Personal access tokens › Fine-grained tokens** › Generate new token
2. Resource owner: 레포 소유 계정, Repository access: **Only select repositories** → `lol_2026cal_for_lck`
3. Permissions › Repository permissions › **Actions: Read and write** (Metadata는 자동). 만료는 시즌 종료 이후로
4. 토큰 값을 Apps Script **프로젝트 설정 › 스크립트 속성**에 `GITHUB_TOKEN`으로 저장. 파일·커밋에는 적지 않는다
5. `checkGithub` 실행으로 확인. 토큰이 없거나 만료되면 캘린더 미러는 계속 돌고 Actions만 GitHub cron(수 시간 간격)에 의존한다

## 운영 메모

- **GitHub cron은 믿지 않는다.** 2026-10-27~28 실측 하루 4~5회(5~7시간 간격)만 실행됐다. 그래서 Apps Script가 `workflow_dispatch`로 깨운다. 경기 중 1분, 평소 15분.
- 반영 지연(경기 중): Google 캘린더 ≈ 1분(API 직접 반영). ICS(애플/Outlook) ≈ Actions 1분 + Pages 배포 1분 + Pages CDN 캐시 최대 10분(`cache-control: max-age=600`, 고정) + 앱 갱신 주기.
- Apps Script 무료 계정 한도: 트리거 총 실행 시간 하루 90분, UrlFetch 하루 2만 회. 평소 tick은 0.1초(속성만 읽고 끝), 5분마다 1~2초, 경기 중 매분 3~5초. 실시간 모드는 경기 시작 후 7시간이 지나면 강제 해제(`LIVE_MAX_MS`).
- 실시간 모드 판정은 `lck.json`·`intl.json`에서 아직 `completed`가 아닌 경기의 시작 시각 기준(스크립트 속성 `watch`). 경기 시작 3분 전부터.
- 새 LCK 팀 코드가 생기면 Apps Script가 그 팀 캘린더를 자동으로 만든다. `logLinks`로 링크를 다시 받아 `GOOGLE_LINKS`에 추가.
- 시즌 마지막 경기(보통 Worlds 결승) 종료 +3일이 지나면 `fetch_schedule.py`는 `NO_CHANGE`만 내고, Apps Script `tick`은 트리거를 지우고 워크플로를 Disable 한다(토큰 필요). 바로 끝내려면 `shutdownNow`, 되돌리려면 `installTrigger` + GitHub에서 워크플로 Enable.
- 연도는 `fetch_schedule.py`·`Code.gs`의 `YEAR = 2026` 상수. 다른 해에 쓰려면 레포를 복제해 상수를 바꾼다.
- 대상 리그는 `fetch_schedule.py`의 `LEAGUES`(lolesports slug). 리그 ID는 매 실행 `getLeagues`에서 slug로 찾고, `lck`가 없으면 실패(기존 파일 유지), 국제대회 slug가 없으면 경고 후 건너뛴다.
- API 키는 lolesports.com이 쓰는 공용 키. Riot이 바꾸면 lolesports.com 네트워크 탭에서 `x-api-key`를 확인해 `fetch_schedule.py`·`Code.gs` 두 곳 상수 교체.
- 제목·설명 문구를 바꾸면 `fetch_schedule.py` `to_match`와 `Code.gs` `formatMatch_`를 같이 바꾼다. 다르면 경기 중 두 쪽이 번갈아 덮어쓴다.
- TODO: 게임 단위 실시간 점수가 필요하면 `getEventDetails?id=<matchId>` 추가 호출(현재 범위 밖).
