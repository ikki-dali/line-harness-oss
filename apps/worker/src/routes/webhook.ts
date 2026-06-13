import { Hono } from 'hono';
import { verifySignature, LineClient } from '@line-crm/line-sdk';
import type { WebhookRequestBody, WebhookEvent, TextEventMessage } from '@line-crm/line-sdk';
import {
  upsertFriend,
  updateFriendFollowStatus,
  getFriendByLineUserId,
  getScenarios,
  enrollFriendInScenario,
  getScenarioSteps,
  advanceFriendScenario,
  completeFriendScenario,
  upsertChatOnMessage,
  getLineAccounts,
  jstNow,
  computeNextDeliveryAt,
  resolveStepContent,
  addTagToFriend,
  getEntryRouteByRefCode,
  getMessageTemplateById,
} from '@line-crm/db';
import type { EntryRoute } from '@line-crm/db';
import { fireEvent } from '../services/event-bus.js';
import { buildMessage, expandVariables } from '../services/step-delivery.js';
import type { Env } from '../index.js';
import {
  DEMO_CANDIDATE_LINE_ACCOUNT_ID,
  DEMO_CANDIDATES,
  DEMO_CHAT_VERSION,
  DEMO_COMPANY_LINE_ACCOUNT_ID,
  DEMO_COMPANY_NAME,
  DEMO_SERVICE_NAME,
  DEMO_TIMEREX_URL,
  DEMO_WORKER_URL,
  SAIYO_PRO_BRAND_BLUE,
  SAIYO_PRO_BRAND_MUTED,
  SAIYO_PRO_BRAND_NAVY,
  SAIYO_PRO_BRAND_ORANGE,
  SAIYO_PRO_BRAND_PRIMARY,
  SAIYO_PRO_BRAND_SECONDARY,
  SAIYO_PRO_BRAND_SOFT_BG,
  SAIYO_PRO_APPLICATION_COMPLETE_IMAGE_URL,
  SAIYO_PRO_APPLICATION_START_IMAGE_URL,
  resolveSaiyoProDemoCandidateByLineUserId,
  type DemoCandidate,
  type DemoCandidateStatus,
  type DemoCompanyJob,
} from './saiyo-pro-demo-data.js';

const webhook = new Hono<Env>();

// LINE webhook bodies are small (events array). Cap defends against unauthenticated
// large-payload DoS before signature verification (#104). 1 MiB leaves room for
// bursty batched deliveries (~100 events × ~5 KB) while still well below the
// 128 MB Cloudflare Workers memory ceiling.
const MAX_WEBHOOK_BODY_SIZE = 1024 * 1024; // 1 MiB

type DemoCompanyAccount = {
  id: string;
  companyName: string;
  staffName: string;
  linked: boolean;
};

type DemoReplySession = {
  candidateId: string;
  candidateName: string;
  job: string;
  candidateLineUserId?: string;
  expiresAt: string;
};

type SaiyoProApplicationQuestion = 'age' | 'gender' | 'location' | 'income';

type SaiyoProApplicationAnswers = Partial<Record<SaiyoProApplicationQuestion, string>>;

type SaiyoProApplicationRow = {
  age: string | null;
  gender: string | null;
  location: string | null;
  income: string | null;
};

type FriendCandidateRow = {
  id: string;
  line_user_id: string;
  display_name: string | null;
  created_at: string;
};

webhook.post('/webhook', async (c) => {
  // Pre-read size guard: reject before reading the body if Content-Length is oversized.
  const contentLengthHeader = c.req.header('Content-Length');
  if (contentLengthHeader) {
    const declared = Number.parseInt(contentLengthHeader, 10);
    if (Number.isFinite(declared) && declared > MAX_WEBHOOK_BODY_SIZE) {
      return c.json({ status: 'too_large' }, 413);
    }
  }

  const rawBody = await c.req.text();

  // Post-read size guard for the case where Content-Length was absent or untrustworthy.
  // Use UTF-8 byte count: `rawBody.length` counts UTF-16 code units, so multibyte
  // payloads (Japanese/emoji) would otherwise bypass the cap.
  const rawBodyByteLength = new TextEncoder().encode(rawBody).byteLength;
  if (rawBodyByteLength > MAX_WEBHOOK_BODY_SIZE) {
    return c.json({ status: 'too_large' }, 413);
  }

  const signature = c.req.header('X-Line-Signature') ?? '';
  const db = c.env.DB;

  // Cheap pre-reject for unsigned / malformed-signature requests. LINE signatures
  // are HMAC-SHA256 + base64 = 44 chars. This avoids D1 lookups and HMAC compute
  // for junk traffic on a public endpoint.
  const LINE_SIGNATURE_LENGTH = 44;
  if (signature.length !== LINE_SIGNATURE_LENGTH) {
    console.error('Missing or malformed LINE signature');
    return c.json({ status: 'ok' }, 200);
  }

  // Verify signature BEFORE JSON.parse so attacker-controlled bodies never reach the parser.
  // Fast path: try env default secret first so malformed/unauthenticated traffic
  //   fails fast without a D1 lookup. The main account is typically also registered
  //   in line_accounts; on env match we still look it up so matchedAccountId binds
  //   correctly for downstream account-scoped filters.
  // Slow path: iterate DB-registered accounts for genuinely multi-account installs.
  let channelAccessToken = c.env.LINE_CHANNEL_ACCESS_TOKEN;
  let matchedAccountId: string | null = null;
  let valid = false;

  const envSecret = c.env.LINE_CHANNEL_SECRET;
  if (envSecret) {
    valid = await verifySignature(envSecret, rawBody, signature);
    if (valid) {
      const accounts = await getLineAccounts(db);
      const main = accounts.find(
        (a) => a.is_active && a.channel_secret === envSecret,
      );
      if (main) {
        channelAccessToken = main.channel_access_token;
        matchedAccountId = main.id;
      } else {
        const byToken = accounts.find(
          (a) => a.is_active && a.channel_access_token === channelAccessToken,
        );
        matchedAccountId = byToken?.id ?? DEMO_CANDIDATE_LINE_ACCOUNT_ID;
      }
    }
  }

  if (!valid) {
    const accounts = await getLineAccounts(db);
    for (const account of accounts) {
      if (!account.is_active) continue;
      if (envSecret && account.channel_secret === envSecret) continue; // already tried via fast path
      const isValid = await verifySignature(account.channel_secret, rawBody, signature);
      if (isValid) {
        channelAccessToken = account.channel_access_token;
        matchedAccountId = account.id;
        valid = true;
        break;
      }
    }
  }

  if (!valid) {
    console.error('Invalid LINE signature');
    return c.json({ status: 'ok' }, 200);
  }

  let body: WebhookRequestBody;
  try {
    body = JSON.parse(rawBody) as WebhookRequestBody;
  } catch {
    console.error('Failed to parse webhook body');
    return c.json({ status: 'ok' }, 200);
  }

  const lineClient = new LineClient(channelAccessToken);

  // 非同期処理 — LINE は ~1s 以内のレスポンスを要求
  const processingPromise = (async () => {
    for (const event of body.events) {
      try {
        await handleEvent(db, lineClient, event, channelAccessToken, matchedAccountId, c.env.WORKER_URL || new URL(c.req.url).origin, c.env.LIFF_URL, c.env.IMAGES, c.env.AI_API_KEY);
      } catch (err) {
        console.error('Error handling webhook event:', err);
      }
    }
  })();

  c.executionCtx.waitUntil(processingPromise);

  return c.json({ status: 'ok' }, 200);
});

async function handleEvent(
  db: D1Database,
  lineClient: LineClient,
  event: WebhookEvent,
  lineAccessToken: string,
  lineAccountId: string | null = null,
  workerUrl?: string,
  liffUrl?: string,
  r2?: R2Bucket,
  aiApiKey?: string,
): Promise<void> {
  if (event.type === 'follow') {
    const userId =
      event.source.type === 'user' ? event.source.userId : undefined;
    if (!userId) return;

    console.log(`[follow] userId=${userId} lineAccountId=${lineAccountId}`);

    // プロフィール取得 & 友だち登録/更新
    let profile;
    try {
      profile = await lineClient.getProfile(userId);
    } catch (err) {
      console.error('Failed to get profile for', userId, err);
    }

    console.log(`[follow] profile=${profile?.displayName ?? 'null'}`);

    const friend = await upsertFriend(db, {
      lineUserId: userId,
      displayName: profile?.displayName ?? null,
      pictureUrl: profile?.pictureUrl ?? null,
      statusMessage: profile?.statusMessage ?? null,
    });

    console.log(`[follow] friend.id=${friend.id} friend.line_account_id=${(friend as any).line_account_id}`);

    // Set line_account_id for multi-account tracking (always update on follow)
    if (lineAccountId) {
      await db.prepare('UPDATE friends SET line_account_id = ?, updated_at = ? WHERE id = ?')
        .bind(lineAccountId, jstNow(), friend.id).run();
      console.log(`[follow] line_account_id set to ${lineAccountId} for friend ${friend.id}`);
    }
    if (lineAccountId === DEMO_COMPANY_LINE_ACCOUNT_ID) {
      await updateFriendMetadata(db, friend.id, {
        demo_company_line_user_id: userId,
        demo_company_account: buildDemoCompanyAccountFromProfile(userId, profile?.displayName ?? null),
      });
    }

    const demoWelcome = buildDemoWelcomeText(lineAccountId);
    if (demoWelcome) {
      const replyMessages = lineAccountId === DEMO_CANDIDATE_LINE_ACCOUNT_ID
        ? [
            buildMessage('text', demoWelcome),
            buildMessage('flex', buildDemoApplicationStartFlex()),
          ]
        : [buildMessage('text', demoWelcome)];
      await lineClient.replyMessage(event.replyToken, replyMessages);
      const { messageToLogPayload } = await import('../services/step-delivery.js');
      await db.batch(replyMessages.map((message) => {
        const payload = messageToLogPayload(message);
        return db
          .prepare(
            `INSERT INTO messages_log (id, friend_id, direction, message_type, content, broadcast_id, scenario_step_id, delivery_type, source, line_account_id, created_at)
             VALUES (?, ?, 'outgoing', ?, ?, NULL, NULL, 'reply', 'demo_welcome', ?, ?)`,
          )
          .bind(crypto.randomUUID(), friend.id, payload.messageType, payload.content, lineAccountId ?? null, jstNow());
      }));
      await fireEvent(db, 'friend_add', { friendId: friend.id, eventData: { displayName: friend.display_name } }, lineAccessToken, lineAccountId);
      return;
    }

    // Resolve referral link (entry_route) for this friend.
    // /auth/callback (OAuth path) writes friends.ref_code in parallel with
    // this follow webhook, so the field can briefly be NULL when LINE
    // delivers the event. Retry a few times (~1s total) before giving up,
    // otherwise override mode and intro pushes silently fall back to the
    // account default whenever the webhook wins the race.
    const { getFriendById } = await import('@line-crm/db');
    let friendRefCode = (friend as { ref_code?: string | null }).ref_code ?? null;
    if (!friendRefCode) {
      for (let attempt = 0; attempt < 5; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 200));
        const refreshed = await getFriendById(db, friend.id);
        const refreshedRef = (refreshed as { ref_code?: string | null } | null)?.ref_code ?? null;
        if (refreshedRef) {
          friendRefCode = refreshedRef;
          break;
        }
      }
    }
    const referralRoute: EntryRoute | null = friendRefCode
      ? await getEntryRouteByRefCode(db, friendRefCode)
      : null;
    const runAccountScenarios =
      !referralRoute || referralRoute.run_account_friend_add_scenarios !== 0;

    // friend_add シナリオに登録（このアカウントのシナリオのみ）
    // Skip entirely when a referral link explicitly overrides (run_account_friend_add_scenarios=0).
    const scenarios = runAccountScenarios ? await getScenarios(db) : [];
    for (const scenario of scenarios) {
      // Only trigger scenarios belonging to this account (or unassigned for backward compat)
      const scenarioAccountMatch = !scenario.line_account_id || !lineAccountId || scenario.line_account_id === lineAccountId;
      if (scenario.trigger_type === 'friend_add' && scenario.is_active && scenarioAccountMatch) {
        try {
          // INSERT OR IGNORE handles dedup via UNIQUE(friend_id, scenario_id)
          const friendScenario = await enrollFriendInScenario(db, friend.id, scenario.id);
          if (!friendScenario) continue; // already enrolled

            // Immediate delivery: scenario.delivery_mode を踏まえて step1 が「now 以前」に
            // スケジュールされる場合のみ replyMessage で即時送信する。
            // - relative + delay_minutes=0 → 即時
            // - elapsed + offset_days=0 + offset_minutes=0 → 即時
            // - absolute_time で過去時刻 → computeNextDeliveryAt が now に clamp するので即時
            const steps = await getScenarioSteps(db, scenario.id);
            const firstStep = steps[0];
            const deliveryMode = scenario.delivery_mode ?? 'relative';
            const enrolledAtJst = new Date(Date.now() + 9 * 60 * 60_000);
            const firstScheduledAt = firstStep
              ? computeNextDeliveryAt(
                  { delivery_mode: deliveryMode },
                  firstStep,
                  { enrolledAt: enrolledAtJst, previousDeliveredAt: enrolledAtJst, now: enrolledAtJst },
                )
              : null;
            const shouldSendImmediately =
              firstStep &&
              firstScheduledAt !== null &&
              firstScheduledAt.getTime() <= enrolledAtJst.getTime() &&
              friendScenario.status === 'active';
            if (firstStep && shouldSendImmediately) {
              try {
                // Resolve template_id → templates table (参照型)
                const resolved = await resolveStepContent(db, firstStep);
                const { resolveMetadata } = await import('../services/step-delivery.js');
                const resolvedMeta = await resolveMetadata(db, { user_id: (friend as unknown as Record<string, string | null>).user_id, metadata: (friend as unknown as Record<string, string | null>).metadata });
                const expandedContent = expandVariables(resolved.messageContent, { ...friend, metadata: resolvedMeta } as Parameters<typeof expandVariables>[1]);
                const message = buildMessage(resolved.messageType, expandedContent);
                await lineClient.replyMessage(event.replyToken, [message]);
                console.log(`Immediate delivery: sent step ${firstStep.id} to ${userId}`);

                // Log what was actually delivered (post buildMessage normalization)
                // so the dashboard chat view mirrors LINE 1:1.
                const logId = crypto.randomUUID();
                const { messageToLogPayload: logPayload1 } = await import('../services/step-delivery.js');
                const wbScenarioPayload = logPayload1(message);
                await db
                  .prepare(
                    `INSERT INTO messages_log (id, friend_id, direction, message_type, content, broadcast_id, scenario_step_id, delivery_type, source, template_id_at_send, line_account_id, created_at)
                     VALUES (?, ?, 'outgoing', ?, ?, NULL, ?, 'reply', 'scenario', ?, ?, ?)`,
                  )
                  .bind(logId, friend.id, wbScenarioPayload.messageType, wbScenarioPayload.content, firstStep.id, resolved.templateIdAtSend, lineAccountId ?? null, jstNow())
                  .run();

                // Advance or complete the friend_scenario — step 2 のスケジュールも
                // computeNextDeliveryAt で計算する（elapsed/absolute_time で正しく動かすため）
                const secondStep = steps[1] ?? null;
                if (secondStep) {
                  const nextDeliveryDate = computeNextDeliveryAt(
                    { delivery_mode: deliveryMode },
                    secondStep,
                    { enrolledAt: enrolledAtJst, previousDeliveredAt: enrolledAtJst, now: enrolledAtJst },
                  );
                  await advanceFriendScenario(db, friendScenario.id, firstStep.step_order, nextDeliveryDate.toISOString().slice(0, -1) + '+09:00');
                } else {
                  await completeFriendScenario(db, friendScenario.id);
                }

                // 到達タグ付与 (advance / complete の後)
                if (firstStep.on_reach_tag_id) {
                  try {
                    await addTagToFriend(db, friend.id, firstStep.on_reach_tag_id);
                  } catch (err) {
                    console.error(`[scenario] tag attach failed step=${firstStep.id}:`, err);
                  }
                }
              } catch (err) {
                console.error('Failed immediate delivery for scenario', scenario.id, err);
              }
            }
        } catch (err) {
          console.error('Failed to enroll friend in scenario', scenario.id, err);
        }
      }
    }

    // Referral link side-effects (intro push + dedicated scenario)
    if (referralRoute) {
      // Intro push from referral link
      if (referralRoute.intro_template_id) {
        try {
          const template = await getMessageTemplateById(db, referralRoute.intro_template_id);
          if (template) {
            const message = buildMessage(template.message_type, template.message_content);
            await lineClient.pushMessage(userId, [message]);
            console.log(`[follow] referral intro push sent route=${referralRoute.id}`);
          }
        } catch (err) {
          console.error('[follow] referral intro push failed', err);
        }
      }

      // Dedicated scenario enrollment from referral link
      if (referralRoute.scenario_id) {
        try {
          await enrollFriendInScenario(db, friend.id, referralRoute.scenario_id);
          console.log(`[follow] referral scenario enrolled scenario=${referralRoute.scenario_id}`);
        } catch (err) {
          console.error('[follow] referral scenario enrollment failed', err);
        }
      }
    }

    // イベントバス発火: friend_add（replyToken は Step 0 で使用済みの可能性あり）
    await fireEvent(db, 'friend_add', { friendId: friend.id, eventData: { displayName: friend.display_name } }, lineAccessToken, lineAccountId);
    return;
  }

  if (event.type === 'unfollow') {
    const userId =
      event.source.type === 'user' ? event.source.userId : undefined;
    if (!userId) return;

    await updateFriendFollowStatus(db, userId, false);
    return;
  }

  // Postback events — triggered by Flex buttons with action.type: "postback"
  // Uses the same auto_replies matching but without displaying text in chat
  if (event.type === 'postback') {
    const userId = event.source.type === 'user' ? event.source.userId : undefined;
    if (!userId) return;

    const friend = await ensureFriendForLineUser(db, lineClient, userId, lineAccountId);
    if (!friend) return;

    const postbackData = (event as unknown as { postback: { data: string } }).postback.data;

    // Match postback data against auto_replies (exact match on keyword)
    const autoReplyQuery = lineAccountId
      ? `SELECT * FROM auto_replies WHERE is_active = 1 AND (line_account_id IS NULL OR line_account_id = ?) ORDER BY created_at ASC`
      : `SELECT * FROM auto_replies WHERE is_active = 1 AND line_account_id IS NULL ORDER BY created_at ASC`;
    const autoReplyStmt = db.prepare(autoReplyQuery);
    const autoReplies = await (lineAccountId ? autoReplyStmt.bind(lineAccountId) : autoReplyStmt)
      .all<{
        id: string;
        keyword: string;
        match_type: 'exact' | 'contains';
        response_type: string;
        response_content: string;
        template_id: string | null;
      }>();

    // postback の incoming 自体を messages_log に記録する。Rich Menu のタップで
     // 利用者が "コスト比較" などのアクションを起こした事実を chat 履歴で可視化する。
     // delivery_type='push' は厳密には push ではないが、incoming/non-test として
     // 既存 chat list / 詳細 SQL のフィルタを通すための妥当な値 (auto_reply text 同様)。
    try {
      await db
        .prepare(
          `INSERT INTO messages_log (id, friend_id, direction, message_type, content, broadcast_id, scenario_step_id, source, line_account_id, created_at)
           VALUES (?, ?, 'incoming', 'text', ?, NULL, NULL, 'postback', ?, ?)`,
        )
        .bind(crypto.randomUUID(), friend.id, postbackData, lineAccountId ?? null, jstNow())
        .run();
    } catch (err) {
      console.error('Failed to log incoming postback', err);
    }

    if (lineAccountId === DEMO_CANDIDATE_LINE_ACCOUNT_ID && postbackData.startsWith('demo:application:')) {
      if (postbackData === 'demo:application:start') {
        await resetSaiyoProApplicationAnswers(db, friend.id);
        const replyMsg = buildMessage('flex', buildDemoApplicationQuestionFlex('age'));
        await lineClient.replyMessage(event.replyToken, [replyMsg]);
        const { messageToLogPayload } = await import('../services/step-delivery.js');
        const payload = messageToLogPayload(replyMsg);
        await db
          .prepare(
            `INSERT INTO messages_log (id, friend_id, direction, message_type, content, broadcast_id, scenario_step_id, delivery_type, source, line_account_id, created_at)
             VALUES (?, ?, 'outgoing', ?, ?, NULL, NULL, 'reply', 'saiyo_pro_application_start', ?, ?)`,
          )
          .bind(crypto.randomUUID(), friend.id, payload.messageType, payload.content, lineAccountId, jstNow())
          .run();
        return;
      }
      const handled = await handleSaiyoProApplicationPostback(db, lineClient, event.replyToken, friend, postbackData, lineAccountId);
      if (handled) return;
    }

    if (postbackData.startsWith('demo:reply:')) {
      const candidateId = postbackData.slice('demo:reply:'.length);
      const candidate = DEMO_CANDIDATES[candidateId];
      if (!candidate) return;

      await updateFriendMetadata(db, friend.id, {
        demo_reply_session: {
          candidateId: candidate.id,
          candidateName: candidate.name,
          job: candidate.job,
          candidateLineUserId: candidate.lineUserId,
          expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
        } satisfies DemoReplySession,
      });

      const replyMsg = buildMessage('flex', buildDemoReplyModeFlex(candidate));
      await lineClient.replyMessage(event.replyToken, [replyMsg]);

      const { messageToLogPayload } = await import('../services/step-delivery.js');
      const replyPayload = messageToLogPayload(replyMsg);
      await db
        .prepare(
          `INSERT INTO messages_log (id, friend_id, direction, message_type, content, broadcast_id, scenario_step_id, delivery_type, source, line_account_id, created_at)
           VALUES (?, ?, 'outgoing', ?, ?, NULL, NULL, 'reply', 'demo_reply_mode', ?, ?)`,
        )
        .bind(crypto.randomUUID(), friend.id, replyPayload.messageType, replyPayload.content, lineAccountId ?? null, jstNow())
        .run();
      return;
    }

    if (postbackData.startsWith('demo:send-schedule:') || postbackData.startsWith('demo:send-confirm:')) {
      const isSchedule = postbackData.startsWith('demo:send-schedule:');
      const candidateId = postbackData.slice((isSchedule ? 'demo:send-schedule:' : 'demo:send-confirm:').length);
      const candidate = DEMO_CANDIDATES[candidateId];
      if (!candidate) return;

      const body = isSchedule
        ? `${candidate.name}さん、面接日程の件でご連絡です。以下のリンクからご都合のよい日時を選んでください。\n${DEMO_TIMEREX_URL}`
        : `${candidate.name}さん、ご返信ありがとうございます。内容を確認しました。追って担当者よりご連絡します。`;
      await sendDemoPresetToCandidate(db, friend, lineClient, event.replyToken, lineAccountId, candidate, body);
      return;
    }

    if (lineAccountId === DEMO_COMPANY_LINE_ACCOUNT_ID && postbackData.startsWith('demo:company-menu:')) {
      const modeKey = postbackData.slice('demo:company-menu:'.length);
      const mode = modeKey === 'unread'
        ? '未対応チャット'
        : modeKey === 'jobs'
          ? '新着応募者'
        : modeKey === 'interviews'
          ? '面談予定'
          : modeKey === 'hires'
            ? '面談予定'
            : '新着応募者';
      const companyAccount = await getDemoCompanyAccountForFriend(db, friend);
      const replyContent = await buildDemoCompanyMenuReply(db, mode, null, companyAccount);
      if (!replyContent) return;
      const replyMsg = buildMessage('flex', replyContent);
      await lineClient.replyMessage(event.replyToken, [replyMsg]);
      const { messageToLogPayload } = await import('../services/step-delivery.js');
      const payload = messageToLogPayload(replyMsg);
      await db
        .prepare(
          `INSERT INTO messages_log (id, friend_id, direction, message_type, content, broadcast_id, scenario_step_id, delivery_type, source, line_account_id, created_at)
           VALUES (?, ?, 'outgoing', ?, ?, NULL, NULL, 'reply', 'demo_company_menu', ?, ?)`,
        )
        .bind(crypto.randomUUID(), friend.id, payload.messageType, payload.content, lineAccountId ?? null, jstNow())
        .run();
      return;
    }

    if (lineAccountId === DEMO_CANDIDATE_LINE_ACCOUNT_ID && postbackData.startsWith('demo:candidate-menu:')) {
      const modeKey = postbackData.slice('demo:candidate-menu:'.length);
      const mode = modeKey === 'profile'
        ? 'プロフィール'
        : modeKey === 'jobs-card'
          ? '求人を見る'
          : modeKey === 'status'
            ? '応募状況'
            : 'チャット';
      const candidate = resolveDemoCandidateByLineUserId(userId) ?? DEMO_CANDIDATES.yamada;
      const replyContent = mode === '求人を見る'
        ? await buildDemoCandidateCompanyCardsFlex(db, candidate)
        : buildDemoCandidateSelfMenuFlex(candidate, mode);
      const replyMsg = buildMessage('flex', replyContent);
      await lineClient.replyMessage(event.replyToken, [replyMsg]);
      const { messageToLogPayload } = await import('../services/step-delivery.js');
      const payload = messageToLogPayload(replyMsg);
      await db
        .prepare(
          `INSERT INTO messages_log (id, friend_id, direction, message_type, content, broadcast_id, scenario_step_id, delivery_type, source, line_account_id, created_at)
           VALUES (?, ?, 'outgoing', ?, ?, NULL, NULL, 'reply', 'demo_candidate_menu', ?, ?)`,
        )
        .bind(crypto.randomUUID(), friend.id, payload.messageType, payload.content, lineAccountId ?? null, jstNow())
        .run();
      return;
    }

    for (const rule of autoReplies.results) {
      const isMatch = rule.match_type === 'exact'
        ? postbackData === rule.keyword
        : postbackData.includes(rule.keyword);

      if (isMatch) {
        try {
          const { resolveMetadata } = await import('../services/step-delivery.js');
          const resolvedMeta = await resolveMetadata(db, { user_id: (friend as unknown as Record<string, string | null>).user_id, metadata: (friend as unknown as Record<string, string | null>).metadata });
          const resolved = await resolveAutoReplyContent(db, {
            template_id: rule.template_id,
            response_type: rule.response_type,
            response_content: rule.response_content,
          });
          const expandedContent = expandVariables(resolved.content, { ...friend, metadata: resolvedMeta } as Parameters<typeof expandVariables>[1], workerUrl);
          const replyMsg = buildMessage(resolved.messageType, expandedContent);
          await lineClient.replyMessage(event.replyToken, [replyMsg]);

          // 送信ログ — Rich Menu 経由の Flex 応答もチャット詳細に残るようにする。
          // テキスト auto_reply (line ~390) と同じパターン。
          const { messageToLogPayload: logPayload } = await import('../services/step-delivery.js');
          const replyPayload = logPayload(replyMsg);
          await db
            .prepare(
              `INSERT INTO messages_log (id, friend_id, direction, message_type, content, broadcast_id, scenario_step_id, delivery_type, source, line_account_id, created_at)
               VALUES (?, ?, 'outgoing', ?, ?, NULL, NULL, 'reply', 'auto_reply', ?, ?)`,
            )
            .bind(crypto.randomUUID(), friend.id, replyPayload.messageType, replyPayload.content, lineAccountId ?? null, jstNow())
            .run();
        } catch (err) {
          console.error('Failed to send postback reply', err);
        }
        break;
      }
    }
    return;
  }

  // 非テキストの受信メッセージ（スタンプ/画像/音声/動画/ファイル/位置情報等）もログに残す。
  // ここで早期 return することで、テキスト用の auto_reply / scenario 判定には進まない
  // （スタンプ単体に対するキーワードマッチは意味を持たないため）。inbox 抜けだけ防ぐ。
  if (event.type === 'message' && event.message.type !== 'text') {
    const userId = event.source.type === 'user' ? event.source.userId : undefined;
    if (!userId) return;
    const friend = await ensureFriendForLineUser(db, lineClient, userId, lineAccountId);
    if (!friend) return;

    const msg = event.message as { id: string; type: string; fileName?: string; title?: string };
    const labels: Record<string, string> = {
      sticker: '[スタンプ]',
      image: '[画像]',
      audio: '[音声]',
      video: '[動画]',
      file: msg.fileName ? `[ファイル: ${msg.fileName}]` : '[ファイル]',
      location: msg.title ? `[位置情報: ${msg.title}]` : '[位置情報]',
    };
    const content = labels[msg.type] ?? `[${msg.type}]`;

    // image の場合は LINE Content API でバイナリを取得 → R2 → JSON URL に置換。
    // 失敗時は labels[msg.type] のラベル文字列のまま (フォールバック)。
    let finalContent = content;
    if (msg.type === 'image' && r2 && workerUrl) {
      const lineMessageId = msg.id;
      const { fetchAndStoreIncomingImage } = await import('../services/incoming-image.js');
      const refs = await fetchAndStoreIncomingImage({
        r2,
        workerUrl,
        channelAccessToken: lineAccessToken,
        accountId: lineAccountId ?? 'unknown',
        messageId: lineMessageId,
      });
      if (refs) {
        finalContent = JSON.stringify(refs);
      }
    }

    await db
      .prepare(
        `INSERT INTO messages_log (id, friend_id, direction, message_type, content, broadcast_id, scenario_step_id, source, line_account_id, created_at)
         VALUES (?, ?, 'incoming', ?, ?, NULL, NULL, 'user', ?, ?)`,
      )
      .bind(crypto.randomUUID(), friend.id, msg.type, finalContent, lineAccountId ?? null, jstNow())
      .run();
    return;
  }

  if (event.type === 'message' && event.message.type === 'text') {
    const textMessage = event.message as TextEventMessage;
    const userId =
      event.source.type === 'user' ? event.source.userId : undefined;
    if (!userId) return;

    const friend = await ensureFriendForLineUser(db, lineClient, userId, lineAccountId);
    if (!friend) return;

    const incomingText = textMessage.text;
    const now = jstNow();
    const logId = crypto.randomUUID();

    // 受信メッセージをログに記録
    await db
      .prepare(
        `INSERT INTO messages_log (id, friend_id, direction, message_type, content, broadcast_id, scenario_step_id, source, line_account_id, created_at)
         VALUES (?, ?, 'incoming', 'text', ?, NULL, NULL, 'user', ?, ?)`,
      )
      .bind(logId, friend.id, incomingText, lineAccountId ?? null, now)
      .run();
    await rememberDemoLineUserId(db, friend.id, lineAccountId, userId);

    const normalizedText = incomingText.trim();
    const activeDemoReplySession = getActiveDemoReplySession(friend);
    const activeDemoCandidate = activeDemoReplySession
      ? DEMO_CANDIDATES[activeDemoReplySession.candidateId]
      : null;

    if (lineAccountId === DEMO_CANDIDATE_LINE_ACCOUNT_ID && isSaiyoProApplicationStartText(normalizedText)) {
      if (isSaiyoProApplicationStartButtonText(normalizedText)) {
        await resetSaiyoProApplicationAnswers(db, friend.id);
      }
      const replyMsg = buildMessage(
        'flex',
        isSaiyoProApplicationStartButtonText(normalizedText)
          ? buildDemoApplicationQuestionFlex('age')
          : buildDemoApplicationStartFlex(),
      );
      await lineClient.replyMessage(event.replyToken, [replyMsg]);
      const { messageToLogPayload } = await import('../services/step-delivery.js');
      const payload = messageToLogPayload(replyMsg);
      await db
        .prepare(
          `INSERT INTO messages_log (id, friend_id, direction, message_type, content, broadcast_id, scenario_step_id, delivery_type, source, line_account_id, created_at)
           VALUES (?, ?, 'outgoing', ?, ?, NULL, NULL, 'reply', 'saiyo_pro_application_start', ?, ?)`,
        )
        .bind(crypto.randomUUID(), friend.id, payload.messageType, payload.content, lineAccountId, jstNow())
        .run();
      return;
    }

    if (lineAccountId === DEMO_COMPANY_LINE_ACCOUNT_ID) {
      const companyAccount = await getDemoCompanyAccountForFriend(db, friend);
      const menuReply = await buildDemoCompanyMenuReply(db, normalizedText, activeDemoCandidate, companyAccount);
      if (menuReply) {
        if (normalizedText === '終了') {
          await clearDemoReplySession(db, friend.id);
        }
        const replyMsg = buildMessage('flex', menuReply);
        await lineClient.replyMessage(event.replyToken, [replyMsg]);
        const { messageToLogPayload } = await import('../services/step-delivery.js');
        const payload = messageToLogPayload(replyMsg);
        await db
          .prepare(
            `INSERT INTO messages_log (id, friend_id, direction, message_type, content, broadcast_id, scenario_step_id, delivery_type, source, line_account_id, created_at)
             VALUES (?, ?, 'outgoing', ?, ?, NULL, NULL, 'reply', 'demo_company_menu', ?, ?)`,
          )
          .bind(crypto.randomUUID(), friend.id, payload.messageType, payload.content, lineAccountId, jstNow())
          .run();
        return;
      }
    }

    if (
      lineAccountId === DEMO_CANDIDATE_LINE_ACCOUNT_ID &&
      (normalizedText === 'チャット' || normalizedText === 'プロフィール' || normalizedText === '求人を見る' || normalizedText === '応募状況')
    ) {
      const candidate = resolveDemoCandidateByLineUserId(userId) ?? DEMO_CANDIDATES.yamada;
      const replyContent = normalizedText === '求人を見る'
        ? await buildDemoCandidateCompanyCardsFlex(db, candidate)
        : buildDemoCandidateSelfMenuFlex(candidate, normalizedText);
      const replyMsg = buildMessage('flex', replyContent);
      await lineClient.replyMessage(event.replyToken, [replyMsg]);
      const { messageToLogPayload } = await import('../services/step-delivery.js');
      const payload = messageToLogPayload(replyMsg);
      await db
        .prepare(
          `INSERT INTO messages_log (id, friend_id, direction, message_type, content, broadcast_id, scenario_step_id, delivery_type, source, line_account_id, created_at)
           VALUES (?, ?, 'outgoing', ?, ?, NULL, NULL, 'reply', 'demo_candidate_menu', ?, ?)`,
        )
        .bind(crypto.randomUUID(), friend.id, payload.messageType, payload.content, lineAccountId ?? null, jstNow())
        .run();
      return;
    }

    const demoDetailCandidate = resolveDemoDetailCandidate(normalizedText);
    if (lineAccountId === DEMO_COMPANY_LINE_ACCOUNT_ID && demoDetailCandidate) {
      const candidate = demoDetailCandidate;
      const replyMsg = buildMessage('flex', buildDemoCandidateDetailFlex(candidate));
      await lineClient.replyMessage(event.replyToken, [replyMsg]);
      const { messageToLogPayload } = await import('../services/step-delivery.js');
      const payload = messageToLogPayload(replyMsg);
      await db
        .prepare(
          `INSERT INTO messages_log (id, friend_id, direction, message_type, content, broadcast_id, scenario_step_id, delivery_type, source, line_account_id, created_at)
           VALUES (?, ?, 'outgoing', ?, ?, NULL, NULL, 'reply', 'demo_candidate_detail', ?, ?)`,
        )
        .bind(crypto.randomUUID(), friend.id, payload.messageType, payload.content, lineAccountId ?? null, jstNow())
        .run();
      return;
    }

    if (lineAccountId === DEMO_COMPANY_LINE_ACCOUNT_ID && activeDemoCandidate && isDemoScheduleShortcut(normalizedText)) {
      const body = `${activeDemoCandidate.name}さん、面接日程の件でご連絡です。以下のリンクからご都合のよい日時を選んでください。\n${DEMO_TIMEREX_URL}`;
      await sendDemoPresetToCandidate(db, friend, lineClient, event.replyToken, lineAccountId, activeDemoCandidate, body);
      return;
    }

    if (lineAccountId === DEMO_COMPANY_LINE_ACCOUNT_ID && activeDemoCandidate && isDemoConfirmShortcut(normalizedText)) {
      const body = `${activeDemoCandidate.name}さん、ご返信ありがとうございます。内容を確認しました。追って担当者よりご連絡します。`;
      await sendDemoPresetToCandidate(db, friend, lineClient, event.replyToken, lineAccountId, activeDemoCandidate, body);
      return;
    }

    if (normalizedText === '返信終了' || normalizedText === 'やり取り終了') {
      await clearDemoReplySession(db, friend.id);
      const replyMsg = buildMessage('text', 'やり取りモードを終了しました。');
      await lineClient.replyMessage(event.replyToken, [replyMsg]);
      await db
        .prepare(
          `INSERT INTO messages_log (id, friend_id, direction, message_type, content, broadcast_id, scenario_step_id, delivery_type, source, line_account_id, created_at)
           VALUES (?, ?, 'outgoing', 'text', ?, NULL, NULL, 'reply', 'demo_reply_mode', ?, ?)`,
        )
        .bind(crypto.randomUUID(), friend.id, 'やり取りモードを終了しました。', lineAccountId ?? null, jstNow())
        .run();
      return;
    }

    if (activeDemoReplySession && lineAccountId === DEMO_COMPANY_LINE_ACCOUNT_ID) {
      const replyMsg = buildMessage('flex', buildDemoForwardedFlex(activeDemoReplySession, incomingText));
      await lineClient.replyMessage(event.replyToken, [replyMsg]);

      const { messageToLogPayload } = await import('../services/step-delivery.js');
      const replyPayload = messageToLogPayload(replyMsg);
      await db
        .prepare(
          `INSERT INTO messages_log (id, friend_id, direction, message_type, content, broadcast_id, scenario_step_id, delivery_type, source, line_account_id, created_at)
           VALUES (?, ?, 'outgoing', ?, ?, NULL, NULL, 'reply', 'demo_forward_confirm', ?, ?)`,
        )
        .bind(crypto.randomUUID(), friend.id, replyPayload.messageType, replyPayload.content, lineAccountId ?? null, jstNow())
        .run();

      const candidateLineAccessToken = await getDemoLineAccountToken(db, DEMO_CANDIDATE_LINE_ACCOUNT_ID);
      const candidateLineUserId = activeDemoReplySession.candidateLineUserId
        ?? getRememberedDemoLineUserId(friend, DEMO_CANDIDATE_LINE_ACCOUNT_ID);
      if (candidateLineAccessToken && candidateLineUserId) {
        const candidateClient = new LineClient(candidateLineAccessToken);
        const candidateMsg = buildMessage('flex', buildDemoCompanyMessageFlex(activeDemoReplySession, incomingText));
        await candidateClient.pushMessage(candidateLineUserId, [candidateMsg]);
      }

      await db
        .prepare(
          `INSERT INTO messages_log (id, friend_id, direction, message_type, content, broadcast_id, scenario_step_id, delivery_type, source, line_account_id, created_at)
           VALUES (?, ?, 'outgoing', 'text', ?, NULL, NULL, 'push', 'demo_candidate_forward', ?, ?)`,
        )
        .bind(
          crypto.randomUUID(),
          friend.id,
          `候補者へ転送（デモ）: ${activeDemoReplySession.candidateName} / ${incomingText}`,
          lineAccountId ?? null,
          jstNow(),
        )
        .run();
      return;
    }

    // Cross-account trigger: send message from another account via UUID
    if (incomingText === '体験を完了する' && lineAccountId) {
      try {
        const friendRecord = await db.prepare('SELECT user_id FROM friends WHERE id = ?').bind(friend.id).first<{ user_id: string | null }>();
        if (friendRecord?.user_id) {
          // Find the same user on other accounts
          const otherFriends = await db.prepare(
            'SELECT f.line_user_id, la.channel_access_token FROM friends f INNER JOIN line_accounts la ON la.id = f.line_account_id WHERE f.user_id = ? AND f.line_account_id != ? AND f.is_following = 1'
          ).bind(friendRecord.user_id, lineAccountId).all<{ line_user_id: string; channel_access_token: string }>();

          for (const other of otherFriends.results) {
            const otherClient = new LineClient(other.channel_access_token);
            const { buildMessage: bm } = await import('../services/step-delivery.js');
            await otherClient.pushMessage(other.line_user_id, [bm('flex', JSON.stringify({
              type: 'bubble', size: 'giga',
              header: { type: 'box', layout: 'vertical', paddingAll: '20px', backgroundColor: '#fffbeb',
                contents: [{ type: 'text', text: `${friend.display_name || ''}さんへ`, size: 'lg', weight: 'bold', color: '#1e293b' }],
              },
              body: { type: 'box', layout: 'vertical', paddingAll: '20px',
                contents: [
                  { type: 'text', text: '別アカウントからのアクションを検知しました。', size: 'sm', color: '#06C755', weight: 'bold', wrap: true },
                  { type: 'text', text: 'アカウント連携が正常に動作しています。体験ありがとうございました。', size: 'sm', color: '#1e293b', wrap: true, margin: 'md' },
                  { type: 'separator', margin: 'lg' },
                  { type: 'text', text: 'ステップ配信・フォーム即返信・アカウント連携・リッチメニュー・自動返信 — 全て無料、全てOSS。', size: 'xs', color: '#64748b', wrap: true, margin: 'lg' },
                ],
              },
              footer: { type: 'box', layout: 'vertical', paddingAll: '16px',
                contents: [
                  { type: 'button', action: { type: 'message', label: '導入について相談する', text: '導入支援を希望します' }, style: 'primary', color: '#06C755' },
                  ...(liffUrl ? [{ type: 'button', action: { type: 'uri', label: 'フィードバックを送る', uri: `${liffUrl}?page=form` }, style: 'secondary', margin: 'sm' }] : []),
                ],
              },
            }))]);
          }

          // Reply on Account ② confirming
          await lineClient.replyMessage(event.replyToken, [buildMessage('flex', JSON.stringify({
            type: 'bubble',
            body: { type: 'box', layout: 'vertical', paddingAll: '20px',
              contents: [
                { type: 'text', text: 'Account ① にメッセージを送りました', size: 'sm', color: '#06C755', weight: 'bold', align: 'center' },
                { type: 'text', text: 'Account ① のトーク画面を確認してください', size: 'xs', color: '#64748b', align: 'center', margin: 'md' },
              ],
            },
          }))]);
          return;
        }
      } catch (err) {
        console.error('Cross-account trigger error:', err);
      }
    }

    // 自動返信チェック（このアカウントのルール + グローバルルールのみ）
    // NOTE: Auto-replies use replyMessage (free, no quota) instead of pushMessage
    // The replyToken is only valid for ~1 minute after the message event
    const autoReplyQuery = lineAccountId
      ? `SELECT * FROM auto_replies WHERE is_active = 1 AND (line_account_id IS NULL OR line_account_id = ?) ORDER BY created_at ASC`
      : `SELECT * FROM auto_replies WHERE is_active = 1 AND line_account_id IS NULL ORDER BY created_at ASC`;
    const autoReplyStmt = db.prepare(autoReplyQuery);
    const autoReplies = await (lineAccountId ? autoReplyStmt.bind(lineAccountId) : autoReplyStmt)
      .all<{
        id: string;
        keyword: string;
        match_type: 'exact' | 'contains';
        response_type: string;
        response_content: string;
        template_id: string | null;
        is_active: number;
        created_at: string;
      }>();

    let matched = false;
    let replyTokenConsumed = false;
    for (const rule of autoReplies.results) {
      const isMatch =
        rule.match_type === 'exact'
          ? incomingText === rule.keyword
          : incomingText.includes(rule.keyword);

      if (isMatch) {
        // silent タイプ: 返信しないが matched=true にして unread / push を抑止する
        if (rule.response_type === 'silent') {
          matched = true;
          break;
        }

        try {
          const { resolveMetadata: resolveMeta2 } = await import('../services/step-delivery.js');
          const resolvedMeta2 = await resolveMeta2(db, { user_id: (friend as unknown as Record<string, string | null>).user_id, metadata: (friend as unknown as Record<string, string | null>).metadata });
          const resolved = await resolveAutoReplyContent(db, {
            template_id: rule.template_id,
            response_type: rule.response_type,
            response_content: rule.response_content,
          });
          const expandedContent = expandVariables(resolved.content, { ...friend, metadata: resolvedMeta2 } as Parameters<typeof expandVariables>[1], workerUrl);
          const replyMsg = buildMessage(resolved.messageType, expandedContent);
          await lineClient.replyMessage(event.replyToken, [replyMsg]);
          replyTokenConsumed = true;

          // 送信ログ（replyMessage = 無料）— derive content from the built
          // reply message so any cleanEmptyNodes / parse-failure fallback is
          // reflected in the dashboard.
          const outLogId = crypto.randomUUID();
          const { messageToLogPayload: logPayload2 } = await import('../services/step-delivery.js');
          const wbAutoReplyPayload = logPayload2(replyMsg);
          await db
            .prepare(
              `INSERT INTO messages_log (id, friend_id, direction, message_type, content, broadcast_id, scenario_step_id, delivery_type, source, line_account_id, created_at)
               VALUES (?, ?, 'outgoing', ?, ?, NULL, NULL, 'reply', 'auto_reply', ?, ?)`,
            )
            .bind(outLogId, friend.id, wbAutoReplyPayload.messageType, wbAutoReplyPayload.content, lineAccountId ?? null, jstNow())
            .run();
        } catch (err) {
          console.error('Failed to send auto-reply', err);
        }

        matched = true;
        break;
      }
    }

    if (!matched && lineAccountId === DEMO_CANDIDATE_LINE_ACCOUNT_ID) {
      const replyMsg = buildMessage(
        'text',
        'ありがとうございます。内容を受け付けました。案内メッセージやアンケートに沿ってお進みください。企業との個別のやり取りは、専用チャット画面からお願いします。',
      );
      await lineClient.replyMessage(event.replyToken, [replyMsg]);
      replyTokenConsumed = true;
      matched = true;

      const { messageToLogPayload } = await import('../services/step-delivery.js');
      const payload = messageToLogPayload(replyMsg);
      await db
        .prepare(
          `INSERT INTO messages_log (id, friend_id, direction, message_type, content, broadcast_id, scenario_step_id, delivery_type, source, line_account_id, created_at)
           VALUES (?, ?, 'outgoing', ?, ?, NULL, NULL, 'reply', 'demo_candidate_auto_ack', ?, ?)`,
        )
        .bind(crypto.randomUUID(), friend.id, payload.messageType, payload.content, lineAccountId, jstNow())
        .run();
    }

    // auto_replies にマッチしなかった = 自発メッセージ → unread にする
    if (!matched) {
      await upsertChatOnMessage(db, friend.id);
    }

    // イベントバス発火: message_received
    // Pass replyToken only when auto_reply didn't actually consume it
    await fireEvent(db, 'message_received', {
      friendId: friend.id,
      eventData: { text: incomingText, matched },
      replyToken: replyTokenConsumed ? undefined : event.replyToken,
    }, lineAccessToken, lineAccountId, aiApiKey);

    return;
  }
}

/**
 * auto_reply 行の content/type を resolve する。template_id が set なら templates
 * から取得、参照切れや NULL のときは inline response_content/response_type を使う。
 */
async function resolveAutoReplyContent(
  db: D1Database,
  rule: { template_id: string | null; response_type: string; response_content: string },
): Promise<{ messageType: string; content: string }> {
  if (rule.template_id) {
    const { getTemplateById } = await import('@line-crm/db');
    const tpl = await getTemplateById(db, rule.template_id);
    if (tpl) {
      return { messageType: tpl.message_type, content: tpl.message_content };
    }
  }
  return { messageType: rule.response_type, content: rule.response_content };
}

async function ensureFriendForLineUser(
  db: D1Database,
  lineClient: LineClient,
  lineUserId: string,
  lineAccountId: string | null | undefined,
): Promise<Awaited<ReturnType<typeof upsertFriend>> | null> {
  const existing = await getFriendByLineUserId(db, lineUserId);
  if (existing) {
    if (lineAccountId) {
      await db
        .prepare('UPDATE friends SET line_account_id = ?, is_following = 1, updated_at = ? WHERE id = ?')
        .bind(lineAccountId, jstNow(), existing.id)
        .run();
    }
    await rememberDemoLineUserId(db, existing.id, lineAccountId, lineUserId);
    if (lineAccountId === DEMO_COMPANY_LINE_ACCOUNT_ID) {
      await updateFriendMetadata(db, existing.id, {
        demo_company_line_user_id: lineUserId,
        demo_company_account: buildDemoCompanyAccountFromProfile(lineUserId, existing.display_name),
      });
    }
    return existing as Awaited<ReturnType<typeof upsertFriend>>;
  }

  let profile: Awaited<ReturnType<LineClient['getProfile']>> | null = null;
  try {
    profile = await lineClient.getProfile(lineUserId);
  } catch (err) {
    console.error('Failed to get profile for', lineUserId, err);
  }

  const friend = await upsertFriend(db, {
    lineUserId,
    displayName: profile?.displayName ?? null,
    pictureUrl: profile?.pictureUrl ?? null,
    statusMessage: profile?.statusMessage ?? null,
  });

  if (lineAccountId) {
    await db
      .prepare('UPDATE friends SET line_account_id = ?, is_following = 1, updated_at = ? WHERE id = ?')
      .bind(lineAccountId, jstNow(), friend.id)
      .run();
  }
  await rememberDemoLineUserId(db, friend.id, lineAccountId, lineUserId);
  if (lineAccountId === DEMO_COMPANY_LINE_ACCOUNT_ID) {
    await updateFriendMetadata(db, friend.id, {
      demo_company_line_user_id: lineUserId,
      demo_company_account: buildDemoCompanyAccountFromProfile(lineUserId, profile?.displayName ?? null),
    });
  }
  return friend;
}

function parseFriendMetadata(friend: { metadata?: string | null }): Record<string, unknown> {
  if (!friend.metadata) return {};
  try {
    const parsed = JSON.parse(friend.metadata) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

async function updateFriendMetadata(
  db: D1Database,
  friendId: string,
  patch: Record<string, unknown>,
): Promise<void> {
  const row = await db
    .prepare('SELECT metadata FROM friends WHERE id = ?')
    .bind(friendId)
    .first<{ metadata: string | null }>();
  const current = parseFriendMetadata(row ?? {});
  await db
    .prepare('UPDATE friends SET metadata = ?, updated_at = ? WHERE id = ?')
    .bind(JSON.stringify({ ...current, ...patch }), jstNow(), friendId)
    .run();
}

function getActiveDemoReplySession(friend: { metadata?: string | null }): DemoReplySession | null {
  const meta = parseFriendMetadata(friend);
  const session = meta.demo_reply_session as Partial<DemoReplySession> | null | undefined;
  if (!session?.candidateId || !session.candidateName || !session.job || !session.expiresAt) return null;
  if (new Date(session.expiresAt).getTime() <= Date.now()) return null;
  return session as DemoReplySession;
}

async function handleSaiyoProApplicationPostback(
  db: D1Database,
  lineClient: LineClient,
  replyToken: string,
  friend: { id: string; metadata?: string | null },
  postbackData: string,
  lineAccountId: string | null | undefined,
): Promise<boolean> {
  const parsed = parseSaiyoProApplicationPostback(postbackData);
  if (!parsed) return false;

  const current = await getSaiyoProApplicationAnswers(db, friend);
  const answers = mergeSaiyoProApplicationAnswer(current, parsed.question, parsed.value);
  await upsertSaiyoProApplication(db, friend.id, lineAccountId, answers);

  const nextQuestion = getNextSaiyoProApplicationQuestion(answers);
  const replyMsg = nextQuestion
    ? buildMessage('flex', buildDemoApplicationQuestionFlex(nextQuestion))
    : isSaiyoProApplicationEligible(answers)
      ? buildMessage('flex', buildSaiyoProApplicationResultFlex())
      : buildMessage('text', buildSaiyoProApplicationResultText(answers));
  await lineClient.replyMessage(replyToken, [replyMsg]);

  const { messageToLogPayload } = await import('../services/step-delivery.js');
  const payload = messageToLogPayload(replyMsg);
  await db
    .prepare(
      `INSERT INTO messages_log (id, friend_id, direction, message_type, content, broadcast_id, scenario_step_id, delivery_type, source, line_account_id, created_at)
       VALUES (?, ?, 'outgoing', ?, ?, NULL, NULL, 'reply', 'saiyo_pro_application', ?, ?)`,
    )
    .bind(crypto.randomUUID(), friend.id, payload.messageType, payload.content, lineAccountId ?? null, jstNow())
    .run();
  return true;
}

function parseSaiyoProApplicationPostback(postbackData: string): { question: SaiyoProApplicationQuestion; value: string } | null {
  const [, , question, value] = postbackData.split(':');
  if (!isSaiyoProApplicationQuestion(question) || !value) return null;
  return { question, value };
}

function isSaiyoProApplicationQuestion(value: string | undefined): value is SaiyoProApplicationQuestion {
  return value === 'age' || value === 'gender' || value === 'location' || value === 'income';
}

function isSaiyoProApplicationStartText(text: string): boolean {
  return ['アンケート', '応募確認', '回答する', '応募する', '応募アンケート', '応募内容の確認を始める', '求人案内の確認を始める'].includes(text);
}

function isSaiyoProApplicationStartButtonText(text: string): boolean {
  return text === '応募内容の確認を始める' || text === '求人案内の確認を始める';
}

async function getSaiyoProApplicationAnswers(
  db: D1Database,
  friend: { id: string; metadata?: string | null },
): Promise<SaiyoProApplicationAnswers> {
  const row = await db
    .prepare(
      `SELECT age, gender, location, income
         FROM saiyo_pro_applications
        WHERE friend_id = ?
        LIMIT 1`,
    )
    .bind(friend.id)
    .first<SaiyoProApplicationRow>()
    .catch((err) => {
      console.error('Failed to read saiyo pro application row', err);
      return null;
    });

  if (row) {
    return normalizeSaiyoProApplicationAnswers(row);
  }

  const meta = parseFriendMetadata(friend);
  const raw = meta.saiyo_pro_application;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  return normalizeSaiyoProApplicationAnswers(raw as Record<string, unknown>);
}

function normalizeSaiyoProApplicationAnswers(record: Record<string, unknown>): SaiyoProApplicationAnswers {
  const answers: SaiyoProApplicationAnswers = {};
  for (const question of SAIYO_PRO_APPLICATION_QUESTION_ORDER) {
    if (typeof record[question] === 'string') answers[question] = record[question];
  }
  return answers;
}

function mergeSaiyoProApplicationAnswer(
  current: SaiyoProApplicationAnswers,
  question: SaiyoProApplicationQuestion,
  value: string,
): SaiyoProApplicationAnswers {
  const answers: SaiyoProApplicationAnswers = {};
  for (const orderedQuestion of SAIYO_PRO_APPLICATION_QUESTION_ORDER) {
    if (orderedQuestion === question) {
      answers[orderedQuestion] = value;
      break;
    }
    if (current[orderedQuestion]) answers[orderedQuestion] = current[orderedQuestion];
  }
  return answers;
}

async function resetSaiyoProApplicationAnswers(db: D1Database, friendId: string): Promise<void> {
  await db
    .prepare(
      `UPDATE saiyo_pro_applications
          SET age = NULL,
              gender = NULL,
              location = NULL,
              income = NULL,
              eligibility_status = 'pending',
              interview_url = NULL,
              updated_at = ?
        WHERE friend_id = ?`,
    )
    .bind(jstNow(), friendId)
    .run()
    .catch((err) => {
      console.error('Failed to reset saiyo pro application row', err);
    });

  await updateFriendMetadata(db, friendId, { saiyo_pro_application: null });
}

async function upsertSaiyoProApplication(
  db: D1Database,
  friendId: string,
  lineAccountId: string | null | undefined,
  answers: SaiyoProApplicationAnswers,
): Promise<void> {
  const eligibilityStatus = getNextSaiyoProApplicationQuestion(answers)
    ? 'pending'
    : isSaiyoProApplicationEligible(answers)
      ? 'eligible'
      : 'ineligible';

  await db
    .prepare(
      `INSERT INTO saiyo_pro_applications (
         id, friend_id, line_account_id, age, gender, location, income,
         eligibility_status, interview_url, source, created_at, updated_at
       )
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'line_questionnaire', ?, ?)
       ON CONFLICT(friend_id) DO UPDATE SET
         line_account_id = excluded.line_account_id,
         age = excluded.age,
         gender = excluded.gender,
         location = excluded.location,
         income = excluded.income,
         eligibility_status = excluded.eligibility_status,
         interview_url = excluded.interview_url,
         updated_at = excluded.updated_at`,
    )
    .bind(
      crypto.randomUUID(),
      friendId,
      lineAccountId ?? null,
      answers.age ?? null,
      answers.gender ?? null,
      answers.location ?? null,
      answers.income ?? null,
      eligibilityStatus,
      eligibilityStatus === 'eligible' ? DEMO_TIMEREX_URL : null,
      jstNow(),
      jstNow(),
    )
    .run();
}

const SAIYO_PRO_APPLICATION_QUESTION_ORDER: SaiyoProApplicationQuestion[] = ['age', 'gender', 'location', 'income'];

function getNextSaiyoProApplicationQuestion(answers: SaiyoProApplicationAnswers): SaiyoProApplicationQuestion | null {
  return SAIYO_PRO_APPLICATION_QUESTION_ORDER.find((question) => !answers[question]) ?? null;
}

function isSaiyoProApplicationEligible(answers: SaiyoProApplicationAnswers): boolean {
  const ageMatches =
    answers.age === 'age_22_24' ||
    answers.age === 'age_25_27' ||
    answers.age === 'under27';
  const locationMatches =
    answers.location === 'kanto' ||
    answers.location === 'tokyo' ||
    answers.location === 'anywhere';
  return ageMatches && answers.gender === 'male' && locationMatches;
}

function buildSaiyoProApplicationResultText(answers: SaiyoProApplicationAnswers): string {
  if (isSaiyoProApplicationEligible(answers)) {
    return [
      'ご回答ありがとうございます。',
      '',
      '採用PROから求人案内が届きました。',
      '内容が合いそうな方には、次のステップとして面談日程をご案内しています。',
      '',
      '以下のURLからご都合のよい日時を選んでください。',
      DEMO_TIMEREX_URL,
      '',
      '求人に関する個別のやり取りは、案内された専用チャット画面で行います。',
    ].join('\n');
  }

  return [
    'ご回答ありがとうございます。',
    '',
    'いただいた内容をもとに確認します。',
    '必要な場合は、追加書類や今後のご案内をこのLINEでお送りします。',
    '',
    '通常のトーク内容は企業へ直接送信されません。',
  ].join('\n');
}

function buildSaiyoProApplicationResultFlex(): string {
  return JSON.stringify({
    type: 'bubble',
    size: 'mega',
    hero: {
      type: 'image',
      url: SAIYO_PRO_APPLICATION_COMPLETE_IMAGE_URL,
      size: 'full',
      aspectRatio: '3:2',
      aspectMode: 'cover',
    },
    body: {
      type: 'box',
      layout: 'vertical',
      paddingAll: '18px',
      spacing: 'md',
      contents: [
        { type: 'text', text: '採用PROから求人案内が届きました', size: 'xl', weight: 'bold', color: SAIYO_PRO_BRAND_NAVY, wrap: true },
        { type: 'text', text: '内容が合いそうな方には、次のステップとして面談日程をご案内しています。', size: 'sm', color: SAIYO_PRO_BRAND_MUTED, wrap: true },
        {
          type: 'box',
          layout: 'vertical',
          backgroundColor: SAIYO_PRO_BRAND_SOFT_BG,
          cornerRadius: 'md',
          paddingAll: '12px',
          contents: [
            { type: 'text', text: '求人案内', size: 'xs', color: SAIYO_PRO_BRAND_PRIMARY, weight: 'bold' },
            { type: 'text', text: '採用PRO / 正社員求人', size: 'sm', color: SAIYO_PRO_BRAND_NAVY, wrap: true, margin: 'sm' },
          ],
        },
      ],
    },
    footer: {
      type: 'box',
      layout: 'vertical',
      paddingAll: '12px',
      contents: [
        {
          type: 'button',
          style: 'primary',
          color: SAIYO_PRO_BRAND_PRIMARY,
          height: 'sm',
          action: {
            type: 'uri',
            label: '面談日程を選ぶ',
            uri: DEMO_TIMEREX_URL,
          },
        },
      ],
    },
  });
}

function buildDemoCompanyAccountFromProfile(lineUserId: string, displayName: string | null | undefined): DemoCompanyAccount {
  const suffix = lineUserId.slice(-6) || 'demo';
  const cleanName = typeof displayName === 'string' ? displayName.trim() : '';
  return {
    id: `demo-company-${suffix}`,
    companyName: `${DEMO_SERVICE_NAME}【公式】`,
    staffName: cleanName || '対応担当',
    linked: false,
  };
}

function normalizeDemoCompanyAccount(value: unknown): DemoCompanyAccount | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  if (typeof record.id !== 'string' || typeof record.companyName !== 'string') return null;
  return {
    id: record.id,
    companyName: record.companyName,
    staffName: typeof record.staffName === 'string' && record.staffName ? record.staffName : '対応担当',
    linked: record.linked === true,
  };
}

async function getDemoCompanyAccountForFriend(db: D1Database, friend: { metadata?: string | null; line_user_id?: string; display_name?: string | null }): Promise<DemoCompanyAccount | null> {
  const meta = parseFriendMetadata(friend);
  const existing = normalizeDemoCompanyAccount(meta.demo_company_account);
  if (existing) return existing;
  if (!friend.line_user_id) return null;
  const account = buildDemoCompanyAccountFromProfile(friend.line_user_id, friend.display_name);
  const friendId = (friend as { id?: string }).id;
  if (friendId) {
    await updateFriendMetadata(db, friendId, { demo_company_account: account, demo_company_line_user_id: friend.line_user_id });
  }
  return account;
}

async function clearDemoReplySession(db: D1Database, friendId: string): Promise<void> {
  await updateFriendMetadata(db, friendId, { demo_reply_session: null });
}

async function rememberDemoLineUserId(
  db: D1Database,
  friendId: string,
  lineAccountId: string | null | undefined,
  lineUserId: string,
): Promise<void> {
  if (!lineAccountId) return;
  if (lineAccountId === DEMO_CANDIDATE_LINE_ACCOUNT_ID) {
    await updateFriendMetadata(db, friendId, { demo_candidate_line_user_id: lineUserId });
  } else if (lineAccountId === DEMO_COMPANY_LINE_ACCOUNT_ID) {
    await updateFriendMetadata(db, friendId, { demo_company_line_user_id: lineUserId });
  }
}

function getRememberedDemoLineUserId(
  friend: { metadata?: string | null; line_user_id?: string },
  lineAccountId: string,
): string | null {
  const meta = parseFriendMetadata(friend);
  const key = lineAccountId === DEMO_CANDIDATE_LINE_ACCOUNT_ID
    ? 'demo_candidate_line_user_id'
    : 'demo_company_line_user_id';
  const value = meta[key];
  return typeof value === 'string' && value ? value : friend.line_user_id ?? null;
}

function resolveDemoDetailCandidate(text: string): DemoCandidate | null {
  if (text === '山田詳細') return DEMO_CANDIDATES.yamada;
  if (text === '時原詳細' || text === '時原 陸' || text === '時原陸') return DEMO_CANDIDATES.tokihara;
  return null;
}

function resolveDemoCandidateByLineUserId(lineUserId: string): DemoCandidate | null {
  return resolveSaiyoProDemoCandidateByLineUserId(lineUserId);
}

async function buildDemoCompanyMenuReply(db: D1Database, text: string, activeCandidate: DemoCandidate | null, companyAccount: DemoCompanyAccount | null = null): Promise<string | null> {
  if (text === 'マッチ求職者一覧' || text === '新着応募者' || text === '候補者' || text === '応募者' || text === '求職者' || text === '求職者リスト' || text === '新着' || text === '未対応' || text === '未対応チャット') {
    return buildDemoCandidateListFlex(db, text);
  }
  if (text === '面談予定' || text === '面接予定') {
    return buildDemoCandidateListFlex(db, text);
  }
  if (text === '面接') {
    return activeCandidate
      ? buildDemoCandidateDetailFlex(activeCandidate)
      : buildDemoCandidateListFlex(db, '面接');
  }
  if (text === '終了') {
    return buildDemoCloseChatFlex(activeCandidate);
  }
  return null;
}

function getDemoCompanyDisplayName(companyAccount: DemoCompanyAccount | null): string {
  return companyAccount?.companyName ?? DEMO_COMPANY_NAME;
}

function getDemoCompanyLinkStatus(companyAccount: DemoCompanyAccount | null): string {
  return companyAccount?.linked ? '連携済み' : '未連携';
}

function buildDemoCompanyJobsUrl(companyAccount: DemoCompanyAccount | null): string {
  const companyName = getDemoCompanyDisplayName(companyAccount);
  return `${DEMO_WORKER_URL}/demo-company-jobs?companyName=${encodeURIComponent(companyName)}`;
}

function buildDemoCompanyHiresFlex(companyAccount: DemoCompanyAccount | null = null): string {
  return JSON.stringify({
    type: 'bubble',
    size: 'mega',
    header: {
      type: 'box',
      layout: 'vertical',
      backgroundColor: '#7C3AED',
      paddingAll: '16px',
      contents: [
        { type: 'text', text: '採用実績', size: 'xs', color: '#FFFFFF', weight: 'bold' },
        { type: 'text', text: getDemoCompanyDisplayName(companyAccount), size: 'lg', color: '#FFFFFF', weight: 'bold', margin: 'sm', wrap: true },
      ],
    },
    body: {
      type: 'box',
      layout: 'vertical',
      spacing: 'sm',
      paddingAll: '16px',
      contents: [
        buildDemoInfoRow('今月の面談', '3件'),
        buildDemoInfoRow('採用決定', '0件'),
        buildDemoInfoRow('連携状態', getDemoCompanyLinkStatus(companyAccount)),
        buildDemoInfoRow('成果報酬', '採用成立後に計上'),
        buildDemoInfoRow('次の運用', '面談結果を返すほどマッチング精度が上がります'),
      ],
    },
  });
}

function buildDemoCompanyJobsFlex(companyAccount: DemoCompanyAccount | null = null): string {
  return JSON.stringify({
    type: 'bubble',
    size: 'mega',
    header: {
      type: 'box',
      layout: 'vertical',
      backgroundColor: '#7C3AED',
      paddingAll: '16px',
      contents: [
        { type: 'text', text: '求人案内設定', size: 'xs', color: '#FFFFFF', weight: 'bold' },
        { type: 'text', text: getDemoCompanyDisplayName(companyAccount), size: 'lg', color: '#FFFFFF', weight: 'bold', margin: 'sm', wrap: true },
      ],
    },
    body: {
      type: 'box',
      layout: 'vertical',
      spacing: 'sm',
      paddingAll: '16px',
      contents: [
        buildDemoInfoRow('掲載中', '店舗スタッフ / 店長候補'),
        buildDemoInfoRow('連携状態', getDemoCompanyLinkStatus(companyAccount)),
        buildDemoInfoRow('案内先', '採用PRO'),
        buildDemoInfoRow('操作', '求人案内を作成して、対象者へ通知できます'),
      ],
    },
    footer: {
      type: 'box',
      layout: 'vertical',
      paddingAll: '12px',
      contents: [
        {
          type: 'button',
          style: 'primary',
          color: '#16A34A',
          height: 'sm',
          action: { type: 'uri', label: '求人案内を作成', uri: buildDemoCompanyJobsUrl(companyAccount) },
        },
      ],
    },
  });
}

function buildDemoCompanySettingsFlex(companyAccount: DemoCompanyAccount | null = null): string {
  return JSON.stringify({
    type: 'bubble',
    size: 'mega',
    header: {
      type: 'box',
      layout: 'vertical',
      backgroundColor: '#4B5563',
      paddingAll: '16px',
      contents: [
        { type: 'text', text: '設定', size: 'xs', color: '#FFFFFF', weight: 'bold' },
        { type: 'text', text: getDemoCompanyDisplayName(companyAccount), size: 'lg', color: '#FFFFFF', weight: 'bold', margin: 'sm', wrap: true },
      ],
    },
    body: {
      type: 'box',
      layout: 'vertical',
      spacing: 'md',
      paddingAll: '16px',
      contents: [
        { type: 'text', text: '面談URL・求人企業名・担当者名は、対応画面右上の対応設定から編集できます。', size: 'sm', color: '#111827', wrap: true },
        buildDemoInfoRow('連携状態', getDemoCompanyLinkStatus(companyAccount)),
      ],
    },
    footer: {
      type: 'box',
      layout: 'vertical',
      paddingAll: '12px',
      contents: [
        { type: 'button', style: 'primary', color: '#4B5563', height: 'sm', action: { type: 'message', label: '求職者', text: '求職者' } },
      ],
    },
  });
}

async function buildDemoCandidateListFlex(db: D1Database, mode: string): Promise<string> {
  const realCandidates = await getDemoCandidatesFromFriends(db);
  const candidatesWithStatus = await Promise.all(
    realCandidates.map(async (candidate) => ({
      candidate,
      status: await getDemoCandidateStatus(db, candidate),
    })),
  );
  const candidates = candidatesWithStatus
    .filter((item) => item.status.status !== 'archived')
    .map((item) => item.candidate);
  if (candidates.length === 0) {
    return JSON.stringify({
      type: 'bubble',
      size: 'mega',
      header: {
        type: 'box',
        layout: 'vertical',
        backgroundColor: '#111827',
        paddingAll: '14px',
        contents: [
          { type: 'text', text: mode, wrap: true, size: 'xs', color: '#FFFFFF', weight: 'bold' },
          { type: 'text', text: '求職者リスト', wrap: true, size: 'lg', color: '#FFFFFF', weight: 'bold', margin: 'sm' },
        ],
      },
      body: {
        type: 'box',
        layout: 'vertical',
        paddingAll: '16px',
        contents: [
          { type: 'text', text: '表示できる求職者はいません。', size: 'sm', color: '#374151', wrap: true },
        ],
      },
    });
  }
  return JSON.stringify({
    type: 'carousel',
    contents: candidates.map((candidate) => ({
      type: 'bubble',
      size: 'mega',
      header: {
        type: 'box',
        layout: 'vertical',
        backgroundColor: candidate.color,
        paddingAll: '14px',
        contents: [
          { type: 'text', text: mode, wrap: true, size: 'xs', color: '#FFFFFF', weight: 'bold' },
          { type: 'text', text: candidate.name, wrap: true, size: 'lg', color: '#FFFFFF', weight: 'bold', margin: 'sm' },
        ],
      },
      body: {
        type: 'box',
        layout: 'vertical',
        spacing: 'sm',
        paddingAll: '14px',
        contents: [
          buildDemoInfoRow('応募求人', candidate.job),
          buildDemoInfoRow('状態', candidate.status),
          buildDemoInfoRow('最終返信', candidate.lastMessage),
        ],
      },
      footer: {
        type: 'box',
        layout: 'vertical',
        spacing: 'sm',
        paddingAll: '12px',
        contents: [
          { type: 'button', style: 'primary', color: candidate.color, height: 'sm', action: { type: 'message', label: '候補者詳細', text: candidate.id === 'tokihara' ? '時原詳細' : '山田詳細' } },
          { type: 'button', style: 'secondary', height: 'sm', action: buildDemoChatUriAction(candidate, 'やり取りする') },
        ],
      },
    })),
  });
}

async function getDemoCandidatesFromFriends(db: D1Database): Promise<DemoCandidate[]> {
  const rows = await db
    .prepare(
      `SELECT id, line_user_id, display_name, created_at
         FROM friends
        WHERE line_account_id = ?
          AND is_following = 1
        ORDER BY datetime(COALESCE(updated_at, created_at)) DESC`,
    )
    .bind(DEMO_CANDIDATE_LINE_ACCOUNT_ID)
    .all<FriendCandidateRow>();

  return rows.results.map((row, index) => {
    const name = row.display_name?.trim() || `応募者 ${index + 1}`;
    return {
      id: row.id,
      name,
      job: '採用PRO 求人案内対象者',
      color: demoCandidateColor(row.id),
      status: '応募受付',
      lastMessage: 'LINE登録済み',
      lineUserId: row.line_user_id,
    };
  });
}

function demoCandidateColor(seed: string): string {
  const colors = ['#2563EB', '#16A34A', '#7C3AED', '#EA580C', '#0891B2', '#4B5563'];
  let hash = 0;
  for (const char of seed) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return colors[hash % colors.length] ?? colors[0];
}

async function getDemoCandidateStatus(db: D1Database, candidate: DemoCandidate): Promise<DemoCandidateStatus> {
  const row = await db
    .prepare(
      `SELECT content
         FROM messages_log
        WHERE source = 'demo_candidate_status'
          AND content LIKE ?
        ORDER BY created_at DESC
        LIMIT 1`,
    )
    .bind(`%"candidateId":"${candidate.id}"%`)
    .first<{ content: string }>();
  if (!row?.content) return normalizeDemoCandidateStatus(candidate, 'active');
  try {
    const parsed = JSON.parse(row.content) as Partial<DemoCandidateStatus>;
    return normalizeDemoCandidateStatus(candidate, parsed.status);
  } catch {
    return normalizeDemoCandidateStatus(candidate, 'active');
  }
}

function normalizeDemoCandidateStatus(candidate: DemoCandidate, value: unknown): DemoCandidateStatus {
  const status = value === 'interview' || value === 'rejected' || value === 'archived' ? value : 'active';
  const labels: Record<DemoCandidateStatus['status'], string> = {
    active: 'やり取り中',
    interview: '面接',
    rejected: '不合格',
    archived: '削除済み',
  };
  return {
    candidateId: candidate.id,
    status,
    label: labels[status],
  };
}

function buildDemoCloseChatFlex(activeCandidate: DemoCandidate | null): string {
  const name = activeCandidate?.name ?? '候補者';
  return JSON.stringify({
    type: 'bubble',
    size: 'mega',
    header: {
      type: 'box',
      layout: 'vertical',
      backgroundColor: '#6B7280',
      paddingAll: '16px',
      contents: [
        { type: 'text', text: '対応終了', size: 'xs', color: '#FFFFFF', weight: 'bold' },
        { type: 'text', text: name, size: 'lg', color: '#FFFFFF', weight: 'bold', margin: 'sm', wrap: true },
      ],
    },
    body: {
      type: 'box',
      layout: 'vertical',
      spacing: 'md',
      paddingAll: '16px',
      contents: [
        { type: 'text', text: 'デモ上の対応を終了しました。続ける場合は候補者詳細から再開できます。', size: 'sm', color: '#111827', wrap: true },
      ],
    },
    footer: {
      type: 'box',
      layout: 'vertical',
      paddingAll: '12px',
      contents: [
        { type: 'button', style: 'secondary', height: 'sm', action: { type: 'message', label: '候補者一覧', text: '候補者' } },
      ],
    },
  });
}

function buildDemoChatUriAction(candidate: DemoCandidate, label: string): Record<string, string> {
  return {
    type: 'uri',
    label,
    uri: `${DEMO_WORKER_URL}/demo-chat?candidate=${encodeURIComponent(candidate.id)}`,
  };
}

function isDemoScheduleShortcut(text: string): boolean {
  return ['面接', '面接日程', '日程', '日程送る', '面接日程を送る'].includes(text);
}

function isDemoConfirmShortcut(text: string): boolean {
  return ['確認', '確認メッセージ', '確認メッセージを送る'].includes(text);
}

async function getDemoLineAccountToken(db: D1Database, accountId: string): Promise<string | null> {
  const row = await db
    .prepare('SELECT channel_access_token FROM line_accounts WHERE id = ? AND is_active = 1')
    .bind(accountId)
    .first<{ channel_access_token: string }>();
  return row?.channel_access_token ?? null;
}

async function sendDemoPresetToCandidate(
  db: D1Database,
  friend: { id: string; metadata?: string | null; line_user_id?: string },
  lineClient: LineClient,
  replyToken: string,
  lineAccountId: string | null | undefined,
  candidate: DemoCandidate,
  body: string,
): Promise<void> {
  const candidateLineAccessToken = await getDemoLineAccountToken(db, DEMO_CANDIDATE_LINE_ACCOUNT_ID);
  const candidateLineUserId = candidate.lineUserId ?? getRememberedDemoLineUserId(friend, DEMO_CANDIDATE_LINE_ACCOUNT_ID);
  const candidateMsg = buildMessage('flex', buildDemoCompanyMessageFlex(
    {
      candidateId: candidate.id,
      candidateName: candidate.name,
      job: candidate.job,
      candidateLineUserId: candidate.lineUserId,
      expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
    },
    body,
  ));

  if (candidateLineAccessToken && candidateLineUserId) {
    const candidateClient = new LineClient(candidateLineAccessToken);
    await candidateClient.pushMessage(candidateLineUserId, [candidateMsg]);
  }

  const replyMsg = buildMessage('flex', buildDemoPresetSentFlex(candidate, body));
  await lineClient.replyMessage(replyToken, [replyMsg]);

  const { messageToLogPayload } = await import('../services/step-delivery.js');
  const candidatePayload = messageToLogPayload(candidateMsg);
  const replyPayload = messageToLogPayload(replyMsg);
  await db.batch([
    db
      .prepare(
        `INSERT INTO messages_log (id, friend_id, direction, message_type, content, broadcast_id, scenario_step_id, delivery_type, source, line_account_id, created_at)
         VALUES (?, ?, 'outgoing', ?, ?, NULL, NULL, 'push', 'demo_candidate_preset', ?, ?)`,
      )
      .bind(crypto.randomUUID(), friend.id, candidatePayload.messageType, candidatePayload.content, DEMO_CANDIDATE_LINE_ACCOUNT_ID, jstNow()),
    db
      .prepare(
        `INSERT INTO messages_log (id, friend_id, direction, message_type, content, broadcast_id, scenario_step_id, delivery_type, source, line_account_id, created_at)
         VALUES (?, ?, 'outgoing', ?, ?, NULL, NULL, 'reply', 'demo_preset_sent', ?, ?)`,
      )
      .bind(crypto.randomUUID(), friend.id, replyPayload.messageType, replyPayload.content, lineAccountId ?? null, jstNow()),
  ]);
}

function buildDemoCandidateDetailFlex(candidate: DemoCandidate): string {
  return JSON.stringify({
    type: 'bubble',
    size: 'mega',
    header: {
      type: 'box',
      layout: 'vertical',
      backgroundColor: candidate.color,
      paddingAll: '16px',
      contents: [
        { type: 'text', text: '候補者詳細', size: 'xs', color: '#FFFFFF', weight: 'bold' },
        { type: 'text', text: candidate.name, size: 'xl', color: '#FFFFFF', weight: 'bold', margin: 'sm', wrap: true },
      ],
    },
    body: {
      type: 'box',
      layout: 'vertical',
      spacing: 'md',
      paddingAll: '16px',
      contents: [
        buildDemoInfoRow('応募求人', candidate.job),
        buildDemoInfoRow('ステータス', candidate.status),
        buildDemoInfoRow('最終返信', candidate.lastMessage),
        { type: 'separator', margin: 'md' },
        { type: 'text', text: '次にやることをこのカードから選べます。', size: 'xs', color: '#6B7280', wrap: true },
      ],
    },
    footer: {
      type: 'box',
      layout: 'vertical',
      spacing: 'sm',
      paddingAll: '12px',
      contents: [
        { type: 'button', style: 'primary', color: candidate.color, height: 'sm', action: { type: 'postback', label: '面接日程を送る', data: `demo:send-schedule:${candidate.id}` } },
        { type: 'button', style: 'secondary', height: 'sm', action: { type: 'postback', label: '確認メッセージを送る', data: `demo:send-confirm:${candidate.id}` } },
        { type: 'button', style: 'link', height: 'sm', action: buildDemoChatUriAction(candidate, 'やり取りする') },
      ],
    },
  });
}

function buildDemoInfoRow(label: string, value: string): Record<string, unknown> {
  return {
    type: 'box',
    layout: 'horizontal',
    spacing: 'sm',
    contents: [
      { type: 'text', text: label, size: 'xs', color: '#6B7280', flex: 2 },
      { type: 'text', text: value, size: 'xs', color: '#111827', flex: 5, wrap: true },
    ],
  };
}

function buildDemoPresetSentFlex(candidate: DemoCandidate, body: string): string {
  return JSON.stringify({
    type: 'bubble',
    size: 'mega',
    header: {
      type: 'box',
      layout: 'vertical',
      backgroundColor: candidate.color,
      paddingAll: '16px',
      contents: [
        { type: 'text', text: '送信しました', size: 'xs', color: '#FFFFFF', weight: 'bold' },
        { type: 'text', text: candidate.name, size: 'lg', color: '#FFFFFF', weight: 'bold', margin: 'sm', wrap: true },
      ],
    },
    body: {
      type: 'box',
      layout: 'vertical',
      spacing: 'md',
      paddingAll: '16px',
      contents: [
        { type: 'text', text: body, size: 'sm', color: '#111827', wrap: true },
        ...buildDemoLinkButtons(body),
      ],
    },
    footer: {
      type: 'box',
      layout: 'vertical',
      spacing: 'sm',
      paddingAll: '12px',
      contents: [
        { type: 'button', style: 'secondary', height: 'sm', action: buildDemoChatUriAction(candidate, '続けてやり取り') },
      ],
    },
  });
}

function buildDemoReplyModeFlex(candidate: DemoCandidate): string {
  return JSON.stringify({
    type: 'bubble',
    size: 'mega',
    header: {
      type: 'box',
      layout: 'vertical',
      backgroundColor: candidate.color,
      paddingAll: '16px',
      contents: [
        { type: 'text', text: 'やり取りモード開始', size: 'xs', color: '#FFFFFF', weight: 'bold' },
        { type: 'text', text: candidate.name, size: 'xl', color: '#FFFFFF', weight: 'bold', margin: 'sm', wrap: true },
      ],
    },
    body: {
      type: 'box',
      layout: 'vertical',
      spacing: 'md',
      paddingAll: '16px',
      contents: [
        { type: 'text', text: 'このまま文章を送ると、応募者へメッセージが届きます。', size: 'sm', color: '#111827', wrap: true },
        { type: 'separator', margin: 'md' },
        {
          type: 'box',
          layout: 'horizontal',
          spacing: 'sm',
          contents: [
            { type: 'text', text: '応募求人', size: 'xs', color: '#6B7280', flex: 2 },
            { type: 'text', text: candidate.job, size: 'xs', color: '#111827', flex: 5, wrap: true },
          ],
        },
        { type: 'text', text: '終了する場合は「やり取り終了」と送ってください。やり取りモードは60分で自動終了します。', size: 'xs', color: '#6B7280', wrap: true, margin: 'md' },
      ],
    },
    footer: {
      type: 'box',
      layout: 'vertical',
      paddingAll: '12px',
      contents: [
        { type: 'button', style: 'link', height: 'sm', action: { type: 'message', label: 'やり取り終了', text: 'やり取り終了' } },
      ],
    },
  });
}

function buildDemoForwardedFlex(session: DemoReplySession, body: string): string {
  return JSON.stringify({
    type: 'bubble',
    size: 'mega',
    header: {
      type: 'box',
      layout: 'vertical',
      backgroundColor: '#16A34A',
      paddingAll: '16px',
      contents: [
        { type: 'text', text: '送信しました（デモ）', size: 'xs', color: '#FFFFFF', weight: 'bold' },
        { type: 'text', text: session.candidateName, size: 'lg', color: '#FFFFFF', weight: 'bold', margin: 'sm', wrap: true },
      ],
    },
    body: {
      type: 'box',
      layout: 'vertical',
      spacing: 'md',
      paddingAll: '16px',
      contents: [
        { type: 'text', text: body, size: 'sm', color: '#111827', wrap: true },
        { type: 'separator', margin: 'md' },
        { type: 'text', text: '実装時はこの本文を採用PROへpushし、conversation_messagesへ保存します。', size: 'xs', color: '#6B7280', wrap: true },
      ],
    },
    footer: {
      type: 'box',
      layout: 'vertical',
      spacing: 'sm',
      paddingAll: '12px',
      contents: [
        { type: 'button', style: 'secondary', height: 'sm', action: buildDemoChatUriAction(DEMO_CANDIDATES[session.candidateId] ?? DEMO_CANDIDATES.yamada, '続けてやり取り') },
        { type: 'button', style: 'link', height: 'sm', action: { type: 'message', label: 'やり取り終了', text: 'やり取り終了' } },
      ],
    },
  });
}

function buildDemoCompanyMessageFlex(session: DemoReplySession, body: string): string {
  const linkButtons = buildDemoLinkButtons(body);
  return JSON.stringify({
    type: 'bubble',
    size: 'mega',
    header: {
      type: 'box',
      layout: 'vertical',
      backgroundColor: '#111827',
      paddingAll: '16px',
      contents: [
        { type: 'text', text: '企業からメッセージ', size: 'xs', color: '#FFFFFF', weight: 'bold' },
        { type: 'text', text: DEMO_COMPANY_NAME, size: 'lg', color: '#FFFFFF', weight: 'bold', margin: 'sm', wrap: true },
      ],
    },
    body: {
      type: 'box',
      layout: 'vertical',
      spacing: 'md',
      paddingAll: '16px',
      contents: [
        { type: 'text', text: body, size: 'sm', color: '#111827', wrap: true },
        ...linkButtons,
        { type: 'separator', margin: 'md' },
        { type: 'text', text: '採用PROで返信すると、採用PRO 企業向けへ新着通知が届きます。', size: 'xs', color: '#6B7280', wrap: true },
      ],
    },
  });
}

function buildDemoCandidateSelfMenuFlex(candidate: DemoCandidate, mode: string): string {
  const isProfile = mode === 'プロフィール';
  const isJobs = mode === '求人を見る';
  const isStatus = mode === '応募状況';
  if (!isProfile && !isJobs && !isStatus) {
    return buildDemoCandidateMatchPromptFlex(candidate);
  }
  if (isJobs) {
    return buildDemoCandidateJobCardsFlex(candidate);
  }
  if (isStatus) {
    return buildDemoCandidateStatusFlex(candidate);
  }
  const title = isProfile ? 'プロフィール' : isStatus ? '応募状況' : '応募チャット';
  const body = isProfile
    ? 'プロフィール画面で、企業へ見せる名前・連絡先・希望勤務時間を確認できます。'
    : '現在の応募状況、面接予定、選考結果を確認できます。';
  const buttonLabel = isProfile
    ? 'プロフィールを開く'
    : '応募状況を見る';
  const action = isProfile
    ? {
        type: 'uri',
        label: buttonLabel,
        uri: `${DEMO_WORKER_URL}/demo-candidate-chat?candidate=${encodeURIComponent(candidate.id)}&profile=1`,
      }
    : {
        type: 'uri',
        label: buttonLabel,
        uri: `${DEMO_WORKER_URL}/demo-candidate-chat?candidate=${encodeURIComponent(candidate.id)}&status=1`,
      };
  return JSON.stringify({
    type: 'bubble',
    size: 'mega',
    header: {
      type: 'box',
      layout: 'vertical',
      backgroundColor: isProfile ? '#111827' : isJobs ? '#2563EB' : isStatus ? '#7C3AED' : candidate.color,
      paddingAll: '16px',
      contents: [
        { type: 'text', text: title, size: 'xs', color: '#FFFFFF', weight: 'bold' },
        { type: 'text', text: DEMO_COMPANY_NAME, size: 'lg', color: '#FFFFFF', weight: 'bold', margin: 'sm', wrap: true },
      ],
    },
    body: {
      type: 'box',
      layout: 'vertical',
      spacing: 'md',
      paddingAll: '16px',
      contents: [
        {
          type: 'text',
          text: body,
          size: 'sm',
          color: '#111827',
          wrap: true,
        },
      ],
    },
    footer: {
      type: 'box',
      layout: 'vertical',
      paddingAll: '12px',
      contents: [
        {
          type: 'button',
          style: 'primary',
          color: candidate.color,
          height: 'sm',
          action,
        },
      ],
    },
  });
}

function buildDemoCandidateJobsLinkFlex(candidate: DemoCandidate): string {
  void candidate;
  return buildDemoApplicationStartFlex();
}

function buildDemoCandidateJobCardsFlex(candidate: DemoCandidate): string {
  return JSON.stringify({
    type: 'bubble',
    size: 'mega',
    header: {
      type: 'box',
      layout: 'vertical',
      backgroundColor: '#2563EB',
      paddingAll: '16px',
      contents: [
        { type: 'text', text: '求人を見る', size: 'xs', color: '#FFFFFF', weight: 'bold' },
        { type: 'text', text: '求人カードを確認できます', size: 'lg', color: '#FFFFFF', weight: 'bold', margin: 'sm', wrap: true },
      ],
    },
    body: {
      type: 'box',
      layout: 'vertical',
      spacing: 'md',
      paddingAll: '16px',
      contents: [
        { type: 'text', text: `${candidate.name}さんに合いそうな求人が届いたら、ここから確認できます！！`, size: 'sm', color: '#111827', wrap: true },
      ],
    },
    footer: {
      type: 'box',
      layout: 'vertical',
      paddingAll: '12px',
      contents: [
        {
          type: 'button',
          style: 'primary',
          color: '#2563EB',
          height: 'sm',
          action: { type: 'uri', label: '求人を見る', uri: `${DEMO_WORKER_URL}/demo-candidate-jobs?candidate=${encodeURIComponent(candidate.id)}` },
        },
      ],
    },
  });
}

async function getDemoRegisteredCompanyAccounts(db: D1Database): Promise<DemoCompanyAccount[]> {
  const result = await db
    .prepare(
      `SELECT line_user_id, display_name, metadata
         FROM friends
        WHERE line_account_id = ?
           OR metadata LIKE '%demo_company_account%'
           OR metadata LIKE '%demo_company_line_user_id%'
        ORDER BY updated_at DESC
        LIMIT 20`,
    )
    .bind(DEMO_COMPANY_LINE_ACCOUNT_ID)
    .all<{ line_user_id: string | null; display_name: string | null; metadata: string | null }>();
  const seen = new Set<string>();
  const accounts: DemoCompanyAccount[] = [];
  for (const row of result.results ?? []) {
    let account: DemoCompanyAccount | null = null;
    try {
      const meta = row.metadata ? JSON.parse(row.metadata) as Record<string, unknown> : {};
      account = normalizeDemoCompanyAccount(meta.demo_company_account);
    } catch {
      // Ignore malformed demo metadata.
    }
    if (!account && row.line_user_id) {
      account = buildDemoCompanyAccountFromProfile(row.line_user_id, row.display_name);
    }
    if (!account || seen.has(account.id)) continue;
    seen.add(account.id);
    accounts.push(account);
  }
  return accounts;
}

function normalizeDemoCompanyJob(raw: unknown): DemoCompanyJob | null {
  if (!raw || typeof raw !== 'object') return null;
  const record = raw as Record<string, unknown>;
  const companyName = typeof record.companyName === 'string' ? record.companyName.trim() : '';
  const title = typeof record.title === 'string' ? record.title.trim() : '';
  if (!companyName || !title) return null;
  return {
    companyName,
    title,
    hourlyWage: typeof record.hourlyWage === 'string' && record.hourlyWage.trim() ? record.hourlyWage.trim() : '条件は求人詳細で確認できます',
    shift: typeof record.shift === 'string' && record.shift.trim() ? record.shift.trim() : '勤務時間は相談可能です',
    description: typeof record.description === 'string' && record.description.trim() ? record.description.trim() : '仕事内容は求人詳細で確認できます',
    bannerUrl: typeof record.bannerUrl === 'string' && /^https:\/\//.test(record.bannerUrl) ? record.bannerUrl : 'https://placehold.co/1024x520/2563EB/FFFFFF/png?text=Job+Card',
    bannerPosition: 'center',
    bannerOffsetX: 0,
    bannerOffsetY: 0,
    bannerZoom: 1,
  };
}

async function getDemoPublishedCompanyJobs(db: D1Database): Promise<DemoCompanyJob[]> {
  const result = await db
    .prepare(
      `SELECT content
         FROM messages_log
        WHERE source = 'demo_company_job'
        ORDER BY created_at DESC
        LIMIT 50`,
    )
    .all<{ content: string }>();
  const seenCompanyNames = new Set<string>();
  const jobs: DemoCompanyJob[] = [];
  for (const row of result.results ?? []) {
    try {
      const job = normalizeDemoCompanyJob(JSON.parse(row.content));
      if (!job || seenCompanyNames.has(job.companyName)) continue;
      seenCompanyNames.add(job.companyName);
      jobs.push(job);
      if (jobs.length >= 10) break;
    } catch {
      // Ignore malformed demo job rows.
    }
  }
  return jobs;
}

async function buildDemoCandidateCompanyCardsFlex(db: D1Database, candidate: DemoCandidate): Promise<string> {
  const jobs = await getDemoPublishedCompanyJobs(db);
  if (jobs.length === 0) {
    return buildDemoCandidateJobCardsFlex(candidate);
  }

  const bubbles = jobs.slice(0, 10).map((job) => ({
    type: 'bubble',
    size: 'mega',
    hero: {
      type: 'image',
      url: job.bannerUrl,
      size: 'full',
      aspectRatio: '20:10',
      aspectMode: 'cover',
    },
    header: {
      type: 'box',
      layout: 'vertical',
      backgroundColor: '#2563EB',
      paddingAll: '16px',
      contents: [
        { type: 'text', text: 'あなたに合いそうな求人です！！', size: 'xs', color: '#FFFFFF', weight: 'bold', wrap: true },
        { type: 'text', text: job.title, size: 'lg', color: '#FFFFFF', weight: 'bold', margin: 'sm', wrap: true },
      ],
    },
    body: {
      type: 'box',
      layout: 'vertical',
      spacing: 'sm',
      paddingAll: '16px',
      contents: [
        { type: 'text', text: job.companyName, size: 'sm', color: '#111827', weight: 'bold', wrap: true },
        { type: 'separator', margin: 'sm' },
        buildDemoInfoRow('時給', job.hourlyWage),
        buildDemoInfoRow('勤務時間', job.shift),
        { type: 'text', text: job.description, size: 'xs', color: '#6B7280', wrap: true, margin: 'md' },
      ],
    },
    footer: {
      type: 'box',
      layout: 'vertical',
      paddingAll: '12px',
      contents: [
        {
          type: 'button',
          style: 'primary',
          color: '#2563EB',
          height: 'sm',
          action: {
            type: 'uri',
            label: '詳細を見る',
            uri: `${DEMO_WORKER_URL}/demo-candidate-jobs?candidate=${encodeURIComponent(candidate.id)}&companyName=${encodeURIComponent(job.companyName)}`,
          },
        },
      ],
    },
  }));

  return JSON.stringify({
    type: 'carousel',
    contents: bubbles,
  });
}

function buildDemoWelcomeText(lineAccountId: string | null | undefined): string | null {
  if (lineAccountId === DEMO_COMPANY_LINE_ACCOUNT_ID) {
    return [
      'こんにちは！！採用PRO 企業向けです✨',
      '',
      'まずは「アカウント連携」から会社情報をつなげてください！',
      '連携できたら、応募者対応と求人出稿がこのLINEから使えます👇',
      '',
      '🔵 新着応募者',
      '新しく反応があった求職者を確認できます！',
      '',
      '🟢 未対応チャット',
      '返信が必要な相手をすぐ確認できます！',
      '',
      '🟣 求人管理',
      '求人を作って、求職者LINEへ出稿できます！',
      '',
      '⚫️ アカウント連携',
      '採用PROのアカウントとLINEをつなぎます！',
    ].join('\n');
  }
  if (lineAccountId === DEMO_CANDIDATE_LINE_ACCOUNT_ID) {
    return [
      '採用PROへのご登録ありがとうございます！！✨',
      '',
      'あなたに合いそうな求人を届けるために、まずは「求人を見る」から求人をチェックしてみてください！！',
      '',
      '気になる求人があったら、そのまま応募チャットでやり取りできます👇',
    ].join('\n');
  }
  return null;
}

function buildDemoApplicationQuestionFlex(question: SaiyoProApplicationQuestion): string {
  const config = getSaiyoProApplicationQuestionConfig(question);
  return JSON.stringify({
    type: 'bubble',
    size: 'mega',
    header: {
      type: 'box',
      layout: 'vertical',
      backgroundColor: config.color,
      paddingAll: '16px',
      contents: [
        { type: 'text', text: '応募確認', size: 'xs', color: '#FFFFFF', weight: 'bold' },
        { type: 'text', text: config.title, size: 'xl', color: '#FFFFFF', weight: 'bold', margin: 'sm', wrap: true },
      ],
    },
    body: {
      type: 'box',
      layout: 'vertical',
      paddingAll: '16px',
      spacing: 'md',
      contents: [
        { type: 'text', text: config.description, size: 'sm', color: '#111827', wrap: true },
      ],
    },
    footer: {
      type: 'box',
      layout: 'vertical',
      spacing: 'sm',
      paddingAll: '12px',
      contents: config.options.map((option) => ({
        type: 'button',
        style: option.primary ? 'primary' : 'secondary',
        color: option.primary ? config.color : undefined,
        height: 'sm',
        action: {
          type: 'postback',
          label: option.label,
          data: `demo:application:${question}:${option.value}`,
        },
      })),
    },
  });
}

function buildDemoApplicationStartFlex(): string {
  return JSON.stringify({
    type: 'bubble',
    size: 'mega',
    hero: {
      type: 'image',
      url: SAIYO_PRO_APPLICATION_START_IMAGE_URL,
      size: 'full',
      aspectRatio: '3:2',
      aspectMode: 'cover',
    },
    body: {
      type: 'box',
      layout: 'vertical',
      paddingAll: '18px',
      spacing: 'md',
      contents: [
        { type: 'text', text: '採用PRO 求人案内', size: 'xl', weight: 'bold', color: SAIYO_PRO_BRAND_NAVY, wrap: true },
        { type: 'text', text: 'ご登録ありがとうございます！あなたに合う求人をご案内するために、かんたんな確認をお願いします。1分ほどで完了します。', size: 'sm', color: SAIYO_PRO_BRAND_MUTED, wrap: true },
        {
          type: 'box',
          layout: 'vertical',
          backgroundColor: SAIYO_PRO_BRAND_SOFT_BG,
          cornerRadius: 'md',
          paddingAll: '12px',
          contents: [
            { type: 'text', text: '確認する内容', size: 'xs', color: SAIYO_PRO_BRAND_PRIMARY, weight: 'bold' },
            { type: 'text', text: '年齢 / 性別 / 希望勤務地 / 現在の年収帯', size: 'sm', color: SAIYO_PRO_BRAND_NAVY, wrap: true, margin: 'sm' },
          ],
        },
      ],
    },
    footer: {
      type: 'box',
      layout: 'vertical',
      paddingAll: '12px',
      contents: [
        {
          type: 'button',
          style: 'primary',
          color: SAIYO_PRO_BRAND_PRIMARY,
          height: 'sm',
          action: {
            type: 'message',
            label: '求人案内の確認を始める',
            text: '求人案内の確認を始める',
          },
        },
      ],
    },
  });
}

function getSaiyoProApplicationQuestionConfig(question: SaiyoProApplicationQuestion): {
  title: string;
  description: string;
  color: string;
  options: Array<{ label: string; value: string; primary?: boolean }>;
} {
  switch (question) {
    case 'age':
      return {
        title: '年齢帯を教えてください',
        description: '求人案内の条件確認のため、該当する項目を選んでください。',
        color: SAIYO_PRO_BRAND_PRIMARY,
        options: [
          { label: '22〜24歳', value: 'age_22_24', primary: true },
          { label: '25〜27歳', value: 'age_25_27' },
          { label: '28〜30歳', value: 'age_28_30' },
          { label: '31歳以上', value: 'age_31_plus' },
        ],
      };
    case 'gender':
      return {
        title: '性別を教えてください',
        description: '今回の応募条件確認に使用します。',
        color: SAIYO_PRO_BRAND_SECONDARY,
        options: [
          { label: '男性', value: 'male', primary: true },
          { label: '女性', value: 'female' },
          { label: 'その他/回答しない', value: 'other' },
        ],
      };
    case 'location':
      return {
        title: '希望勤務地を教えてください',
        description: '勤務可能なエリアを選んでください。',
        color: SAIYO_PRO_BRAND_BLUE,
        options: [
          { label: '関東', value: 'kanto', primary: true },
          { label: '関西', value: 'kansai' },
          { label: '東北', value: 'tohoku' },
          { label: 'どこでもいい', value: 'anywhere' },
        ],
      };
    case 'income':
      return {
        title: '現在の年収帯を教えてください',
        description: '面談時の参考情報として使用します。',
        color: SAIYO_PRO_BRAND_ORANGE,
        options: [
          { label: '300万円未満', value: 'under300', primary: true },
          { label: '300〜400万円', value: '300_400' },
          { label: '400万円以上', value: 'over400' },
          { label: '未回答', value: 'unknown' },
        ],
      };
  }
}

function buildDemoCandidateChatOpenFlex(candidate: DemoCandidate): string {
  return JSON.stringify({
    type: 'bubble',
    size: 'mega',
    header: {
      type: 'box',
      layout: 'vertical',
      backgroundColor: candidate.color,
      paddingAll: '16px',
      contents: [
        { type: 'text', text: '応募者専用チャット', size: 'xs', color: '#FFFFFF', weight: 'bold' },
        { type: 'text', text: DEMO_COMPANY_NAME, size: 'lg', color: '#FFFFFF', weight: 'bold', margin: 'sm', wrap: true },
      ],
    },
    body: {
      type: 'box',
      layout: 'vertical',
      spacing: 'md',
      paddingAll: '16px',
      contents: [
        { type: 'text', text: '企業からの連絡、面接日程、質問への返信はこの応募者専用ページで確認できます。', size: 'sm', color: '#111827', wrap: true },
        buildDemoInfoRow('応募者', candidate.name),
        buildDemoInfoRow('応募求人', candidate.job),
      ],
    },
    footer: {
      type: 'box',
      layout: 'vertical',
      paddingAll: '12px',
      contents: [
        {
          type: 'button',
          style: 'primary',
          color: candidate.color,
          height: 'sm',
          action: {
            type: 'uri',
            label: '応募チャットを開く',
            uri: `${DEMO_WORKER_URL}/demo-candidate-chat?candidate=${encodeURIComponent(candidate.id)}&matched=1&v=${DEMO_CHAT_VERSION}`,
          },
        },
      ],
    },
  });
}

function buildDemoCandidateMatchPromptFlex(candidate: DemoCandidate): string {
  return JSON.stringify({
    type: 'bubble',
    size: 'mega',
    header: {
      type: 'box',
      layout: 'vertical',
      backgroundColor: '#2563EB',
      paddingAll: '16px',
      contents: [
        { type: 'text', text: '応募チャット', size: 'xs', color: '#FFFFFF', weight: 'bold' },
        { type: 'text', text: 'まずは求人に応募してマッチングしましょう！！', size: 'lg', color: '#FFFFFF', weight: 'bold', margin: 'sm', wrap: true },
      ],
    },
    body: {
      type: 'box',
      layout: 'vertical',
      spacing: 'md',
      paddingAll: '16px',
      contents: [
        { type: 'text', text: 'マッチングしたあとに企業とのチャットが開けます。気になる求人を見つけて、応募してみてください！！', size: 'sm', color: '#111827', wrap: true },
        buildDemoInfoRow('あなた', candidate.name),
        buildDemoInfoRow('次にやること', '求人を見る → 応募する → マッチング後にチャット'),
      ],
    },
    footer: {
      type: 'box',
      layout: 'vertical',
      paddingAll: '12px',
      contents: [
        {
          type: 'button',
          style: 'primary',
          color: '#2563EB',
          height: 'sm',
          action: {
            type: 'postback',
            label: '求人を見る',
            data: 'demo:candidate-menu:jobs-card',
          },
        },
      ],
    },
  });
}

function buildDemoCandidateChatChooserFlex(activeCandidate: DemoCandidate): string {
  const candidates = [DEMO_CANDIDATES.yamada, DEMO_CANDIDATES.tokihara];
  return JSON.stringify({
    type: 'carousel',
    contents: candidates.map((item) => ({
      type: 'bubble',
      size: 'mega',
      header: {
        type: 'box',
        layout: 'vertical',
        backgroundColor: item.id === activeCandidate.id ? activeCandidate.color : item.color,
        paddingAll: '14px',
        contents: [
          { type: 'text', text: '応募チャット', size: 'xs', color: '#FFFFFF', weight: 'bold' },
          { type: 'text', text: item.name, size: 'lg', color: '#FFFFFF', weight: 'bold', margin: 'sm', wrap: true },
        ],
      },
      body: {
        type: 'box',
        layout: 'vertical',
        spacing: 'sm',
        paddingAll: '14px',
        contents: [
          buildDemoInfoRow('応募先', DEMO_COMPANY_NAME),
          buildDemoInfoRow('求人', item.job),
          buildDemoInfoRow('状況', item.status),
        ],
      },
      footer: {
        type: 'box',
        layout: 'vertical',
        paddingAll: '12px',
        contents: [
          {
            type: 'button',
            style: 'primary',
            color: item.color,
            height: 'sm',
            action: {
              type: 'uri',
              label: 'このチャットへ進む',
              uri: `${DEMO_WORKER_URL}/demo-candidate-chat?candidate=${encodeURIComponent(item.id)}&matched=1&v=${DEMO_CHAT_VERSION}`,
            },
          },
        ],
      },
    })),
  });
}

function buildDemoCandidateStatusFlex(activeCandidate: DemoCandidate): string {
  return JSON.stringify({
    type: 'bubble',
    size: 'mega',
    header: {
      type: 'box',
      layout: 'vertical',
      backgroundColor: activeCandidate.color,
      paddingAll: '14px',
      contents: [
        { type: 'text', text: '応募状況', size: 'xs', color: '#FFFFFF', weight: 'bold' },
        { type: 'text', text: DEMO_COMPANY_NAME, size: 'lg', color: '#FFFFFF', weight: 'bold', margin: 'sm', wrap: true },
      ],
    },
    body: {
      type: 'box',
      layout: 'vertical',
      spacing: 'sm',
      paddingAll: '14px',
      contents: [
        buildDemoInfoRow('応募者', activeCandidate.name),
        buildDemoInfoRow('状況', activeCandidate.status),
        buildDemoInfoRow('最終連絡', activeCandidate.lastMessage),
      ],
    },
    footer: {
      type: 'box',
      layout: 'vertical',
      paddingAll: '12px',
      contents: [
        {
          type: 'button',
          style: 'secondary',
          height: 'sm',
          action: {
            type: 'uri',
            label: '応募状況を見る',
            uri: `${DEMO_WORKER_URL}/demo-candidate-chat?candidate=${encodeURIComponent(activeCandidate.id)}&status=1`,
          },
        },
      ],
    },
  });
}

function buildDemoCandidateReplyNotificationFlex(candidate: DemoCandidate, body: string): string {
  const linkButtons = buildDemoLinkButtons(body);
  return JSON.stringify({
    type: 'bubble',
    size: 'mega',
    header: {
      type: 'box',
      layout: 'vertical',
      backgroundColor: candidate.color,
      paddingAll: '16px',
      contents: [
        { type: 'text', text: '新着メッセージ', size: 'xs', color: '#FFFFFF', weight: 'bold' },
        { type: 'text', text: candidate.name, size: 'xl', color: '#FFFFFF', weight: 'bold', margin: 'sm', wrap: true },
      ],
    },
    body: {
      type: 'box',
      layout: 'vertical',
      spacing: 'md',
      paddingAll: '16px',
      contents: [
        {
          type: 'box',
            layout: 'vertical',
            backgroundColor: '#F3F4F6',
            cornerRadius: 'md',
            paddingAll: '12px',
            contents: [
              { type: 'text', text: body, size: 'sm', color: '#111827', wrap: true },
              ...linkButtons,
            ],
          },
        {
          type: 'box',
          layout: 'horizontal',
          spacing: 'sm',
          contents: [
            { type: 'text', text: '応募求人', size: 'xs', color: '#6B7280', flex: 2 },
            { type: 'text', text: candidate.job, size: 'xs', color: '#111827', flex: 5, wrap: true },
          ],
        },
      ],
    },
    footer: {
      type: 'box',
      layout: 'vertical',
      spacing: 'sm',
      paddingAll: '12px',
      contents: [
        { type: 'button', style: 'primary', color: candidate.color, height: 'sm', action: buildDemoChatUriAction(candidate, 'やり取りする') },
        { type: 'button', style: 'secondary', height: 'sm', action: { type: 'message', label: '候補者詳細', text: '山田詳細' } },
      ],
    },
  });
}

function buildDemoLinkButtons(body: string): Array<Record<string, unknown>> {
  const urls = extractDemoUrls(body);
  return urls.map((url, index) => ({
    type: 'button',
    style: 'link',
    height: 'sm',
    margin: index === 0 ? 'md' : 'xs',
    action: {
      type: 'uri',
      label: urls.length === 1 ? 'リンクを開く' : `リンク${index + 1}を開く`,
      uri: url,
    },
  }));
}

function extractDemoUrls(body: string): string[] {
  const matches = body.match(/https?:\/\/[^\s<>"'）)]+/g) ?? [];
  const seen = new Set<string>();
  const urls: string[] = [];
  for (const raw of matches) {
    const url = raw.replace(/[、。,.]+$/g, '');
    if (seen.has(url)) continue;
    seen.add(url);
    urls.push(url);
    if (urls.length >= 3) break;
  }
  return urls;
}

export { webhook, buildDemoApplicationStartFlex, buildDemoApplicationQuestionFlex, buildSaiyoProApplicationResultFlex, buildDemoCandidateJobsLinkFlex, buildDemoCandidateListFlex, buildDemoCandidateSelfMenuFlex, buildDemoCandidateCompanyCardsFlex, buildDemoCompanyAccountFromProfile, buildDemoCompanyMenuReply, buildDemoWelcomeText };
