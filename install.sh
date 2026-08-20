#!/usr/bin/env bash
#
# SPUM 맵 킷을 현재 폴더에 설치한다 — 새 프로젝트에서 "맵 만들어줘" 가 바로 되게.
#
# 쓰는 법 (새 폴더에서):
#   git clone --depth 1 https://github.com/GojoSuperman/spum-kit.git /tmp/spum-kit \
#     && bash /tmp/spum-kit/install.sh
#
# 설치되는 것:
#   .claude/skills/spum-map/   스킬 (Claude Code 가 "맵 만들어줘" 에 반응하게 하는 것)
#   scripts/ (6) · src/ (7)    파이프라인
#   package.json               scene-map / studio-login / studio-open / studio-pull / studio-apply
#   .gitignore                 out/ 등
#
# 로그인 프로필은 **홈 공용**(~/.spum-studio)이라 프로젝트마다 다시 로그인하지 않는다.
# SPUM_STUDIO_HOME 로 위치를 바꿀 수 있다.

set -euo pipefail

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEST="$(pwd)"

if [ "$SRC" = "$DEST" ]; then
  echo "여기는 킷 원본 저장소입니다. 설치할 새 폴더로 이동해서 실행하세요." >&2
  exit 1
fi

echo "설치: $SRC  →  $DEST"

# ── 1. 스킬 ────────────────────────────────────────────────
mkdir -p "$DEST/.claude/skills"
cp -r "$SRC/.claude/skills/spum-map" "$DEST/.claude/skills/"
echo "  ✓ 스킬        .claude/skills/spum-map/"

# ── 2. 파이프라인 ──────────────────────────────────────────
# ★ src 목록은 import 그래프가 닫히도록 유지한다 (2026-08-21: auto-connect →
#   roles, image-io 가 빠져 설치본이 깨졌던 것을 고침).
mkdir -p "$DEST/scripts" "$DEST/src"
for f in make-scene-map scene-to-map studio-login studio-open studio-pull studio-apply; do
  cp "$SRC/scripts/$f.mjs" "$DEST/scripts/"
done
for f in studio-browser studio-scene studio-backup png image-io auto-connect roles; do
  cp "$SRC/src/$f.mjs" "$DEST/src/"
done
echo "  ✓ 스크립트    scripts/ (6) · src/ (7)"

# ── 3. 참고 문서 ───────────────────────────────────────────
mkdir -p "$DEST/docs"
cp "$SRC/docs/Studio 를 두 곳에서 쓰기.md" "$DEST/docs/" 2>/dev/null || true
echo "  ✓ 문서        docs/"

# ── 4. package.json ────────────────────────────────────────
if [ ! -f "$DEST/package.json" ]; then
  cat > "$DEST/package.json" <<'JSON'
{
  "name": "spum-map-project",
  "private": true,
  "type": "module",
  "scripts": {
    "scene-map": "node scripts/make-scene-map.mjs",
    "studio-login": "node scripts/studio-login.mjs",
    "studio-open": "node scripts/studio-open.mjs",
    "studio-pull": "node scripts/studio-pull.mjs",
    "studio-apply": "node scripts/studio-apply.mjs"
  },
  "dependencies": { "jpeg-js": "^0.4.4" },
  "devDependencies": { "playwright": "^1.62.1" }
}
JSON
  echo "  ✓ package.json 새로 만듦"
else
  node - "$DEST/package.json" <<'NODE'
const fs = require('node:fs');
const f = process.argv[2];
const p = JSON.parse(fs.readFileSync(f, 'utf8'));
p.type ||= 'module';
p.scripts = {
  'scene-map': 'node scripts/make-scene-map.mjs',
  'studio-login': 'node scripts/studio-login.mjs',
  'studio-open': 'node scripts/studio-open.mjs',
  'studio-pull': 'node scripts/studio-pull.mjs',
  'studio-apply': 'node scripts/studio-apply.mjs',
  ...(p.scripts || {}),
};
p.dependencies = { 'jpeg-js': '^0.4.4', ...(p.dependencies || {}) };
p.devDependencies = { playwright: '^1.62.1', ...(p.devDependencies || {}) };
fs.writeFileSync(f, JSON.stringify(p, null, 2) + '\n');
NODE
  echo "  ✓ package.json 에 스크립트 병합 (기존 값 우선)"
fi

# ── 5. .gitignore ──────────────────────────────────────────
touch "$DEST/.gitignore"
for line in "node_modules/" "out/" ".browser/" ".env" ".env.local" ".claude/settings.local.json"; do
  grep -qxF "$line" "$DEST/.gitignore" || echo "$line" >> "$DEST/.gitignore"
done
echo "  ✓ .gitignore"

mkdir -p "$DEST/prompts" "$DEST/out"

# ── 6. 설치 ────────────────────────────────────────────────
echo ""
echo "의존성 설치 중… (playwright 브라우저 포함, 처음엔 몇 분 걸립니다)"
cd "$DEST"
npm install --silent
npx playwright install chromium >/dev/null 2>&1 || npx playwright install chromium

# ── 7. 안내 ────────────────────────────────────────────────
PROFILE="${SPUM_STUDIO_HOME:-$HOME/.spum-studio}"
echo ""
echo "설치 끝."
if [ -d "$PROFILE/profile" ]; then
  echo "  로그인 프로필이 이미 있습니다 ($PROFILE) — 재로그인 없이 바로 씁니다."
  echo ""
  echo "  다음: 이 폴더에서 claude 를 실행하고 \"맵 만들어줘\" 라고 하세요."
else
  echo "  로그인 프로필이 없습니다. 한 번만 로그인하면 이후 모든 프로젝트에서 재사용됩니다:"
  echo ""
  echo "      npm run studio-login        # 창이 뜨면 이메일 매직링크를 누르세요"
  echo ""
  echo "  그다음 이 폴더에서 claude 를 실행하고 \"맵 만들어줘\" 라고 하세요."
fi
echo ""
echo "  다른 곳에서 Studio 를 만졌다면 시작 전에:  npm run studio-pull"
