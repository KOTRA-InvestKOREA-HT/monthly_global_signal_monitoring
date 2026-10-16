// 판정 파일(outputs/review_work/reviews/*.json)은 판정·문안·검토 세 단계가 차례로 고쳐 쓰고, 다음 실행이 캐시로 이어 받는다.
// 워크플로가 45분 제한에 걸려 쓰는 도중 끊기면 반쯤 쓴 JSON 이 남고, 다음 실행은 그 기사를 읽지 못해 다시 판정한다.
// 같은 폴더의 임시 파일에 끝까지 쓴 뒤 이름을 바꿔 놓는다. 이름 바꾸기는 한 번에 일어나므로 읽는 쪽은 옛 파일이나 새 파일
// 둘 중 하나만 본다. 임시 파일 이름에 프로세스와 난수를 넣어, 같은 파일을 동시에 쓰는 두 쓰기가 서로의 임시 파일을 덮지 않게 한다.
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

export const TEMP_SUFFIX = '.tmp';

export async function writeJsonAtomic(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}-${crypto.randomUUID().slice(0, 8)}${TEMP_SUFFIX}`;
  try {
    await fs.writeFile(temp, JSON.stringify(value, null, 2) + '\n');
    await fs.rename(temp, file);
  } catch (error) {
    await fs.rm(temp, { force: true }).catch(() => {});
    throw error;
  }
}
