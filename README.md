# 🐝 Spelling Bee Practice (PWA)

앱이 "Spell ___"라고 단어를 읽어주면 아이가 소리 내서 스펠링을 말하고, 앱이 맞았는지 틀렸는지 알려줍니다.
틀리거나 어려워한 단어는 오답노트에 자동으로 모이고, 복습 모드로 따로 연습할 수 있습니다.
기록은 Google Cloud(Firebase)에 저장되어 여러 기기에서 같이 보입니다.

## 파일 구성
| 파일 | 역할 |
|---|---|
| `words.json` | 단어 데이터 450개 (Scripps 2026-27 School Study List) |
| `grader.js` | 음성 → 알파벳 변환, 채점 |
| `store.js` | 저장 (Firebase 또는 이 기기만) |
| `app.js` / `index.html` / `style.css` | 화면 |
| `config.js` | **Firebase 설정을 붙여 넣는 곳** |
| `firestore.rules` | Firestore 보안 규칙 (콘솔에 붙여 넣기) |
| `manifest.json`, `sw.js`, `icons/` | 홈 화면 앱(PWA) 설정 |

`config.js`가 `null` 상태여도 앱은 동작합니다. 이 경우 기록이 그 기기에만 저장됩니다.

---

## 1단계: GitHub → Vercel 배포
1. GitHub에서 새 저장소(예: `spelling-bee`)를 만들고, 압축을 푼 파일 전체를 **저장소 맨 위(root)**에 업로드합니다.
2. Vercel → Add New → Project → 그 저장소 선택 → Framework Preset은 **Other**로 두고 Deploy를 누릅니다. 빌드 설정은 필요 없습니다.
3. 배포된 주소(예: `https://spelling-bee-xxx.vercel.app`)를 아이폰 Safari에서 열어 동작을 확인합니다.

## 2단계: Firebase 설정 (Google Cloud 동기화)
1. https://console.firebase.google.com 에서 **프로젝트 추가**를 누릅니다. 기존 Google Cloud 프로젝트를 골라도 되고 새로 만들어도 됩니다. Google Analytics는 꺼도 됩니다.
2. **Authentication** → 시작하기 → 로그인 방법에서 **이메일/비밀번호**를 사용 설정합니다.
   - Users 탭 → **사용자 추가**에서 가족 공용 계정을 하나 만듭니다(예: 본인 이메일 + 새 비밀번호).
   - 모든 기기에서 이 계정 하나로 로그인하면 같은 오답노트를 봅니다.
3. **Firestore Database** → 데이터베이스 만들기 → 위치는 `us-central1`처럼 가까운 곳을 고르고 **프로덕션 모드**로 시작합니다.
   - **규칙** 탭에 `firestore.rules` 내용을 그대로 붙여 넣고 게시합니다.
4. 프로젝트 설정(⚙️) → 일반 → 내 앱 → **웹 앱(</>) 추가**를 누릅니다. 앱 이름을 입력하고, Hosting 체크는 하지 않습니다.
   - 화면에 나오는 `firebaseConfig = { ... }` 객체를 복사합니다.
5. GitHub에서 `config.js`를 열어 `export const firebaseConfig = null;`을 복사한 객체로 바꾸고 Commit합니다. Vercel이 자동으로 다시 배포합니다.
6. 앱을 새로 고치면 로그인 화면이 나옵니다. 2번에서 만든 계정으로 로그인하면 상단에 `☁️ synced`가 표시됩니다.

> `apiKey`는 비밀번호가 아니라 프로젝트 식별자라서 GitHub에 올라가도 괜찮습니다. 데이터 보호는 로그인과 보안 규칙이 담당합니다. 무료(Spark) 요금제로 충분합니다.

## 3단계: 아이폰/아이패드에 설치
1. Safari에서 앱 주소를 엽니다 → 공유 버튼 → **홈 화면에 추가**를 누릅니다.
2. 처음 🎤를 누르면 마이크와 음성 인식 권한을 물어봅니다. **허용**을 누릅니다.
3. 홈 화면 앱에서 음성 인식이 잘 안 되면 Safari 탭에서 열어 사용합니다(iOS 버전에 따라 다릅니다).
4. 설정 → 손쉬운 사용 → 읽기 및 말하기 → 음성에서 영어 **Enhanced** 음성을 내려받으면 단어 발음이 훨씬 자연스러워집니다. 받은 뒤 앱 ⚙️ Settings에서 그 음성을 선택합니다.

---

## 동작 방식
- **채점**: 대소문자, 악센트(é, ñ), 띄어쓰기, 하이픈은 채점에서 제외하고 **알파벳 순서만** 비교합니다. 철자가 2개인 단어(fertilizer/fertiliser 등)는 둘 다 정답입니다.
- **말하는 방식**: 대회처럼 "beach — B, E, A, C, H — beach"라고 말해도 앞뒤 단어는 자동으로 빼고 채점합니다.
- **자동 교정 방지**: 인식기가 철자 대신 "beach" 같은 통단어를 돌려주면 채점하지 않고 다시 말하라고 안내합니다.
- **오답노트에 들어가는 조건**: 틀림 / 🔊 다시 듣기 2번 이상 / 답하기까지 8초 이상 / "😓 That was hard" 버튼 / 부모가 "Mark wrong"으로 정정
- **오답노트 졸업**: 위 조건 없이 3번 연속 맞히면 빠집니다. 기준은 ⚙️ Settings에서 바꿀 수 있습니다.
- **부모 정정**: 결과 화면 아래 "Parent: fix the result"에서 음성 오인식을 바로잡을 수 있습니다.
- **📊 Parent view**: 레벨별 진도, 정답률, 최근 답안(틀린 철자 포함)을 보여줍니다.

## Firestore 데이터 구조
```
users/{uid}/progress/{wordId}   단어별 누적 기록, 오답노트 상태
users/{uid}/attempts/{autoId}   답안 하나하나의 기록
```
