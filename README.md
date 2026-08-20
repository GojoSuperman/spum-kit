# spum-kit

**[SPUM Studio](https://spum.soonsoon.ai) 를 코드로 몰아, AI 조감도 한 장을 게임 맵으로 만드는 Claude Code 킷.**

타일을 반복해 까는 방식과 달리, 씬 전체를 한 장으로 그려 32×32 격자로 잘라
**1024칸을 각각 고유 타일로** 등록한다. 완성된 일러스트가 그대로 맵이 된다.
통행 판정(걷기 가능/막힘)까지 자동으로 붙는다.

```
① 씬 조감도 생성 (AI)          ④ 통행 판정 · 고립 구역 잇기
② 참조본 512² 축소             ⑤ Studio 주입
③ 통행 마스크 생성 (img2img)   ⑥ 새로고침 · 확인 스크린샷
```

창 하나가 뜨고 전 과정이 이어진다. 사람이 전부 지켜볼 수 있다.

## 설치

새 프로젝트 폴더에서:

```bash
rm -rf /tmp/spum-kit && git clone --depth 1 https://github.com/GojoSuperman/spum-kit.git /tmp/spum-kit \
  && bash /tmp/spum-kit/install.sh
```

스킬(`.claude/skills/spum-map/`) · 파이프라인(scripts 6 + src 7) · npm scripts ·
`.gitignore` 가 놓이고 의존성(playwright 포함)까지 깔린다.

요구 환경: Node 22+, [Claude Code](https://claude.com/claude-code), SPUM 계정.
새 리눅스/WSL 이면 크롬 구동용 시스템 라이브러리도 한 번 깐다: `npx playwright install-deps`

## 로그인 — 계정당 한 번

**API 키가 필요 없다.** 인증은 브라우저 SSO 세션이다:

```bash
npm run studio-login      # 창이 뜨면 이메일 매직링크를 누른다
```

로그인 프로필은 **홈 공용 `~/.spum-studio/`** 에 저장된다. 프로젝트를 새로 파도
다시 로그인하지 않는다. 위치를 바꾸려면 `SPUM_STUDIO_HOME` 환경변수.

## 쓰기

설치한 폴더에서 `claude` 를 띄우고:

> **"이런 느낌으로 맵 만들어줘"**

스킬이 구역 구성·분위기를 몇 가지 묻고, 프롬프트 초안을 보여준 뒤 실행한다.
직접 돌리려면:

```bash
npm run scene-map -- --name "<맵 이름>" --prompt-file <파일> --headed --record --quality medium
```

`prompts/` 에 검증된 예시 프롬프트 5개가 들어 있다 (산동네 마을 · 미래 도시 · 판타지 시장 광장 ·
다다미 집 · 성주의 거처). 우주선 실내·중세 여관 골격은 스킬의 `references/프롬프트 예시.md` 에 있다.
`--dry-run` 은 그림만 만들고 주입하지 않는다.

### 결과 확인

- `out/scene-walkmask-<맵>.png` — 통행 판정 오버레이. **초록=통행 · 빨강=막힘 ·
  노랑=자동으로 뚫은 문 · 주황=잇지 않고 막은 고립 조각.** 주입 전에 꼭 눈으로 본다.
- `out/scene-final-<맵>.png` — 주입 후 Studio 렌더 스크린샷.
- Studio 를 직접 보려면 `npm run studio-open` (자동화와 같은 프로필이라 안전하다).

## 실측으로 배운 것 (겪고 나서 적음)

| 증상/규칙 | 내용 |
|---|---|
| 프롬프트 **520자 이하** | 507자에서 `504`, 446~488자 성공. 구역 배치를 남기고 수식어를 줄인다 |
| `504 Gateway Timeout` | 프롬프트보다 먼저 **`--quality medium`** 으로 낮춘다. 504 여도 과금은 된다 |
| `413 Payload Too Large` | 업로드 한도 base64 1MiB ≈ 파일 780KB. 스크립트가 512² 축소 + 초과 시 JPEG 재인코딩까지 자동 처리 |
| 마스크가 죽었을 때 | `--scene <씬 PNG>` 로 씬 생성 과금 없이 마스크부터 재개 |
| **세션은 로그인 후 약 30분** | 서버가 끊는다 (15분에 쿠키 회전 1회 → 30분 종료, 계측). 준비를 먼저 끝내고 로그인 직후 몰아서 반영한다 |
| 계정당 세션 하나 | 다른 브라우저로 Studio 에 로그인하면 자동화 세션이 죽는다 |
| **동시 실행 금지** | `studio-open` 창을 열어둔 채 다른 스크립트를 돌리면 저장이 어디에도 안 남는다 (스크립트가 시작 전에 막는다) |
| 다른 기기와 오갈 때 | 동기화가 append-only 라 낡은 로컬로 열면 낡은 게 최신이 된다 — 시작 전 `npm run studio-pull` ([문서](docs/Studio%20%EB%A5%BC%20%EB%91%90%20%EA%B3%B3%EC%97%90%EC%84%9C%20%EC%93%B0%EA%B8%B0.md)) |
| `Classify` 는 누르지 않는다 | 분류기가 러그를 장애물로, 돌바닥을 blocked 로 붙인 사례 |
| 밝은 씬일수록 좋다 | 마스크 정확도가 밝기에 비례한다. 야외 맵은 물·잔디 판정을 꼭 확인 |
| 비용 | 씬 맵 하나 약 250쌤 — 쌤(SSAM)은 SPUM 계정의 AI 생성 크레딧이다 (조감도 125 + 마스크 125). 저장소는 localStorage 약 5MB, 맵 하나 ~550KB |

## 통행 판정이 하는 일

- AI 마스크(img2img)로 걷기/막힘을 가른다 — 씬 픽셀만으로 추정하면 실패한다 (실측: 통행 0칸)
- 칸의 **흰 픽셀 35% 이상**이면 통행 — 길 가장자리가 잘려 통로가 1칸으로 좁아지는 것을 막는다
- 고립 구역은 **밝은 칸(실제 문 자리일 곳)을 골라** 뚫어 잇고, 뚫은 칸은
  **타일 그림을 이웃 바닥으로 갈아 끼워** 개구부가 실제로 보이게 한다
- 이어지지 않는 부스러기 조각은 막는다 (캐릭터가 갇히지 않게)

## 구성

```
.claude/skills/spum-map/   스킬 — "맵 만들어줘" 의 진입점
scripts/                   make-scene-map · scene-to-map · studio-login/open/pull/apply
src/                       studio-browser · studio-scene · studio-backup · png · image-io · auto-connect · roles
prompts/                   검증된 예시 프롬프트
docs/                      Studio 를 두 곳에서 쓰기
install.sh                 새 프로젝트에 킷 심기
```

## 라이선스

MIT — [LICENSE](LICENSE)
