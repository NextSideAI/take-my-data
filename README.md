# take-my-data

Claude Code, Codex, Pi, OpenCode에서 생성한 본인의 에이전트 코딩 세션을
**[OpenDataReasoningHub](https://opendatareasoninghub.org)**에 기부하는 에이전트 스킬입니다.
공개 데이터셋과 개인·팀 순위표에 반영됩니다.

- 비밀키, 토큰, 이메일, 전화번호, 카드 번호, 홈 디렉터리 사용자명과
  `<system-reminder>` 블록은 전송 전에 **사용자 컴퓨터에서 제거**됩니다.
- 도구 출력은 2,000자로 잘리며 점수에 포함되지 않습니다.
- 마스킹된 전체 내용을 검토하고 사용자가 명시적으로 동의해야만 업로드합니다.
- 기부한 세션은 나중에 철회할 수 있습니다. 철회 시 점수가 취소되고 대화 내용이 삭제됩니다.

## 지원 도구

| 도구 | 읽는 위치·방법 | 중복 방지 처리 |
| --- | --- | --- |
| Claude Code | `~/.claude/projects/**/*.jsonl` | 사이드체인 세션 제외 |
| Codex | `~/.codex/sessions/**/*.jsonl`, 보관된 세션 | 하위 에이전트 세션 제외 |
| Pi | `~/.pi/agent/sessions/**/*.jsonl` | 현재 활성 브랜치만 사용 |
| OpenCode | `opencode session list`, `opencode export` | 자식 세션 제외 |

OpenCode 세션을 읽으려면 `opencode` 실행 파일이 `PATH`에 있어야 합니다. 나머지 도구는
로컬 JSONL 파일을 직접 읽습니다. 현재 Codex 세션과 최근 10분 안에 수정된 활성 세션은 기본적으로 제외됩니다.

## 설치

가장 간단한 방법은 다음 명령입니다.

```bash
npx skills add nextsideai/take-my-data
```

직접 설치하려면 사용하는 에이전트의 개인 스킬 폴더에 저장소를 복제합니다.

```bash
# Claude Code
git clone https://github.com/nextsideai/take-my-data ~/.claude/skills/take-my-data

# Codex
git clone https://github.com/nextsideai/take-my-data ~/.codex/skills/take-my-data

# Pi
git clone https://github.com/nextsideai/take-my-data ~/.pi/agent/skills/take-my-data

# OpenCode
git clone https://github.com/nextsideai/take-my-data ~/.config/opencode/skills/take-my-data
```

Node.js 18.3 이상이 필요하며 별도 패키지 의존성은 없습니다.

## 사용법

에이전트에서 다음과 같이 요청할 수 있습니다.

```text
/take-my-data
/take-my-data all
/take-my-data withdraw 123
```

기본 실행은 현재 작업 폴더와 연결된 네 도구의 세션을 한 번에 찾습니다. `all`은 모든
프로젝트를 찾습니다. 에이전트 없이 명령줄에서 직접 실행할 수도 있습니다.

```bash
node scripts/donate.mjs login
node scripts/donate.mjs preview
node scripts/donate.mjs dump 1
node scripts/donate.mjs donate --yes --pick 1,2
node scripts/donate.mjs withdraw 123
```

특정 도구만 찾으려면 `--harness`를 사용합니다.

```bash
node scripts/donate.mjs preview --harness codex
node scripts/donate.mjs preview --harness pi,opencode --all
```

사용 가능한 값은 `claude_code`, `codex`, `pi`, `opencode`입니다. `--include-active`는
최근 10분 안에 수정된 세션도 포함하고, `--origin http://localhost:3000` 또는
`ODRH_ORIGIN`은 다른 허브를 지정합니다.

## 업로드되는 정보

세션별로 정제된 `user`·`assistant`·`tool` 대화, 어시스턴트의 추론 텍스트와 도구 호출 입력,
모델명, 하네스 버전, 시간이 업로드됩니다. 작업 폴더, Git 브랜치, 호스트명, 사용자명,
2,000자를 넘는 원본 도구 출력, 하위 에이전트 대화, 명령 에코는 업로드하지 않습니다.

세션은 `sha256("<harness>:" + sessionId)`로 중복을 판별하므로 서로 다른 도구에서 같은
세션 식별자를 사용해도 충돌하지 않습니다. 같은 세션은 최초 기부자에게 한 번만 인정됩니다.

## 데이터 라이선스

업로드한 세션은 **[CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/)**에 따라
퍼블릭 도메인으로 공개됩니다. 미리보기와 동의 질문에 라이선스가 표시되며, 익명 설정이
아니면 GitHub 사용자명이 기여자로 표시됩니다. 철회한 세션은 이후 데이터셋에서 제거됩니다.

클라이언트는 `GET /api/dataset`에서 현재 라이선스를 확인합니다. 허브의 라이선스가 바뀌면
이전 동의를 재사용하지 않고 다시 동의를 받습니다.

## 점수

| 항목 | 기준 |
| --- | --- |
| 세션 점수 | 사용 가능 토큰 × 가중치 ÷ 1,000점 |
| 가중치 | 의미 품질 검사 통과 시 1.0, 그 외 0.7 |
| 최소 기준 | 대화 3턴, 사용 가능 토큰 500개, 반복 비율 60% 이하 |
| 보너스 | 첫 승인 기부 +50점, 창립 멤버 조건 충족 시 +300점 |
| 제한 | 계정당 시간당 50요청, 요청당 최대 5세션 |

전체 규칙과 다른 하네스를 위한 API는 [기부 안내](https://opendatareasoninghub.org/donate)에서 확인할 수 있습니다.

## 구성

```text
SKILL.md                  에이전트 실행 절차와 필수 안전 규칙
scripts/donate.mjs        명령줄 프로그램
scripts/lib/transcript.mjs 네 가지 하네스 세션 검색·변환
scripts/lib/sanitize.mjs  로컬 마스킹과 품질 측정
scripts/lib/api.mjs       로그인, 토큰 저장, HTTP 통신
test/                     파서와 마스킹 테스트
```

## 라이선스

MIT
