# Studio 를 두 곳에서 쓰기 — 자동화 창과 내 브라우저

Studio 작업은 **자동화 창**(Playwright 가 띄우는 Chromium)과 **사람의 평소 브라우저** 두 곳에서
할 수 있다. 이 문서는 둘을 오갈 때 작업이 사라지지 않게 하는 절차다.

2026-08-20 에 실제로 사고가 났고, 그때 코드를 뜯어 확인한 사실들을 근거로 적는다.

## 알아야 할 세 가지 (실측)

### ① 동기화는 append-only — 여는 쪽이 이긴다

부팅할 때 로컬과 서버가 다르면 Studio 는 **서버를 읽어오지 않는다.** 로컬을 새 리비전으로
서버에 얹는다. `studio/main.js` 의 주석이 명시한다:

```js
// #55 append model: diverged at boot too. The ledger is append-only, so instead
// of a manual-merge dead-stop, append local as a NEW revision on top of the
// server's current one — the server's previous version stays recoverable in
// ledger history.
_markServerStudioDirty('boot-diverge-append');
```

화면 하단에 이렇게 뜬다:

```
서버와 로컬이 달라 로컬을 새 리비전으로 저장했습니다(이전 서버 버전은 히스토리에 보존) · rev 79
```

그래서 **낡은 로컬을 가진 브라우저로 Studio 를 열면 그 낡은 상태가 최신 리비전이 된다.**
실제로 맵 5개가 있던 rev 76 위에, 옛 맵 하나뿐인 브라우저가 rev 78 을 얹었다.
덮어쓰기가 아니라 append 라 **잃지는 않지만**, 다음에 여는 쪽은 낡은 것을 보게 된다.

### ② 로그인은 계정당 하나

사람이 자기 브라우저로 로그인하면 **자동화 세션이 죽는다** (실측: `/api/me → {"user":null}`,
`/api/studio/state → 401 login_required`). SSO 는 이메일 매직링크라 재로그인에 사람 손이 든다.

### ③ 같은 프로필을 두 크롬이 잡으면 저장이 유실된다

이건 자동화 프로필 안의 이야기다 (`npm run studio-open` 창을 열어둔 채 스크립트를 돌리는 경우).
스크립트가 시작 전에 막아준다. 문서 1-2절 참고.

## 절차 — 자동화 → 내 브라우저

1. **자동화 창을 완전히 닫는다.** 크롬 프로세스가 남아 있지 않은지 본다:

   ```bash
   ps -eo pid,cmd | grep -F "user-data-dir=$PWD/.browser/profile" | grep -v grep
   ```

2. 서버의 **현재 리비전 번호**를 확인해 적어둔다:

   ```bash
   npm run studio-pull -- --list      # ▶ 표시가 활성 리비전
   ```

3. 브라우저로 `spum.soonsoon.ai/studio/` 로그인. 이때 **그 브라우저의 낡은 로컬이 새 리비전으로
   올라간다** — 정상이다. 놀라지 않아도 된다. 2번에서 적어둔 리비전은 히스토리에 남아 있다.

4. 우상단 **계정 메뉴 → 리비전 목록**에서 2번의 리비전을 찾아 **`복구`** 를 누른다.
   그 브라우저의 로컬이 그 상태가 되고, 다시 최신 리비전으로 올라간다.

5. 작업한다. 한글 입력은 이쪽에서만 된다 (자동화 창은 WSLg 라 IME 가 없다).

## 절차 — 내 브라우저 → 자동화

1. **Studio 탭을 닫는다.**

2. 자동화 재로그인 (세션이 죽어 있다):

   ```bash
   npm run studio-login          # 창이 뜨면 매직링크를 누른다
   ```

3. **서버 최신을 로컬로 당겨온다.** 이 단계를 빼먹으면 자동화의 낡은 로컬이 다시 얹힌다:

   ```bash
   npm run studio-pull -- --dry-run   # 무엇이 바뀌는지 먼저 본다
   npm run studio-pull                # 활성 리비전을 로컬에 반영
   ```

4. 작업한다.

## `npm run studio-pull`

서버 리비전을 이 프로필의 localStorage 로 가져온다. **앱을 띄우지 않고** 쓰기 때문에
가져오는 도중에 동기화가 끼어들지 않는다.

| 명령 | 동작 |
|---|---|
| `npm run studio-pull` | 활성 리비전을 가져온다 |
| `npm run studio-pull -- --list` | 리비전 20개를 나열한다 (가져오지 않음) |
| `npm run studio-pull -- --revision 79` | 특정 리비전을 가져온다 |
| `npm run studio-pull -- --dry-run` | 무엇이 바뀔지만 보여준다 |
| `npm run studio-pull -- --replace` | 서버에 없는 Studio 로컬 키도 지운다 (기본은 병합) |

- 쓰기 전에 현재 로컬 전체를 `out/backups/studio-before-pull-<시각>.json` 에 백업한다.
- 기본이 **병합**인 이유: `spum-map-theme-source-state:*` 같은 편집기 작업본은 서버 상태에
  들어 있지 않다. `--replace` 를 쓰면 그것들이 지워진다.
- localStorage 한도(약 5MB)에 걸리면 어떤 키가 실패했는지 알려주고 종료한다.

## 더 단순한 길 — 창 하나만 쓴다

절차가 번거로우면 **자동화 창 하나로 통일**하는 방법이 있다. 동기화도 세션도 문제가 없다.

```bash
npm run studio-open        # 사람이 직접 조작. 다 보면 창을 닫는다
```

또는 맵 생성 파이프라인 끝에 창을 남긴다:

```bash
npm run scene-map -- --name "..." --prompt-file <파일> --headed --quality medium --keep-open
```

걸림돌은 **한글 입력**이다. WSLg 로 띄운 Chromium 에는 IME 가 붙지 않아 한글이 안 쳐진다.
대안 두 가지:

- Windows 에서 복사 → 그 창에서 `Ctrl+V` (WSLg 클립보드가 살아 있으면 된다. 미검증)
- 문구를 Claude 에게 주고 Playwright 로 넣게 한다 (IME 를 안 거치므로 확실하다)

## 사고가 났을 때

작업이 사라진 것처럼 보여도 **거의 항상 남아 있다.** 확인 순서:

1. `npm run studio-pull -- --list` — 서버 리비전 히스토리에서 맞는 시각·크기를 찾는다
   (맵이 든 리비전은 2MB 대, 빈 것은 500KB 대라 크기로도 구분된다)
2. `npm run studio-pull -- --revision <번호> --dry-run` 으로 내용을 확인하고 가져온다
3. 서버에도 없으면 `out/backups/*.json` (로컬 전체 백업) 과 `out/scene-map-*.json` (맵 레코드),
   `out/assets-studio/*.png` (비용을 들여 만든 원본 그림) 이 남아 있다
