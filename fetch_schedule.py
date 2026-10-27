#!/usr/bin/env python3
"""lolesports API에서 2026년 LCK 1군 경기 일정을 받아 docs/lck.ics, docs/lck.json을 만든다.

대상: LCK 리그 경기 전부 + 국제대회(First Stand·MSI·EWC·Worlds) 중 LCK 팀이 나오는 경기.
LCK 팀은 그 해 LCK 리그 경기에 나온 팀 코드로 정한다(LCK CL·2군 제외, 팀명 변경 자동 반영).
국제대회의 TBD 경기는 LCK 팀이 들어갈 수 있으므로 포함하고, 상대가 확정되어 LCK 팀이 없으면 빠진다.

- 실패(네트워크·파싱·0건) 시 기존 파일을 건드리지 않고 exit 1.
- 결과가 기존 파일과 같으면(DTSTAMP 제외) 쓰지 않고 stdout에 NO_CHANGE.
- 마지막 경기 종료 +3일이 지나면 NO_CHANGE로 끝낸다(Actions 끄는 건 사람이).
"""
import json
import os
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

import requests

API_BASE = "https://esports-api.lolesports.com/persisted/gw"
# 공용 키, Riot이 바꾸면 lolesports.com 네트워크 탭에서 재확인
API_KEY = "0TvQnueqKa5mxJntVWt0w4LpLfEkrV1Ta8rQBb9Z"
YEAR = 2026
DOMESTIC = "lck"
# slug → 일정 제목 앞에 붙는 표기. 리그 ID는 매 실행 getLeagues에서 slug로 찾는다.
LEAGUES = {
    "lck": "LCK",
    "first_stand": "FST",
    "msi": "MSI",
    "ewc_lol": "EWC",
    "worlds": "Worlds",
}
MAX_PAGES = 10  # 리그별
GRACE_AFTER_END = timedelta(days=3)

KST = timezone(timedelta(hours=9))  # 한국은 DST 없음
DURATION = {1: timedelta(hours=1, minutes=30), 3: timedelta(hours=2, minutes=30), 5: timedelta(hours=4)}
SCHEDULE_URL = "https://lolesports.com/ko-KR/schedule"

DOCS = Path(__file__).resolve().parent / "docs"
ICS_PATH = DOCS / "lck.ics"
JSON_PATH = DOCS / "lck.json"


class FetchError(Exception):
    pass


# ── 수집 ──────────────────────────────────────────────────────────────

def get_json(endpoint, **params):
    try:
        res = requests.get(
            f"{API_BASE}/{endpoint}",
            params={"hl": "ko-KR", **params},
            headers={"x-api-key": API_KEY},
            timeout=20,
        )
        res.raise_for_status()
        return res.json()
    except (requests.RequestException, ValueError) as e:
        raise FetchError(f"{endpoint} 실패: {e}") from e


def league_ids():
    try:
        leagues = get_json("getLeagues")["data"]["leagues"]
    except (KeyError, TypeError) as e:
        raise FetchError(f"getLeagues 응답 구조 이상: {e}") from e
    ids = {l.get("slug"): l.get("id") for l in leagues if l.get("slug") in LEAGUES}
    if DOMESTIC not in ids:
        raise FetchError("getLeagues에 lck 리그가 없음")
    for slug in LEAGUES.keys() - ids.keys():
        print(f"WARN: 리그 {slug} 없음 — 건너뜀", file=sys.stderr)
    return ids


def get_schedule_page(league_id, token=None):
    params = {"leagueId": league_id}
    if token:
        params["pageToken"] = token
    try:
        schedule = get_json("getSchedule", **params)["data"]["schedule"]
        return schedule["events"], schedule.get("pages") or {}
    except (KeyError, TypeError) as e:
        raise FetchError(f"getSchedule 응답 구조 이상: {e}") from e


def fetch_league(slug, league_id):
    """첫 페이지에서 older(과거)·newer(미래) 토큰을 따라가며 YEAR년 경기를 모은다."""
    events, pages = get_schedule_page(league_id)
    collected = list(events)
    count = 1
    for direction in ("older", "newer"):
        token = pages.get(direction)
        page_events = events
        while token and count < MAX_PAGES:
            # 과거 방향은 이미 이전 연도 이벤트가 보이면 더 갈 필요 없음
            if direction == "older" and any(year_of(e) < YEAR for e in page_events):
                break
            page_events, page_info = get_schedule_page(league_id, token)
            count += 1
            collected.extend(page_events)
            token = page_info.get(direction)

    matches = {}
    for e in collected:
        # leagueId 필터를 걸어도 다른 리그가 섞이는 경우가 있음
        if e.get("type") != "match" or (e.get("league") or {}).get("slug") != slug:
            continue
        if year_of(e) != YEAR or not (e.get("match") or {}).get("id"):
            continue
        matches[e["match"]["id"]] = e  # 페이지 경계 중복 제거
    return list(matches.values())


def team_codes(event):
    return [t.get("code") or "TBD" for t in (event["match"].get("teams") or [])] or ["TBD"]


def fetch_events():
    ids = league_ids()
    domestic = fetch_league(DOMESTIC, ids[DOMESTIC])
    lck_teams = {c for e in domestic for c in team_codes(e)} - {"TBD"}
    if not lck_teams:
        raise FetchError(f"{YEAR}년 LCK 경기에서 팀을 찾지 못함")

    events = list(domestic)
    for slug, league_id in ids.items():
        if slug == DOMESTIC:
            continue
        for e in fetch_league(slug, league_id):
            codes = team_codes(e)
            if "TBD" in codes or lck_teams.intersection(codes):
                events.append(e)
    return events, lck_teams


def year_of(event):
    return parse_time(event["startTime"]).astimezone(KST).year


def parse_time(s):
    return datetime.fromisoformat(s.replace("Z", "+00:00"))


# ── 변환 ──────────────────────────────────────────────────────────────

def to_match(e):
    m = e["match"]
    slug = e["league"]["slug"]
    league_name = e["league"].get("name") or LEAGUES[slug]
    teams = (m.get("teams") or []) + [{}, {}]
    t1, t2 = teams[0], teams[1]
    code1, code2 = t1.get("code") or "TBD", t2.get("code") or "TBD"
    name1, name2 = t1.get("name") or code1, t2.get("name") or code2
    wins1 = ((t1.get("result") or {}).get("gameWins")) or 0
    wins2 = ((t2.get("result") or {}).get("gameWins")) or 0
    best_of = (m.get("strategy") or {}).get("count") or 1
    state = e.get("state") or "unstarted"
    block = e.get("blockName") or ""
    tag = LEAGUES[slug]

    if state == "completed":
        title = f"[{tag}] {code1} vs {code2} ({wins1} : {wins2})"
    elif state == "inProgress":
        title = f"[{tag}] {code1} vs {code2} 🔴 {wins1}:{wins2}"
    else:
        title = f"[{tag}] {code1} vs {code2} (Bo{best_of})"

    round_name = f"{league_name} · {block}" if block else league_name
    lines = [round_name, f"{name1} vs {name2}", SCHEDULE_URL]
    if state == "completed":
        winner = next((t.get("code") for t in (t1, t2) if (t.get("result") or {}).get("outcome") == "win"), None)
        if winner:
            lines.insert(0, f"승: {winner}")

    start = parse_time(e["startTime"]).astimezone(KST)
    end = start + DURATION.get(best_of, DURATION[1])
    return {
        "id": m["id"],
        "start": start.isoformat(),
        "end": end.isoformat(),
        "title": title,
        "description": "\n".join(lines),
        "round": round_name,
        "league": tag,
        "state": state,
    }


# ── ICS 생성 ──────────────────────────────────────────────────────────

def escape_text(s):
    return s.replace("\\", "\\\\").replace(";", "\\;").replace(",", "\\,").replace("\n", "\\n")


def fold(line):
    """RFC 5545: 75옥텟마다 CRLF + 공백. UTF-8 문자 중간에서 자르지 않는다."""
    out, cur, size = [], "", 0
    for ch in line:
        n = len(ch.encode("utf-8"))
        limit = 75 if not out else 74  # 이어지는 줄은 앞 공백 1옥텟 포함
        if size + n > limit:
            out.append(cur)
            cur, size = "", 0
        cur += ch
        size += n
    out.append(cur)
    return "\r\n ".join(out)


def ics_local(iso):
    return datetime.fromisoformat(iso).strftime("%Y%m%dT%H%M%S")


def build_ics(matches, now):
    dtstamp = now.astimezone(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    lines = [
        "BEGIN:VCALENDAR",
        "VERSION:2.0",
        "PRODID:-//lol_2026cal_for_lck//LCK Schedule//KO",
        "CALSCALE:GREGORIAN",
        "METHOD:PUBLISH",
        f"X-WR-CALNAME:{YEAR} LCK 1군 경기 일정",
        "X-WR-TIMEZONE:Asia/Seoul",
        "X-PUBLISHED-TTL:PT15M",
        "REFRESH-INTERVAL;VALUE=DURATION:PT15M",
        "BEGIN:VTIMEZONE",
        "TZID:Asia/Seoul",
        "X-LIC-LOCATION:Asia/Seoul",
        "BEGIN:STANDARD",
        "TZOFFSETFROM:+0900",
        "TZOFFSETTO:+0900",
        "TZNAME:KST",
        "DTSTART:19700101T000000",
        "END:STANDARD",
        "END:VTIMEZONE",
    ]
    for m in matches:
        lines += [
            "BEGIN:VEVENT",
            f"UID:lol-{m['id']}@lol_2026cal_for_lck",
            f"DTSTAMP:{dtstamp}",
            f"DTSTART;TZID=Asia/Seoul:{ics_local(m['start'])}",
            f"DTEND;TZID=Asia/Seoul:{ics_local(m['end'])}",
            f"SUMMARY:{escape_text(m['title'])}",
            f"DESCRIPTION:{escape_text(m['description'])}",
            f"LOCATION:{escape_text(m['round'])}",
            f"SEQUENCE:{1 if m['state'] == 'completed' else 0}",
            "END:VEVENT",
        ]
    lines.append("END:VCALENDAR")
    return "".join(fold(l) + "\r\n" for l in lines)


def without_dtstamp(ics):
    return "\r\n".join(l for l in ics.split("\r\n") if not l.startswith("DTSTAMP:"))


# ── 실행 ──────────────────────────────────────────────────────────────

def read_text(path):
    try:
        return path.read_bytes().decode("utf-8")
    except FileNotFoundError:
        return None


def write_atomic(path, text):
    tmp = path.with_suffix(path.suffix + ".tmp")
    with open(tmp, "w", encoding="utf-8", newline="") as f:
        f.write(text)
    os.replace(tmp, path)


def main():
    now = datetime.now(timezone.utc)
    try:
        events, lck_teams = fetch_events()
    except FetchError as e:
        print(f"ERROR: {e}", file=sys.stderr)
        return 1

    try:
        matches = sorted((to_match(e) for e in events), key=lambda m: (m["start"], m["id"]))
    except (KeyError, TypeError, ValueError) as e:
        print(f"ERROR: 이벤트 변환 실패: {e}", file=sys.stderr)
        return 1

    if now > max(datetime.fromisoformat(m["end"]) for m in matches) + GRACE_AFTER_END:
        print("NO_CHANGE (시즌 마지막 경기 +3일 경과)")
        return 0

    ics = build_ics(matches, now)
    js = json.dumps(matches, ensure_ascii=False, indent=2) + "\n"
    old_ics = read_text(ICS_PATH)
    if old_ics is not None and without_dtstamp(old_ics) == without_dtstamp(ics) and read_text(JSON_PATH) == js:
        print("NO_CHANGE")
        return 0

    DOCS.mkdir(exist_ok=True)
    write_atomic(JSON_PATH, js)
    write_atomic(ICS_PATH, ics)
    by_league = {tag: sum(m["league"] == tag for m in matches) for tag in LEAGUES.values()}
    states = {s: sum(m["state"] == s for m in matches) for s in ("completed", "inProgress", "unstarted")}
    print(f"UPDATED: {len(matches)}경기 {by_league} {states} LCK팀={sorted(lck_teams)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
