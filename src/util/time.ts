const KST_OFFSET_MS = 9 * 60 * 60 * 1000;

/** 호스트 PC의 타임존 설정과 무관하게 항상 KST(+09:00, DST 없음) 기준으로 포맷한다.
 * 네이버웍스 API가 요구하는 YYYY-MM-DDThh:mm:ssTZD 형식과 맞춘다. */
export function toKstIso(date: Date): string {
  const kst = new Date(date.getTime() + KST_OFFSET_MS);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return (
    `${kst.getUTCFullYear()}-${pad(kst.getUTCMonth() + 1)}-${pad(kst.getUTCDate())}` +
    `T${pad(kst.getUTCHours())}:${pad(kst.getUTCMinutes())}:${pad(kst.getUTCSeconds())}+09:00`
  );
}

export function nowKstIso(): string {
  return toKstIso(new Date());
}

export function addDaysKstIso(date: Date, days: number): string {
  return toKstIso(new Date(date.getTime() + days * 86_400_000));
}
