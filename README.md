# CachedGPT

[English](./README.en.md)

ChatGPT의 좌측 사이드바 목록 요청을 캐시하고 중복 요청을 합쳐, 429(Too Many Requests) 발생 가능성을 줄이는 브라우저 유저스크립트입니다. 429가 발생해도 저장된 목록이 있으면 이를 계속 표시합니다.

> **비공식 프로젝트입니다.** OpenAI 또는 ChatGPT와 제휴·보증 관계가 없습니다. ChatGPT의 내부 API/DOM 구조 변경에 따라 동작이 깨질 수 있습니다.

## 설치

**[▶ CachedGPT 유저스크립트 설치](https://raw.githubusercontent.com/HiSkyZen/CachedGPT/main/cachedgpt.user.js)**

위 링크는 `.user.js` 직접 링크입니다. Tampermonkey 또는 Violentmonkey가 설치되어 있으면 일반적으로 설치 화면으로 바로 인식됩니다.

1. [Violentmonkey](https://violentmonkey.github.io/) 또는 [Tampermonkey](https://www.tampermonkey.net/)를 설치합니다.
2. 위 **유저스크립트 설치** 링크를 클릭합니다.
3. 유저스크립트 매니저에서 설치를 승인합니다.
4. `https://chatgpt.com/`을 새로고침합니다.

직접 설치 URL:

```text
https://raw.githubusercontent.com/HiSkyZen/CachedGPT/main/cachedgpt.user.js
```

## 기능

- **사이드바 캐시**: 최근 대화, 프로젝트별 대화, 프로젝트 사이드바, 고정 항목 응답을 기본 30초 동안 캐시합니다.
- **변경 후 갱신**: 대화·프로젝트·고정 항목의 쓰기 요청이 성공하면 기존 목록을 보존하면서 다음 조회에서 새 응답을 받도록 표시합니다.
- **동일 요청 중복 제거**: 같은 URL에 대한 동시 요청은 하나의 네트워크 요청으로 합칩니다.
- **요청 직렬화**: 보호 대상 API 요청이 한꺼번에 폭주하지 않도록 최소 간격을 둡니다.
- **429 백오프**: `Retry-After`가 있으면 우선 적용하고, 없으면 지수 백오프를 사용합니다.
- **stale cache fallback**: 서버가 429를 반환하거나 네트워크 오류가 발생하면 마지막 정상 캐시를 사용합니다.
- **IndexedDB 영속 캐시**: 정상 목록 응답을 최대 128 MiB까지 저장하고, 용량 제한에 도달하면 오래된 항목부터 제거합니다. 이전 버전의 대화 본문 캐시는 정리합니다.
- **비차단 알림**: 대화 접근 제한 모달/alert 대신 우측 하단의 작은 상태 표시를 사용합니다.
- **자동 업데이트**: `@updateURL`/`@downloadURL`이 GitHub의 최신 `cachedgpt.user.js`를 가리킵니다.

## 기본 설정

스크립트 상단의 `CFG` 객체에서 조정할 수 있습니다.

| 설정 | 기본값 | 의미 |
| --- | ---: | --- |
| `LIST_FRESH_MS` | `30000` | 대화 목록 캐시 TTL |
| `MIN_NETWORK_GAP_MS` | `500` | 보호 대상 네트워크 요청 간 최소 간격 |
| `INITIAL_BACKOFF_MS` | `15000` | 최초 429 백오프 |
| `MAX_BACKOFF_MS` | `120000` | 최대 백오프 |
| `CACHE_MAX_BYTES` | 128 MiB | IndexedDB 캐시 최대 용량 |
| `SHOW_STATUS` | `true` | 조용한 우측 하단 상태 표시 사용 여부 |

완전 무음 모드를 원하면 다음처럼 변경합니다.

```js
SHOW_STATUS: false,
```

## 동작 방식

예를 들어 ChatGPT 클라이언트가 같은 대화 목록을 동시에 네 번 요청하면 CachedGPT는 실제 서버 요청을 하나로 합칩니다.

```text
4 identical requests
        ↓
     dedupe
        ↓
1 network request
        ↓
IndexedDB cache
```

캐시가 아직 fresh 상태라면 서버에 요청하지 않고 캐시에서 즉시 응답합니다. fresh TTL이 지난 뒤 서버가 `429`를 반환하면 마지막 정상 응답을 사용합니다. 429 대기 시간 중에는 해당 목록 종류의 저장된 응답을 즉시 사용하고 서버에 재요청하지 않습니다. 따라서 작업 목록의 429가 일반 대화 목록을 막지 않습니다. 상태 표시에는 저장된 응답의 나이가 나타납니다.

CachedGPT는 제한을 우회하거나 요청량을 늘리는 도구가 아닙니다. 반대로 요청량을 줄이고 서버가 보내는 `Retry-After` 및 백오프를 존중하도록 설계되어 있습니다.

## 제한 사항

- ChatGPT의 내부 엔드포인트와 DOM 구조는 공개 API가 아니며 언제든 변경될 수 있습니다.
- 캐시 fallback 중에는 표시되는 데이터가 최신 서버 상태보다 오래될 수 있습니다.
- POST/PATCH/DELETE 등 쓰기 요청은 그대로 서버에 전달하며 응답 본문을 캐시하지 않습니다.
- 캐시는 브라우저의 IndexedDB에 로컬로 저장됩니다.
- 계정 식별 헤더를 확인할 수 없는 요청은 캐시하지 않습니다. 서로 다른 계정의 목록은 별도로 저장합니다.
- 저장된 목록만 있을 때 표시 내용은 오래되었을 수 있습니다. 아직 성공한 응답이 없는 요청은 캐시로 복원할 수 없습니다.

## 개인정보 및 보안

CachedGPT는 외부 분석 서버를 사용하지 않습니다. 캐시된 대화 JSON은 해당 브라우저 프로필의 IndexedDB에만 저장됩니다. 유저스크립트가 동작하는 범위는 `https://chatgpt.com/*`입니다.

공용 PC에서는 사용하지 않거나 사용 후 해당 사이트 데이터를 삭제하는 것을 권장합니다.

## 업데이트

Tampermonkey/Violentmonkey의 자동 업데이트 기능을 사용할 수 있습니다. 수동 업데이트가 필요하면 설치 링크를 다시 열어 최신 버전을 설치하면 됩니다.

## 라이선스

MIT License. 자세한 내용은 [`LICENSE`](./LICENSE)를 참고하세요.
