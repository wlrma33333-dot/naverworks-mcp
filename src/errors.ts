/** 재로그인이 필요할 때. `npm run login` 안내 메시지를 항상 포함한다. */
export class ReloginRequiredError extends Error {}

/** 웍스 API가 비정상 상태 코드를 반환했을 때. */
export class WorksApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body?: string,
  ) {
    super(message);
  }
}
