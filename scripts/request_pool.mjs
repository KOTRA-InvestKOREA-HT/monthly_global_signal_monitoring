// 문안·검토 단계의 요청 묶음. 요청 시작 간격(무료 등급 분당 요청 한도)은 지키면서, 응답은 여러 건을 함께 기다린다.
// 예전에는 기사마다 앞 요청의 응답이 와야 다음 요청을 보냈다. 추론을 high 로 둔 응답은 한 건에 수십 초가 걸려,
// Issue 4(10월 1일 실행)에서 문안 100여 건과 검토 100여 건을 쓰는 데 40분이 넘게 걸렸다. 판정 단계는 이미 4건씩 보낸다.

export const DEFAULT_CONCURRENCY = 4;

// 판정 단계와 같은 REPORT_CONCURRENCY 를 쓴다. 한 값으로 세 단계의 동시 요청 수를 맞춘다.
export function resolveConcurrency(env = process.env) {
  const concurrency = Number(env.REPORT_CONCURRENCY || DEFAULT_CONCURRENCY);
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 12) throw new Error('REPORT_CONCURRENCY must be 1..12');
  return concurrency;
}

// 다음 요청의 시작 시각을 먼저 잡아 두고 기다린다. 기다린 뒤에 잡으면 동시에 깨어난 요청들이 같은 시각에 나간다.
export function createPacer(now = Date.now) {
  let next = 0;
  return async (delayMs, sleep) => {
    const start = Math.max(now(), next);
    next = start + delayMs;
    const wait = start - now();
    if (wait > 0) await sleep(wait);
  };
}

// items 를 앞에서부터 꺼내 최대 concurrency 개를 함께 처리한다. shouldStop 이 참이 되면 새 항목을 꺼내지 않는다.
export async function forEachConcurrent(items, concurrency, worker, shouldStop = () => false) {
  let index = 0;
  const run = async () => {
    while (index < items.length && !shouldStop()) await worker(items[index++]);
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, run));
}
