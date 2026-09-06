import { APIResource } from '../resource.js';
import { stripNotGiven } from '../util.js';
import { Page, PageSchema } from '../pagination.js';
import { MessageSchema } from '../types/message.js';
import type { Message } from '../types/message.js';
import type {
  BrandSendParams,
  KakaoSendParams,
  MessageCreateParams,
  MessageListParams,
} from '../types/message-params.js';

/**
 * 알림톡·브랜드의 발송 지정을 서버 표기(PascalCase)로 옮긴다.
 *
 * 두 채널이 **한 함수를 쓴다** — 알림톡엔 자유형이 없어 `Free` 가 언제나 `undefined` 이고,
 * `stripNotGiven` 이 그걸 떨군다. 갈라 두면 서버가 `Variables` 키 이름을 바꿀 때 두 곳을
 * 고쳐야 하고, 한쪽을 빠뜨려도 값이 `Record<string, unknown>` 이라 컴파일이 통과한다.
 *
 * ⛔ **네 칸을 그대로 옮긴다 — 여기서 템플릿형/자유형을 고르지 않는다.** `free` 가 있으면
 *    `TemplateId` 를 떨구는 식으로 짜면, 둘 다 실은 (타입을 안 쓰는) 호출자가 `400` 대신
 *    **자기가 안 시킨 자유형이 나간 것**을 받는다. 배타 판정은 서버 한 곳이다.
 *
 * ⚠️ `Free` 는 불투명 오브젝트다. `stripNotGiven` 은 한 겹만 훑으므로 안쪽은 손대지 않는다 —
 *    판정은 서버의 말풍선 표가 한다.
 */
const sendBlock = (p?: KakaoSendParams | BrandSendParams) =>
  p &&
  stripNotGiven({
    ChannelId: p.channelId,
    TemplateId: p.templateId,
    Variables: p.variables,
    Free: p.free,
  });

export class Messages extends APIResource {
  /**
   * 문자(SMS/LMS/MMS) 또는 카카오 알림톡·브랜드 메시지를 발송합니다.
   *
   * 셋은 배타적입니다 — `kakao` 를 실으면 알림톡, `brand` 를 실으면 브랜드 메시지이고,
   * 이때 `body`·`subject`·`mediaUrl` 은 실을 수 없습니다(본문은 템플릿이 정합니다).
   *
   * ```ts
   * // 문자
   * await client.messages.create({ to: '010…', from: '070…', body: '안녕하세요' });
   *
   * // 알림톡 — 실패하면 fallback 문구가 문자로 대신 나갑니다(별도 1건으로 과금)
   * await client.messages.create({
   *   to: '010…',
   *   from: '070…',
   *   kakao: { channelId, templateId, variables: { 고객명: '홍길동' } },
   *   fallback: { body: '주문이 접수되었습니다.' },
   * });
   *
   * // 브랜드 메시지 — 채널을 추가한 친구에게 나가는 광고성 메시지
   * // ⚠️ 야간 제한과 대체발송 없음 — 제약은 `BrandMessageCreateParams` 참고.
   * await client.messages.create({
   *   to: '010…',
   *   from: '070…',
   *   brand: { channelId, templateId, variables: { 고객명: '홍길동' } },
   * });
   * ```
   */
  async create(
    params: MessageCreateParams,
    options: {
      extraHeaders?: Record<string, string>;
      extraQuery?: Record<string, unknown>;
      timeout?: number;
    } = {},
  ): Promise<Message> {
    const body = stripNotGiven({
      To: params.to,
      From: params.from,
      Body: params.body,
      Type: params.type,
      Subject: params.subject,
      MediaUrl: params.mediaUrl,
      IdempotencyKey: params.idempotencyKey,
      // 중첩 객체는 손으로 조립한다 — stripNotGiven 은 한 겹만 훑는다.
      Kakao: sendBlock(params.kakao),
      Brand: sendBlock(params.brand),
      Fallback:
        params.fallback &&
        stripNotGiven({
          Type: params.fallback.type,
          Subject: params.fallback.subject,
          Body: params.fallback.body,
          Disabled: params.fallback.disabled,
        }),
    });
    return this._client._post(`${this._basePath}/messages`, {
      body,
      castTo: MessageSchema,
      ...options,
    });
  }

  async list(
    params: MessageListParams = {},
    options: {
      extraHeaders?: Record<string, string>;
      extraQuery?: Record<string, unknown>;
      timeout?: number;
    } = {},
  ): Promise<Page<Message>> {
    const query = stripNotGiven({
      type: params.type,
      status: params.status,
      number: params.number,
      page: params.page,
      pageSize: params.pageSize,
    });
    const path = `${this._basePath}/messages`;
    const schema = PageSchema(MessageSchema);
    const raw = await this._client._get(path, {
      castTo: schema,
      query: Object.keys(query).length ? query : undefined,
      ...options,
    });
    const page = new Page<Message>(raw.data, raw.meta);
    page._setClient(this._client, path, MessageSchema, query);
    return page;
  }

  async get(
    messageId: string,
    options: {
      extraHeaders?: Record<string, string>;
      extraQuery?: Record<string, unknown>;
      timeout?: number;
    } = {},
  ): Promise<Message> {
    return this._client._get(`${this._basePath}/messages/${messageId}`, {
      castTo: MessageSchema,
      ...options,
    });
  }
}
